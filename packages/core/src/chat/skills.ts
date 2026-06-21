import type { VisualReaderStore } from "../storage/store.js";

/**
 * SKILLS — the assistant's durable "intelligence docs": named markdown playbooks it
 * keeps across EVERY conversation (not per-book, not per-workspace) so it learns to do
 * recurring tasks better over time. The reader (or the assistant itself, via save_skill)
 * writes them; a compact INDEX of names+descriptions rides in every system prompt, and
 * the full body is fetched on demand with read_skill — the same "index in context,
 * detail on demand" shape as the Visual Bible, so a growing library stays cheap.
 *
 * Persisted as one JSON memo in the shared store (like reader-memory), so the same
 * skills apply to every chat session regardless of which book/folder is open. Bounded
 * (count + per-field caps) so the always-on index can't bloat the prompt.
 */

export const READER_SKILLS_KEY = "reader-skills";
export const MAX_SKILLS = 50;
export const MAX_SKILL_NAME_CHARS = 60;
export const MAX_SKILL_DESC_CHARS = 200;
export const MAX_SKILL_BODY_CHARS = 8_000;

export interface Skill {
  /** Short unique handle the model passes to read_skill (e.g. "react-component"). */
  name: string;
  /** One line: WHEN to use this skill — the trigger that appears in the index. */
  description: string;
  /** The full playbook (markdown), fetched on demand. */
  body: string;
  /** ms epoch of the last write. */
  at: number;
  /** ms epoch this skill was last USED (read_skill matched it); drives eviction so a
   * frequently-reused skill isn't dropped just for being old. Defaults to `at`. */
  lastUsedAt?: number;
  /** How many times this skill has been loaded/applied — a "has it earned its place" signal. */
  useCount?: number;
}

function isSkill(v: unknown): v is Skill {
  const s = v as Skill;
  return s != null && typeof s.name === "string" && typeof s.body === "string";
}

/** Memo flag: starter skills have been seeded once (so we never re-add them, and never
 * fight the reader if they delete one). */
export const SKILLS_SEEDED_KEY = "skills-seeded";

/** A handful of ready-made playbooks the assistant ships with, so a fresh install already
 * knows a few recurring jobs (and shows the reader what a skill looks like). The reader can
 * edit or forget any of them; they're only ever seeded ONCE. `at` is set at seed time. */
export const STARTER_SKILLS: readonly Omit<Skill, "at">[] = [
  {
    name: "clone-and-setup-repo",
    description: "Clone a GitHub repo and get it running (install deps, build, run tests).",
    body:
      "# Clone & set up a repo\n\n" +
      "1. `gh repo clone <owner>/<repo>` (gh is already authenticated). Each run_command starts in the " +
      "workspace root and `cd` does NOT persist — chain steps with `&&`.\n" +
      "2. Detect the stack from the files: `package.json` → Node, `requirements.txt`/`pyproject.toml` → " +
      "Python, `Cargo.toml` → Rust, `go.mod` → Go.\n" +
      "3. Install: Node `npm install` (or `pnpm install`/`yarn` if a lockfile says so); Python `pip install " +
      "-r requirements.txt` (prefer a venv); Rust `cargo build`; Go `go mod download`.\n" +
      "4. Read the README for any setup/env steps; create a `.env` from `.env.example` if present (ask the " +
      "reader for any secret values — never invent them).\n" +
      "5. Build + test to confirm it works (`npm run build` / `npm test`, `pytest`, `cargo test`, `go test ./...`).\n" +
      "6. Report what ran, what passed/failed, and how to start it (the dev/run command).",
  },
  {
    name: "draft-status-email",
    description: "Draft a clear status/update email from notes or a task's progress.",
    body:
      "# Draft a status email\n\n" +
      "Use draft_email (it lands in Gmail Drafts for the reader to review) unless they say to send.\n" +
      "1. Confirm the recipient(s) — pull the address from an email you read, or ask; never guess.\n" +
      "2. Subject: specific and scannable (e.g. \"Project X — week of <date>: on track\").\n" +
      "3. Body, short and skimmable: one-line summary first; then **Done**, **In progress**, **Blocked/needs " +
      "you** as short bullet groups; a clear ask or next step at the end.\n" +
      "4. Match the reader's voice — plain, warm, no filler. Keep it under ~200 words unless they want detail.\n" +
      "5. Draft it, then tell the reader it's ready to review and send.",
  },
  {
    name: "run-tests-and-summarize",
    description: "Run a project's tests and report failures concisely with likely causes.",
    body:
      "# Run tests & summarize\n\n" +
      "1. Find the test command (package.json scripts, Makefile, CI config, or the stack default: " +
      "`npm test`, `pytest -q`, `cargo test`, `go test ./...`).\n" +
      "2. Run it; capture stdout+stderr. If it fails to start, fix the obvious setup issue (missing deps) and retry once.\n" +
      "3. Summarize: total passed/failed, then for each failure the test name, the assertion/error line, and the " +
      "file:line — not the whole dump.\n" +
      "4. For each failure give a one-line likely cause and the smallest next step. Don't claim a fix you didn't verify.",
  },
];

/**
 * Seed {@link STARTER_SKILLS} ONCE per install: only when they've never been seeded AND the
 * reader has no skills of their own (so we never overwrite or duplicate). Idempotent — the
 * memo flag short-circuits every later call. Safe to invoke before each skills load.
 */
export async function seedStarterSkills(store: VisualReaderStore): Promise<void> {
  try {
    if (await store.getMemo?.(SKILLS_SEEDED_KEY)) return;
    const existing = await loadSkills(store);
    if (existing.length === 0) {
      const at = Date.now();
      await persist(store, STARTER_SKILLS.map((s) => ({ ...s, at })));
    }
    await store.putMemo?.(SKILLS_SEEDED_KEY, "1");
  } catch {
    /* seeding is best-effort — a store hiccup must never block a chat turn */
  }
}

/** When a skill was last touched (used, else written) — the eviction key. */
function usedAt(s: Skill): number {
  return s.lastUsedAt ?? s.at;
}

/** Keep the MAX_SKILLS most-recently-USED (not merely most-recently-written) skills; on a tie,
 * the later-inserted one wins (so identical timestamps fall back to insertion order). */
function evictByUse(skills: Skill[]): Skill[] {
  if (skills.length <= MAX_SKILLS) return skills;
  const ranked = skills
    .map((s, i) => ({ s, i }))
    .sort((a, b) => usedAt(b.s) - usedAt(a.s) || b.i - a.i);
  const keep = new Set(ranked.slice(0, MAX_SKILLS).map((r) => r.s));
  return skills.filter((s) => keep.has(s)); // preserve original order among survivors
}

export async function loadSkills(store: VisualReaderStore): Promise<Skill[]> {
  try {
    const raw = await store.getMemo?.(READER_SKILLS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return evictByUse(parsed.filter(isSkill));
  } catch {
    return [];
  }
}

async function persist(store: VisualReaderStore, skills: Skill[]): Promise<void> {
  await store.putMemo?.(READER_SKILLS_KEY, JSON.stringify(evictByUse(skills)));
}

/** Clean + bound a skill's fields; returns undefined when there's no usable name/body. */
export function normalizeSkill(input: { name: string; description?: string; body: string }): Skill | undefined {
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, MAX_SKILL_NAME_CHARS);
  const body = input.body.trim().slice(0, MAX_SKILL_BODY_CHARS);
  if (!name || !body) return undefined;
  return {
    name,
    description: (input.description ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_SKILL_DESC_CHARS),
    body,
    at: Date.now(),
  };
}

/**
 * Upsert a skill (case-insensitive by name — re-saving the same name REPLACES it, so
 * the assistant can refine a playbook in place; oldest evicted past the cap). Returns
 * the full list. Throws on an empty name/body so a bad save_skill call self-corrects.
 */
export async function saveSkill(
  store: VisualReaderStore,
  input: { name: string; description?: string; body: string },
): Promise<Skill[]> {
  const skill = normalizeSkill(input);
  if (!skill) throw new Error("a skill needs a name and a body");
  const skills = await loadSkills(store);
  const key = skill.name.toLowerCase();
  const prior = skills.find((s) => s.name.toLowerCase() === key);
  const kept = skills.filter((s) => s.name.toLowerCase() !== key);
  // Refining a skill in place keeps its earned reuse stats.
  kept.push({ ...skill, lastUsedAt: skill.at, useCount: prior?.useCount ?? 0 });
  const bounded = evictByUse(kept);
  await persist(store, bounded);
  return bounded;
}

/** Record that a skill was USED (read_skill matched it): bump its use count + recency so reuse
 * keeps it from being evicted. No-op when nothing matches. Returns the matched skill, if any. */
export async function touchSkill(store: VisualReaderStore, query: string): Promise<Skill | undefined> {
  const skills = await loadSkills(store);
  const hit = findSkill(skills, query);
  if (!hit) return undefined;
  const updated = skills.map((s) =>
    s === hit ? { ...s, lastUsedAt: Date.now(), useCount: (s.useCount ?? 0) + 1 } : s,
  );
  await persist(store, updated);
  return hit;
}

/** Remove every skill whose name contains `match` (case-insensitive); throws when none
 * matched so the wording self-corrects. Returns what's left. */
export async function forgetSkill(store: VisualReaderStore, match: string): Promise<Skill[]> {
  const needle = match.trim().toLowerCase();
  if (!needle) throw new Error("nothing to forget");
  const skills = await loadSkills(store);
  const kept = skills.filter((s) => !s.name.toLowerCase().includes(needle));
  if (kept.length === skills.length) throw new Error(`no skill name contains "${match.trim()}"`);
  await persist(store, kept);
  return kept;
}

/** Find one skill by name (exact, then loose) or description — the read_skill lookup. */
export function findSkill(skills: readonly Skill[], query: string): Skill | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return (
    skills.find((s) => s.name.toLowerCase() === q) ??
    skills.find((s) => s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase())) ??
    skills.find((s) => s.description.toLowerCase().includes(q))
  );
}

/** The full body for a matched skill (the read_skill payload), or "" when none match. */
export function readSkillBody(skills: readonly Skill[], query: string): string {
  return findSkill(skills, query)?.body ?? "";
}

/** The always-on compact index injected into the system prompt ("" when empty). */
export function skillsIndexBlock(skills: readonly Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ""}`);
  return (
    "SKILLS — your saved playbooks, kept across every conversation. When a task matches one, call " +
    "read_skill with its name to load the full steps BEFORE you start; when you work out a reusable " +
    "approach the reader would want again, save_skill it so you do it better next time:\n" +
    lines.join("\n")
  );
}
