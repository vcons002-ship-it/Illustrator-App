/**
 * In-place file editing — search/replace blocks (the reliable format leading coding agents use),
 * applied to a file's text so the model edits an EXISTING file without re-emitting the whole thing
 * (which truncates on big files and is token-expensive). Each `search` must match EXACTLY ONCE so an
 * edit is never applied to the wrong place; zero or ambiguous matches are reported, not guessed. PURE —
 * the host reads the file, calls this, writes the result back. See the `edit_file` tool.
 */

/** One search/replace edit: find `search` (verbatim) and swap it for `replace`. */
export interface FileEdit {
  search: string;
  replace: string;
}

/** Why a single edit couldn't be applied. */
export interface FileEditFailure {
  index: number;
  search: string;
  reason: "not_found" | "ambiguous";
}

export interface FileEditResult {
  /** The edited text (edits that failed are skipped — partial application is reported via failures). */
  content: string;
  /** How many edits applied cleanly. */
  applied: number;
  /** Edits that matched zero (not_found) or 2+ (ambiguous) times. */
  failures: FileEditFailure[];
}

/** Count non-overlapping occurrences of `needle` in `hay` (verbatim). */
function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Apply search/replace edits to `content`, in order. Each `search` must match EXACTLY ONCE in the
 * CURRENT text (after any prior edits) — 0 matches → `not_found`, 2+ → `ambiguous` — so an edit can
 * never land in the wrong spot. Failed edits are skipped and reported so the caller can tell the model
 * to retry with a more specific anchor (more surrounding context). PURE.
 */
export function applyFileEdits(content: string, edits: FileEdit[]): FileEditResult {
  let out = content;
  let applied = 0;
  const failures: FileEditFailure[] = [];
  edits.forEach((edit, index) => {
    const { search, replace } = edit;
    const matches = countOccurrences(out, search);
    if (matches === 1) {
      // Use the function form of replace so `replace` is inserted VERBATIM. String.replace treats
      // `$&`, `` $` ``, `$'`, `$$`, `$1` in a STRING replacement as substitution patterns — a
      // model-supplied replacement containing those would be silently corrupted. A replacer function's
      // return value is never interpreted, so the swap is always literal.
      out = out.replace(search, () => replace);
      applied++;
    } else {
      failures.push({ index, search, reason: matches > 1 ? "ambiguous" : "not_found" });
    }
  });
  return { content: out, applied, failures };
}

// ------------------------------------------------------------- line upserts
//
// Search/replace above is the right primitive when you know the text you're changing. It is the WRONG
// one for a running list — an RSVP list, a checklist, a status per person — because to change Bo's
// entry you have to already know whether it currently says "?" or "yes", and if you guess wrong the
// edit misses. The historical fallback from a miss was to add the new answer at the bottom, leaving
// the list saying two different things about Bo. An upsert removes the guess: name the LABEL, give
// the line you want, and it lands wherever that label already sits — or joins the list if it's new.

/** An upsert of one labelled line — the "make sure the list says this" primitive. */
export interface LineUpsert {
  /** The label identifying the line, e.g. "Bo" for a line reading "- Bo: ?". Matched case-insensitively
   * against the start of each line, on a word boundary, so "Bo" won't hit "Bobby". */
  match: string;
  /** The full line to put there, e.g. "Bo: yes". Any bullet the old line had is kept. When nothing
   * matches, this is inserted into the existing list rather than dropped at the very bottom. */
  line: string;
}

/** Indent, bullet/number, and checkbox are tracked SEPARATELY: a checkbox is state the caller may
 * want to set ("[x] Bo") while the bullet is decoration to preserve, so collapsing them into one
 * "marker" makes a new `[x] …` line silently lose its "- ". */
const MARKER_RE = /^(\s*)((?:[-*•·+]|\d+[.)])\s*)?(\[[ xX]?\]\s*)?([\s\S]*)$/;

interface LineParts {
  indent: string;
  bullet: string;
  checkbox: string;
  body: string;
}

function parseLine(line: string): LineParts {
  const m = MARKER_RE.exec(line);
  return { indent: m?.[1] ?? "", bullet: m?.[2] ?? "", checkbox: m?.[3] ?? "", body: m?.[4] ?? line };
}

/** Indent + any bullet/number/checkbox that opens a line, split from the text after it. PURE. */
export function splitLineMarker(line: string): [marker: string, body: string] {
  const p = parseLine(line);
  return [p.indent + p.bullet + p.checkbox, p.body];
}

/** Does `body` start with `label` followed by a boundary (": ", " —", end)? PURE. */
function startsWithLabel(body: string, label: string): boolean {
  if (!label) return false;
  const b = body.toLowerCase();
  const l = label.toLowerCase();
  if (!b.startsWith(l)) return false;
  const next = b.charAt(l.length);
  return next === "" || !/[a-z0-9]/.test(next);
}

/** A label as written on a line, minus the trailing punctuation people put after it ("Bo:" → "bo"). */
function normalizeLabel(match: string): string {
  return match.trim().replace(/[:\-–—=]+$/, "").trim();
}

/**
 * The replacement text for a line. The old line's indent and bullet are kept (they're the list's
 * formatting, not the caller's business) unless the new text brings its own bullet. The checkbox is
 * different — it's STATE, so a new "[x] …" ticks the box while text without one leaves the box as it
 * was. PURE.
 */
export function reline(oldLine: string, next: string): string {
  const o = parseLine(oldLine);
  const n = parseLine(next.trim());
  return o.indent + (n.bullet || o.bullet) + (n.checkbox || o.checkbox) + n.body;
}

/**
 * Upsert labelled lines: overwrite the line for that label if it's there, otherwise add it. Any EXTRA
 * lines carrying the same label are dropped, which heals text that a previous blind append already
 * double-entered. New lines are inserted after the last list item rather than at the very bottom, so
 * they join the list instead of trailing behind whatever follows it. PURE.
 */
export function applyLineUpserts(
  text: string,
  entries: readonly LineUpsert[],
): { text: string; replaced: string[]; added: string[] } {
  const lines = text ? text.split("\n") : [];
  const replaced: string[] = [];
  const added: string[] = [];
  for (const entry of entries) {
    const label = normalizeLabel(entry.match);
    const next = entry.line.trim();
    if (!label || !next) continue;
    const hits = lines.reduce<number[]>((acc, l, i) => {
      if (startsWithLabel(splitLineMarker(l)[1].trim(), label)) acc.push(i);
      return acc;
    }, []);
    if (hits.length > 0) {
      const first = hits[0] ?? 0;
      lines[first] = reline(lines[first] ?? "", next);
      // Later duplicates go, back-to-front so the earlier indices stay valid.
      for (const dup of hits.slice(1).reverse()) lines.splice(dup, 1);
      replaced.push(entry.match);
      continue;
    }
    // Land it in the list: after the last bulleted line if there is one, else at the end. The new
    // entry copies that list's indent and bullet so it reads as part of it — same composition as
    // reline, so a "[x] Bo" appended to a "- [ ] …" list gets the dash rather than losing it.
    const lastItem = lines.reduce((acc, l, i) => {
      const p = parseLine(l);
      return p.bullet.trim() && p.body.trim() ? i : acc;
    }, -1);
    const host = lastItem >= 0 ? parseLine(lines[lastItem] ?? "") : undefined;
    // A numbered marker can't be reused verbatim (it would repeat the number), so fall back to a dash.
    const bullet = host ? (/\d/.test(host.bullet) ? "- " : host.bullet) : "";
    const n = parseLine(next);
    const line = (n.indent || host?.indent || "") + (n.bullet || bullet) + n.checkbox + n.body;
    if (lastItem >= 0) lines.splice(lastItem + 1, 0, line);
    else lines.push(line);
    added.push(entry.match);
  }
  return { text: lines.join("\n").replace(/^\n+/, ""), replaced, added };
}

/**
 * One Markdown section of `body` — the named ATX heading plus everything under it, up to the next
 * heading at the SAME OR SHALLOWER level (so asking for "## Scope" gets its "###" subsections too).
 * Matched case-insensitively on the heading text. Undefined when no heading matches. PURE.
 */
export function extractSection(body: string, heading: string): string | undefined {
  const want = heading.trim().replace(/^#+\s*/, "").toLowerCase();
  if (!want) return undefined;
  const lines = body.split("\n");
  const headings = lines.map((l) => /^(#{1,6})\s+(.+?)\s*#*$/.exec(l));
  const start = headings.findIndex((m) => m && (m[2] ?? "").trim().toLowerCase() === want);
  if (start < 0) return undefined;
  const depth = (headings[start]?.[1] ?? "#").length;
  const after = headings.findIndex((m, i) => i > start && m && (m[1] ?? "").length <= depth);
  return lines.slice(start, after < 0 ? lines.length : after).join("\n").trimEnd();
}

/** A one-line, model-facing summary of an edit result (for the tool feedback). */
export function summarizeFileEdits(path: string, r: FileEditResult): string {
  if (r.failures.length === 0) return `[edit_file applied ${r.applied} edit(s) to ${path}.]`;
  const why = r.failures
    .map((f) => `#${f.index + 1} ${f.reason === "ambiguous" ? "matched 2+ places (add more surrounding context)" : "no exact match (re-read the file; copy the text verbatim)"}`)
    .join("; ");
  return `[edit_file: ${r.applied} applied, ${r.failures.length} FAILED on ${path} — ${why}. The file is unchanged for the failed edits.]`;
}
