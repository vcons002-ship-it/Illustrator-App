import type { VisualReaderStore } from "../storage/store.js";
import { type NoteEntry, type NoteStoreSpec, loadNotes, saveNotes, rememberIn, forgetIn } from "./note-store.js";
// The soul's look-budget is deliberately the SAME number the image prompt will accept for a
// character, so the soul is never the tighter of the two and nothing is trimmed twice.
import { MAX_CHARACTER_DESCRIPTOR_CHARS } from "../providers/image/bible-injection.js";
import { repairTruncatedJson } from "../providers/llm/extraction.js";
import { stripTransientCharacterDetailsExact } from "../visual-bible/character-details.js";

/**
 * The two identity "souls" — durable notes, separate from reader-memory, that capture
 * IDENTITY rather than preferences:
 *  - SELF  ("who you are"): the assistant's own persona, look, and voice — so when it
 *    plays itself in a story (You & me roleplay) it stays consistent.
 *  - USER  ("who the reader is"): what the assistant knows about the reader's own
 *    character — look, personality — so it can portray them when they play themselves.
 *
 * Same bounded note machinery as reader-memory (`note-store.ts`), under different memo
 * keys, plus a short NAME per soul (used to seed the played character names in roleplay).
 * Edited via the Soul panels AND the remember/forget tools (`about:"self"|"user"`).
 */

export type SoulKind = "self" | "user";

export const SELF_SOUL_KEY = "self-soul";
export const ABOUT_YOU_SOUL_KEY = "about-you-soul";
export const SELF_SOUL_ESSENCE_KEY = "self-soul-essence";
export const ABOUT_YOU_SOUL_ESSENCE_KEY = "about-you-soul-essence";
/**
 * How many identity notes are KEPT. Distinct from how many are shown to the model each turn
 * ({@link SOUL_PROMPT_BUDGET_CHARS}) — conflating the two is what made this small.
 *
 * It was 40, which is fine for notes a reader writes by hand and far too few once the assistant adds
 * its own from what it reads: the store evicts oldest-first, so a handful of weeks of exploring would
 * quietly delete the character underneath it. Storage is a KV string; the cost of keeping 200 is a
 * few kilobytes on disk, and none of it reaches the prompt unless it fits the budget below.
 */
export const MAX_SOUL_NOTES = 200;
/**
 * How much of a soul rides in EVERY system prompt. This is the real limit, and why the note cap
 * couldn't just be raised on its own: the block used to render every note with no bound, so 40 notes
 * at the 2000-char ceiling could have put 80k characters into a ~33k-character prompt.
 *
 * ~4k characters is roughly 1k tokens — enough for around forty short traits, which is more than the
 * old cap ever held, while the rest stay on disk and in the Soul panel instead of being destroyed.
 */
export const SOUL_PROMPT_BUDGET_CHARS = 4000;
/** Per-note character cap — generous enough for a real character bio/paragraph. Matches reader-memory's
 * MAX_NOTE_CHARS; kept as its own constant since souls are a separate bounded list. */
export const MAX_SOUL_NOTE_CHARS = 2000;
export const MAX_SOUL_NAME_CHARS = 80;

const SPECS: Record<SoulKind, NoteStoreSpec> = {
  self: { key: SELF_SOUL_KEY, maxNotes: MAX_SOUL_NOTES, maxChars: MAX_SOUL_NOTE_CHARS },
  user: { key: ABOUT_YOU_SOUL_KEY, maxNotes: MAX_SOUL_NOTES, maxChars: MAX_SOUL_NOTE_CHARS },
};
const NAME_KEY: Record<SoulKind, string> = { self: "self-soul-name", user: "about-you-soul-name" };
const FORGET_LABEL: Record<SoulKind, string> = { self: "self-soul note", user: "about-you note" };
const IMAGES_KEY: Record<SoulKind, string> = { self: "self-soul-images", user: "about-you-soul-images" };
const ESSENCE_KEY: Record<SoulKind, string> = {
  self: SELF_SOUL_ESSENCE_KEY,
  user: ABOUT_YOU_SOUL_ESSENCE_KEY,
};
/** How many reference photos a soul may hold — a couple of angles is plenty for character conditioning. */
export const MAX_SOUL_IMAGES = 3;

/** A reference photo attached to a soul: stored base64 (JSON-able in the KV store), decoded to bytes
 * only when fed to the image model as a character reference. */
export interface SoulImage {
  mimeType: string;
  dataBase64: string;
}

function isSoulImage(v: unknown): v is SoulImage {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as SoulImage).mimeType === "string" &&
    typeof (v as SoulImage).dataBase64 === "string" &&
    (v as SoulImage).dataBase64.length > 0
  );
}

/** The soul's reference photos ([] when none). */
export async function loadSoulImages(store: VisualReaderStore, kind: SoulKind): Promise<SoulImage[]> {
  const raw = await store.getMemo?.(IMAGES_KEY[kind]).catch(() => undefined);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(isSoulImage).slice(0, MAX_SOUL_IMAGES) : [];
  } catch {
    return [];
  }
}

/** Replace the soul's reference photos (capped at MAX_SOUL_IMAGES). */
export async function saveSoulImages(store: VisualReaderStore, kind: SoulKind, images: readonly SoulImage[]): Promise<void> {
  await store.putMemo?.(IMAGES_KEY[kind], JSON.stringify(images.filter(isSoulImage).slice(0, MAX_SOUL_IMAGES)));
}

/** A single durable identity note. */
export type SoulNote = NoteEntry;

export function loadSoul(store: VisualReaderStore, kind: SoulKind): Promise<SoulNote[]> {
  return loadNotes(store, SPECS[kind]);
}

/** Replace the WHOLE list — for the editable Soul panel. */
export async function saveSoul(
  store: VisualReaderStore,
  kind: SoulKind,
  notes: readonly SoulNote[],
): Promise<SoulNote[]> {
  const saved = await saveNotes(store, SPECS[kind], notes);
  return saved;
}

export async function rememberSoul(store: VisualReaderStore, kind: SoulKind, text: string): Promise<SoulNote[]> {
  const saved = await rememberIn(store, SPECS[kind], text);
  return saved;
}

export async function forgetSoul(store: VisualReaderStore, kind: SoulKind, match: string): Promise<SoulNote[]> {
  const saved = await forgetIn(store, SPECS[kind], match, FORGET_LABEL[kind]);
  return saved;
}

/** The played character's NAME for this soul ("" when unset). */
export async function loadSoulName(store: VisualReaderStore, kind: SoulKind): Promise<string> {
  return ((await store.getMemo?.(NAME_KEY[kind])) ?? "").trim();
}

export async function saveSoulName(store: VisualReaderStore, kind: SoulKind, name: string): Promise<void> {
  await store.putMemo?.(NAME_KEY[kind], name.trim().slice(0, MAX_SOUL_NAME_CHARS));
}

/**
 * A Soul Essence is a derived, compact interpretation of the authoritative SoulNote[].
 * Its source fingerprint distinguishes a current Essence from the last validated snapshot after the
 * notes change. The old snapshot remains available while an updated one is prepared, and every
 * distilled assertion points back to the notes that supported that historical synthesis.
 */
export const SOUL_ESSENCE_SCHEMA_VERSION = 3 as const;
export const MAX_SOUL_ESSENCE_FACET_CHARS = 420;
/**
 * The standing identity is intentionally much smaller than its grounded support facets. This is
 * the only synthesized personality text ordinary chat and stories should embody by default.
 */
export const MAX_SOUL_GENERALIZED_ESSENCE_CHARS = 160;
/** The final standing identity is a handful of portable trait phrases, not a miniature biography. */
export const MAX_SOUL_GENERALIZED_TRAITS = 6;
export const MAX_SOUL_GENERALIZED_TRAIT_WORDS = 4;

export const SOUL_ESSENCE_FACETS = [
  "coreDisposition",
  "conversationalVoice",
  "thinkingStyle",
  "valuesAndMotivations",
  "relationalStyle",
  "personalityDirections",
  "tensionsAndNuance",
] as const;

export type SoulEssenceFacetKey = (typeof SOUL_ESSENCE_FACETS)[number];

export const SOUL_GENERALIZABLE_FACETS = [
  "coreDisposition",
  "conversationalVoice",
  "thinkingStyle",
  "valuesAndMotivations",
  "relationalStyle",
  "tensionsAndNuance",
] as const;

export type SoulGeneralizableFacetKey = (typeof SOUL_GENERALIZABLE_FACETS)[number];

export interface SoulEssenceSource {
  /** Stable for this exact note text + timestamp. */
  id: string;
  text: string;
  at: number;
}

export interface SoulEssenceFacet {
  /** A synthesis, not a list or quotation of individual examples. */
  text: string;
  /** IDs of the authoritative notes that support this synthesis. */
  sourceIds: string[];
}

export type SoulEssenceFacets = {
  [K in SoulEssenceFacetKey]: SoulEssenceFacet;
};

export interface SoulEssenceAppearanceFact {
  /** Verbatim visual span/value from a source note, after deterministic current-state reconciliation. */
  text: string;
  sourceIds: string[];
  /** Deterministic semantic anchor for rendering an otherwise-bare exact value such as "auburn". */
  slot?: string;
}

export interface SoulEssenceDirectionFact {
  /** Verbatim personality/portrayal direction from an authoritative source note. */
  text: string;
  sourceIds: string[];
}

export interface SoulEssence {
  schemaVersion: typeof SOUL_ESSENCE_SCHEMA_VERSION;
  kind: SoulKind;
  sourceFingerprint: string;
  generatedAt: number;
  /**
   * A portable, higher-order identity distilled across the support facets. It deliberately excludes
   * named interests, anecdotes, appearance, and exact behavioral directions.
   */
  generalizedEssence: SoulEssenceFacet;
  /**
   * Grounded support/evidence index. These retain the meaning of every authoritative note for
   * validation and explicit source retrieval, but are not injected as the standing personality.
   */
  facets: SoulEssenceFacets;
  /**
   * Appearance is kept apart from personality synthesis and copied verbatim from its sources. That
   * prevents a summarizer from quietly changing eye colour, body type, scars, clothing, or age.
   */
  exactAppearance: SoulEssenceAppearanceFact[];
  /**
   * Directions are source-exact for the same reason appearance is: an LLM synthesis may combine
   * their meaning, but it must never weaken or invert the actual instruction.
   */
  exactPersonalityDirections: SoulEssenceDirectionFact[];
}

export interface SoulEssenceDistillationPrompt {
  system: string;
  user: string;
  sourceFingerprint: string;
}

export interface SoulEssenceDigestInput {
  notes: readonly SoulNote[];
  essence: SoulEssence;
}

/** The three deliberately different Soul access policies used by chat. */
export type SoulContextMode = "ordinary" | "story" | "creative";

/**
 * Pick a Soul policy without letting an overlapping Creative flag reopen raw notes during a story.
 * PURE and exported so the worker's otherwise-inaccessible routing matrix stays regression-tested.
 */
export function selectSoulContextMode(input: {
  storyActive?: boolean;
  creativeIdle?: boolean;
  creativeSession?: boolean;
}): SoulContextMode {
  if (input.storyActive) return "story";
  if (input.creativeIdle || input.creativeSession) return "creative";
  return "ordinary";
}

/** Conservative default for one raw-source pass; the worker lowers/raises it to the active context. */
export const SOUL_DISTILLATION_SOURCE_CHUNK_CHARS = 6_000;
/** Citation-heavy leaf JSON stays reliable even when hundreds of very short notes fit by characters. */
export const SOUL_DISTILLATION_MAX_NOTES_PER_CHUNK = 32;

/**
 * A small deterministic non-cryptographic hash. It is used for cache coherency/evidence labels, not
 * security. Keeping it synchronous also makes the core usable in browser and worker prompt paths
 * without WebCrypto setup.
 */
function soulHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    hash ^= BigInt(code & 0xff);
    hash = BigInt.asUintN(64, hash * prime);
    hash ^= BigInt(code >>> 8);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

/** Stable evidence labels for the current source notes. PURE. */
export function soulNoteSources(notes: readonly SoulNote[]): SoulEssenceSource[] {
  const seen = new Map<string, number>();
  return notes.map((note) => {
    const at = Number.isFinite(note.at) ? note.at : 0;
    const base = `sn_${soulHash(JSON.stringify([note.text, at]))}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return {
      id: occurrence === 1 ? base : `${base}_${occurrence}`,
      text: note.text,
      at,
    };
  });
}

/** Changes for any source-note edit, reorder, addition, removal, or timestamp refresh. PURE. */
export function soulSourceFingerprint(notes: readonly SoulNote[]): string {
  const canonical = notes.map((note) => [
    note.text,
    Number.isFinite(note.at) ? note.at : 0,
  ]);
  return `soul-v${SOUL_ESSENCE_SCHEMA_VERSION}-${soulHash(JSON.stringify(canonical))}`;
}

/**
 * Partition without truncating any source note. Oversized individual notes remain intact in their
 * own chunk; the per-note store cap keeps that worst case bounded. PURE.
 */
export function partitionSoulNotes(
  notes: readonly SoulNote[],
  budget = SOUL_DISTILLATION_SOURCE_CHUNK_CHARS,
  maxNotes = SOUL_DISTILLATION_MAX_NOTES_PER_CHUNK,
): SoulNote[][] {
  if (notes.length === 0) return [];
  const sources = soulNoteSources(notes);
  const chunks: SoulNote[][] = [];
  let current: SoulNote[] = [];
  let used = 2; // JSON array brackets
  for (let index = 0; index < notes.length; index++) {
    const cost = JSON.stringify(sources[index]).length + (current.length ? 1 : 0);
    if (
      current.length > 0 &&
      (used + cost > Math.max(1, budget) || current.length >= Math.max(1, maxNotes))
    ) {
      chunks.push(current);
      current = [];
      used = 2;
    }
    current.push(notes[index]!);
    used += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function soulSourcesForPersonalityDistillation(
  notes: readonly SoulNote[],
): SoulEssenceSource[] {
  const sources = soulNoteSources(notes);
  const projection = reconcileSoulAppearance(notes);
  const accounted = new Set(projection.accountedSourceIds);
  return sources.flatMap((source) => {
    const nonVisual = projection.nonVisualTextBySourceId[source.id]?.trim();
    if (nonVisual) return [{ ...source, text: nonVisual }];
    return accounted.has(source.id) ? [] : [source];
  });
}

function essenceJsonShape(kind: SoulKind, sourceFingerprint: string): string {
  return `{"schemaVersion":${SOUL_ESSENCE_SCHEMA_VERSION},"kind":"${kind}","sourceFingerprint":"${sourceFingerprint}","generalizedEssence":{"text":"","sourceIds":[]},"facets":{"coreDisposition":{"text":"","sourceIds":[]},"conversationalVoice":{"text":"","sourceIds":[]},"thinkingStyle":{"text":"","sourceIds":[]},"valuesAndMotivations":{"text":"","sourceIds":[]},"relationalStyle":{"text":"","sourceIds":[]},"personalityDirections":{"text":"","sourceIds":[]},"tensionsAndNuance":{"text":"","sourceIds":[]}},"exactAppearance":[]}`;
}

/** Provider-safe structured-output shape for a Soul Essence. Keep semantic constraints (length,
 * evidence coverage, exact empty appearance) in the validator/prompt: several cloud structured-output
 * APIs reject otherwise-valid JSON Schema keywords such as maxLength, maxItems, and uniqueItems. */
export function soulEssenceJsonSchema(
  kind: SoulKind,
  sourceFingerprint: string,
  sourceIds: readonly string[] = [],
): Record<string, unknown> {
  const sourceId = {
    type: "string",
    ...(sourceIds.length > 0 ? { enum: [...sourceIds] } : {}),
  };
  const facet = {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string" },
      sourceIds: {
        type: "array",
        items: sourceId,
      },
    },
    required: ["text", "sourceIds"],
  };
  const facets = Object.fromEntries(
    SOUL_ESSENCE_FACETS.map((key) => [key, facet]),
  );
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      schemaVersion: { type: "integer", enum: [SOUL_ESSENCE_SCHEMA_VERSION] },
      kind: { type: "string", enum: [kind] },
      sourceFingerprint: { type: "string", enum: [sourceFingerprint] },
      generalizedEssence: facet,
      facets: {
        type: "object",
        additionalProperties: false,
        properties: facets,
        required: Object.keys(facets),
      },
      exactAppearance: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            sourceIds: { type: "array", items: sourceId },
          },
          required: ["text", "sourceIds"],
        },
      },
    },
    required: [
      "schemaVersion",
      "kind",
      "sourceFingerprint",
      "generalizedEssence",
      "facets",
      "exactAppearance",
    ],
  };
}

/**
 * Prompts an LLM to integrate ALL current source notes into a compact latent identity. The model is
 * required to cite source IDs; parsing below refuses stale fingerprints and invented IDs.
 */
export function buildSoulEssenceDistillationPrompt(
  kind: SoulKind,
  notes: readonly SoulNote[],
): SoulEssenceDistillationPrompt {
  const sourceFingerprint = soulSourceFingerprint(notes);
  const subject = kind === "self" ? "the assistant's own identity" : "the reader's identity";
  const system = [
    `Distill ${subject} from the complete authoritative Soul-note set into a concise, integrated Soul Essence.`,
    "Treat the notes as evidence, not as a list of subjects to mention. Infer what their combination means for the person.",
    "Interests, memorable thoughts, and anecdotes should shape broad disposition, values, and thinking style; do not make their specific examples into recurring topics.",
    `Write generalizedEssence as one portable higher-order identity of at most ${MAX_SOUL_GENERALIZED_ESSENCE_CHARS} characters: one short sentence or 1-6 brief qualities/tendencies.`,
    "generalizedEssence describes transferable behavior toward ideas, people, and uncertainty. Do not include names, named interests, technologies, hobbies, places, events, anecdotes, quotations, physical details, explicit instructions, or an inventory of the supporting notes.",
    "Translate specifics upward: for example, several technical interests may support 'intellectually curious'; their subjects do not belong in generalizedEssence.",
    "Cite only the strongest directly supporting source IDs in generalizedEssence. Complete source coverage belongs in the support facets below, not in the standing essence.",
    "Preserve meaningful tensions instead of flattening contradictions.",
    "Return personalityDirections with empty text and sourceIds. Deterministic source validation restores explicit behavioral directions verbatim, so never paraphrase, weaken, or invert them here.",
    "Do not invent facts. Every non-empty facet must cite one or more supplied source IDs that directly support it.",
    "Every supplied source ID other than an explicit behavioral direction must remain covered in at least one facet it informed. Appearance-only and superseded visual sources have already been removed and are accounted deterministically; do not reconstruct or infer them.",
    "Return exactAppearance as an empty array. Deterministic source validation restores exact physical clauses directly from the authoritative notes, so never summarize or paraphrase appearance here.",
    `Keep every facet at or below ${MAX_SOUL_ESSENCE_FACET_CHARS} characters. Synthesize in natural third-person fragments; do not quote or enumerate examples.`,
    "Return strict JSON only: no markdown fence, preamble, comments, or trailing commas.",
    "Use exactly this shape:",
    essenceJsonShape(kind, sourceFingerprint),
  ].join("\n");
  const user = [
    `Kind: ${kind}`,
    `Source fingerprint (copy exactly): ${sourceFingerprint}`,
    "Personality-relevant authoritative source clauses (use every supplied item; IDs are evidence citations):",
    JSON.stringify(soulSourcesForPersonalityDistillation(notes)),
  ].join("\n");
  return { system, user, sourceFingerprint };
}

function sourceIdentity(source: Pick<SoulEssenceSource, "text" | "at">): string {
  return JSON.stringify([source.text, source.at]);
}

function rebaseSoulDigestFacets(
  notes: readonly SoulNote[],
  digests: readonly SoulEssenceDigestInput[],
): SoulEssenceFacets[] {
  const fullSources = soulNoteSources(notes);
  const fullIdsByIdentity = new Map<string, string[]>();
  for (const source of fullSources) {
    const identity = sourceIdentity(source);
    const ids = fullIdsByIdentity.get(identity) ?? [];
    ids.push(source.id);
    fullIdsByIdentity.set(identity, ids);
  }
  return digests.map((digest) => {
    const partialSources = soulNoteSources(digest.notes);
    const idMap = new Map<string, string>();
    for (const source of partialSources) {
      const ids = fullIdsByIdentity.get(sourceIdentity(source));
      idMap.set(source.id, ids?.shift() ?? source.id);
    }
    return Object.fromEntries(
      SOUL_ESSENCE_FACETS.map((key) => [
        key,
        {
          text: digest.essence.facets[key].text,
          sourceIds: digest.essence.facets[key].sourceIds.map((id) => idMap.get(id) ?? id),
        },
      ]),
    ) as SoulEssenceFacets;
  });
}

/**
 * Merge already-grounded chunk essences without resending the long raw notes. Evidence IDs are
 * restored deterministically after the model combines the bounded facet texts. That keeps a large
 * Soul's hundreds of opaque evidence IDs out of both the merge input and its generated JSON. PURE.
 */
export function buildSoulEssenceMergePrompt(
  kind: SoulKind,
  notes: readonly SoulNote[],
  digests: readonly SoulEssenceDigestInput[],
): SoulEssenceDistillationPrompt {
  const sourceFingerprint = soulSourceFingerprint(notes);
  const digestTexts = digests.map((digest) => ({
    generalizedEssence: digest.essence.generalizedEssence.text,
    facets: Object.fromEntries(
      SOUL_ESSENCE_FACETS.map((key) => [key, digest.essence.facets[key].text]),
    ),
  }));
  const system = [
    `Merge the evidence-linked chunk digests into one concise Soul Essence for ${kind === "self" ? "the assistant" : "the reader"}.`,
    "This is synthesis of existing grounded digests, not a chance to add facts. Preserve tensions and combine overlapping ideas.",
    "Specific anecdotes, interests, and profound-thought examples must shape broad facets without becoming recurring subjects.",
    `Re-derive generalizedEssence as one portable higher-order identity of at most ${MAX_SOUL_GENERALIZED_ESSENCE_CHARS} characters: one short sentence or 1-6 brief qualities/tendencies.`,
    "Strip names, named interests, technologies, hobbies, places, events, anecdotes, quotations, physical details, explicit directions, and inventory wording from generalizedEssence. Translate their combined pattern into broadly applicable qualities.",
    "Keep every support facet that is non-empty in any chunk non-empty in the merged result, and preserve its combined meaning in that same support facet. Those facets retain detail for grounding; generalizedEssence must not repeat the dossier.",
    "Return every sourceIds array empty. The caller deterministically restores the already-validated evidence links by facet; do not spend output copying opaque IDs.",
    "Return personalityDirections with empty text and sourceIds. Personality directions are restored source-exact after this synthesis, so never invert, weaken, or embellish them.",
    "Return exactAppearance as an empty array; deterministic validation restores exact visual clauses from their authoritative notes.",
    `Keep every facet at or below ${MAX_SOUL_ESSENCE_FACET_CHARS} characters.`,
    "Return strict JSON only: no markdown fence, preamble, comments, or trailing commas.",
    `Use exactly this shape: ${essenceJsonShape(kind, sourceFingerprint)}`,
  ].join("\n");
  const user = [
    `Combined source fingerprint (copy exactly): ${sourceFingerprint}`,
    "Grounded chunk digests:",
    JSON.stringify(digestTexts),
  ].join("\n");
  return { system, user, sourceFingerprint };
}

/** Minimal final-pass grammar: support facets are already validated and never need to be rewritten. */
export function soulEssenceAbstractionJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      generalizedEssence: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          supportFacetKeys: {
            type: "array",
            items: { type: "string", enum: [...SOUL_GENERALIZABLE_FACETS] },
          },
        },
        required: ["text", "supportFacetKeys"],
      },
    },
    required: ["generalizedEssence"],
  };
}

/**
 * Always run one final abstraction over the grounded integrated digest, including for a one-chunk
 * Soul. It returns only the portable standing identity; callers carry the validated support/evidence
 * index and exact invariants forward without asking a small model to echo a large JSON document.
 */
export function buildSoulEssenceAbstractionPrompt(
  kind: SoulKind,
  notes: readonly SoulNote[],
  integrated: SoulEssence,
): SoulEssenceDistillationPrompt {
  const sourceFingerprint = soulSourceFingerprint(notes);
  const subject = kind === "self" ? "the assistant" : "the reader";
  const support = Object.fromEntries(
    SOUL_ESSENCE_FACETS
      .filter((key) => key !== "personalityDirections")
      .map((key) => [key, integrated.facets[key].text]),
  );
  const system = [
    `Derive ${subject}'s final generalizedEssence from the already-grounded support synthesis.`,
    `Return 1-${MAX_SOUL_GENERALIZED_TRAITS} portable higher-order trait phrases, separated by semicolons, with at most ${MAX_SOUL_GENERALIZED_TRAIT_WORDS} words per phrase and ${MAX_SOUL_GENERALIZED_ESSENCE_CHARS} characters total.`,
    "Prefer the fewest plain traits that preserve the person's overall pattern. Example: intellectually curious; reflective; warmly independent.",
    "Describe transferable behavior toward ideas, people, and uncertainty.",
    "Strip names, named interests, technologies, hobbies, places, events, anecdotes, quotations, physical details, explicit directions, and inventory wording. Translate their combined pattern upward into broadly applicable qualities.",
    "Do not try to preserve every support detail in this field. The caller retains the complete grounded facets, exact appearance, exact directions, and evidence links separately.",
    "Set supportFacetKeys to only the grounded support categories that directly informed the chosen traits. Use only the supplied category names; do not select an empty category.",
    "Use only broad personality or behavioral trait vocabulary. Concrete topic words and acronyms are rejected even when they are short.",
    `The complete accepted word vocabulary is: ${SOUL_GENERALIZED_TRAIT_VOCABULARY.join(", ")}.`,
    "Every word in generalizedEssence.text must come from that list. Use the listed base form rather than an unlisted synonym or inflection.",
    'Return strict JSON only in exactly this shape: {"generalizedEssence":{"text":"","supportFacetKeys":[]}}',
  ].join("\n");
  const user = [
    `Kind: ${kind}`,
    `Combined source fingerprint: ${sourceFingerprint}`,
    "Grounded support synthesis:",
    JSON.stringify(support),
  ].join("\n");
  return { system, user, sourceFingerprint };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidates = [trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const record = objectRecord(parsed);
      if (record) return record;
    } catch {
      try {
        const parsed = JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1")) as unknown;
        const record = objectRecord(parsed);
        if (record) return record;
      } catch {
        // Try the next tolerant envelope.
      }
    }
  }
  return undefined;
}

/** Model-only envelope parse: storage remains strict and is never silently reconstructed. */
function parseGeneratedJsonObject(raw: string): Record<string, unknown> | undefined {
  const parsed = parseJsonObject(raw);
  if (parsed) return parsed;
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  // A local model can hit its response ceiling after completing the whole required shape but before
  // writing the final brackets. Close only fully emitted values; required-facet validation below
  // rejects a repair that stopped before the complete semantic payload arrived.
  const repaired = repairTruncatedJson(trimmed);
  if (repaired) {
    try {
      const parsed = JSON.parse(repaired) as unknown;
      const record = objectRecord(parsed);
      if (record) return record;
    } catch {
      // A cutoff inside a string/key is intentionally not guessed at.
    }
  }
  return undefined;
}

function cleanEvidenceIds(value: unknown, knownIds: ReadonlySet<string>): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !knownIds.has(item)) return undefined;
    if (!ids.includes(item)) ids.push(item);
  }
  return ids;
}

function cleanFacet(value: unknown, knownIds: ReadonlySet<string>): SoulEssenceFacet | undefined {
  if (value === undefined || value === null) return { text: "", sourceIds: [] };
  const record = objectRecord(value);
  if (!record) return undefined;
  const rawText = typeof record.text === "string"
    ? record.text
    : typeof record.summary === "string"
      ? record.summary
      : "";
  const text = rawText.trim().slice(0, MAX_SOUL_ESSENCE_FACET_CHARS);
  const sourceIds = cleanEvidenceIds(record.sourceIds ?? record.evidence, knownIds);
  if (!sourceIds) {
    return text ? undefined : { text: "", sourceIds: [] };
  }
  if (text && sourceIds.length === 0) return undefined;
  return { text, sourceIds: text ? sourceIds : [] };
}

/**
 * Exact free-text vocabulary accepted by the final abstraction validator. Keep this exported and
 * present it verbatim to the model: a local model cannot comply with a hidden allowlist.
 */
export const SOUL_GENERALIZED_TRAIT_VOCABULARY = [
    "accepting", "adaptable", "adventurous", "analytical", "assertive", "attentive",
    "affectionate", "attuned", "authentic", "autonomous", "aware", "balanced", "ambitious", "bold",
    "brave", "calm", "candid", "careful", "caring", "cautious", "collaborative",
    "comfortable", "community", "connected", "connection",
    "compassionate", "confident", "conscientious", "considerate", "contemplative",
    "cooperative", "competitive", "creative", "curiosity", "curious", "decisive",
    "courageous", "deliberate", "dependable", "depth", "diplomatic", "diligent",
    "direct", "discerning", "disciplined",
    "driven", "empathetic", "empathetically", "emotional", "emotionally", "energetic",
    "epistemic", "epistemically", "equitable", "ethical", "ethically", "earnest",
    "experimental", "exploratory", "expressive", "extroverted", "fair", "fairness", "flexible",
    "focused", "forgiving", "forthright", "generous", "gentle", "grounded", "honest", "hopeful",
    "humorous",
    "growth", "humble", "idealistic", "ideas", "imaginative", "independent",
    "independently", "inquisitive", "insightful", "intelligent", "intellectual",
    "intellectually", "introspective", "introverted", "intuitive", "inventive", "irreverent", "justice",
    "kind", "logical", "loving", "loyal", "methodical", "mindful", "moral", "morally", "minded",
    "meaning", "merciful", "modest", "nuanced", "observant", "open", "optimistic",
    "nonconformist", "oriented", "outgoing", "patient", "people", "private",
    "passionate", "perceptive", "persistent", "philosophical", "playful", "practical",
    "pragmatic", "precise", "principled", "protective", "questioning", "rational",
    "realistic", "receptive", "reflective", "relational", "reserved", "resilient",
    "resourceful", "rigorous",
    "self", "sensitive", "serene", "serious", "sincere", "skeptical", "socially", "spiritual",
    "spiritually", "spontaneous", "steady", "stoic", "strategic", "supportive", "systems",
    "tactful", "tenacious", "thinking", "thoughtful", "tolerant", "truth", "trusting",
    "trustworthy", "uncertainty", "unconventional", "warm", "warmly", "witty",
    "and", "but", "deeply", "gently", "quietly", "seeking", "selectively", "strongly",
    "with", "yet",
  ] as const;
const GENERIC_SOUL_ESSENCE_WORDS = new Set<string>(
  SOUL_GENERALIZED_TRAIT_VOCABULARY,
);

function generalizedEssenceWords(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/[-‐‑‒–—]/gu, " ")
      .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []
  );
}

/**
 * Enforce the part a weak local model cannot be trusted to self-police: the final result must be a
 * tiny list of abstract traits, not source-topic prose that merely fits inside the character cap.
 */
export function soulGeneralizedEssenceIssue(
  text: string,
): string | undefined {
  const value = text.replace(/\s+/g, " ").trim().replace(/[.!?]+$/u, "");
  if (!value) return undefined;
  if (value.length > MAX_SOUL_GENERALIZED_ESSENCE_CHARS) {
    return `generalizedEssence.text is ${value.length} characters; shorten it to at most ${MAX_SOUL_GENERALIZED_ESSENCE_CHARS}.`;
  }
  if (/[\r\n,|•]/u.test(value)) {
    return "Use semicolons between plain trait phrases; do not return prose, bullets, or comma-separated inventory.";
  }
  if (/[\d@#()[\]{}"“”/:\\]/u.test(value) || /\bhttps?:\b/iu.test(value)) {
    return "Remove names, numbers, quotations, links, labels, and other source-level details.";
  }
  if (
    /\b(?:about|regarding|interested in|focused on|driven by|curiosity (?:for|about)|passion for|love of|knowledge of|experience with|all things)\b/iu.test(
      value,
    )
  ) {
    return "Use standalone higher-order traits, not interests, subject areas, or dossier-style explanations.";
  }
  const traits = value.split(";").map((trait) => trait.trim()).filter(Boolean);
  if (traits.length === 0 || traits.length > MAX_SOUL_GENERALIZED_TRAITS) {
    return `Return 1-${MAX_SOUL_GENERALIZED_TRAITS} brief trait phrases separated by semicolons.`;
  }
  for (const trait of traits) {
    const words = generalizedEssenceWords(trait);
    if (words.length === 0 || words.length > MAX_SOUL_GENERALIZED_TRAIT_WORDS) {
      return `Keep each generalized trait to at most ${MAX_SOUL_GENERALIZED_TRAIT_WORDS} words.`;
    }
  }
  const nonGeneralWords = generalizedEssenceWords(value).filter(
    (word) => !GENERIC_SOUL_ESSENCE_WORDS.has(word),
  );
  if (nonGeneralWords.length > 0) {
    return (
      "Replace source-specific wording with broad personality or behavioral traits; non-general terms: " +
      JSON.stringify([...new Set(nonGeneralWords)]) +
      "."
    );
  }
  return undefined;
}

function cleanGeneralizedEssence(
  value: unknown,
  knownIds: ReadonlySet<string>,
): SoulEssenceFacet | undefined {
  const record = objectRecord(value);
  if (!record || typeof record.text !== "string") return undefined;
  const text = record.text.replace(/\s+/g, " ").trim();
  if (text.length > MAX_SOUL_GENERALIZED_ESSENCE_CHARS) return undefined;
  const sourceIds = cleanEvidenceIds(record.sourceIds ?? record.evidence, knownIds);
  if (!sourceIds) return undefined;
  if (text && sourceIds.length === 0) return undefined;
  return { text, sourceIds: text ? sourceIds : [] };
}

function cleanExactAppearance(
  value: unknown,
  notes: readonly SoulNote[],
  sources: readonly SoulEssenceSource[],
): SoulEssenceAppearanceFact[] | undefined {
  if (value !== undefined && !Array.isArray(value)) return undefined;
  const projection = reconcileSoulAppearance(notes);
  const canonical = projection.activeFacts;
  const knownIds = new Set(sources.map((source) => source.id));
  // Stored values are derived cache data, but still reject invented/paraphrased facts rather than
  // silently legitimising them. A missing/subset value is harmless: the current projection below
  // deterministically restores every active source-exact fact.
  for (const item of (value ?? []) as unknown[]) {
    const record = objectRecord(item);
    if (!record || typeof record.text !== "string") return undefined;
    const text = record.text.trim();
    const sourceIds = cleanEvidenceIds(record.sourceIds ?? record.evidence, knownIds);
    if (!text || !sourceIds?.length) return undefined;
    const slot = typeof record.slot === "string" ? record.slot : undefined;
    const fact = canonical.find(
      (candidate) =>
        candidate.text === text &&
        (slot !== undefined
          ? candidate.slot === slot
          : sourceIds.every((sourceId) => candidate.sourceIds.includes(sourceId))),
    );
    if (!fact || sourceIds.some((sourceId) => !fact.sourceIds.includes(sourceId))) return undefined;
  }
  return canonical;
}

const PERSONALITY_DIRECTION_WORDS =
  /(?:\b(?:strives? to|aspires? to|trying to become|wants? to become|personality direction|direction:|instruction:|(?:always|never) (?:be|stay|keep|speak|respond|act|behave|write|challenge|avoid|prefer|question|push|encourage|admit|acknowledge|flatter|agree)|do not (?:be|stay|keep|speak|respond|act|behave|write|flatter|agree|avoid|hide|pretend)|don't (?:be|stay|keep|speak|respond|act|behave|write|flatter|agree|avoid|hide|pretend)|portray(?:ed)? (?:me|them|the reader|the assistant) as)\b|(?:^|[.!]\s*)(?:please\s+)?(?:should|must|ought to|need(?:s)? to)\b|\b(?:you|i|the assistant|assistant|the reader|reader|responses?|answers?|tone|voice|personality|portrayal)\s+(?:should|must|ought to|need(?:s)? to)\b|\b(?:i\s+want|i(?:['’]d| would)\s+like)\s+(?:you|the assistant|assistant|the ai)\s+to\s+(?:be|become|stay|keep|speak|respond|act|behave|write|challenge|avoid|prefer|question|push|encourage|admit|acknowledge|portray)\b)/i;
const PERSONALITY_DIRECTION_IMPERATIVE =
  /^(?:please\s+)?(?:be|become|speak|respond|act|behave|write|avoid|challenge|portray|keep|do not|don't|stay|prefer|question|push|encourage|admit|acknowledge)\b/i;

function isPersonalityDirectionNote(text: string): boolean {
  const trimmed = text.trim();
  if (
    trimmed.endsWith("?") &&
    !/\b(?:personality direction|direction:|instruction:)\b/i.test(trimmed)
  ) {
    return false;
  }
  return (
    PERSONALITY_DIRECTION_WORDS.test(trimmed) ||
    PERSONALITY_DIRECTION_IMPERATIVE.test(trimmed)
  );
}

function personalityDirectionClauses(text: string): string[] {
  const clauses = text
    .split(/\s*(?:;|\r?\n)\s*|(?<=[.!?])\s+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const exact = clauses.filter(isPersonalityDirectionNote);
  return exact.length > 0 ? exact : isPersonalityDirectionNote(text) ? [text.trim()] : [];
}

function personalityDirectionSourceIds(
  notes: readonly SoulNote[],
  sources: readonly SoulEssenceSource[],
): string[] {
  return notes.flatMap((note, index) =>
    personalityDirectionClauses(note.text).length > 0
      ? [sources[index]!.id]
      : [],
  );
}

function exactPersonalityDirections(
  notes: readonly SoulNote[],
  sources: readonly SoulEssenceSource[],
): SoulEssenceDirectionFact[] {
  return notes.flatMap((note, index) => {
    return personalityDirectionClauses(note.text).map((text) => ({
      text,
      sourceIds: [sources[index]!.id],
    }));
  });
}

function boundedExactTexts(texts: readonly string[], budget: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) continue;
    const cost = text.length + (kept.length ? 2 : 0);
    if (used + cost <= budget) {
      kept.push(text);
      used += cost;
      continue;
    }
    if (kept.length === 0 && budget > 0) {
      const prefix = text.slice(0, budget + 1).replace(/\s+\S*$/, "").replace(/[;,:\s]+$/, "");
      return prefix || text.slice(0, budget);
    }
  }
  return kept.join("; ");
}

type SoulAppearanceValidationFact = Pick<SoulAppearanceContribution, "slot" | "text">;

function soulAppearanceValidationFacts(
  notes: readonly SoulNote[],
  sources: readonly SoulEssenceSource[],
): SoulAppearanceValidationFact[] {
  return notes.flatMap((note, index) =>
    analyseAppearanceNote(note, sources[index]!, index).contributions.map(
      ({ slot, text }) => ({ slot, text }),
    ),
  );
}

const APPEARANCE_SLOT_ANCHORS: Readonly<Record<string, RegExp>> = {
  eyes: /\b(?:eye|eyes|eyed|iris|irises|pupil|pupils)\b/i,
  hair: /\b(?:hair|haired|braid|braids|curl|curls|loc|locs|ponytail|bun|bald|shaved)\b/i,
  skin: /\b(?:skin|skinned|complexion)\b/i,
  face: /\b(?:face|facial|jaw|chin|cheek|cheekbone|nose|lip|mouth|teeth|dimple)\b/i,
  mark: /\b(?:mark|scar|tattoo|birthmark|piercing|freckle|burn|vitiligo)\b/i,
  feature: /\b(?:feature|wing|horn|antler|tail|pointed ears?|scale|fur|feather|fang|claw|hoof|antenna|tentacle|fin|gill|halo|prosthetic|cybernetic)\b/i,
  accessory: /\b(?:accessor|glasses|spectacles|mask|hat|cap|hood|scarf|glove|necklace|bracelet|earring|ring|jewellery|jewelry)\b/i,
  clothing: /\b(?:clothing|clothes|outfit|coat|jacket|cloak|robe|dress|gown|armour|armor|uniform|shirt|tunic|trousers|jeans|boots|shoes)\b/i,
  age: /\b(?:age|aged|years? old|teen|twenties|thirties|forties|fifties|sixties|seventies|eighties|middle aged|elderly)\b/i,
  gender: /\b(?:gender|woman|man|female|male|nonbinary|androgynous)\b/i,
  ethnicity: /\b(?:ethnicity|race|racial|afro latina|latina|latino|asian|indigenous|middle eastern|african|european|hispanic|mixed race)\b/i,
  height: /\b(?:height|stature|feet|foot|inches|centimetres|centimeters|meters|metres|tall (?:person|woman|man|figure)|short (?:person|woman|man|figure))\b/i,
  weight: /\b(?:weight|weighs?|pounds?|lbs?|kilograms?|kgs?)\b/i,
  build: /\b(?:build|body|frame|physique|shoulders?)\b/i,
  species: /\b(?:species|human|android|robot|cyborg|elf|fae|fairy|demon|angel|alien|dragon|vampire|werewolf)\b/i,
  appearance: /\b(?:appearance|physical|look|looks)\b/i,
};

function appearanceSlotAnchoredInText(slot: string, normalized: string): boolean {
  const family = slot.split(/[.:]/, 1)[0] ?? "";
  return APPEARANCE_SLOT_ANCHORS[family]?.test(normalized) ?? false;
}

const UNAMBIGUOUS_PHYSICAL_COMPOUND =
  /\b(?:black|white|gr[ae]y|brown|blond(?:e)?|auburn|red|ginger|silver|gold(?:en)?|blue|green|hazel|amber|violet|purple|pink|teal|turquoise|copper|crimson|scarlet|orange|olive|tan(?:ned)?|pale|ivory|ebony|bronze|multicolou?red)[ -](?:eyed|haired|skinned)\b/i;

function facetRepeatsSourceAppearance(
  text: string,
  facts: readonly SoulAppearanceValidationFact[],
): boolean {
  if (UNAMBIGUOUS_PHYSICAL_COMPOUND.test(text)) return true;
  const normalized = normalizedAppearanceKey(text);
  if (!normalized) return false;
  const padded = ` ${normalized} `;
  return facts.some((fact) => {
    const exact = normalizedAppearanceKey(fact.text);
    if (!exact || !padded.includes(` ${exact} `)) return false;
    // Preserve high-confidence phrase matching, but require semantic context for short values such
    // as "blue" and "32" so idioms and unrelated prose do not trigger a repair loop.
    return (
      exact.length >= 6 ||
      normalized === exact ||
      appearanceSlotAnchoredInText(fact.slot, normalized)
    );
  });
}

function normaliseSoulEssence(
  value: unknown,
  kind: SoulKind,
  notes: readonly SoulNote[],
  generatedAtOverride?: number,
): SoulEssence | undefined {
  const envelope = objectRecord(value);
  const record = objectRecord(envelope?.essence) ?? envelope;
  if (!record) return undefined;
  if (record.schemaVersion !== SOUL_ESSENCE_SCHEMA_VERSION || record.kind !== kind) return undefined;
  if (record.sourceFingerprint !== soulSourceFingerprint(notes)) return undefined;

  const sources = soulNoteSources(notes);
  const knownIds = new Set(sources.map((source) => source.id));
  const appearanceProjection = reconcileSoulAppearance(notes);
  const appearanceValidationFacts = soulAppearanceValidationFacts(notes, sources);
  const appearanceOnlyIds = new Set(
    appearanceProjection.accountedSourceIds.filter(
      (id) => !appearanceProjection.nonVisualTextBySourceId[id],
    ),
  );
  const rawFacets = objectRecord(record.facets);
  if (!rawFacets) return undefined;
  const rawGeneralizedEssence = cleanGeneralizedEssence(record.generalizedEssence, knownIds);
  if (!rawGeneralizedEssence) return undefined;
  const generalizedEssence = {
    ...rawGeneralizedEssence,
    sourceIds: rawGeneralizedEssence.sourceIds.filter((id) => !appearanceOnlyIds.has(id)),
  };
  if (
    generalizedEssence.text &&
    (
      generalizedEssence.sourceIds.length === 0 ||
      facetRepeatsSourceAppearance(generalizedEssence.text, appearanceValidationFacts)
    )
  ) return undefined;

  const facets = {} as SoulEssenceFacets;
  for (const key of SOUL_ESSENCE_FACETS) {
    // Explicit behavioral instructions never cross a generative trust boundary. Ignore even
    // malformed or invented model output in this slot; source-exact facts replace it below.
    if (key === "personalityDirections") {
      facets[key] = { text: "", sourceIds: [] };
      continue;
    }
    const facet = cleanFacet(rawFacets[key], knownIds);
    if (!facet) return undefined;
    const sourceIds = facet.sourceIds.filter((id) => !appearanceOnlyIds.has(id));
    if (
      facet.text &&
      (
        sourceIds.length === 0 ||
        facetRepeatsSourceAppearance(facet.text, appearanceValidationFacts)
      )
    ) {
      return undefined;
    }
    facets[key] = { text: facet.text, sourceIds };
  }
  const exactAppearance = cleanExactAppearance(record.exactAppearance, notes, sources);
  if (!exactAppearance) return undefined;
  const exactDirections = exactPersonalityDirections(notes, sources);
  // Never trust a generated paraphrase for an explicit behavioral direction: even a grounded model
  // can accidentally weaken "never agree reflexively" into its opposite. The synthesis slot is
  // canonicalized from source-exact text, while the complete facts remain separately retrievable.
  facets.personalityDirections = exactDirections.length
    ? {
        text: boundedExactTexts(
          exactDirections.map((fact) => fact.text),
          MAX_SOUL_ESSENCE_FACET_CHARS,
        ),
        sourceIds: [...new Set(exactDirections.flatMap((fact) => fact.sourceIds))],
      }
    : { text: "", sourceIds: [] };

  const supportFacetKeys = SOUL_ESSENCE_FACETS.filter(
    (key) => key !== "personalityDirections",
  );
  const hasGeneralizableSynthesis = supportFacetKeys.some((key) => !!facets[key].text);
  if (hasGeneralizableSynthesis !== !!generalizedEssence.text) return undefined;
  const generalizedSupportIds = new Set(
    supportFacetKeys.flatMap((key) => facets[key].sourceIds),
  );
  if (
    generalizedEssence.sourceIds.some((id) => !generalizedSupportIds.has(id))
  ) {
    return undefined;
  }
  const hasSynthesis =
    !!generalizedEssence.text ||
    SOUL_ESSENCE_FACETS.some((key) => !!facets[key].text);
  if (
    notes.length > 0 &&
    !hasSynthesis &&
    exactAppearance.length === 0 &&
    appearanceProjection.accountedSourceIds.length === 0
  ) return undefined;
  const citedSourceIds = new Set([
    ...generalizedEssence.sourceIds,
    ...SOUL_ESSENCE_FACETS.flatMap((key) => facets[key].sourceIds),
    ...exactAppearance.flatMap((fact) => fact.sourceIds),
    ...exactDirections.flatMap((fact) => fact.sourceIds),
    ...appearanceProjection.accountedSourceIds.filter(
      (id) => !appearanceProjection.nonVisualTextBySourceId[id],
    ),
  ]);
  if (sources.some((source) => !citedSourceIds.has(source.id))) return undefined;
  const semanticCitedSourceIds = new Set([
    ...generalizedEssence.sourceIds,
    ...SOUL_ESSENCE_FACETS.flatMap((key) => facets[key].sourceIds),
    ...exactDirections.flatMap((fact) => fact.sourceIds),
  ]);
  if (
    Object.keys(appearanceProjection.nonVisualTextBySourceId).some(
      (id) => !semanticCitedSourceIds.has(id),
    )
  ) return undefined;
  const directionSourceIds = personalityDirectionSourceIds(notes, sources);
  if (
    directionSourceIds.length > 0 &&
    (
      !facets.personalityDirections.text ||
      directionSourceIds.some((id) => !facets.personalityDirections.sourceIds.includes(id))
    )
  ) {
    return undefined;
  }

  const storedGeneratedAt = typeof record.generatedAt === "number" && Number.isFinite(record.generatedAt)
    ? record.generatedAt
    : undefined;
  return {
    schemaVersion: SOUL_ESSENCE_SCHEMA_VERSION,
    kind,
    sourceFingerprint: soulSourceFingerprint(notes),
    generatedAt: generatedAtOverride ?? storedGeneratedAt ?? Date.now(),
    generalizedEssence,
    facets,
    exactAppearance,
    exactPersonalityDirections: exactDirections,
  };
}

/** Validate an already-parsed essence against the current authoritative SoulNote[]. PURE. */
export function validateSoulEssence(
  value: unknown,
  kind: SoulKind,
  notes: readonly SoulNote[],
): SoulEssence | undefined {
  return normaliseSoulEssence(value, kind, notes);
}

/** Tolerantly unwrap model JSON, then strictly validate its schema, fingerprint, and evidence. PURE. */
export function parseSoulEssence(
  raw: string,
  kind: SoulKind,
  notes: readonly SoulNote[],
  generatedAt?: number,
): SoulEssence | undefined {
  const parsed = parseJsonObject(raw);
  return parsed ? normaliseSoulEssence(parsed, kind, notes, generatedAt) : undefined;
}

/**
 * Parse an untrusted MODEL response.
 *
 * The request already owns kind/version/fingerprint, and the caller verifies that the authoritative
 * notes did not change before saving. Making a small model copy those bookkeeping fields perfectly
 * adds failure modes without adding trust. Generated appearance is likewise ignored completely and
 * reconstructed source-exact by `normaliseSoulEssence`, just like personality directions. Stored
 * essences continue to use the strict `parseSoulEssence` path above.
 */
export function parseGeneratedSoulEssence(
  raw: string,
  kind: SoulKind,
  notes: readonly SoulNote[],
  generatedAt?: number,
): SoulEssence | undefined {
  const parsed = parseGeneratedJsonObject(raw);
  const record = generatedEssenceRecord(parsed);
  if (!record || !hasCompleteGeneratedFacets(record)) return undefined;
  const knownIds = new Set(soulNoteSources(notes).map((source) => source.id));
  const rawFacets = objectRecord(record.facets);
  const rawGeneralized = objectRecord(record.generalizedEssence);
  const generalizedIds = rawGeneralized?.sourceIds ?? rawGeneralized?.evidence;
  const generalizedEssence =
    rawGeneralized && Array.isArray(generalizedIds)
      ? {
          ...rawGeneralized,
          sourceIds: generalizedIds.filter(
            (id): id is string => typeof id === "string" && knownIds.has(id),
          ),
        }
      : record.generalizedEssence;
  const facets = rawFacets
    ? Object.fromEntries(
        Object.entries(rawFacets).map(([key, value]) => {
          const facet = objectRecord(value);
          if (!facet) return [key, value];
          const ids = facet.sourceIds ?? facet.evidence;
          if (!Array.isArray(ids)) return [key, value];
          // A stray invented ID must never enter the essence, but it also need not poison a facet
          // that carries at least one real citation. Unknown-only text still fails below.
          return [
            key,
            {
              ...facet,
              sourceIds: ids.filter(
                (id): id is string => typeof id === "string" && knownIds.has(id),
              ),
            },
          ];
        }),
      )
    : record.facets;
  return normaliseSoulEssence(
    {
      ...record,
      schemaVersion: SOUL_ESSENCE_SCHEMA_VERSION,
      kind,
      sourceFingerprint: soulSourceFingerprint(notes),
      generalizedEssence,
      facets,
      exactAppearance: [],
    },
    kind,
    notes,
    generatedAt,
  );
}

/** Common wrappers emitted by local instruction models despite a top-level-object request. */
function generatedEssenceRecord(
  parsed: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!parsed) return undefined;
  if (objectRecord(parsed.facets)) return parsed;
  for (const key of ["essence", "result", "data", "output"] as const) {
    const nested = objectRecord(parsed[key]);
    if (nested && objectRecord(nested.facets)) return nested;
  }
  return parsed;
}

function hasCompleteGeneratedFacets(record: Record<string, unknown>): boolean {
  const facets = objectRecord(record.facets);
  return (
    !!objectRecord(record.generalizedEssence) &&
    !!facets &&
    SOUL_ESSENCE_FACETS.every((key) => !!objectRecord(facets[key]))
  );
}

/**
 * Explain a failed leaf response in terms a temperature-zero local model can actually correct.
 * This stays strict about invented evidence and uncovered ordinary notes; only bookkeeping and
 * exact-source fields are canonicalized outside the model.
 */
export function soulEssenceRepairFeedback(
  raw: string,
  kind: SoulKind,
  notes: readonly SoulNote[],
): string {
  if (parseGeneratedSoulEssence(raw, kind, notes)) return "";
  const parsed = parseGeneratedJsonObject(raw);
  const record = generatedEssenceRecord(parsed);
  if (!record) {
    return "The response was not one complete JSON object with a facets object.";
  }
  const rawFacets = objectRecord(record.facets);
  if (!rawFacets) {
    return "The response did not contain a facets object.";
  }

  const sources = soulNoteSources(notes);
  const knownIds = new Set(sources.map((source) => source.id));
  const appearanceProjection = reconcileSoulAppearance(notes);
  const appearanceValidationFacts = soulAppearanceValidationFacts(notes, sources);
  const pureAppearanceIds = new Set(
    appearanceProjection.accountedSourceIds.filter(
      (id) => !appearanceProjection.nonVisualTextBySourceId[id],
    ),
  );
  const covered = new Set<string>();
  for (const id of pureAppearanceIds) covered.add(id);
  for (let index = 0; index < notes.length; index++) {
    const source = sources[index]!;
    if (personalityDirectionClauses(notes[index]!.text).length > 0) covered.add(source.id);
  }

  const issues: string[] = [];
  const rawGeneralized = objectRecord(record.generalizedEssence);
  const generalizedText =
    typeof rawGeneralized?.text === "string"
      ? rawGeneralized.text.replace(/\s+/g, " ").trim()
      : "";
  const rawGeneralizedIds = rawGeneralized?.sourceIds ?? rawGeneralized?.evidence;
  const validGeneralizedIds = Array.isArray(rawGeneralizedIds)
    ? rawGeneralizedIds.filter(
        (id): id is string => typeof id === "string" && knownIds.has(id),
      )
    : [];
  if (!rawGeneralized) {
    issues.push("generalizedEssence must be an object with text and sourceIds.");
  } else {
    if (typeof rawGeneralized.text !== "string") {
      issues.push("generalizedEssence.text must be a string.");
    } else if (generalizedText.length > MAX_SOUL_GENERALIZED_ESSENCE_CHARS) {
      issues.push(
        `generalizedEssence.text is ${generalizedText.length} characters; shorten it to at most ${MAX_SOUL_GENERALIZED_ESSENCE_CHARS}.`,
      );
    }
    if (!Array.isArray(rawGeneralizedIds)) {
      issues.push("generalizedEssence.sourceIds must be an array.");
    } else {
      const unknownGeneralizedIds = rawGeneralizedIds.filter(
        (id) => typeof id !== "string" || !knownIds.has(id),
      );
      if (unknownGeneralizedIds.length > 0) {
        issues.push(
          "generalizedEssence cites unknown source IDs: " +
            JSON.stringify([...new Set(unknownGeneralizedIds.map(String))]) +
            ".",
        );
      }
      if (generalizedText && validGeneralizedIds.length === 0) {
        issues.push("generalizedEssence has text but no valid source ID.");
      }
    }
  }
  if (
    generalizedText &&
    facetRepeatsSourceAppearance(generalizedText, appearanceValidationFacts)
  ) {
    issues.push(
      "generalizedEssence repeats physical-description text; appearance is reconciled separately.",
    );
  }
  const missingFacetKeys = SOUL_ESSENCE_FACETS.filter(
    (key) => !objectRecord(rawFacets[key]),
  );
  if (missingFacetKeys.length > 0) {
    issues.push(
      `The response is missing complete facet objects for: ${JSON.stringify(missingFacetKeys)}.`,
    );
  }
  for (const key of SOUL_ESSENCE_FACETS) {
    if (key === "personalityDirections") continue;
    const rawFacet = rawFacets[key];
    if (rawFacet === undefined || rawFacet === null) continue;
    const facet = objectRecord(rawFacet);
    if (!facet) {
      issues.push(`facets.${key} must be an object with text and sourceIds.`);
      continue;
    }
    const text =
      typeof facet.text === "string"
        ? facet.text.trim()
        : typeof facet.summary === "string"
          ? facet.summary.trim()
          : "";
    const rawIds = facet.sourceIds ?? facet.evidence;
    if (!Array.isArray(rawIds)) {
      if (text) issues.push(`facets.${key} has text but sourceIds is not an array.`);
      continue;
    }
    const validIds: string[] = [];
    const unknownIds: string[] = [];
    for (const item of rawIds) {
      if (typeof item === "string" && knownIds.has(item) && !pureAppearanceIds.has(item)) validIds.push(item);
      else unknownIds.push(String(item));
    }
    if (unknownIds.length > 0) {
      issues.push(
        `facets.${key} cites unknown source IDs: ${JSON.stringify([...new Set(unknownIds)])}.`,
      );
    }
    if (text && validIds.length === 0) {
      issues.push(`facets.${key} has meaningful text but no valid source ID.`);
    }
    if (text && facetRepeatsSourceAppearance(text, appearanceValidationFacts)) {
      issues.push(`facets.${key} repeats physical-description text; appearance is reconciled separately.`);
    }
    if (text) {
      for (const id of validIds) covered.add(id);
    }
  }

  const hasGeneralizableFacet = SOUL_ESSENCE_FACETS.some(
    (key) =>
      key !== "personalityDirections" &&
      !!(
        typeof objectRecord(rawFacets[key])?.text === "string"
          ? (objectRecord(rawFacets[key])!.text as string).trim()
          : typeof objectRecord(rawFacets[key])?.summary === "string"
            ? (objectRecord(rawFacets[key])!.summary as string).trim()
            : ""
      ),
  );
  if (hasGeneralizableFacet && !generalizedText) {
    issues.push(
      "generalizedEssence is empty even though the support facets contain generalizable identity meaning.",
    );
  } else if (!hasGeneralizableFacet && generalizedText) {
    issues.push(
      "generalizedEssence invents standing personality even though every non-direction support facet is empty.",
    );
  }
  const generalizedSupportIds = new Set<string>();
  for (const key of SOUL_ESSENCE_FACETS) {
    if (key === "personalityDirections") continue;
    const facet = objectRecord(rawFacets[key]);
    const ids = facet?.sourceIds ?? facet?.evidence;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id === "string" && knownIds.has(id)) generalizedSupportIds.add(id);
    }
  }
  const unsupportedGeneralizedIds = validGeneralizedIds.filter(
    (id) => !generalizedSupportIds.has(id),
  );
  if (unsupportedGeneralizedIds.length > 0) {
    issues.push(
      "generalizedEssence must cite evidence retained in a non-direction support facet; unsupported IDs: " +
        JSON.stringify(unsupportedGeneralizedIds) +
        ".",
    );
  }

  const uncovered = sources.filter((source) => !covered.has(source.id));
  if (uncovered.length > 0) {
    issues.push(
      "These authoritative source IDs were not cited by any non-empty facet: " +
        JSON.stringify(uncovered.map((source) => source.id)) +
        ". Find each ID in the supplied sources, integrate that source's broad meaning into an appropriate facet, and cite the exact ID.",
    );
  }
  return issues.length > 0
    ? issues.join("\n")
    : "The response was structurally close but failed grounded facet validation. Return every facet as {text, sourceIds}, use only supplied IDs, and cite every ordinary source.";
}

/**
 * Parse a hierarchical merge while restoring its evidence links from the already-validated child
 * digests. The merge model handles meaning only; it never has to echo hundreds of opaque IDs. PURE.
 */
export function parseSoulEssenceMerge(
  raw: string,
  kind: SoulKind,
  notes: readonly SoulNote[],
  digests: readonly SoulEssenceDigestInput[],
  generatedAt?: number,
): SoulEssence | undefined {
  const envelope = parseGeneratedJsonObject(raw);
  const record = generatedEssenceRecord(envelope);
  if (!record || !hasCompleteGeneratedFacets(record)) return undefined;
  const rawFacets = objectRecord(record.facets);
  if (!rawFacets) return undefined;
  const rebased = rebaseSoulDigestFacets(notes, digests);
  const facets = {} as SoulEssenceFacets;

  for (const key of SOUL_ESSENCE_FACETS) {
    const rawFacet = objectRecord(rawFacets[key]);
    if (!rawFacet) return undefined;
    const value = typeof rawFacet.text === "string"
      ? rawFacet.text
      : typeof rawFacet.summary === "string"
        ? rawFacet.summary
        : "";
    const text = value.trim().slice(0, MAX_SOUL_ESSENCE_FACET_CHARS);
    const sourceIds = [...new Set(rebased.flatMap((digest) => digest[key].sourceIds))];
    const childHasMeaning = rebased.some((digest) => !!digest[key].text);
    // Explicit directions are canonicalized from their source notes below; every other populated
    // child facet must survive the semantic merge instead of disappearing behind restored IDs.
    if (key !== "personalityDirections" && childHasMeaning && !text) return undefined;
    if (text && !childHasMeaning) return undefined;
    facets[key] = {
      text,
      sourceIds: text ? sourceIds : [],
    };
  }
  const rawGeneralized = objectRecord(record.generalizedEssence);
  if (!rawGeneralized || typeof rawGeneralized.text !== "string") return undefined;
  const generalizedText = rawGeneralized.text.replace(/\s+/g, " ").trim();
  if (generalizedText.length > MAX_SOUL_GENERALIZED_ESSENCE_CHARS) return undefined;
  const childHasGeneralizedMeaning = digests.some(
    (digest) => !!digest.essence.generalizedEssence.text,
  );
  if (childHasGeneralizedMeaning !== !!generalizedText) return undefined;
  const generalizedSourceIds = [
    ...new Set(
      SOUL_ESSENCE_FACETS.filter((key) => key !== "personalityDirections")
        .flatMap((key) => facets[key].sourceIds),
    ),
  ];

  return normaliseSoulEssence(
    {
      ...record,
      schemaVersion: SOUL_ESSENCE_SCHEMA_VERSION,
      kind,
      sourceFingerprint: soulSourceFingerprint(notes),
      generalizedEssence: {
        text: generalizedText,
        sourceIds: generalizedText ? generalizedSourceIds : [],
      },
      facets,
      exactAppearance: [],
    },
    kind,
    notes,
    generatedAt,
  );
}

/** Targeted feedback for a semantic merge, whose evidence IDs are restored from child digests. */
export function soulEssenceMergeRepairFeedback(
  raw: string,
  kind: SoulKind,
  notes: readonly SoulNote[],
  digests: readonly SoulEssenceDigestInput[],
): string {
  if (parseSoulEssenceMerge(raw, kind, notes, digests)) return "";
  const record = generatedEssenceRecord(parseGeneratedJsonObject(raw));
  const rawFacets = objectRecord(record?.facets);
  if (!rawFacets) {
    return "The response was not one complete JSON object with every required facet.";
  }
  const rebased = rebaseSoulDigestFacets(notes, digests);
  const issues: string[] = [];
  const rawGeneralized = objectRecord(record?.generalizedEssence);
  const generalizedText =
    typeof rawGeneralized?.text === "string"
      ? rawGeneralized.text.replace(/\s+/g, " ").trim()
      : "";
  const childHasGeneralizedMeaning = digests.some(
    (digest) => !!digest.essence.generalizedEssence.text,
  );
  if (!rawGeneralized || typeof rawGeneralized.text !== "string") {
    issues.push("generalizedEssence must be an object with text and sourceIds.");
  } else if (generalizedText.length > MAX_SOUL_GENERALIZED_ESSENCE_CHARS) {
    issues.push(
      `generalizedEssence.text is ${generalizedText.length} characters; shorten it to at most ${MAX_SOUL_GENERALIZED_ESSENCE_CHARS}.`,
    );
  } else if (childHasGeneralizedMeaning && !generalizedText) {
    issues.push(
      "generalizedEssence became empty even though the grounded child digest contains identity meaning.",
    );
  } else if (!childHasGeneralizedMeaning && generalizedText) {
    issues.push(
      "generalizedEssence invented meaning even though every grounded child digest is empty.",
    );
  }
  const missingFacetKeys = SOUL_ESSENCE_FACETS.filter(
    (key) => !objectRecord(rawFacets[key]),
  );
  if (missingFacetKeys.length > 0) {
    issues.push(
      `The response is missing complete facet objects for: ${JSON.stringify(missingFacetKeys)}.`,
    );
  }
  for (const key of SOUL_ESSENCE_FACETS) {
    if (key === "personalityDirections") continue;
    const rawFacet = objectRecord(rawFacets[key]);
    const text =
      typeof rawFacet?.text === "string"
        ? rawFacet.text.trim()
        : typeof rawFacet?.summary === "string"
          ? rawFacet.summary.trim()
          : "";
    const childHasMeaning = rebased.some((digest) => !!digest[key].text);
    if (childHasMeaning && !text) {
      issues.push(`facets.${key} became empty even though a child digest contains meaning there.`);
    } else if (text && !childHasMeaning) {
      issues.push(`facets.${key} invented meaning even though every child digest is empty there.`);
    }
  }
  return issues.length > 0
    ? issues.join("\n")
    : "The merge failed validation. Keep generalizedEssence portable and brief, preserve every populated child support facet in that same facet, leave genuinely empty facets empty, and return sourceIds as empty arrays.";
}

function generatedAbstractionRecord(
  parsed: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!parsed) return undefined;
  if (objectRecord(parsed.generalizedEssence)) return parsed;
  for (const key of ["essence", "result", "data", "output"] as const) {
    const nested = objectRecord(parsed[key]);
    if (nested && objectRecord(nested.generalizedEssence)) return nested;
  }
  return parsed;
}

/** Parse the minimal final abstraction while carrying all grounded support forward unchanged. */
export function parseSoulEssenceAbstraction(
  raw: string,
  kind: SoulKind,
  notes: readonly SoulNote[],
  integrated: SoulEssence,
  generatedAt?: number,
): SoulEssence | undefined {
  const base = validateSoulEssence(integrated, kind, notes);
  if (!base) return undefined;
  const record = generatedAbstractionRecord(parseGeneratedJsonObject(raw));
  const rawGeneralized = objectRecord(record?.generalizedEssence);
  if (
    !rawGeneralized ||
    typeof rawGeneralized.text !== "string" ||
    !Array.isArray(rawGeneralized.supportFacetKeys)
  ) {
    return undefined;
  }
  const supportFacetKeys: SoulGeneralizableFacetKey[] = [];
  for (const value of rawGeneralized.supportFacetKeys) {
    if (
      typeof value !== "string" ||
      !SOUL_GENERALIZABLE_FACETS.includes(value as SoulGeneralizableFacetKey)
    ) {
      return undefined;
    }
    const key = value as SoulGeneralizableFacetKey;
    if (!base.facets[key].text || supportFacetKeys.includes(key)) return undefined;
    supportFacetKeys.push(key);
  }
  const text = rawGeneralized.text.replace(/\s+/g, " ").trim();
  if (soulGeneralizedEssenceIssue(text)) return undefined;
  const hadMeaning = !!base.generalizedEssence.text;
  if (hadMeaning !== !!text) return undefined;
  if (!!text !== (supportFacetKeys.length > 0)) return undefined;
  const sourceIds = [
    ...new Set(
      supportFacetKeys.flatMap((key) => base.facets[key].sourceIds),
    ),
  ];
  return normaliseSoulEssence(
    {
      ...base,
      generalizedEssence: {
        text,
        sourceIds: text ? sourceIds : [],
      },
    },
    kind,
    notes,
    generatedAt,
  );
}

/** Targeted feedback for the minimal, low-output final abstraction pass. */
function withSoulGeneralizedVocabulary(message: string): string {
  return [
    message,
    `Complete accepted word vocabulary: ${SOUL_GENERALIZED_TRAIT_VOCABULARY.join(", ")}.`,
    "Every output word must appear in that list exactly; use a listed base form instead of an unlisted synonym or inflection.",
  ].join("\n");
}

export function soulEssenceAbstractionRepairFeedback(
  raw: string,
  kind: SoulKind,
  notes: readonly SoulNote[],
  integrated: SoulEssence,
): string {
  if (parseSoulEssenceAbstraction(raw, kind, notes, integrated)) return "";
  if (!validateSoulEssence(integrated, kind, notes)) {
    return "The grounded Soul synthesis supplied to the abstraction pass was stale or invalid.";
  }
  const record = generatedAbstractionRecord(parseGeneratedJsonObject(raw));
  const rawGeneralized = objectRecord(record?.generalizedEssence);
  if (!rawGeneralized) {
    return withSoulGeneralizedVocabulary(
      "The response did not contain generalizedEssence as an object with text and supportFacetKeys.",
    );
  }
  if (typeof rawGeneralized.text !== "string") {
    return withSoulGeneralizedVocabulary("generalizedEssence.text must be a string.");
  }
  if (!Array.isArray(rawGeneralized.supportFacetKeys)) {
    return withSoulGeneralizedVocabulary(
      "generalizedEssence.supportFacetKeys must be an array of supplied grounded support category names.",
    );
  }
  const invalidKeys = rawGeneralized.supportFacetKeys.filter(
    (value) =>
      typeof value !== "string" ||
      !SOUL_GENERALIZABLE_FACETS.includes(value as SoulGeneralizableFacetKey) ||
      !integrated.facets[value as SoulGeneralizableFacetKey]?.text,
  );
  if (invalidKeys.length > 0) {
    return withSoulGeneralizedVocabulary(
      "generalizedEssence.supportFacetKeys contains unknown or empty support categories: " +
        JSON.stringify(invalidKeys) +
        ".",
    );
  }
  const text = rawGeneralized.text.replace(/\s+/g, " ").trim();
  const specificityIssue = soulGeneralizedEssenceIssue(text);
  if (specificityIssue) return withSoulGeneralizedVocabulary(specificityIssue);
  if (!!integrated.generalizedEssence.text && !text) {
    return withSoulGeneralizedVocabulary(
      "generalizedEssence became empty even though the grounded support contains identity meaning.",
    );
  }
  if (!integrated.generalizedEssence.text && text) {
    return withSoulGeneralizedVocabulary(
      "generalizedEssence invented identity meaning where the grounded support has none.",
    );
  }
  if (text && rawGeneralized.supportFacetKeys.length === 0) {
    return withSoulGeneralizedVocabulary(
      "Choose at least one non-empty grounded support category in supportFacetKeys.",
    );
  }
  if (!text && rawGeneralized.supportFacetKeys.length > 0) {
    return withSoulGeneralizedVocabulary(
      "Leave supportFacetKeys empty when generalizedEssence.text is empty.",
    );
  }
  return withSoulGeneralizedVocabulary(
    "Return only one brief, portable generalizedEssence object with its directly supporting facet keys.",
  );
}

/** Load only a current, supported essence. Stale/corrupt memo values behave as absent. */
export async function loadSoulEssence(
  store: VisualReaderStore,
  kind: SoulKind,
  notes: readonly SoulNote[],
): Promise<SoulEssence | undefined> {
  try {
    const raw = await store.getMemo?.(ESSENCE_KEY[kind]);
    return raw ? parseSoulEssence(raw, kind, notes) : undefined;
  } catch {
    return undefined;
  }
}

const RETAINED_SOUL_SOURCE_ID = /^sn_[0-9a-f]{16}(?:_[1-9][0-9]*)?$/;
const RETAINED_SOUL_FINGERPRINT = new RegExp(
  `^soul-v${SOUL_ESSENCE_SCHEMA_VERSION}-[0-9a-f]{16}$`,
);
const MAX_RETAINED_SOUL_ESSENCE_JSON_CHARS = 1_000_000;
const MAX_RETAINED_SOUL_EXACT_FACTS = MAX_SOUL_NOTES * 64;

function retainedSourceIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_RETAINED_SOUL_EXACT_FACTS) {
    return undefined;
  }
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !RETAINED_SOUL_SOURCE_ID.test(item)) {
      return undefined;
    }
    if (!ids.includes(item)) ids.push(item);
    if (ids.length > MAX_SOUL_NOTES) return undefined;
  }
  return ids;
}

function retainedFacet(
  value: unknown,
  maxChars: number,
): SoulEssenceFacet | undefined {
  const record = objectRecord(value);
  if (!record || typeof record.text !== "string") return undefined;
  const text = record.text;
  if (text !== text.trim() || text.length > maxChars) return undefined;
  const sourceIds = retainedSourceIds(record.sourceIds);
  if (!sourceIds || (!!text !== (sourceIds.length > 0))) return undefined;
  return { text, sourceIds };
}

function retainedExactFacts(
  value: unknown,
  allowSlot: boolean,
): SoulEssenceAppearanceFact[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_RETAINED_SOUL_EXACT_FACTS) {
    return undefined;
  }
  const facts: SoulEssenceAppearanceFact[] = [];
  for (const item of value) {
    const record = objectRecord(item);
    if (!record || typeof record.text !== "string") return undefined;
    const text = record.text;
    if (!text || text !== text.trim() || text.length > MAX_SOUL_NOTE_CHARS) {
      return undefined;
    }
    const sourceIds = retainedSourceIds(record.sourceIds);
    if (!sourceIds?.length) return undefined;
    const slot = record.slot;
    if (
      slot !== undefined &&
      (
        !allowSlot ||
        typeof slot !== "string" ||
        !/^[a-z][a-z0-9_.:-]{0,79}$/i.test(slot)
      )
    ) {
      return undefined;
    }
    facts.push({ text, sourceIds, ...(typeof slot === "string" ? { slot } : {}) });
  }
  return facts;
}

/**
 * Parse the last snapshot without pretending that it is current for today's notes. Every value at
 * this key was written only after strict source validation; this deliberately conservative shape
 * check protects callers from corrupt/tampered storage without retaining deleted source notes just
 * to revalidate a historical synthesis.
 */
function parseLatestSoulEssence(raw: string, kind: SoulKind): SoulEssence | undefined {
  if (raw.length > MAX_RETAINED_SOUL_ESSENCE_JSON_CHARS) return undefined;
  const envelope = parseJsonObject(raw);
  const record = objectRecord(envelope?.essence) ?? envelope;
  if (
    !record ||
    record.schemaVersion !== SOUL_ESSENCE_SCHEMA_VERSION ||
    record.kind !== kind ||
    typeof record.sourceFingerprint !== "string" ||
    !RETAINED_SOUL_FINGERPRINT.test(record.sourceFingerprint) ||
    typeof record.generatedAt !== "number" ||
    !Number.isFinite(record.generatedAt) ||
    record.generatedAt < 0
  ) {
    return undefined;
  }

  const generalizedEssence = retainedFacet(
    record.generalizedEssence,
    MAX_SOUL_GENERALIZED_ESSENCE_CHARS,
  );
  const rawFacets = objectRecord(record.facets);
  if (!generalizedEssence || !rawFacets) return undefined;
  const facets = {} as SoulEssenceFacets;
  for (const key of SOUL_ESSENCE_FACETS) {
    const facet = retainedFacet(rawFacets[key], MAX_SOUL_ESSENCE_FACET_CHARS);
    if (!facet) return undefined;
    facets[key] = facet;
  }
  const hasGeneralizableSupport = SOUL_GENERALIZABLE_FACETS.some(
    (key) => !!facets[key].text,
  );
  if (hasGeneralizableSupport !== !!generalizedEssence.text) return undefined;
  const supportIds = new Set(
    SOUL_GENERALIZABLE_FACETS.flatMap((key) => facets[key].sourceIds),
  );
  if (generalizedEssence.sourceIds.some((id) => !supportIds.has(id))) {
    return undefined;
  }

  const exactAppearance = retainedExactFacts(record.exactAppearance, true);
  const exactPersonalityDirections = retainedExactFacts(
    record.exactPersonalityDirections,
    false,
  );
  if (!exactAppearance || !exactPersonalityDirections) return undefined;
  return {
    schemaVersion: SOUL_ESSENCE_SCHEMA_VERSION,
    kind,
    sourceFingerprint: record.sourceFingerprint,
    generatedAt: record.generatedAt,
    generalizedEssence,
    facets,
    exactAppearance,
    exactPersonalityDirections,
  };
}

/**
 * Load the most recently validated snapshot even when its fingerprint no longer matches the current
 * notes. Use `loadSoulEssence` whenever currentness matters; retained snapshots are for continuity
 * while an automatic refresh is pending.
 */
export async function loadLatestSoulEssence(
  store: VisualReaderStore,
  kind: SoulKind,
  notes: readonly SoulNote[],
): Promise<SoulEssence | undefined> {
  try {
    const raw = await store.getMemo?.(ESSENCE_KEY[kind]);
    if (!raw) return undefined;
    const current = parseSoulEssence(raw, kind, notes);
    if (current) return current;
    const retained = parseLatestSoulEssence(raw, kind);
    // Structural validation exists only for a genuinely older revision. A snapshot that claims to
    // be current but failed full evidence/exact-field validation is corrupt, not continuity.
    return retained?.sourceFingerprint !== soulSourceFingerprint(notes)
      ? retained
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Make a retained snapshot safe to show or provisionally inject beside a newer note revision. Its
 * generalized synthesis and grounding facets stay historical, including the old fingerprint, while
 * exact appearance and behavioral directions are rebuilt solely from the authoritative notes now.
 * No historical exact field can leak through this view.
 */
export function soulEssenceViewForNotes(
  essence: SoulEssence,
  notes: readonly SoulNote[],
): SoulEssence {
  const sources = soulNoteSources(notes);
  const directions = exactPersonalityDirections(notes, sources);
  return {
    ...essence,
    facets: {
      ...essence.facets,
      personalityDirections: directions.length
        ? {
            text: boundedExactTexts(
              directions.map((fact) => fact.text),
              MAX_SOUL_ESSENCE_FACET_CHARS,
            ),
            sourceIds: [...new Set(directions.flatMap((fact) => fact.sourceIds))],
          }
        : { text: "", sourceIds: [] },
    },
    exactAppearance: reconcileSoulAppearance(notes).activeFacts,
    exactPersonalityDirections: directions,
  };
}

/** Persist only an essence validated against the current authoritative notes. */
export async function saveSoulEssence(
  store: VisualReaderStore,
  kind: SoulKind,
  essence: SoulEssence,
  notes: readonly SoulNote[],
): Promise<SoulEssence> {
  const valid = validateSoulEssence(essence, kind, notes);
  if (!valid) throw new Error("cannot save a stale or invalid Soul Essence");
  await store.putMemo?.(ESSENCE_KEY[kind], JSON.stringify(valid));
  return valid;
}

export async function clearSoulEssence(store: VisualReaderStore, kind: SoulKind): Promise<void> {
  await store.deleteMemo?.(ESSENCE_KEY[kind]);
}

/** Exact behavioral directions get their own standing allowance instead of competing with looks. */
export const SOUL_DIRECTION_PROMPT_BUDGET_CHARS = 1_000;
/** Bound one everyday identity block even if a model fills every facet to its schema maximum. */
export const SOUL_ESSENCE_CONTENT_PROMPT_BUDGET_CHARS = 3_200;

function essenceContentLines(essence: SoulEssence, name: string): string[] {
  const candidates: string[] = name.trim() ? [`- Name: ${name.trim()}`] : [];
  const exactDirections = boundedExactTexts(
    essence.exactPersonalityDirections.map((fact) => fact.text),
    SOUL_DIRECTION_PROMPT_BUDGET_CHARS,
  );
  if (exactDirections) {
    candidates.push(`- Source-exact personality directions: ${exactDirections}`);
    const completeDirections = essence.exactPersonalityDirections
      .map((fact) => fact.text.trim())
      .filter(Boolean)
      .join("; ");
    if (completeDirections.length > exactDirections.length) {
      candidates.push(
        "- Additional source-exact personality directions remain stored outside this compact standing prompt.",
      );
    }
  }
  // The persisted essence retains every exact visual clause, but the standing ordinary-chat block
  // is bounded to the same descriptor budget as image prompts. Overflow remains visible in the Soul
  // panel and retrievable from the authoritative notes.
  const exactLook = renderSoulAppearanceFacts(
    essence.exactAppearance,
    SOUL_LOOK_BUDGET_CHARS,
  );
  if (exactLook) candidates.push(`- Exact physical appearance: ${exactLook}`);
  const generalized = essence.generalizedEssence.text.trim();
  if (generalized) candidates.push(`- General essence: ${generalized}`);

  const lines: string[] = [];
  let used = 0;
  for (const line of candidates) {
    const cost = line.length + (lines.length ? 1 : 0);
    if (used + cost > SOUL_ESSENCE_CONTENT_PROMPT_BUDGET_CHARS) continue;
    lines.push(line);
    used += cost;
  }
  return lines;
}

function sourceExactIdentityLines(notes: readonly SoulNote[], name: string): string[] {
  const lines = name.trim() ? [`- Name: ${name.trim()}`] : [];
  const directions = boundedExactTexts(
    notes
      .flatMap((note) => personalityDirectionClauses(note.text)),
    SOUL_DIRECTION_PROMPT_BUDGET_CHARS,
  );
  if (directions) lines.push(`- Source-exact personality directions: ${directions}`);
  const exactLook = visualSoulNotes(notes);
  if (exactLook) lines.push(`- Exact physical appearance: ${exactLook}`);
  return lines;
}

/**
 * Safe temporary ordinary-chat context while the current essence has not been generated yet. It
 * preserves exact invariants without reverting to the raw interests/thoughts dossier.
 */
export function selfSoulExactIdentityPromptBlock(
  notes: readonly SoulNote[],
  name = "",
): string {
  const lines = sourceExactIdentityLines(notes, name);
  if (lines.length === 0) return "";
  return [
    "WHO YOU ARE (source-exact identity invariants; generalized essence pending):",
    ...lines,
    "Honor these silently. Do not infer or recite a broader personality from the unavailable raw Soul-note list.",
  ].join("\n");
}

/** Reader counterpart to {@link selfSoulExactIdentityPromptBlock}. */
export function userSoulExactIdentityPromptBlock(
  notes: readonly SoulNote[],
  name = "",
): string {
  const lines = sourceExactIdentityLines(notes, name);
  if (lines.length === 0) return "";
  return [
    "WHO THE READER IS (source-exact identity invariants; generalized essence pending):",
    ...lines,
    "Use these only where relevant. Do not infer or recite a broader profile from the unavailable raw Soul-note list.",
  ].join("\n");
}

/**
 * Compact everyday prompt for the assistant's identity. Creative/deep paths can deliberately keep
 * using selfSoulPromptBlock to retrieve the original individual notes.
 */
export function selfSoulEssencePromptBlock(essence: SoulEssence | undefined, name = ""): string {
  if (!essence || essence.kind !== "self") return "";
  return [
    "WHO YOU ARE (integrated Soul Essence for ordinary conversation):",
    ...essenceContentLines(essence, name),
    "Embody this silently as your underlying personality. Do not recite this profile, quote its source notes, or repeatedly mention its examples.",
    "Do not steer unrelated conversation toward these interests or profound thoughts. Let their combined meaning shape how you think, speak, and relate; discuss a specific example only when the reader asks for it or the present context naturally requires it.",
  ].join("\n");
}

/**
 * Compact everyday prompt for understanding the reader. Creative/deep paths can deliberately keep
 * using userSoulPromptBlock to retrieve the original individual notes.
 */
export function userSoulEssencePromptBlock(essence: SoulEssence | undefined, name = ""): string {
  if (!essence || essence.kind !== "user") return "";
  return [
    "WHO THE READER IS (integrated Soul Essence for ordinary conversation):",
    ...essenceContentLines(essence, name),
    "Let this inform your understanding silently. Do not recite the profile, stereotype the reader, or repeatedly mention its source examples.",
    "Do not steer unrelated conversation toward these interests or profound thoughts. Use a specific source example only when the reader asks for it or the present context naturally requires it.",
  ].join("\n");
}

function storySoulEssencePromptBlock(
  kind: SoulKind,
  essence: SoulEssence | undefined,
  name: string,
): string {
  if (!essence || essence.kind !== kind || !essence.generalizedEssence.text.trim()) return "";
  const role =
    kind === "self"
      ? "assistant's mapped story character"
      : "reader's mapped story character";
  const displayName =
    name.trim() ||
    (kind === "self" ? "the assistant's character" : "the reader's character");
  return [
    `STORY CHARACTER BASELINE — ${displayName} (${role}):`,
    `- General essence: ${essence.generalizedEssence.text.trim()}`,
    "Use this only as subtle behavioral color where the story itself leaves room. Established characterization, the current scene, the Visual Bible, genre, and the reader's steer override it.",
    "Never turn supporting Soul interests, thoughts, examples, or directions into plot subjects or backstory. Never apply this baseline to any other character.",
  ].join("\n");
}

/**
 * Story prose gets only the portable generalized identity. Exact directions, exact appearance, raw
 * notes, and query-retrieved evidence deliberately stay out of this path.
 */
export function selfStorySoulEssencePromptBlock(
  essence: SoulEssence | undefined,
  name = "",
): string {
  return storySoulEssencePromptBlock("self", essence, name);
}

/** Story-only counterpart for the reader's mapped character. */
export function userStorySoulEssencePromptBlock(
  essence: SoulEssence | undefined,
  name = "",
): string {
  return storySoulEssencePromptBlock("user", essence, name);
}

/**
 * Select the Soul block for an active foreground chat turn without mutating storage or invoking a
 * model. Essence generation belongs to the explicit/idle refresh path; a conversation must be able
 * to start immediately from a retained Essence or a deterministic mode-specific fallback.
 */
export function soulContextPromptBlock(
  kind: SoulKind,
  notes: readonly SoulNote[],
  opts: {
    mode?: SoulContextMode;
    name?: string;
    queryContext?: string;
    /** Most recently validated snapshot, which may predate the current notes. */
    latestEssence?: SoulEssence;
  } = {},
): string {
  const mode = opts.mode ?? "ordinary";
  const name = opts.name?.trim() ?? "";
  const raw = kind === "self"
    ? selfSoulPromptBlock(notes, name)
    : userSoulPromptBlock(notes, name);
  const exactFallback = kind === "self"
    ? selfSoulExactIdentityPromptBlock(notes, name)
    : userSoulExactIdentityPromptBlock(notes, name);
  const cachedEssence =
    opts.latestEssence?.sourceFingerprint === soulSourceFingerprint(notes)
      ? opts.latestEssence
      : undefined;
  // A stale snapshot remains a useful generalized baseline while the idle refresh is pending, but
  // exact appearance and personality directions must always be projected from the current notes.
  const retainedEssence = opts.latestEssence
    ? soulEssenceViewForNotes(opts.latestEssence, notes)
    : undefined;
  const evidence =
    mode !== "story" && opts.queryContext
      ? soulEvidencePromptBlock(kind, notes, opts.queryContext, undefined, cachedEssence)
      : "";

  if (mode === "creative" || notes.length === 0) {
    if (mode === "story") return "";
    return [raw, evidence].filter(Boolean).join("\n\n");
  }

  const compact = mode === "story"
    ? kind === "self"
      ? selfStorySoulEssencePromptBlock(retainedEssence, name)
      : userStorySoulEssencePromptBlock(retainedEssence, name)
    : kind === "self"
      ? selfSoulEssencePromptBlock(retainedEssence, name)
      : userSoulEssencePromptBlock(retainedEssence, name);
  if (compact) return [compact, evidence].filter(Boolean).join("\n\n");

  // Ordinary conversation keeps exact identity invariants while waiting for idle generation. Story
  // intentionally has no raw/exact fallback, because only its generalized baseline belongs in prose.
  if (mode === "story") return "";
  return [exactFallback, evidence].filter(Boolean).join("\n\n");
}

/** One bounded block for a persisted You-and-me Soul cast. */
export function storySoulCharacterizationPromptBlock(input: {
  selfEssence?: SoulEssence;
  selfName?: string;
  userEssence?: SoulEssence;
  userName?: string;
}): string {
  const blocks = [
    selfStorySoulEssencePromptBlock(input.selfEssence, input.selfName),
    userStorySoulEssencePromptBlock(input.userEssence, input.userName),
  ].filter(Boolean);
  if (blocks.length === 0) return "";
  return [
    'GENERALIZED SOUL ESSENCE FOR THIS "YOU & ME" CAST:',
    ...blocks,
    "These baselines belong only to the explicitly mapped characters above. They are not narrator instructions and do not characterize the rest of the cast.",
  ].join("\n\n");
}

/** Upper bound for raw Soul-note evidence retrieved for one explicit identity question. */
export const SOUL_EVIDENCE_PROMPT_BUDGET_CHARS = 2600;

const SELF_IDENTITY_QUESTION =
  /\b(?:who are you|tell me about yourself|describe yourself|what (?:are you like|makes you you|do you look like|do you care about|do you value)|your (?:(?:own|moral|ethical|core|personal|deep|profound|philosophical|creative|usual|physical|writing|speaking|conversational)\s+){0,2}(?:soul|identity|personality|character|interests?|passions?|values?|beliefs?|thoughts?|ideas?|worldview|voice|manner|appearance|looks?|physical description|body|face|hair|eyes?|clothes?|style)|assistant(?:'s)? (?:soul|identity|personality|appearance))\b/i;
const USER_IDENTITY_QUESTION =
  /\b(?:who am i|tell me about me|describe me|what (?:am i like|makes me me|do i look like|do you know about me)|my (?:(?:own|moral|ethical|core|personal|deep|profound|philosophical|creative|usual|physical|writing|speaking|conversational)\s+){0,2}(?:soul|identity|personality|character|interests?|passions?|values?|beliefs?|thoughts?|ideas?|worldview|voice|manner|appearance|looks?|physical description|body|face|hair|eyes?|clothes?|style)|reader(?:'s)? (?:soul|identity|personality|appearance))\b/i;
const APPEARANCE_QUESTION =
  /\b(?:appearance|looks?|look like|physical|body|face|hair|eyes?|clothes?|clothing|wear|portrait|(?:visual|fashion|clothing|dress) style)\b/i;
const NON_APPEARANCE_IDENTITY_QUESTION =
  /\b(?:identity|personality|character|interests?|passions?|values?|beliefs?|thoughts?|ideas?|worldview|voice|manner|care about|(?:writing|speaking|conversational) style)\b/i;
const IDENTITY_FOLLOW_UP =
  /\b(?:specific|concrete|individual)\s+examples?\b|\b(?:give|share|show|name|list)(?:\s+me)?\s+(?:some\s+)?(?:(?:specific|concrete|individual)\s+)?examples?\b|\b(?:tell me more|elaborate|expand on (?:that|it)|go on|how so|what do you mean|which ones?)\b/i;
const QUERY_STOP_WORDS = new Set([
  "about", "actual", "assistant", "concrete", "could", "describe", "examples", "give",
  "have", "identity", "individual", "interests", "like", "more", "personality", "please",
  "reader", "specific", "tell", "that", "their", "them", "these", "think", "thoughts",
  "values", "what", "which", "with", "would", "your", "yourself",
]);

function evidenceQueryTerms(query: string): string[] {
  return [...new Set(
    (query.toLowerCase().match(/[\p{L}\p{N}'-]+/gu) ?? [])
      .map((word) => word.replace(/^['-]+|['-]+$/g, ""))
      .filter((word) => word.length >= 4 && !QUERY_STOP_WORDS.has(word)),
  )];
}

const EVIDENCE_SEMANTIC_TERM_GROUPS = [
  ["belief", "beliefs", "ethic", "ethical", "ethics", "moral", "morals", "principle", "principles", "value", "values"],
  ["appearance", "body", "clothes", "clothing", "face", "hair", "look", "looks", "physical", "portrait", "wear"],
  ["curiosity", "idea", "ideas", "think", "thinking", "thought", "thoughts", "worldview"],
  ["interest", "interests", "passion", "passions", "motivation", "motivations"],
  ["character", "disposition", "identity", "personality", "temperament"],
  ["manner", "speak", "speaking", "style", "tone", "voice"],
  ["aspire", "become", "direction", "directions", "portray", "portrayed", "should"],
  ["relationship", "relationships", "relational", "trust", "warmth"],
] as const;

function expandedEvidenceTerms(terms: readonly string[]): string[] {
  const expanded = new Set(terms);
  for (const group of EVIDENCE_SEMANTIC_TERM_GROUPS) {
    if (group.some((term) => expanded.has(term))) {
      for (const term of group) expanded.add(term);
    }
  }
  return [...expanded];
}

function evidenceFacetSourceIds(
  essence: SoulEssence | undefined,
  categoryRequest: string,
  appearanceOnly: boolean,
): Set<string> {
  const ids = new Set<string>();
  if (!essence) return ids;
  if (appearanceOnly) {
    for (const fact of essence.exactAppearance) {
      for (const id of fact.sourceIds) ids.add(id);
    }
    return ids;
  }

  const keys = new Set<SoulEssenceFacetKey>();
  if (/\b(?:voice|tone|manner|speak|speaking|style)\b/i.test(categoryRequest)) {
    keys.add("conversationalVoice");
  }
  if (/\b(?:think|thinking|thoughts?|ideas?|curiosity|worldview)\b/i.test(categoryRequest)) {
    keys.add("thinkingStyle");
  }
  if (/\b(?:values?|beliefs?|morals?|ethics?|principles?|care about|motivations?|interests?|passions?)\b/i.test(categoryRequest)) {
    keys.add("valuesAndMotivations");
    keys.add("thinkingStyle");
  }
  if (/\b(?:relationship|relational|trust|warmth|with (?:me|people|others))\b/i.test(categoryRequest)) {
    keys.add("relationalStyle");
  }
  if (/\b(?:direction|should|must|aspire|become|portray|portrayed)\b/i.test(categoryRequest)) {
    keys.add("personalityDirections");
  }
  if (/\b(?:personality|character|identity|who (?:are you|am i)|what (?:are you|am i) like)\b/i.test(categoryRequest)) {
    for (const key of SOUL_ESSENCE_FACETS) keys.add(key);
  }
  // A broad identity/examples request has no single facet to rank. In that case use the evidence
  // links from every facet before falling back to the oldest/newest sampler.
  if (keys.size === 0) {
    for (const key of SOUL_ESSENCE_FACETS) keys.add(key);
  }
  for (const key of keys) {
    for (const id of essence.facets[key].sourceIds) ids.add(id);
  }
  return ids;
}

function evidenceRequestParts(query: string): { current: string; prior: string } {
  const marker = /(?:^|\n)CURRENT USER (?:QUESTION|REQUEST):\s*/i.exec(query);
  if (!marker) return { current: query.trim(), prior: "" };
  return {
    current: query.slice(marker.index + marker[0].length).trim(),
    prior: query
      .slice(0, marker.index)
      .replace(/(?:^|\n)PRIOR USER (?:QUESTION|REQUEST):\s*/gi, "\n")
      .trim(),
  };
}

/**
 * Retrieve original notes only when the query/context explicitly asks about this soul's identity.
 *
 * A caller may label one preceding turn as `PRIOR USER REQUEST:` and the present turn as
 * `CURRENT USER REQUEST:`. That lets "specific examples?" continue an identity question without
 * treating an unrelated next request as identity work merely because the old question is in history.
 * The returned notes are evidence for this answer only, never a replacement for the Essence.
 */
export function soulEvidencePromptBlock(
  kind: SoulKind,
  notes: readonly SoulNote[],
  query: string,
  budget = SOUL_EVIDENCE_PROMPT_BUDGET_CHARS,
  essence?: SoulEssence,
): string {
  const { current, prior } = evidenceRequestParts(query);
  const identityQuestion = kind === "self" ? SELF_IDENTITY_QUESTION : USER_IDENTITY_QUESTION;
  const directRequest = identityQuestion.test(current);
  const identityFollowUp =
    !directRequest && IDENTITY_FOLLOW_UP.test(current) && identityQuestion.test(prior);
  if (!current || notes.length === 0 || (!directRequest && !identityFollowUp)) return "";

  const groundedRequest = identityFollowUp ? `${prior}\n${current}` : current;
  const categoryRequest = identityFollowUp ? prior : current;
  const appearanceOnly =
    APPEARANCE_QUESTION.test(categoryRequest) &&
    !NON_APPEARANCE_IDENTITY_QUESTION.test(categoryRequest);
  const appearanceHistoryRequest =
    appearanceOnly &&
    /\b(?:used to|formerly|previous(?:ly)?|old (?:appearance|look)|in the past|before)\b/i.test(
      groundedRequest,
    );
  if (appearanceOnly && !appearanceHistoryRequest) {
    const facts = reconcileSoulAppearance(notes).activeFacts;
    if (facts.length === 0) return "";
    const subject = kind === "self" ? "ASSISTANT" : "READER";
    const prefix = [
      `SOUL SOURCE EXAMPLES / EVIDENCE ABOUT THE ${subject} (for this explicit identity question only):`,
      "These are authoritative current appearance facts, not standing conversational topics.",
    ];
    const suffix =
      "Do not turn these examples into recurring themes or steer later unrelated conversation toward them.";
    const lines = [...prefix];
    let used = [...prefix, suffix].join("\n").length + 1;
    for (const fact of facts) {
      const line = `- ${renderSoulAppearanceFact(fact)}`;
      if (used + line.length + 1 > budget) continue;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length === prefix.length) return "";
    lines.push(suffix);
    return lines.join("\n");
  }
  const sources = soulNoteSources(notes);
  const appearanceProjection = reconcileSoulAppearance(notes);
  const appearanceAccounted = new Set(appearanceProjection.accountedSourceIds);
  const mixedAppearanceRequest = APPEARANCE_QUESTION.test(categoryRequest);
  const candidates = notes
    .map((note, index) => {
      const sourceId = sources[index]!.id;
      let evidenceText = note.text.trim();
      if (appearanceAccounted.has(sourceId) && !appearanceHistoryRequest) {
        const parts: string[] = [];
        const nonVisual = appearanceProjection.nonVisualTextBySourceId[sourceId]?.trim();
        if (nonVisual) parts.push(nonVisual);
        if (mixedAppearanceRequest) {
          for (const fact of appearanceProjection.activeFacts) {
            if (fact.sourceIds.includes(sourceId)) parts.push(renderSoulAppearanceFact(fact));
          }
        }
        evidenceText = [...new Set(parts)].join("; ");
      }
      return { note, index, sourceId, evidenceText };
    })
    .filter(({ note, evidenceText }) =>
      !!evidenceText && (!appearanceOnly || visualSoulFragments(note.text).length > 0),
    );
  if (candidates.length === 0) return "";

  const terms = expandedEvidenceTerms(evidenceQueryTerms(groundedRequest));
  const facetSourceIds = evidenceFacetSourceIds(
    essence?.kind === kind && essence.sourceFingerprint === soulSourceFingerprint(notes)
      ? essence
      : undefined,
    categoryRequest,
    appearanceOnly,
  );
  const score = ({ evidenceText, sourceId }: (typeof candidates)[number]): number => {
    const text = evidenceText.toLowerCase();
    const lexical = terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
    return lexical + (facetSourceIds.has(sourceId) ? 4 : 0);
  };
  const matched = candidates
    .filter((candidate) => score(candidate) > 0)
    .sort((a, b) => score(b) - score(a) || b.index - a.index);

  // When the question is broad, sample both foundational and recent notes instead of silently
  // turning "specific examples" into "the last few examples".
  const balanced: typeof candidates = [];
  for (let left = 0, right = candidates.length - 1; left <= right; left++, right--) {
    balanced.push(candidates[left]!);
    if (right !== left) balanced.push(candidates[right]!);
  }
  const ordered = [...matched, ...balanced].filter(
    (candidate, index, all) => all.findIndex((other) => other.index === candidate.index) === index,
  );

  const subject = kind === "self" ? "ASSISTANT" : "READER";
  const prefix = [
    `SOUL SOURCE EXAMPLES / EVIDENCE ABOUT THE ${subject} (for this explicit identity question only):`,
    "These are authoritative individual notes, not standing conversational topics. Use only the relevant evidence to answer the question.",
  ];
  const suffix =
    "Do not turn these examples into recurring themes or steer later unrelated conversation toward them.";
  const lines = [...prefix];
  let used = [...prefix, suffix].join("\n").length + 1;
  for (const { note, evidenceText: sanitizedEvidence } of ordered) {
    const evidenceText = appearanceOnly
      ? visualSoulFragments(note.text).join("; ")
      : sanitizedEvidence;
    const line = `- ${evidenceText}`;
    if (!evidenceText || used + line.length + 1 > budget) continue;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === prefix.length) return "";
  lines.push(suffix);
  const block = lines.join("\n");
  return block.length <= budget ? block : "";
}

/** System-prompt block for the assistant's own identity ("" when empty). */
/**
 * The notes that fit the prompt budget. Appearance notes are reserved first regardless of age, then
 * the remaining space is filled newest-first; the result is rendered in stored order so the identity
 * reads as it accumulated.
 *
 * Recency alone is wrong for identity: a physical description is commonly one of the first entries
 * and remains true while newer experiences accumulate. Selecting only the tail left that description
 * visible in the Soul panel but absent from every model prompt. Returns what was kept plus how many
 * were left behind, so the block can say so rather than silently showing a partial self. PURE.
 */
export function soulNotesForPrompt(
  notes: readonly SoulNote[],
  budget = SOUL_PROMPT_BUDGET_CHARS,
): { shown: SoulNote[]; omitted: number } {
  const selected = new Set<number>();
  let used = 0;

  const keep = (i: number): boolean => {
    if (selected.has(i)) return true;
    const cost = notes[i]!.text.length + 3; // "- " + newline
    // Preserve the existing guarantee that a non-empty soul always contributes at least one note,
    // even when that single note is longer than the nominal budget.
    if (used + cost > budget && selected.size > 0) return false;
    selected.add(i);
    used += cost;
    return true;
  };

  // A soul's durable LOOK must not age out of the prompt. Walk oldest-first so the foundational
  // description wins if someone has somehow accumulated more appearance text than the whole budget.
  for (let i = 0; i < notes.length; i++) {
    if (visualSoulFragments(notes[i]!.text).length > 0) keep(i);
  }

  // Explicit behavioral/portrayal directions are also identity invariants. Reserve them oldest-first
  // so an early "never flatter me" cannot age out behind newer interests and anecdotes.
  for (let i = 0; i < notes.length; i++) {
    if (isPersonalityDirectionNote(notes[i]!.text)) keep(i);
  }

  // Spend the rest on the newest identity/personality notes.
  for (let i = notes.length - 1; i >= 0; i--) {
    if (!keep(i) && used >= budget) break;
  }

  const shown = [...selected]
    .sort((a, b) => a - b)
    .map((i) => notes[i]!);
  return { shown, omitted: notes.length - shown.length };
}

function currentSoulNotesForStandingPrompt(notes: readonly SoulNote[]): SoulNote[] {
  const sources = soulNoteSources(notes);
  const projection = reconcileSoulAppearance(notes);
  const accounted = new Set(projection.accountedSourceIds);
  return notes.flatMap((note, index) => {
    const source = sources[index]!;
    if (!accounted.has(source.id)) return [note];
    const parts: string[] = [];
    const nonVisual = projection.nonVisualTextBySourceId[source.id]?.trim();
    if (nonVisual) parts.push(nonVisual);
    for (const fact of projection.activeFacts) {
      if (fact.sourceIds.includes(source.id)) parts.push(renderSoulAppearanceFact(fact));
    }
    const text = [...new Set(parts)].join("; ");
    return text ? [{ ...note, text }] : [];
  });
}

export function selfSoulPromptBlock(notes: readonly SoulNote[], name = ""): string {
  if (notes.length === 0 && !name) return "";
  const currentNotes = currentSoulNotesForStandingPrompt(notes);
  const { shown, omitted } = soulNotesForPrompt(currentNotes);
  return (
    "WHO YOU ARE (your own durable identity — your persona, character, voice, and look). This is who " +
    "you are in EVERY conversation: by default speak and carry yourself as this character — in ordinary " +
    "chat just as much as when you play yourself in a story. Stay consistent with it (it shapes your " +
    "tone and manner, never your willingness to help or your honesty). Just BE it — there's no need to " +
    "restate or summarise any of this when you reason; the reader can see your reasoning and it's the " +
    "same paragraph every turn:\n" +
    (name ? `- Name: ${name}\n` : "") +
    shown.map((n) => `- ${n.text}`).join("\n") +
    // Said rather than hidden: the reader can see the full list in the Soul panel, and the model
    // shouldn't believe these few lines are the whole of it.
    (omitted > 0 ? `\n(+ ${omitted} other stored note${omitted === 1 ? "" : "s"} kept, not shown here)` : "")
  );
}

/** System-prompt block for what the assistant knows about the reader's own character ("" when empty). */
export function userSoulPromptBlock(notes: readonly SoulNote[], name = ""): string {
  if (notes.length === 0 && !name) return "";
  const currentNotes = currentSoulNotesForStandingPrompt(notes);
  return (
    "WHO THE READER IS (durable identity facts about the reader's own character — look, personality, " +
    "how they like to be portrayed; use these when the reader plays themselves):\n" +
    (name ? `- Name: ${name}\n` : "") +
    soulNotesForPrompt(currentNotes)
      .shown.map((n) => `- ${n.text}`)
      .join("\n")
  );
}

/**
 * Vocabulary that marks a note as describing how someone LOOKS. Deliberately about the body, what's
 * worn, and colour — the things an image model can draw.
 */
const LOOK_WORDS =
  /\b(appearance|physical\s+(?:description|appearance|traits?|features?|build)|looks?\s+like|physique|hair(?:ed)?|eyes?|eyed|irises?|pupils?|eyebrows?|brows?|eyelashes?|beard|moustache|stubble|skin(?:ned)?|complexion|freckles?|scars?|tattoos?|vitiligo|facial\s+features?|height|weight|weighs?|tall|thin|slim|slender|stocky|wiry|heavyset|muscular|athletic|petite|curvy|plump|gaunt|middle-aged|teenage|twenties|thirties|forties|fifties|sixties|jaw|cheekbones?|nose|lips|fingers?|coat|jacket|cloak|robes?|armou?r|uniform|shirt|trousers|jeans|boots?|shoes?|hat|cap|hood|scarf|gloves?|glasses|spectacles|mask|jewell?ery|necklace|bracelet|earrings?|braid|ponytail|shaved|bald|curly|wavy|blonde?|brunette|auburn|ginger|tanned|freckled)\b/i;
const LOOK_CONTEXT_WORDS =
  /\b(?:(?:short|long|straight|lean|broad)\s+(?:hair|build|frame|body|shoulders?|face|features?)|(?:body|build|frame|shoulders?)\s*(?:is|are|:)?\s*(?:short|tall|slim|slender|stocky|wiry|lean|broad|heavyset|muscular|athletic|petite|curvy|plump|gaunt))\b/i;
const LOOK_STRUCTURED_FACTS =
  /(?:\b(?:round|oval|angular|square|heart-shaped|narrow|long|broad)\s+(?:face|facial features?)\b|\b(?:average|medium|lean|rangy|slim|slender|stocky|wiry|broad|heavyset|muscular|athletic|petite|curvy|plump|gaunt)\s+(?:build|frame|body)\b|\b(?:lean|slim|wiry)\s+and\s+rangy\b|\b(?:face|build|frame|body)\s*(?:is|are|:)\s*(?:round|oval|angular|square|heart-shaped|average|medium|lean|rangy|slim|slender|stocky|wiry|broad|heavyset|muscular|athletic|petite|curvy|plump|gaunt)\b|\b(?:height|posture)\s*(?:is|:)\s*(?:average|short|tall|upright|straight|stooped|slouched|relaxed|rigid)\b|\b(?:calloused|scarred|tattooed|prosthetic|cybernetic|missing)\s+(?:(?:left|right)\s+)?(?:arms?|hands?|legs?|feet|fingers?)\b|\bmissing\s+(?:(?:the|a|an|left|right)\s+){0,2}(?:arms?|hands?|legs?|feet|fingers?|eyes?|ears?)\b|\b\d{1,3}(?:[- ]year[- ]old| years? old)\b|\b(?:[3-7]\s*(?:ft|feet)\s*\d{0,2}\s*(?:in|inches)?|[3-7]'\s*\d{1,2}(?:"| inches?)?|(?:[89]\d|1\d{2}|2[0-4]\d)\s*(?:cm|centimetres?|centimeters?)|\d(?:\.\d{1,2})?\s*(?:m|metres?|meters?))\b|^(?:(?:i(?:\s+am|['’]m)|you(?:\s+are|['’]re)|(?:she|he|they|the reader|the assistant)\s+(?:is|are))\s+)(?:(?:a|an)\s+)?(?:woman|man|female|male|nonbinary|androgynous(?: person)?|amputee)\.?$|^(?:(?:i(?:\s+am|['’]m)|you(?:\s+are|['’]re)|(?:she|he|they|the reader|the assistant)\s+(?:is|are))\s+)?(?:(?:a|an)\s+)?(?:black|white|asian|latina?|latino|indigenous|middle eastern|brown-skinned|dark-skinned|light-skinned|olive-skinned)\s+(?:woman|man|person|female|male|nonbinary)\b|^(?:i(?:\s+am|['’]m)|you(?:\s+are|['’]re)|(?:she|he|they|the reader|the assistant)\s+(?:is|are))\s+(?:black|white|asian|latina?|latino|indigenous|middle eastern|brown-skinned|dark-skinned|light-skinned|olive-skinned)\.?$)/i;
const LOOK_STANDALONE_GENDER =
  /^(?:(?:a|an)\s+)?(?:woman|man|female|male|nonbinary|androgynous(?:\s+person)?)\.?$/i;
const LOOK_ADDITIONAL_WORDS =
  /\b(?:birthmarks?|piercings?|vitiligo|dimples?|jawline|chin|cheeks?|mouth|teeth|fangs?|ears?|arms?|hands?|legs?|feet|dress|gown|rings?|accessories?|clothing|outfit|species|nonhuman|wings?|horns?|antlers?|tail|fur|feathers?|claws?|hooves?|antennae?|tentacles?|fins?|gills?|halo|cybernetic|prosthetic)\b/i;
const PHYSICAL_BUST_DETAIL =
  "(?:(?:small|large|full|natural|prominent|modest)\\s+){1,4}(?:bust|breasts?)";
const LOOK_PHYSICAL_BUST = new RegExp(
  [
    `\\b(?:i|you|she|he|they|the reader|the assistant|the character)\\s+(?:has|have)\\s+(?:a\\s+)?${PHYSICAL_BUST_DETAIL}\\b(?!\\s+of\\b)`,
    `\\b(?:my|your|her|his|their)\\s+${PHYSICAL_BUST_DETAIL}\\b(?!\\s+of\\b)`,
    `^\\s*(?:a\\s+)?${PHYSICAL_BUST_DETAIL}\\b(?!\\s+of\\b)[.!]?\\s*$`,
  ].join("|"),
  "i",
);
const PHYSICAL_SCALE_DETAIL =
  "(?:iridescent|reptilian|dragon|fishlike|overlapping|shimmering|metallic|translucent|armou?red|rough|smooth|fine|tiny|small|large|red|green|blue|bronze|silver|golden|black|white)";
const PHYSICAL_SCALE_LOCUS =
  "(?:skin|body|torso|abdomen|spine|face|cheeks?|jaw|chin|neck|shoulders?|chest|back|waist|hips?|arms?|forearms?|hands?|fingers?|legs?|thighs?|feet|tail|wings?)";
const PHYSICAL_SCALE_TRAILING_CONTEXT =
  `(?=\\s*(?:[.!?]|$)|\\s+(?:on|over|along|across|covering)\\s+(?:(?:her|his|their|my|your|the)\\s+)?(?:entire\\s+)?${PHYSICAL_SCALE_LOCUS}\\b)`;
const LOOK_PHYSICAL_SCALE = new RegExp(
  [
    `\\b(?:i|you|she|he|they|the reader|the assistant|the character|(?:a|an|the)\\s+(?:woman|man|person|dragon|reptile|creature))\\s+(?:has|have)\\s+(?:${PHYSICAL_SCALE_DETAIL}\\s+){0,2}scales\\b(?!\\s+of\\b)${PHYSICAL_SCALE_TRAILING_CONTEXT}`,
    `^\\s*(?:has\\s+)?(?:${PHYSICAL_SCALE_DETAIL}\\s+){0,2}scales\\s*[.!]?\\s*$`,
    `\\bcovered\\s+(?:in|with)\\s+(?:${PHYSICAL_SCALE_DETAIL}\\s+){0,2}scales\\b(?!\\s+of\\b)`,
    `\\b(?:my|your|her|his|their)\\s+(?:${PHYSICAL_SCALE_DETAIL}\\s+){0,2}scales\\b(?!\\s+of\\b)`,
    `\\bscales\\s+(?:cover|covered|covering|line|coat)\\s+(?:(?:her|his|their|my|your|the)\\s+)?(?:entire\\s+)?${PHYSICAL_SCALE_LOCUS}\\b(?!\\s+of\\b)`,
    `\\bscales\\s+(?:run|extend|grow)\\s+(?:on|over|along|across|from|down)\\s+(?:(?:her|his|their|my|your|the)\\s+)?(?:entire\\s+)?${PHYSICAL_SCALE_LOCUS}\\b(?!\\s+of\\b)`,
    `\\bwith\\s+(?:${PHYSICAL_SCALE_DETAIL}\\s+){0,2}scales\\s+(?:on|over|along|covering)\\s+(?:(?:her|his|their|my|your|the)\\s+)?(?:entire\\s+)?${PHYSICAL_SCALE_LOCUS}\\b(?!\\s+of\\b)`,
    `\\b(?:a|an|one|single)\\s+(?:${PHYSICAL_SCALE_DETAIL}\\s+){0,2}scale\\s+(?:on|over|along|beneath|near)\\s+(?:(?:her|his|their|my|your|the)\\s+)?(?:entire\\s+)?${PHYSICAL_SCALE_LOCUS}\\b(?!\\s+of\\b)`,
    `\\b(?:no\\s+(?:${PHYSICAL_SCALE_DETAIL}\\s+){0,2}scales|without\\s+(?:any\\s+)?(?:${PHYSICAL_SCALE_DETAIL}\\s+){0,2}scales|no\\s+longer\\s+(?:has|have)\\s+(?:${PHYSICAL_SCALE_DETAIL}\\s+){0,2}scales|(?:i|you|she|he|they|the reader|the assistant|the character)\\s+(?:has|have)\\s+no\\s+(?:${PHYSICAL_SCALE_DETAIL}\\s+){0,2}scales)\\b(?!\\s+of\\b)`,
    `\\b(?:my|your|her|his|their)\\s+scales\\s+(?:are|were|look|appear)\\s+(?:${PHYSICAL_SCALE_DETAIL})\\b`,
  ].join("|"),
  "i",
);

const BUILD_DESCRIPTOR_WORD =
  "(?:average|medium|thin|slim|slender|stocky|wiry|lean|rangy|broad|heavyset|muscular|athletic|petite|curvy|plump|gaunt)";
const BUILD_NOUN = "(?:build|frame|body|physique)";
const BUILD_PERSON_NOUN =
  "(?:woman|man|person|female|male|figure|human|character|reader|assistant|girl|boy|dragon|reptile|creature|android|robot|cyborg|elf|fae|fairy|demon|angel|alien|vampire|werewolf)";
const BUILD_PERSON_SUBJECT =
  `(?:i|you|she|he|they|the reader|the assistant|the character|this\\s+${BUILD_PERSON_NOUN}|(?:a|an|the)\\s+${BUILD_PERSON_NOUN})`;
const BUILD_LEADING_MODIFIER =
  "(?:cute|pretty|beautiful|handsome|attractive|striking|plain|natural|soft|delicate)";
const QUALIFIED_BUILD_DESCRIPTOR =
  `(?:(?:very|extremely|quite|notably)\\s+)?${BUILD_DESCRIPTOR_WORD}`;
const BUILD_DESCRIPTOR_SEQUENCE =
  `${QUALIFIED_BUILD_DESCRIPTOR}(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+(?:and|but)\\s+)${QUALIFIED_BUILD_DESCRIPTOR})*`;

function buildDescriptorTokens(text: string): string[] {
  return [...text.matchAll(new RegExp(`\\b${QUALIFIED_BUILD_DESCRIPTOR}\\b`, "gi"))]
    .map((match) => match[0]!.trim());
}

function hasPersonalBuildNounContext(text: string, matchIndex: number): boolean {
  const prefix = text.slice(0, matchIndex).trim();
  if (/^(?:no|without(?:\s+(?:a|an|the|any))?)$/i.test(prefix)) {
    return true;
  }
  if (
    new RegExp(
      `^(?:(?:a|an|the|my|your|her|his|their|its)(?:\\s+|$))?(?:${BUILD_LEADING_MODIFIER}\\s*,?\\s*)*$`,
      "i",
    ).test(prefix)
  ) {
    return true;
  }
  if (
    new RegExp(
      `^${BUILD_PERSON_SUBJECT}\\s+(?:have|has|am|are|is)\\s+(?:(?:a|an)(?:\\s+|$))?(?:${BUILD_LEADING_MODIFIER}\\s*,?\\s*)*$`,
      "i",
    ).test(prefix)
  ) {
    return true;
  }
  if (
    new RegExp(
      `\\b${BUILD_PERSON_NOUN}\\b\\s+(?:and|with)\\s+(?:(?:a|an)\\s*)?$`,
      "i",
    ).test(prefix)
  ) {
    return true;
  }
  return /^[\p{Lu}][\p{L}'’-]*(?:\s+[\p{Lu}][\p{L}'’-]*)*\s+(?:has|have|is|are)\s+(?:(?:a|an)\s*)?$/u.test(
    prefix,
  );
}

function buildDescriptionMatches(text: string): string[] {
  const matches: string[] = [];
  const add = (value: string) => {
    const clean = value.trim();
    if (clean && !matches.some((match) => match.toLowerCase() === clean.toLowerCase())) {
      matches.push(clean);
    }
  };

  const beforeNoun = new RegExp(
    `\\b(${BUILD_DESCRIPTOR_SEQUENCE})\\s+(${BUILD_NOUN})(?!\\s+(?:of|hair|fur|feathers?|scales?|paint|language|image|armou?r|glasses?|spectacles?|eyeglasses?|sunglasses?|monocles?|rate|buffer|surrounds?|around|for|pipeline|process|system|configuration|artifact|output|job)\\b)`,
    "gi",
  );
  for (const match of text.matchAll(beforeNoun)) {
    if (!hasPersonalBuildNounContext(text, match.index ?? 0)) continue;
    const descriptors = buildDescriptorTokens(match[1]!);
    descriptors.forEach((descriptor, index) =>
      add(index === descriptors.length - 1 ? `${descriptor} ${match[2]!}` : descriptor)
    );
  }

  const afterNoun = new RegExp(
    `\\b(${BUILD_NOUN})\\s*(?:is|are|:)\\s*(${BUILD_DESCRIPTOR_SEQUENCE})\\b`,
    "gi",
  );
  for (const match of text.matchAll(afterNoun)) {
    if (!hasPersonalBuildNounContext(text, match.index ?? 0)) continue;
    const descriptors = buildDescriptorTokens(match[2]!);
    descriptors.forEach((descriptor, index) =>
      add(index === 0 ? `${match[1]!} is ${descriptor}` : descriptor)
    );
  }

  for (const match of text.matchAll(
    /\bbroad(?:[- ]shouldered|\s+(?:across\s+the\s+)?shoulders?)\b/gi,
  )) {
    add(match[0]!);
  }

  const standaloneSequence = text.match(
    new RegExp(
      `^\\s*(?:(?:a|an)\\s+)?(${BUILD_DESCRIPTOR_SEQUENCE})\\.?\\s*$`,
      "i",
    ),
  );
  if (standaloneSequence) {
    for (const descriptor of buildDescriptorTokens(standaloneSequence[1]!)) add(descriptor);
  }

  const humanCopula = text.match(
    new RegExp(
      `^\\s*(?:i(?:\\s+am|['’]m)|you(?:\\s+are|['’]re)|(?:she|he|they|the reader|the assistant|the character|this\\s+${BUILD_PERSON_NOUN}|(?:a|an|the)\\s+${BUILD_PERSON_NOUN})\\s+(?:is|are))\\s+(?:(?:a|an)\\s+)?(${BUILD_DESCRIPTOR_SEQUENCE})(?:\\s+(?:young|adult|older|elderly|middle-aged))?(?:\\s+${BUILD_PERSON_NOUN})?\\.?\\s*$`,
      "i",
    ),
  );
  if (humanCopula) {
    for (const descriptor of buildDescriptorTokens(humanCopula[1]!)) add(descriptor);
  }

  const humanDescription = text.match(
    new RegExp(
      `\\b(${BUILD_DESCRIPTOR_SEQUENCE})(?:\\s+(?:young|adult|older|elderly|middle-aged)){0,2}\\s+${BUILD_PERSON_NOUN}\\b`,
      "i",
    ),
  );
  const humanDescriptionStart = humanDescription?.index ?? -1;
  const beforeHumanDescription =
    humanDescriptionStart >= 0 ? text.slice(0, humanDescriptionStart).trim() : "";
  const afterHumanDescription =
    humanDescription && humanDescriptionStart >= 0
      ? text.slice(humanDescriptionStart + humanDescription[0].length).trim()
      : "";
  const explicitSelfDescription =
    /^i\s+see\s+myself\s+as\s+(?:(?:a|an)\s+)?(?:(?:cute|pretty|beautiful|handsome|attractive|striking|plain|natural|soft-featured)\s*,?\s*)*$/i.test(
      beforeHumanDescription,
    );
  const standaloneHumanDescription =
    /^(?:a|an)?$/i.test(beforeHumanDescription) &&
    (
      !afterHumanDescription ||
      /^[.!?]$/.test(afterHumanDescription) ||
      /^(?:and|with)\s+.+\b(?:build|body|frame|physique|shoulders?)\b\.?$/i.test(
        afterHumanDescription,
      )
    );
  if (humanDescription && (explicitSelfDescription || standaloneHumanDescription)) {
    for (const descriptor of buildDescriptorTokens(humanDescription[1]!)) add(descriptor);
  }

  const bodied = text.match(
    new RegExp(
      `^\\s*(?:(?:i(?:\\s+am|['’]m)|you(?:\\s+are|['’]re)|(?:she|he|they|the reader|the assistant|the character|this\\s+${BUILD_PERSON_NOUN}|(?:a|an|the)\\s+${BUILD_PERSON_NOUN})\\s+(?:is|are))\\s+)?(?:(?:a|an)\\s+)?(${BUILD_DESCRIPTOR_WORD}[- ](?:built|bodied|framed))(?:\\s+(?:young|adult|older|elderly|middle-aged))?(?:\\s+${BUILD_PERSON_NOUN})?\\.?\\s*$`,
      "i",
    ),
  );
  if (bodied) add(bodied[1]!);

  return matches;
}

function buildDescriptionMatch(text: string): string {
  return buildDescriptionMatches(text)[0] ?? "";
}

function buildAppearanceSlot(text: string, labelledSlot: string): string {
  if (labelledSlot === "build" || /\b(?:average|medium)\b/i.test(text)) return "build";
  if (/\bbroad(?:[- ]shouldered|\s+(?:across\s+the\s+)?shoulders?)\b/i.test(text)) {
    return "build.shoulders.broad";
  }
  const descriptor =
    text.match(new RegExp(`\\b(${BUILD_DESCRIPTOR_WORD})\\b`, "i"))?.[1]?.toLowerCase() ??
    "other";
  if (/\b(?:thin|slim|slender|stocky|wiry|lean|broad|heavyset|curvy|plump|gaunt)\b/i.test(text)) {
    return `build.mass.${descriptor}`;
  }
  if (/\b(?:petite|rangy)\b/i.test(text)) return `build.stature.${descriptor}`;
  if (/\b(?:muscular|athletic)\b/i.test(text)) {
    return `build.composition.${descriptor}`;
  }
  return "build";
}

function buildAppearanceAxis(slot: string): string {
  const parts = slot.split(".");
  return parts.length >= 3 && parts[0] === "build"
    ? `${parts[0]}.${parts[1]}`
    : "";
}

const NON_APPEARANCE_LOOK_IDIOMS =
  /\b(?:(?:keep(?:s|ing)?|kept|has|have|had)\s+)?(?:an?|one|the)?\s*eye\s+(?:on|for)\b|\bfresh(?:\s+pair\s+of)?\s+eyes?\b|\b(?:through|in|from)\s+the\s+eyes?\s+of\b|\btall order\b/gi;

function isLookNote(text: string): boolean {
  const literal = text.replace(NON_APPEARANCE_LOOK_IDIOMS, " ").replace(/\s+/g, " ").trim();
  if (!literal) return false;
  return (
    LOOK_WORDS.test(literal) ||
    LOOK_CONTEXT_WORDS.test(literal) ||
    LOOK_STRUCTURED_FACTS.test(literal) ||
    LOOK_STANDALONE_GENDER.test(literal) ||
    LOOK_ADDITIONAL_WORDS.test(literal) ||
    LOOK_PHYSICAL_BUST.test(literal) ||
    LOOK_PHYSICAL_SCALE.test(literal) ||
    !!buildDescriptionMatch(literal)
  );
}

const TRANSIENT_VISUAL_FRAGMENT =
  /\b(?:smil(?:e|es|ed|ing)|grin(?:s|ned|ning)?|frown(?:s|ed|ing)?|scowl(?:s|ed|ing)?|laugh(?:s|ed|ing)?|cry(?:ing|ies|ied)?|tears?|blush(?:es|ed|ing)?|angry|sad|happy|surprised|afraid|fearful|worried|anxious|excited|expression|gesture|pose|posing)\b/i;
const TRANSIENT_SCENE_ACTION =
  /\b(?:smil(?:e|es|ed|ing)|grin(?:s|ned|ning)?|frown(?:s|ed|ing)?|scowl(?:s|ed|ing)?|laugh(?:s|ed|ing)?|cry(?:ing|ies|ied)?|blush(?:es|ed|ing)?|gesture|pose|posing)\b/i;

/**
 * Source-grounded visual clauses from a mixed Soul note. Semicolons/newlines/sentence boundaries
 * commonly separate "silver hair" from "values difficult honesty"; filtering clause-wise keeps the
 * former exact without laundering the latter into a permanent visual trait.
 */
function visualSoulFragments(text: string): string[] {
  return text
    // Split before stripping: a durability word in "usually wears glasses" must not protect the
    // separate ", smiling now" clause from transient-expression removal.
    .split(
      /\s*(?:;|\r?\n)\s*|(?<=[.!?])\s+|,\s*(?=(?:now\s+)?(?:smil|grin|frown|scowl|laugh|cry|tear|blush|eyes? (?:narrow|widen)|brows? furrow|arms? cross|clench))|(?:\s+while|\s+and)\s+(?=(?:smil|grin|frown|scowl|laugh|cry|tear|blush|eyes? (?:narrow|widen)|brows? furrow|arms? cross|clench))/i,
    )
    .map((part) => stripTransientCharacterDetailsExact(part).trim())
    .filter((part) => part && !TRANSIENT_VISUAL_FRAGMENT.test(part) && isLookNote(part));
}

type SoulAppearanceOperation = "set" | "add" | "remove";

interface SoulAppearanceContribution {
  text: string;
  originText: string;
  originKey: string;
  fieldLabel: string;
  sourceId: string;
  sourceIndex: number;
  sourceAt: number;
  sequence: number;
  slot: string;
  key: string;
  additive: boolean;
  operation: SoulAppearanceOperation;
  priority: number;
}

interface SoulAppearanceNoteAnalysis {
  contributions: SoulAppearanceContribution[];
  accounted: boolean;
  snapshot: boolean;
  historical: boolean;
  nonVisualText: string;
  resetPrefixes: string[];
}

/**
 * The current source-exact appearance projected from the append-only Soul ledger. Older visual
 * sources remain stored for provenance, but only `activeFacts` describe the person now.
 */
export interface SoulAppearanceProjection {
  activeFacts: SoulEssenceAppearanceFact[];
  accountedSourceIds: string[];
  supersededSourceIds: string[];
  historicalSourceIds: string[];
  /** Non-appearance clauses retained from mixed notes, keyed by their authoritative source ID. */
  nonVisualTextBySourceId: Record<string, string>;
}

const APPEARANCE_FIELD_LINE =
  /^\s*(?:[-*]\s*)?(gender|sex|age|ethnicity|race|height|weight|build|body(?:\s+type)?|skin(?:\s+(?:color|colour|tone))?|complexion|hair(?:\s+(?:color|colour|length|style|texture))?|(?:(?:left|right)\s+)?eyes?(?:\s+(?:color|colour|shape))?|face|facial\s+features?|distinguishing\s+marks?|marks?|scars?|tattoos?|birthmarks?|piercings?|accessories?|clothing|clothes|outfit|species|nonhuman\s+features?|features?)\s*:\s*(.*)$/i;
const APPEARANCE_BLOCK_LINE =
  /^\s*(?:[-*]\s*)?((?:(?:current|updated|new|corrected|replacement|revised|latest)\s+)?(?:physical\s+description|physical\s+appearance|appearance|look))\s*:\s*(.*)$/i;
const APPEARANCE_SNAPSHOT_WORDS =
  /\b(?:current|updated|new|corrected|replacement|revised|latest)\b/i;
const HISTORICAL_APPEARANCE_WORDS =
  /\b(?:used to|formerly|previously|in the past|old (?:physical )?(?:description|appearance|look)|before (?:that|this)|once (?:had|was|wore)|as a child)\b/i;
const CURRENT_APPEARANCE_WORDS = /\b(?:but\s+)?(?:now|currently|these days|today)\b/i;
const APPEARANCE_REMOVAL_WORDS =
  /\b(?:no longer|not anymore|without|removed?|(?:do not|does not|don['’]t|doesn['’]t) (?:have|wear)|stopped wearing|lost (?:the|his|her|their|my)|no\s+(?:[a-z-]+\s+){0,2}scales?|no\s+(?:visible\s+)?(?:scars?|tattoos?|birthmarks?|piercings?|freckles?|burns?|marks?|glasses|spectacles|mask|hat|cap|hood|scarf|gloves?|necklace|bracelet|earrings?|ring|jewell?ery))\b/i;
const NONVISUAL_SOUL_WORDS =
  /\b(?:values?|belie(?:f|fs|ves)|thinks?|thoughts?|interests?|curiosity|curious|intellectual(?:ly)?|personality|voice|speaks?|responds?|conversation|honesty|ethics?|morals?|prefers?|enjoys?|loves?|hates?|drawn to|cares? about)\b/i;
const EMPTY_APPEARANCE_VALUE =
  /^(?:unknown|unspecified|unclear|unchanged|same as before|not (?:specified|described|known|provided)|tbd|none|n\/?a|null|undefined|[-–—]+|\?+)$/i;
const EXPLICIT_EMPTY_APPEARANCE_VALUE =
  /^(?:none|absent|no(?:ne)?|no\s+(?:visible\s+)?(?:hair|eyes?|scars?|tattoos?|birthmarks?|piercings?|marks?|features?|accessories|clothing|clothes)|without\s+(?:any\s+)?(?:hair|eyes?|scars?|tattoos?|birthmarks?|piercings?|marks?|features?|accessories|clothing|clothes))\.?$/i;

const APPEARANCE_COLOR =
  "(?:black|white|gr[ae]y|brown|blond(?:e)?|auburn|red|ginger|silver|gold(?:en)?|blue|green|hazel|amber|violet|purple|pink|teal|turquoise|copper|crimson|scarlet|orange|olive|tan(?:ned)?|pale|ivory|ebony|bronze|multicolou?red)";
const HAIR_COLOR_WITH_ANCHOR = new RegExp(
  `\\b${APPEARANCE_COLOR}(?:[- ]${APPEARANCE_COLOR})?\\s+(?:hair|braids?|curls?|locs|dreadlocks?|ponytail)\\b`,
  "i",
);
const EYE_COLOR_WITH_ANCHOR = new RegExp(
  `\\b${APPEARANCE_COLOR}(?:[- ]${APPEARANCE_COLOR})?(?:\\s+(?:almond-shaped|round|narrow|wide-set|close-set|deep-set|large|small|hooded))?\\s+(?:eyes?|irises?|pupils?)\\b|\\b${APPEARANCE_COLOR}[- ]eyed\\b`,
  "i",
);
const EYE_DETAIL_WORDS =
  /\b(?:textures?|patterns?|flecks?|specks?|streaks?|rings?|striations?|veins?|mottling|marbling|flecked|speckled|streaked|ringed|striated|veined)\b/i;
const EYE_APPEARANCE_ANALOGY =
  /\b(?:as if|as though|resembling|reminiscent of|evoking)\b/i;
// This natural-light comparison is a deliberate, stable part of the source appearance rather than
// the lighting of a particular scene. Keep this family narrow: ordinary neon, moonlight, gaze, and
// expression comparisons must continue through the shared transient-detail filter.
const SOURCE_EXACT_EYE_COMPARISON =
  /\b(?:as if|as though)\b[^.;]*\bsunlight\b[^.;]*\bfiltering\s+through\b[^.;]*\b(?:forest|canopy|leaves|foliage)\b/i;
const TRANSIENT_EYE_ANALOGY_STATE =
  /\b(?:narrow(?:s|ed|ing)|widen(?:s|ed|ing)?|glar(?:e|es|ed|ing)|smil(?:e|es|ed|ing)|grin(?:s|ned|ning)?|frown(?:s|ed|ing)?|scowl(?:s|ed|ing)?|cry(?:ing|ies|ied)?|tears?|angry|anger|rage|sad(?:ness)?|happy|happiness|fear(?:ful)?|surpris(?:e|ed)|worried|anxious|excited)\b/i;
const EYE_COLOR_QUALIFIER =
  "(?:deep|dark|light|pale|bright|vivid|rich|mossy|forest|emerald|sea|ocean|steel|stormy|warm|cool|muted|soft|icy|smoky|smokey|dusky|clear|luminous)";
const EYE_SHAPE_OR_SIZE =
  /\b(?:almond-shaped|round|narrow|wide-set|close-set|deep-set|large|small|hooded)\b/i;
const SUPPLEMENTAL_EYE_COLOR_ONLY =
  /^(?:aquamarine|burgundy|cerulean|chartreuse|cobalt|cyan|indigo|jade|magenta|maroon|navy|ochre|sapphire|ultramarine)$/i;
const QUALIFIED_EYE_COLOR_ONLY = new RegExp(
  `^\\s*(?:(?:a|an|the)\\s+)?(?:${EYE_COLOR_QUALIFIER}\\s*,?\\s*){0,3}${APPEARANCE_COLOR}(?:[- ]${APPEARANCE_COLOR})?\\s*[.!]?\\s*$`,
  "i",
);
const SKIN_COLOR_WITH_ANCHOR = new RegExp(
  `\\b${APPEARANCE_COLOR}(?:[- ]${APPEARANCE_COLOR})?\\s+(?:skin|complexion)\\b`,
  "i",
);
const COLOR_ONLY = new RegExp(`\\b${APPEARANCE_COLOR}\\b`, "i");

function isStandaloneAppearanceDescriptor(text: string): boolean {
  return (
    COLOR_ONLY.test(text) ||
    /\b(?:long|short|straight|wavy|curly|coily|braided|unkempt|sleek|round|oval|angular|tall|slim|lean|stocky|muscular|athletic|overbite)\b/i.test(
      text,
    )
  );
}

function exactMatch(text: string, pattern: RegExp): string {
  return text.match(pattern)?.[0]?.trim() ?? "";
}

function isSupplementalEyeColor(text: string): boolean {
  const candidate = text.replace(/^(?:a|an|the)\s+/i, "").trim();
  return SUPPLEMENTAL_EYE_COLOR_ONLY.test(candidate);
}

/** A real iris base color, excluding colors that only qualify flecks, rings, or texture. */
function exactEyeBaseColor(text: string, labelledSlot: string): string {
  const anchored = text.match(EYE_COLOR_WITH_ANCHOR);
  if (anchored?.[0]) {
    const before = text.slice(0, anchored.index ?? 0);
    const qualifiers = before.match(
      new RegExp(`((?:${EYE_COLOR_QUALIFIER}\\s*,?\\s*){1,3})$`, "i"),
    )?.[1] ?? "";
    return `${qualifiers}${anchored[0]}`.trim();
  }
  const eyeGrounded =
    labelledSlot.startsWith("eyes.") ||
    /\b(?:eyes?|irises?|pupils?)\b/i.test(text);
  if (!eyeGrounded) return "";

  const standalone = text.replace(/^(?:a|an|the)\s+/i, "").replace(/[.!\s]+$/, "");
  if (labelledSlot.startsWith("eyes.") && SUPPLEMENTAL_EYE_COLOR_ONLY.test(standalone)) {
    return standalone;
  }

  if (labelledSlot.startsWith("eyes.") && EYE_DETAIL_WORDS.test(text)) {
    const beforeDetail = text.match(/^(.+?)\s*,?\s+with\s+(.+)$/i);
    const candidate = beforeDetail?.[1]?.trim() ?? "";
    const detail = beforeDetail?.[2]?.trim() ?? "";
    if (
      candidate &&
      detail &&
      EYE_DETAIL_WORDS.test(detail) &&
      !EYE_DETAIL_WORDS.test(candidate) &&
      !EYE_SHAPE_OR_SIZE.test(candidate) &&
      (labelledSlot === "eyes.color" || isSupplementalEyeColor(candidate))
    ) {
      return candidate.replace(/^(?:a|an|the)\s+/i, "").trim();
    }
  }

  const colors = [...text.matchAll(new RegExp(`\\b${APPEARANCE_COLOR}\\b`, "gi"))];
  for (const match of colors) {
    const color = match[0]!;
    const index = match.index ?? 0;
    const before = text.slice(0, index);
    const after = text.slice(index + color.length);
    const precedingWith = before.match(/\bwith\b[^.;]*$/i)?.[0] ?? "";
    const insideWithDetail =
      !!precedingWith &&
      EYE_DETAIL_WORDS.test(`${precedingWith}${color}${after}`);
    const qualifiesDetail =
      insideWithDetail ||
      /^\s*(?:-(?:flecked|speckled|streaked|ringed|striated|veined)\b|[- ]?(?:(?:colou?red|tinted)\s+)?(?:fine\s+|tiny\s+|subtle\s+|bright\s+|iridescent\s+)?(?:textures?|patterns?|flecks?|specks?|streaks?|rings?|striations?|veins?|mottling|marbling)\b)/i.test(
        after,
      ) ||
      /\b(?:flecked|speckled|streaked|ringed|striated|veined)\s+(?:with|in)\s*$/i.test(
        before,
      );
    if (qualifiesDetail) continue;

    // An explicit Eye color field is authoritative and can contain punctuation or uncommon
    // modifiers that are still part of the source-exact color phrase.
    if (
      labelledSlot === "eyes.color" &&
      !EYE_DETAIL_WORDS.test(text) &&
      !EYE_APPEARANCE_ANALOGY.test(text)
    ) {
      return text.trim();
    }
    const qualifiers = before.match(
      new RegExp(`((?:${EYE_COLOR_QUALIFIER}\\s*,?\\s*){1,3})$`, "i"),
    )?.[1] ?? "";
    return `${qualifiers}${color}`.trim();
  }
  return "";
}

/** Source-exact iris texture/pattern wording, without treating its accent colors as base color. */
function exactEyeDetail(text: string): string {
  if (!EYE_DETAIL_WORDS.test(text) && !EYE_APPEARANCE_ANALOGY.test(text)) return "";
  const patternedWithAccent = text.match(
    /\b((?:flecked|speckled|streaked|ringed|striated|veined)\s+(?:with|in)\s+.+)$/i,
  )?.[1]?.trim();
  const withDetail = text.match(/^(.+?)\bwith\s+(.+)$/i);
  const beforeWith = withDetail?.[1]?.trim() ?? "";
  const afterWith = withDetail?.[2]?.trim() ?? "";
  const afterPossession = text.match(
    /\b(?:have|has|show|shows|showing|contain|contains|containing|feature|features|featuring)\s+(.+)$/i,
  )?.[1]?.trim();
  const hyphenated = text.match(
    new RegExp(
      `\\b(?:${APPEARANCE_COLOR})[- ](?:flecked|speckled|streaked|ringed|striated|veined)\\b`,
      "i",
    ),
  )?.[0]?.trim();
  const detail =
    patternedWithAccent ||
    (afterWith && EYE_DETAIL_WORDS.test(afterWith) && !EYE_DETAIL_WORDS.test(beforeWith)
      ? afterWith
      : afterPossession && EYE_DETAIL_WORDS.test(afterPossession)
        ? afterPossession
        : hyphenated || text.trim());
  return detail.replace(/[.;,\s]+$/, "").trim();
}

function eyeShapeSource(text: string): string {
  const analogy = text.match(EYE_APPEARANCE_ANALOGY);
  const withDetail = text.match(/\bwith\b/i);
  const withStartsDetail =
    withDetail?.index !== undefined &&
    (
      EYE_DETAIL_WORDS.test(text.slice(withDetail.index)) ||
      EYE_APPEARANCE_ANALOGY.test(text.slice(withDetail.index))
    );
  const cutoffs = [
    analogy?.index,
    withStartsDetail ? withDetail?.index : undefined,
  ].filter((index): index is number => index !== undefined);
  return cutoffs.length > 0 ? text.slice(0, Math.min(...cutoffs)) : text;
}

function exactEyeShape(text: string): string {
  const source = eyeShapeSource(text);
  const detailModifier = new RegExp(
    "^[\\s,/-]*(?:(?:[\\p{L}-]+)[\\s,/-]+){0,2}" +
      "(?:textures?|patterns?|flecks?|specks?|streaks?|rings?|striations?|veins?|mottling|marbling)\\b",
    "iu",
  );
  const matches = source.matchAll(new RegExp(EYE_SHAPE_OR_SIZE.source, "gi"));
  for (const match of matches) {
    const shape = match[0];
    const after = source.slice((match.index ?? 0) + shape.length);
    if (!detailModifier.test(after)) return shape.trim();
  }
  return "";
}

function appearanceSlotPriority(slot: string): number {
  if (slot === "species") return 0;
  if (slot === "gender") return 10;
  if (slot === "ethnicity") return 20;
  if (slot === "age") return 30;
  if (slot === "height") return 40;
  if (slot === "weight") return 45;
  if (slot === "build" || slot.startsWith("build.")) return 50;
  if (slot.startsWith("body.")) return 55;
  if (slot.startsWith("skin.")) return 60;
  if (slot.startsWith("hair.")) return 70;
  if (slot.startsWith("eyes.")) return 80;
  if (slot.startsWith("face.")) return 90;
  if (slot.startsWith("feature:")) return 100;
  if (slot.startsWith("mark:")) return 110;
  if (slot.startsWith("accessory:")) return 120;
  if (slot.startsWith("clothing:")) return 130;
  return 140;
}

function normalizedAppearanceKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function markIdentity(text: string): string {
  const kind =
    text.match(/\b(scar|tattoo|birthmark|piercing|freckle|burn|mark|vitiligo)(?:s| patches)?\b/i)?.[1]?.toLowerCase() ??
    "mark";
  const side = text.match(/\b(left|right)\b/i)?.[1]?.toLowerCase() ?? "";
  const place =
    text.match(/\b(eyebrow|brow|eye|cheek|face|nose|lip|chin|neck|shoulder|arm|hand|finger|chest|back|waist|hip|leg|knee|ankle|foot|ear)s?\b/i)?.[1]?.toLowerCase() ??
    "";
  return `mark:${kind}:${side}:${place}:${appearanceDetailIdentity(text)}`;
}

function appearanceDetailIdentity(text: string): string {
  return normalizedAppearanceKey(
    text
      .replace(
        /\b(?:no longer|not anymore|without|removed?|do not|does not|don['’]t|doesn['’]t|stopped (?:having|wearing)|lost|no)\b/gi,
        " ",
      )
      .replace(/\b(?:has?|have|wears?|the|a|an|any|my|his|her|their|its)\b/gi, " "),
  );
}

function additiveIdentityPrefix(key: string): string {
  const parts = key.split(":");
  return parts[0] === "mark" ? parts.slice(0, 4).join(":") : parts.slice(0, 2).join(":");
}

const APPEARANCE_IDENTITY_STOP_WORDS = new Set([
  "a", "an", "any", "has", "have", "her", "his", "its", "left", "my", "no", "right",
  "the", "their", "with", "without",
]);

function distinctiveAppearanceTokens(text: string): string[] {
  return normalizedAppearanceKey(appearanceDetailIdentity(text))
    .split(" ")
    .filter((token) =>
      token.length > 2 &&
      !APPEARANCE_IDENTITY_STOP_WORDS.has(token) &&
      !/^(?:scar|scars|tattoo|tattoos|birthmark|birthmarks|piercing|piercings|freckle|freckles|burn|burns|mark|marks|feature|features|eye|eyes|eyebrow|eyebrows|brow|brows|cheek|cheeks|face|chin|neck|arm|arms|hand|hands|leg|legs|foot|feet|ear|ears|horn|horns|antler|antlers|tail|tails)$/.test(token),
    );
}

function isBroadMarkRemoval(text: string): boolean {
  if (
    /\b(?:left|right|eyebrow|brow|eye|cheek|face|nose|lip|chin|neck|shoulder|arm|hand|finger|chest|back|waist|hip|leg|knee|ankle|foot|ear)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  return /\b(?:no|without|does not have|doesn't have|no longer has?|no longer have)\s+(?:any\s+)?(?:scars?|tattoos?|birthmarks?|piercings?|freckles?|burns?|marks?)\b/i.test(
    text,
  );
}

function appearanceFieldSlot(label: string): string {
  const key = label.toLowerCase().replace(/\s+/g, " ").trim();
  if (key === "gender" || key === "sex") return "gender";
  if (key === "age") return "age";
  if (key === "ethnicity" || key === "race") return "ethnicity";
  if (key === "height") return "height";
  if (key === "weight") return "weight";
  if (key === "build" || key.startsWith("body")) return "build";
  if (key.startsWith("skin") || key === "complexion") return "skin.tone";
  if (key.startsWith("hair")) return `hair.${key.includes("color") || key.includes("colour") ? "color" : key.includes("length") ? "length" : key.includes("style") || key.includes("texture") ? "style" : "other"}`;
  if (/^(?:(?:left|right)\s+)?eyes?\b/.test(key)) {
    return `eyes.${key.includes("color") || key.includes("colour") ? "color" : key.includes("shape") ? "shape" : "other"}`;
  }
  if (key === "face" || key.startsWith("facial")) return "face.other";
  if (/marks?|scars?|tattoos?|birthmarks?|piercings?/.test(key)) return "mark:other";
  if (key.startsWith("accessor")) return "accessory:other";
  if (/clothing|clothes|outfit/.test(key)) return "clothing:other";
  if (key === "species") return "species";
  if (/nonhuman|features?/.test(key)) return "feature:other";
  return "appearance.other";
}

function appearanceFieldResetPrefix(label: string): string {
  const normalized = label.toLowerCase().replace(/\s+/g, " ").trim();
  if (/^scars?$/.test(normalized)) return "mark:scar";
  if (/^tattoos?$/.test(normalized)) return "mark:tattoo";
  if (/^birthmarks?$/.test(normalized)) return "mark:birthmark";
  if (/^piercings?$/.test(normalized)) return "mark:piercing";
  const slot = appearanceFieldSlot(label);
  if (slot.startsWith("hair.")) return "hair.";
  if (slot.startsWith("eyes.")) return "eyes.";
  if (slot.startsWith("skin.")) return "skin.";
  if (slot.startsWith("face.")) return "face.";
  if (slot.startsWith("mark:")) return "mark:";
  if (slot.startsWith("feature:")) return "feature:";
  if (slot.startsWith("accessory:")) return "accessory:";
  if (slot.startsWith("clothing:")) return "clothing:";
  return slot;
}

function appearanceContributions(
  text: string,
  source: SoulEssenceSource,
  sourceIndex: number,
  sequenceStart: number,
  label = "",
  operation: SoulAppearanceOperation = "set",
  pairedEyeSide = "",
): SoulAppearanceContribution[] {
  const value = text.trim().replace(/^(?:and|with)\s+/i, "").trim();
  if (!value || EMPTY_APPEARANCE_VALUE.test(value)) return [];
  const contributions: SoulAppearanceContribution[] = [];
  let sequence = sequenceStart;
  const add = (
    slot: string,
    exactText = value,
    additive = false,
    key = slot,
  ) => {
    const clean = exactText.trim();
    if (!clean) return;
    const resolvedKey = additive ? key : slot;
    if (contributions.some((fact) => fact.slot === slot && fact.text === clean)) return;
    contributions.push({
      text: clean,
      originText: value,
      originKey: `${source.id}:${sequenceStart}`,
      fieldLabel: label,
      sourceId: source.id,
      sourceIndex,
      sourceAt: source.at,
      sequence: sequence++,
      slot,
      key: resolvedKey,
      additive,
      operation: operation === "remove" ? "remove" : additive ? "add" : "set",
      priority: appearanceSlotPriority(slot),
    });
  };

  const labelledSlot = label ? appearanceFieldSlot(label) : "";
  // A named structured field is authoritative about its family. In particular, "Hair: black"
  // must not also overwrite ethnicity, and "Clothing: short black dress" must not overwrite height
  // or ethnicity. The generic Appearance/Physical description block remains free to contain all.
  const constrainedSlot =
    labelledSlot && labelledSlot !== "appearance.other" ? labelledSlot : "";
  const allows = (prefix: string) =>
    !constrainedSlot || constrainedSlot === prefix || constrainedSlot.startsWith(`${prefix}.`) ||
    constrainedSlot.startsWith(`${prefix}:`);

  const hairMention =
    allows("hair") &&
    (labelledSlot.startsWith("hair.") ||
      /\b(?:hair|braids?|curls?|locs|dreadlocks?|ponytail|bun|bald|shaved|unkempt|sleek)\b/i.test(value));
  if (hairMention) {
    const color = exactMatch(value, HAIR_COLOR_WITH_ANCHOR) ||
      (labelledSlot.startsWith("hair.") ? exactMatch(value, COLOR_ONLY) : "");
    const length = exactMatch(
      value,
      /\b(?:bald|shaved|buzz(?:ed|cut)?|close-cropped|cropped|pixie|short|chin-length|shoulder-length|mid-back|waist-length|floor-length|long|falls? (?:past|to) (?:the )?(?:chin|shoulders?|mid-back|waist))\b/i,
    );
    const style = exactMatch(
      value,
      /\b(?:straight|wavy|curly|curls?|coily|kinky|braided|braids?|locs|dreadlocks?|ponytail|bun|undercut|mohawk|fringe|bangs|messy|unkempt|sleek)\b/i,
    );
    if (color) add("hair.color", color);
    if (length) add("hair.length", length);
    if (style) add("hair.style", style);
    if (!color && !length && !style) add(labelledSlot.startsWith("hair.") ? labelledSlot : "hair.other");
  }

  const facialHairMatch = value.match(
    new RegExp(`\\b(?:${APPEARANCE_COLOR}\\s+)?(beard|moustache|mustache|stubble)\\b`, "i"),
  );
  const facialHair = facialHairMatch?.[0]?.trim() ?? "";
  if (!constrainedSlot && facialHair) {
    const kind =
      facialHairMatch?.[1]?.toLowerCase() === "mustache"
        ? "moustache"
        : facialHairMatch?.[1]?.toLowerCase();
    add("hair.facial", facialHair, true, `hair:facial:${kind ?? "other"}`);
  }

  const eyeMention =
    allows("eyes") &&
    (labelledSlot.startsWith("eyes.") || /\b(?:eyes?|irises?|pupils?|[\p{L}-]+-eyed)\b/iu.test(value));
  if (eyeMention) {
    const eyeContext = `${label} ${value}`;
    const side =
      /\bleft(?:\s+eye)?\b/i.test(eyeContext) ? "left" :
      /\bright(?:\s+eye)?\b/i.test(eyeContext) ? "right" :
      pairedEyeSide ||
      "";
    const color = exactEyeBaseColor(value, labelledSlot);
    const shape = exactEyeShape(value);
    const extractedDetail = exactEyeDetail(value);
    const detail =
      extractedDetail &&
      !color &&
      !shape &&
      labelledSlot.startsWith("eyes.") &&
      /^.+?\bwith\s+.+$/i.test(value)
        ? value.replace(/[.;,\s]+$/, "").trim()
        : extractedDetail;
    if (color) add(`eyes.color${side ? `.${side}` : ""}`, color);
    if (shape) add(`eyes.shape${side ? `.${side}` : ""}`, shape);
    if (detail) {
      add(
        `eyes.detail${side ? `.${side}` : ""}`,
        detail,
        true,
        `eyes:detail:${side}:${appearanceDetailIdentity(detail)}`,
      );
    }
    if (!color && !shape && !detail) add(labelledSlot.startsWith("eyes.") ? labelledSlot : `eyes.other${side ? `.${side}` : ""}`);
  }

  const skinMention =
    allows("skin") &&
    (labelledSlot.startsWith("skin.") || /\b(?:skin|complexion|skinned)\b/i.test(value));
  if (skinMention) {
    const tone = exactMatch(value, SKIN_COLOR_WITH_ANCHOR) ||
      (labelledSlot.startsWith("skin.") ? exactMatch(value, COLOR_ONLY) : "");
    if (tone) add("skin.tone", tone);
    if (!tone) add(labelledSlot.startsWith("skin.") ? labelledSlot : "skin.other");
  }

  const genderText = exactMatch(
    value,
    /\b(?:woman|man|female|male|nonbinary|androgynous(?:\s+person)?)\b/i,
  );
  const combinedDemographic =
    !!genderText &&
    /^(?:(?:i(?:\s+am|['’]m)|you(?:\s+are|['’]re)|(?:she|he|they|the reader|the assistant)\s+(?:is|are))\s+)?(?:(?:a|an)\s+)?(?:black|white|asian|afro[- ]latina?|latina?|latino|indigenous|middle eastern|african|european|hispanic|mixed[- ]race)\s+(?:woman|man|person|female|male|nonbinary)\.?$/i.test(
      value,
    );
  if (
    labelledSlot === "gender" ||
    (
      !constrainedSlot &&
      (
        LOOK_STANDALONE_GENDER.test(value) ||
        combinedDemographic ||
        /^(?:i(?:\s+am|['’]m)|you(?:\s+are|['’]re)|(?:she|he|they|the reader|the assistant)\s+(?:is|are))\s+(?:(?:a|an)\s+)?(?:woman|man|female|male|nonbinary|androgynous(?:\s+person)?)\.?$/i.test(
          value,
        )
      )
    )
  ) add("gender", genderText || value);
  const ethnicityText = exactMatch(
    value,
    /\b(?:black|white|asian|afro[- ]latina?|latina?|latino|indigenous|middle eastern|african|european|hispanic|mixed[- ]race)\b/i,
  );
  if (
    labelledSlot === "ethnicity" ||
    (
      !constrainedSlot &&
      /^(?:(?:i(?:\s+am|['’]m)|you(?:\s+are|['’]re)|(?:she|he|they|the reader|the assistant)\s+(?:is|are))\s+)?(?:(?:a|an)\s+)?(?:black|white|asian|afro[- ]latina?|latina?|latino|indigenous|middle eastern|african|european|hispanic|mixed[- ]race)(?:\s+(?:woman|man|person|female|male|nonbinary))?\.?$/i.test(
        value,
      )
    )
  ) add("ethnicity", ethnicityText || value);
  const ageText = exactMatch(
    value,
    /\b(?:\d{1,3}(?:[- ]year[- ]old| years? old)|(?:(?:early|mid|late)\s+)?(?:teens?|twenties|thirties|forties|fifties|sixties|seventies|eighties)|middle-aged|elderly)\b/i,
  );
  if (
    labelledSlot === "age" ||
    (
      !constrainedSlot &&
      !!ageText
    )
  ) add("age", ageText || value);
  const heightText = exactMatch(
    value,
    /\b(?:height(?:\s+is)?\s+(?:average|medium|tall|short)|(?:average|medium|tall|short)\s+height|tall|short|[3-7]\s*(?:ft|feet|foot)\s*\d{0,2}\s*(?:in|inches)?|[3-7]'\s*\d{1,2}(?:"| inches?)?|(?:[89]\d|1\d{2}|2[0-4]\d)\s*cm)(?=\s|[.,;]|$)/i,
  );
  if (
    labelledSlot === "height" ||
    (!constrainedSlot && !!heightText)
  ) add("height", heightText || value);
  const weightText = exactMatch(
    value,
    /\b(?:weight(?:\s+is)?\s+[^,;.]+|weighs?\s+[^,;.]+|\d+(?:\.\d+)?\s*(?:lbs?|pounds?|kg|kilograms?))\b/i,
  );
  if (
    labelledSlot === "weight" ||
    (!constrainedSlot && !!weightText)
  ) add("weight", weightText || value);
  const bustText = LOOK_PHYSICAL_BUST.test(value)
    ? exactMatch(
      value,
      /\b(?:(?:small|large|full|natural|prominent|modest)\s+){1,4}(?:bust|breasts?)\b/i,
    )
    : "";
  if (!constrainedSlot && bustText) add("body.bust", bustText);
  const buildTexts = buildDescriptionMatches(value);
  if (labelledSlot === "build") {
    if (buildTexts.length > 0) {
      for (const buildText of buildTexts) {
        add(buildAppearanceSlot(buildText, ""), buildText);
      }
    } else {
      add("build", value);
    }
  } else if (!constrainedSlot && buildTexts.length > 0) {
    for (const buildText of buildTexts) {
      add(buildAppearanceSlot(buildText, labelledSlot), buildText);
    }
  }
  const speciesText = exactMatch(
    value,
    /\b(?:human|android|robot|cyborg|elf|fae|fairy|demon|angel|alien|dragon|vampire|werewolf)\b/i,
  );
  if (
    labelledSlot === "species" ||
    (!constrainedSlot && !!speciesText)
  ) add("species", speciesText || value);

  const markMention =
    labelledSlot.startsWith("mark:") ||
    /\b(?:birthmarks?|scars?|tattoos?|piercings?|freckles?|burns?|vitiligo(?:\s+patches?)?)\b/i.test(value);

  if (
    allows("face") &&
    !markMention &&
    (
       labelledSlot.startsWith("face.") ||
      /\b(?:face|facial features?|dimples?|jaw(?:line)?|chin|cheeks?|cheekbones?|nose|lips?|mouth|teeth|eyebrows?|brows?|eyelashes?)\b/i.test(value)
    )
  ) {
    const shape = exactMatch(value, /\b(?:round|oval|angular|square|heart-shaped|narrow|long|broad)\b/i);
    const cheekbones = exactMatch(
      value,
      /\b(?:(?:high|prominent|defined|sharp)\s+)?cheekbones?\b/i,
    );
    if (shape) add("face.shape", shape);
    if (cheekbones) {
      add(
        "face.detail",
        cheekbones,
        true,
        "face:cheekbones",
      );
    }
    if (!shape && !cheekbones) {
      add(
        labelledSlot.startsWith("face.") ? labelledSlot : "face.other",
        value,
        true,
        `face:${appearanceDetailIdentity(value)}`,
      );
    }
  }

  if (
    allows("mark") &&
    markMention
  ) {
    add("mark:detail", value, true, markIdentity(value));
  }

  const feature = value.match(/\b(wings?|horns?|antlers?|tails?|pointed\s+ears?|scales?|fur|feathers?|fangs?|claws?|hooves?|antennae?|tentacles?|fins?|gills?|halo|cybernetic|prosthetic(?:\s+(?:(?:left|right)\s+)?(?:arm|hand|finger|leg|foot|eye|ear))?|missing\s+(?:(?:the|a|an|left|right)\s+){0,2}(?:arm|hand|finger|leg|foot|eye|ear)|calloused\s+(?:arms?|hands?|fingers?|legs?|feet))\b/i)?.[1];
  if (allows("feature") && (labelledSlot.startsWith("feature:") || feature)) {
    const noun =
      feature?.match(/\b(wing|horn|antler|tail|ear|scale|fur|feather|fang|claw|hoof|antenna|tentacle|fin|gill|halo|cybernetic|prosthetic|missing|calloused)/i)?.[1]?.toLowerCase() ??
      "other";
    add("feature:detail", value, true, `feature:${noun}:${appearanceDetailIdentity(value)}`);
  }

  const accessory =
    value.match(/\b(glasses|spectacles|mask|hat|cap|hood|scarf|gloves?|necklace|bracelet|earrings?|rings?|jewell?ery)\b/i)?.[1]?.toLowerCase();
  if (allows("accessory") && (labelledSlot.startsWith("accessory:") || accessory)) {
    const category =
      accessory === "spectacles"
        ? "glasses"
        : accessory === "rings"
          ? "ring"
          : accessory || "other";
    add(
      `accessory:${category}`,
      value,
      !/^(?:glasses|spectacles|mask|hat|cap|hood|scarf|glove)s?$/.test(category),
      `accessory:${category}:${appearanceDetailIdentity(value)}`,
    );
  }

  const clothing =
    value.match(/\b(coat|jacket|cloak|robes?|dress|gown|armou?r|uniform|shirt|tunic|trousers|jeans|boots?|shoes?)\b/i)?.[1]?.toLowerCase();
  if (allows("clothing") && (labelledSlot.startsWith("clothing:") || clothing)) {
    const category =
      !clothing ? "other" :
      /coat|jacket|cloak|robe|armou?r/.test(clothing) ? "outerwear" :
      /shirt|tunic|dress|gown|uniform/.test(clothing) ? "top" :
      /trousers|jeans/.test(clothing) ? "bottom" :
      /boots?|shoes?/.test(clothing) ? "footwear" :
      clothing;
    const garment =
      clothing?.replace(/^(robes?|boots?|shoes?)$/, (word) => word.replace(/s$/, "")) ??
      "other";
    add(
      `clothing:${category}`,
      value,
      true,
      `clothing:${category}:${garment}`,
    );
  }

  if (contributions.length === 0 && labelledSlot) {
    const additive = labelledSlot.startsWith("mark:") || labelledSlot.startsWith("feature:");
    add(labelledSlot, value, additive, `${labelledSlot}:${normalizedAppearanceKey(value)}`);
  }
  return contributions;
}

function isAtomicNaturalEyeDetail(text: string): boolean {
  return (
    (EYE_DETAIL_WORDS.test(text) || EYE_APPEARANCE_ANALOGY.test(text)) &&
    /\b(?:eyes?|irises?|pupils?)\b(?:(?:\s*,[^.;]*,)?\s*)(?:with|have|has|showing|featuring|containing)\b/i.test(
      text,
    )
  );
}

function stripNonDurableEyeAnalogy(text: string): string {
  const analogy = text.match(EYE_APPEARANCE_ANALOGY);
  if (analogy?.index === undefined) return text;
  const suffix = text.slice(analogy.index);
  if (
    !TRANSIENT_EYE_ANALOGY_STATE.test(suffix) &&
    !NONVISUAL_SOUL_WORDS.test(suffix)
  ) return text;
  return text.slice(0, analogy.index).replace(/[,\s]+$/, "").trim();
}

function splitAppearanceAtoms(value: string, forceAppearance: boolean, label = ""): string[] {
  const labelledSlot = label ? appearanceFieldSlot(label) : "";
  const eyeGrounded =
    labelledSlot.startsWith("eyes.") ||
    /\b(?:eyes?|irises?|pupils?)\b/i.test(value);
  const stableValue = eyeGrounded ? stripNonDurableEyeAnalogy(value) : value;
  // In a Soul appearance note, an explicit comparison can be part of the source-exact visual
  // description ("amber flecks, as if catching forest-filtered sunlight"). Preserve that richer
  // appearance wording here; the shared Visual-Bible sanitizer still removes actual scene lighting.
  const preserveEyeAnalogy =
    eyeGrounded &&
    EYE_DETAIL_WORDS.test(stableValue) &&
    SOURCE_EXACT_EYE_COMPARISON.test(stableValue);
  const durable = (
    preserveEyeAnalogy
      ? stableValue.trim()
      : stripTransientCharacterDetailsExact(stableValue).trim()
  );
  if (!durable) return [];
  let parts = durable
    .split(/\s*(?:;|\r?\n)\s*|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  parts = parts.flatMap((part) => {
    const atomicEyeDescription =
      labelledSlot === "eyes.color" ||
      (labelledSlot.startsWith("eyes.") &&
        (EYE_DETAIL_WORDS.test(part) ||
          EYE_APPEARANCE_ANALOGY.test(part) ||
          QUALIFIED_EYE_COLOR_ONLY.test(part))) ||
      isAtomicNaturalEyeDetail(part);
    if (atomicEyeDescription) return [part];
    const pieces = part.split(/\s*,\s*/).map((piece) => piece.trim()).filter(Boolean);
    if (pieces.length < 2) return [part];
    if (buildDescriptionMatches(part).length > 1) return [part];
    if (forceAppearance) return pieces;
    const independentlyVisual = pieces.every(
      (piece) =>
        isLookNote(piece) ||
        isStandaloneAppearanceDescriptor(piece),
    );
    return independentlyVisual ? pieces : [part];
  });
  const splitConjunctions: string[] = [];
  for (const part of parts) {
    if (
      labelledSlot === "eyes.color" ||
      (labelledSlot.startsWith("eyes.") &&
        (EYE_DETAIL_WORDS.test(part) ||
          EYE_APPEARANCE_ANALOGY.test(part) ||
          QUALIFIED_EYE_COLOR_ONLY.test(part))) ||
      isAtomicNaturalEyeDetail(part)
    ) {
      splitConjunctions.push(part);
      continue;
    }
    const match = part.match(/^(.+?)\s+(?:and|but|while)\s+(.+)$/i);
    const left = match?.[1]?.trim() ?? "";
    const right = match?.[2]?.trim() ?? "";
    const visual = (side: string) =>
      isLookNote(side) || isStandaloneAppearanceDescriptor(side);
    const nonVisual = (side: string) =>
      NONVISUAL_SOUL_WORDS.test(side) || isPersonalityDirectionNote(side);
    const wholeBuildMatches = buildDescriptionMatches(part);
    const sameBuild =
      !!match &&
      wholeBuildMatches.length > 1;
    const independentlySeparated =
      (visual(left) && visual(right)) ||
      (visual(left) && nonVisual(right)) ||
      (nonVisual(left) && visual(right));
    if (match && !sameBuild && independentlySeparated) {
      splitConjunctions.push(left, right);
    } else {
      splitConjunctions.push(part);
    }
  }
  return splitConjunctions
    .map((part) => part.replace(/^(?:and|with)\s+/i, "").trim())
    .filter((part) => part && !EMPTY_APPEARANCE_VALUE.test(part))
    .filter((part) => {
      if (!TRANSIENT_VISUAL_FRAGMENT.test(part)) return true;
      return /\b(?:permanent|habitual|signature|fixed|constant|always|smile-shaped|grin-shaped)\b/i.test(part);
    });
}

function chronologicalSoulSources(
  notes: readonly SoulNote[],
): { source: SoulEssenceSource; note: SoulNote; index: number }[] {
  const sources = soulNoteSources(notes);
  return notes
    .map((note, index) => ({ source: sources[index]!, note, index }))
    .sort((a, b) => {
      const aAt = Number.isFinite(a.note.at) ? a.note.at : Number.NEGATIVE_INFINITY;
      const bAt = Number.isFinite(b.note.at) ? b.note.at : Number.NEGATIVE_INFINITY;
      if (aAt !== bAt) return aAt - bAt;
      return a.index - b.index;
    });
}

function analyseAppearanceNote(
  note: SoulNote,
  source: SoulEssenceSource,
  sourceIndex: number,
): SoulAppearanceNoteAnalysis {
  const contributions: SoulAppearanceContribution[] = [];
  const nonVisual: string[] = [];
  let accounted = false;
  let snapshot = false;
  let pendingSnapshot = false;
  let historical = false;
  let appearanceBlock = false;
  let implicitFieldLabel = "";
  let pairedEyeCount = 0;
  let sequence = 0;
  const resetPrefixes: string[] = [];

  const visit = (
    raw: string,
    label = "",
    forceAppearance = false,
    operationOverride?: SoulAppearanceOperation,
  ) => {
    const segment = raw.trim();
    if (!segment) return;
    const personalBuildContrast = segment.match(
      /^(?:i(?:\s+am|['’]m)|you(?:\s+are|['’]re)|(?:she|he|they|the reader|the assistant)\s+(?:is|are))\s+(?:not|no longer)\s+(.+?)\s+but\s+(.+?)[.!]?$/i,
    );
    if (
      personalBuildContrast &&
      buildDescriptionMatches(personalBuildContrast[1]!).length > 0 &&
      buildDescriptionMatches(personalBuildContrast[2]!).length > 0
    ) {
      accounted = true;
      visit(personalBuildContrast[1]!, "", true, "remove");
      visit(personalBuildContrast[2]!, "", true);
      return;
    }
    const personalBuildRemoval = segment.match(
      /^(?:i(?:\s+am|['’]m)|you(?:\s+are|['’]re)|(?:she|he|they|the reader|the assistant)\s+(?:is|are))\s+(?:not|no longer)\s+(.+?)(?:\s+anymore)?[.!]?$/i,
    );
    if (
      personalBuildRemoval &&
      buildDescriptionMatches(personalBuildRemoval[1]!).length > 0
    ) {
      accounted = true;
      visit(personalBuildRemoval[1]!, "", true, "remove");
      return;
    }
    const appearanceGrounded =
      forceAppearance ||
      !!label ||
      isLookNote(segment) ||
      /\b(?:physical (?:description|appearance)|appearance|looked? like)\b/i.test(segment);
    if (!appearanceGrounded) {
      nonVisual.push(segment);
      return;
    }
    const subjectNotAnymore = segment.match(
      /\b(?:(?:my|your|his|her|their|its)\s+)?(hair(?:\s+(?:color|colour|style|texture|length))?|(?:(?:left|right)\s+)?eyes?(?:\s+(?:color|colour|shape))?|skin(?:\s+(?:color|colour|tone))?|complexion|height|weight|build|body(?:\s+type)?|frame|physique|face)\s+(?:(?:is|are)\s+not|isn['’]t|aren['’]t)\s+(.+?)\s+anymore[.!]?$/i,
    );
    if (subjectNotAnymore) {
      accounted = true;
      implicitFieldLabel = subjectNotAnymore[1]!;
      visit(
        subjectNotAnymore[2]!.trim(),
        subjectNotAnymore[1]!,
        true,
        "remove",
      );
      return;
    }
    const subjectRemoval = segment.match(
      /\b(?:(?:my|your|his|her|their|its)\s+)?(hair(?:\s+(?:color|colour|style|texture|length))?|(?:(?:left|right)\s+)?eyes?(?:\s+(?:color|colour|shape))?|skin(?:\s+(?:color|colour|tone))?|complexion|height|weight|build|body(?:\s+type)?|frame|physique|face)\s+(?:is|are|has|have)\s+(?:now\s+)?no longer\s+(.+)$/i,
    );
    if (subjectRemoval) {
      accounted = true;
      implicitFieldLabel = subjectRemoval[1]!;
      visit(subjectRemoval[2]!.trim(), subjectRemoval[1]!, true, "remove");
      return;
    }
    const subjectContrastCorrection = segment.match(
      /\b(?:(?:my|your|his|her|their|its)\s+)?(hair(?:\s+(?:color|colour|style|texture|length))?|(?:(?:left|right)\s+)?eyes?(?:\s+(?:color|colour|shape))?|skin(?:\s+(?:color|colour|tone))?|complexion|height|weight|build|body(?:\s+type)?|frame|physique|face)\s+(?:(?:is|are)\s+not|isn['’]t|aren['’]t)\s+(.+?)\s+but\s+(.+)$/i,
    );
    if (subjectContrastCorrection) {
      accounted = true;
      implicitFieldLabel = subjectContrastCorrection[1]!;
      visit(
        subjectContrastCorrection[2]!.trim(),
        subjectContrastCorrection[1]!,
        true,
        "remove",
      );
      visit(
        subjectContrastCorrection[3]!.trim(),
        subjectContrastCorrection[1]!,
        true,
      );
      return;
    }
    const bodySurfaceFeature =
      /\bbody\s+(?:is|are|has|have)\s+(?:now\s+)?(?:covered|coated|lined)\b.*\b(?:scales?|fur|feathers?)\b/i.test(
        segment,
      );
    const subjectCorrection = bodySurfaceFeature
      ? null
      : segment.match(
        /\b(?:(?:my|your|his|her|their|its)\s+)?(hair(?:\s+(?:color|colour|style|texture|length))?|(?:(?:left|right)\s+)?eyes?(?:\s+(?:color|colour|shape))?|skin(?:\s+(?:color|colour|tone))?|complexion|height|weight|build|body(?:\s+type)?|frame|physique|face)\s+(?:is|are|has|have)\s+(?:now\s+)?(.+)$/i,
      );
    if (subjectCorrection) {
      accounted = true;
      implicitFieldLabel = subjectCorrection[1]!;
      visit(subjectCorrection[2]!.trim(), subjectCorrection[1]!, true);
      return;
    }
    const transition = CURRENT_APPEARANCE_WORDS.exec(segment);
    if (transition && HISTORICAL_APPEARANCE_WORDS.test(segment.slice(0, transition.index))) {
      accounted = true;
      historical = true;
      const current = segment.slice(transition.index + transition[0].length).trim().replace(/^(?:has?|is|are|wears?)\s+/i, "");
      if (current) visit(current, label, true);
      return;
    }
    if (HISTORICAL_APPEARANCE_WORDS.test(segment) && !CURRENT_APPEARANCE_WORDS.test(segment)) {
      accounted = true;
      historical = true;
      for (const atom of splitAppearanceAtoms(segment, false)) {
        if (
          (NONVISUAL_SOUL_WORDS.test(atom) || isPersonalityDirectionNote(atom)) &&
          !isLookNote(atom)
        ) {
          nonVisual.push(atom);
        }
      }
      return;
    }
    const operation: SoulAppearanceOperation =
      operationOverride ??
      (APPEARANCE_REMOVAL_WORDS.test(segment) || /^\s*no\s+/i.test(segment)
        ? "remove"
        : "set");
    const positiveSegment = segment.replace(/\s*,\s*not\b.*$/i, "").trim();
    const atoms = splitAppearanceAtoms(positiveSegment, forceAppearance || !!label, label);
    let found = false;
    for (const atom of atoms) {
      const visual =
        forceAppearance ||
        !!label ||
        isLookNote(atom) ||
        isStandaloneAppearanceDescriptor(atom);
      if (
        !visual ||
        isPersonalityDirectionNote(atom) ||
        (NONVISUAL_SOUL_WORDS.test(atom) && !isLookNote(atom))
      ) {
        nonVisual.push(atom);
        continue;
      }
      const pairedEyeSide =
        /\bone\b.*\beye\b/i.test(atom)
          ? pairedEyeCount++ === 0
            ? "left"
            : "right"
          : "";
      const next = appearanceContributions(
        atom,
        source,
        sourceIndex,
        sequence,
        label,
        operation,
        pairedEyeSide,
      );
      sequence += Math.max(1, next.length);
      if (next.length > 0) {
        contributions.push(...next);
        found = true;
      } else if (!forceAppearance) {
        nonVisual.push(atom);
      }
    }
    if (found || operation === "remove") accounted = true;
  };

  for (const rawLine of note.text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const block = line.match(APPEARANCE_BLOCK_LINE);
    if (block) {
      appearanceBlock = true;
      const wantsSnapshot =
        APPEARANCE_SNAPSHOT_WORDS.test(block[1]!) ||
        /\bphysical\s+(?:description|appearance)\b/i.test(block[1]!);
      accounted = true;
      const before = contributions.length;
      visit(block[2]!, "appearance", true);
      if (wantsSnapshot && contributions.length > before) {
        snapshot = true;
        pendingSnapshot = false;
      } else if (wantsSnapshot && !block[2]!.trim()) {
        // A multiline "Physical description:" header is a snapshot once its first real field
        // arrives. A non-empty placeholder such as "Updated appearance: unknown" is not.
        pendingSnapshot = true;
      }
      continue;
    }
    const field = line.match(APPEARANCE_FIELD_LINE);
    if (field) {
      accounted = true;
      const beforeActions = contributions.length + resetPrefixes.length;
      if (EXPLICIT_EMPTY_APPEARANCE_VALUE.test(field[2]!.trim())) {
        resetPrefixes.push(appearanceFieldResetPrefix(field[1]!));
      } else {
        if (/^build$/i.test(field[1]!.trim())) {
          // An explicit Build field is authoritative as a whole, but its parsed dimensions remain
          // independently patchable by later Body/build details.
          resetPrefixes.push("build");
        }
        visit(field[2]!, field[1]!, true);
      }
      if (
        pendingSnapshot &&
        contributions.length + resetPrefixes.length > beforeActions
      ) {
        snapshot = true;
        pendingSnapshot = false;
      }
      // A structured field is a patch, not a whole-field snapshot. "Eyes: green" changes colour
      // while retaining an independently stored shape; full Physical description blocks are the
      // explicit replace-all boundary.
      continue;
    }
    const parts = line.split(/\s*;\s*|(?<=[.!?])\s+/).filter(Boolean);
    for (const part of parts) {
      const implicitCorrection =
        implicitFieldLabel &&
        part.match(/^(?:they|it|these|those)\s+(?:is|are)\s+(?:now\s+)?(.+)$/i);
      if (implicitCorrection) {
        accounted = true;
        visit(implicitCorrection[1]!.trim(), implicitFieldLabel, true);
        continue;
      }
      const durablePart = stripTransientCharacterDetailsExact(part).trim();
      if (
        TRANSIENT_VISUAL_FRAGMENT.test(part) &&
        !durablePart &&
        (accounted || appearanceBlock || isLookNote(part) || TRANSIENT_SCENE_ACTION.test(part))
      ) {
        accounted = true;
        continue;
      }
      const clearlyNonVisual =
        NONVISUAL_SOUL_WORDS.test(part) || isPersonalityDirectionNote(part);
      const forced = appearanceBlock && !clearlyNonVisual;
      if (forced || isLookNote(part) || HISTORICAL_APPEARANCE_WORDS.test(part) || APPEARANCE_REMOVAL_WORDS.test(part)) {
        const before = contributions.length;
        visit(part, "", forced);
        if (pendingSnapshot && contributions.length > before) {
          snapshot = true;
          pendingSnapshot = false;
        }
      } else {
        nonVisual.push(part.trim());
      }
    }
  }

  return {
    contributions,
    accounted,
    snapshot,
    historical,
    nonVisualText: nonVisual.filter(Boolean).join("; "),
    resetPrefixes,
  };
}

/**
 * Reconcile the Soul's append-only appearance history into one current, source-exact projection.
 * Singleton fields are patches (newest wins); marks and nonhuman features are additive unless a
 * later tombstone or explicit current/updated snapshot removes them.
 */
export function reconcileSoulAppearance(notes: readonly SoulNote[]): SoulAppearanceProjection {
  const singleton = new Map<string, SoulAppearanceContribution>();
  const additive = new Map<string, SoulAppearanceContribution>();
  const accounted = new Set<string>();
  const superseded = new Set<string>();
  const historical = new Set<string>();
  const nonVisualTextBySourceId: Record<string, string> = {};
  const contributionsByOrigin = new Map<string, SoulAppearanceContribution[]>();
  const corroboratingSourceIds = new Map<SoulAppearanceContribution, string[]>();

  const retire = (fact: SoulAppearanceContribution | undefined) => {
    if (fact) superseded.add(fact.sourceId);
  };
  const retireSingleton = (
    slot: string,
    includeSubslots: boolean,
    preserveExact = false,
  ) => {
    for (const [key, prior] of singleton) {
      if (preserveExact && key === slot) continue;
      if (
        key === slot ||
        (includeSubslots && key.startsWith(`${slot}.`)) ||
        (!includeSubslots && slot.startsWith(`${key}.`))
      ) {
        retire(prior);
        singleton.delete(key);
      }
    }
  };
  const retireBuildAxis = (fact: SoulAppearanceContribution) => {
    const axis = buildAppearanceAxis(fact.slot);
    if (!axis) return false;
    for (const [slot, prior] of singleton) {
      if (
        (slot === "build" || slot.startsWith(`${axis}.`)) &&
        prior.originKey !== fact.originKey
      ) {
        retire(prior);
        singleton.delete(slot);
      }
    }
    return true;
  };
  for (const { source, note, index } of chronologicalSoulSources(notes)) {
    const analysis = analyseAppearanceNote(note, source, index);
    if (analysis.nonVisualText) nonVisualTextBySourceId[source.id] = analysis.nonVisualText;
    if (analysis.accounted) accounted.add(source.id);
    if (analysis.historical) historical.add(source.id);
    for (const contribution of analysis.contributions) {
      if (contribution.operation === "remove") continue;
      const origin = contributionsByOrigin.get(contribution.originKey) ?? [];
      origin.push(contribution);
      contributionsByOrigin.set(contribution.originKey, origin);
    }
    if (analysis.snapshot) {
      for (const fact of singleton.values()) retire(fact);
      for (const fact of additive.values()) retire(fact);
      singleton.clear();
      additive.clear();
    }
    for (const prefix of analysis.resetPrefixes) {
      for (const [slot, prior] of singleton) {
        if (slot === prefix || slot.startsWith(prefix)) {
          retire(prior);
          singleton.delete(slot);
        }
      }
      for (const [key, prior] of additive) {
        if (key === prefix || key.startsWith(prefix)) {
          retire(prior);
          additive.delete(key);
        }
      }
    }
    for (const fact of analysis.contributions) {
      if (fact.operation === "remove") {
        if (fact.additive) {
          const scaleRemovalTarget =
            fact.slot === "feature:detail" && /\bscales?\b/i.test(fact.text)
              ? fact.text.replace(
                /^(?:(?:i|you|she|he|they|the reader|the assistant|the character)\s+(?:has|have)\s+no|no\s+longer\s+(?:has|have)|without(?:\s+any)?|no)\s+/i,
                "",
              )
              : fact.text;
          const removeByCategory =
            (fact.slot.startsWith("mark:") && isBroadMarkRemoval(fact.text)) ||
            (
              fact.slot === "feature:detail" &&
              /^scales?[.!]?$/i.test(scaleRemovalTarget.trim())
            );
          const categoryPrefix = fact.key.split(":").slice(0, 2).join(":");
          const identityPrefix = additiveIdentityPrefix(fact.key);
          const candidates = [...additive].filter(([key]) =>
            removeByCategory
              ? key.startsWith(`${categoryPrefix}:`)
              : additiveIdentityPrefix(key) === identityPrefix,
          );
          let removals = candidates.filter(([key]) => key === fact.key);
          if (removeByCategory) {
            removals = candidates;
          } else if (removals.length === 0) {
            const targetTokens = distinctiveAppearanceTokens(scaleRemovalTarget);
            const qualified = candidates.filter(([, prior]) => {
              const priorTokens = new Set(distinctiveAppearanceTokens(prior.text));
              return targetTokens.length > 0 &&
                targetTokens.every((token) => priorTokens.has(token));
            });
            if (qualified.length === 1) removals = qualified;
            else if (targetTokens.length === 0 && candidates.length === 1) removals = candidates;
          }
          for (const [key, prior] of removals) {
            retire(prior);
            additive.delete(key);
          }
        } else {
          const broadSingletonField =
            fact.slot === "eyes.color" ||
            fact.slot === "eyes.shape" ||
            fact.slot === "build";
          retireSingleton(fact.slot, broadSingletonField);
        }
        continue;
      }
      if (fact.operation === "add") {
        const prior = additive.get(fact.key);
        if (prior && prior.text !== fact.text) retire(prior);
        if (prior?.text === fact.text) {
          corroboratingSourceIds.set(
            fact,
            [...new Set([
              ...(corroboratingSourceIds.get(prior) ?? [prior.sourceId]),
              fact.sourceId,
            ])],
          );
        }
        additive.set(fact.key, fact);
      } else {
        const broadSingletonField =
          fact.slot === "eyes.color" ||
          fact.slot === "eyes.shape" ||
          fact.slot === "build";
        if (!retireBuildAxis(fact)) {
          retireSingleton(fact.slot, broadSingletonField, true);
        }
        const prior = singleton.get(fact.slot);
        if (prior && prior.text !== fact.text) retire(prior);
        if (prior?.text === fact.text) {
          corroboratingSourceIds.set(
            fact,
            [...new Set([
              ...(corroboratingSourceIds.get(prior) ?? [prior.sourceId]),
              fact.sourceId,
            ])],
          );
        }
        singleton.set(fact.slot, fact);
      }
    }
  }

  const current = [...singleton.values(), ...additive.values()]
    .sort((a, b) =>
      a.priority - b.priority ||
      b.sourceAt - a.sourceAt ||
      b.sourceIndex - a.sourceIndex ||
      a.sequence - b.sequence
    );
  const currentSet = new Set(current);
  const currentByOrigin = new Map<string, SoulAppearanceContribution[]>();
  for (const fact of current) {
    const group = currentByOrigin.get(fact.originKey) ?? [];
    group.push(fact);
    currentByOrigin.set(fact.originKey, group);
  }
  const outputFacts: SoulAppearanceContribution[] = [];
  const handledOrigins = new Set<string>();
  for (const fact of current) {
    if (handledOrigins.has(fact.originKey)) continue;
    handledOrigins.add(fact.originKey);
    const activeGroup = currentByOrigin.get(fact.originKey) ?? [fact];
    const completeGroup = contributionsByOrigin.get(fact.originKey) ?? [];
    const separatesEyeColorAndDetail =
      completeGroup.some((candidate) => candidate.slot.startsWith("eyes.color")) &&
      completeGroup.some((candidate) => candidate.slot.startsWith("eyes.detail"));
    if (
      completeGroup.length > 0 &&
      !separatesEyeColorAndDetail &&
      completeGroup.every((candidate) => currentSet.has(candidate))
    ) {
      const outputFact = { ...fact, text: fact.originText };
      outputFacts.push(outputFact);
      const corroborating = corroboratingSourceIds.get(fact);
      if (corroborating) corroboratingSourceIds.set(outputFact, corroborating);
    } else {
      outputFacts.push(...activeGroup);
    }
  }
  outputFacts.sort((a, b) =>
    a.priority - b.priority ||
    b.sourceAt - a.sourceAt ||
    b.sourceIndex - a.sourceIndex ||
    a.sequence - b.sequence
  );
  const activeFacts: SoulEssenceAppearanceFact[] = [];
  const activeFactByKey = new Map<string, SoulEssenceAppearanceFact>();
  for (const fact of outputFacts) {
    const needsAnchor =
      fact.text !== fact.originText ||
      (!!fact.fieldLabel && fact.fieldLabel.toLowerCase() !== "appearance");
    const slot = needsAnchor ? fact.slot : undefined;
    const key = JSON.stringify([fact.text, slot ?? null]);
    const existing = activeFactByKey.get(key);
    const sourceIds = corroboratingSourceIds.get(fact) ?? [fact.sourceId];
    if (existing) {
      for (const sourceId of sourceIds) {
        if (!existing.sourceIds.includes(sourceId)) existing.sourceIds.push(sourceId);
      }
    } else {
      const activeFact = {
        text: fact.text,
        sourceIds: [...sourceIds],
        ...(slot ? { slot } : {}),
      };
      activeFacts.push(activeFact);
      activeFactByKey.set(key, activeFact);
    }
  }
  return {
    activeFacts,
    accountedSourceIds: [...accounted],
    supersededSourceIds: [...superseded],
    historicalSourceIds: [...historical],
    nonVisualTextBySourceId,
  };
}

/**
 * The soul notes that describe an APPEARANCE, for seeding a played character's look.
 *
 * A soul is a mixed bag — how someone looks, how they speak, what they care about — and only the
 * first kind is any use to an image model. Handing it the lot is worse than handing it nothing:
 * "I'm drawn to problems where the obvious answer is wrong" as a visual descriptor is pure noise the
 * model still tries to draw, and with per-character regions on, that noise gets concentrated into
 * that character's own patch of canvas.
 *
 * That was the first beat of every story: the setup joined EVERY note, cut the result at 200
 * characters (mid-word, often), and seeded it as the character's look. It only stopped mattering
 * once extraction had read a beat or two and filled in real appearance fields — which is exactly why
 * the opening image was poor and a later re-render was fine.
 *
 * Current source-grounded visual facts only, ordered by identity priority and then correction
 * recency, up to `budget` characters. If no complete fact fits, the highest-priority current fact is
 * retained as a word-safe prefix rather than dropped.
 * Returns "" when nothing looks like a description — better a character the model renders neutrally
 * than one it renders from a personality note. PURE.
 */
export const SOUL_LOOK_BUDGET_CHARS = MAX_CHARACTER_DESCRIPTOR_CHARS;

/** Render a source-exact fact with its semantic slot when the exact span is otherwise ambiguous. */
export function renderSoulAppearanceFact(fact: SoulEssenceAppearanceFact): string {
  const text = fact.text.trim();
  const slot = fact.slot ?? "";
  if (slot.startsWith("hair.") && !/\b(?:hair|braid|curl|locs?|ponytail|bun)\b/i.test(text)) {
    return `hair ${slot.slice("hair.".length)}: ${text}`;
  }
  if (slot.startsWith("eyes.") && !/\b(?:eyes?|irises?|pupils?)\b/i.test(text)) {
    return `eye ${slot.split(".")[1] ?? "detail"}: ${text}`;
  }
  if (slot.startsWith("skin.") && !/\b(?:skin|complexion)\b/i.test(text)) {
    return `skin ${slot.slice("skin.".length)}: ${text}`;
  }
  if (slot.startsWith("face.") && !/\b(?:face|facial features?|jaw|chin|cheeks?|cheekbones?|nose|lips?|mouth)\b/i.test(text)) {
    return `face ${slot.slice("face.".length)}: ${text}`;
  }
  if (slot.startsWith("build.") && !/\b(?:build|body|frame|physique|shoulders?)\b/i.test(text)) {
    return `build: ${text}`;
  }
  const scalarLabel: Record<string, string> = {
    age: "age",
    gender: "gender",
    ethnicity: "ethnicity/race",
    height: "height",
    weight: "weight",
    build: "build",
    species: "species",
  };
  const label = scalarLabel[slot];
  if (label && !new RegExp(`\\b${label.split("/")[0]}\\b`, "i").test(text)) {
    return `${label}: ${text}`;
  }
  return text;
}

function renderSoulAppearanceFacts(
  facts: readonly SoulEssenceAppearanceFact[],
  budget: number,
): string {
  const kept: string[] = [];
  let used = 0;
  let highestPriorityOversized = "";
  for (const fact of facts) {
    const text = renderSoulAppearanceFact(fact);
    const cost = text.length + (kept.length ? 2 : 0); // "; "
    if (used + cost > budget) {
      // Do not let one long paragraph starve later atomic identity fields. Remember it only as a
      // last-resort prefix when no complete current fact fits at all.
      if (!highestPriorityOversized) highestPriorityOversized = text;
      continue;
    }
    kept.push(text);
    used += cost;
  }
  if (kept.length === 0 && highestPriorityOversized && budget > 0) {
    const prefix = highestPriorityOversized
      .slice(0, budget + 1)
      .replace(/\s+\S*$/, "")
      .replace(/[;,:\s]+$/, "");
    return prefix || highestPriorityOversized.slice(0, budget);
  }
  return kept.join("; ");
}

export function visualSoulNotes(notes: readonly SoulNote[], budget = SOUL_LOOK_BUDGET_CHARS): string {
  return renderSoulAppearanceFacts(reconcileSoulAppearance(notes).activeFacts, budget);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * When an in-chat image is of the ASSISTANT ITSELF, fold its identity "soul" appearance into the
 * image prompt so "draw yourself" reliably renders its real look (the soul is otherwise only TEXT in
 * the model's context, which it may or may not apply). Triggers when the prompt names the assistant
 * (whole word) OR self-references it ("yourself", "a selfie", "portrait/picture of you", "draw you").
 * Returns the prompt UNCHANGED when it isn't about the assistant or there's no look to add (so an
 * ordinary "draw an apple" is untouched).
 *
 * `request` is what gets TESTED, defaulting to the prompt itself. They are usually different things:
 * the prompt is what the MODEL wrote for the render, and the reader said "generate an image of
 * yourself". A model that paraphrases into "a portrait of a woman in a garden" has dropped every
 * word this looks for — so the Soul's photos and look were skipped for a request that could not have
 * been clearer. The caller passes the reader's own words alongside.
 */
export function selfPortraitPrompt(
  prompt: string,
  name: string,
  notes: readonly SoulNote[],
  request = prompt,
): string {
  if (!prompt.trim() || !isSelfPortraitRequest(request, name)) return prompt;
  return foldSoulLook(prompt, name, notes, "the assistant");
}

/** Symmetric to selfPortraitPrompt for the USER soul — when the image is of the READER ("draw me", "a
 * picture of me", their character name), fold the user soul's appearance into the prompt. */
export function userPortraitPrompt(
  prompt: string,
  name: string,
  notes: readonly SoulNote[],
  request = prompt,
): string {
  if (!prompt.trim() || !isUserPortraitRequest(request, name)) return prompt;
  return foldSoulLook(prompt, name, notes, "the reader");
}

/**
 * A request for a picture of the assistant AND the reader together — "you and me", "me and you",
 * "us both", "the two of us".
 *
 * Neither single-subject test catches these on its own. "draw you and me on a beach" reads as a
 * self-portrait (it says "draw you") and NOT as a picture of the reader, because the reader test
 * deliberately requires "draw me" and refuses "draw me a castle". So a two-hander carried one face
 * and the other person — named in the same sentence — came out a stranger. PURE.
 */
function isPairRequest(p: string): boolean {
  return (
    /\b(you|us)\s+and\s+(me|i)\b/.test(p) ||
    /\bme\s+and\s+(you|us)\b/.test(p) ||
    /\bus\s+(together|both)\b/.test(p) ||
    /\bboth\s+of\s+us\b/.test(p) ||
    /\bthe\s+two\s+of\s+us\b/.test(p)
  );
}

/** True when an image request is of the ASSISTANT itself — it names the assistant (whole word) or
 * self-references it ("yourself", "a selfie", "portrait of you", "draw you"), or asks for the two of
 * them together. */
export function isSelfPortraitRequest(prompt: string, name: string): boolean {
  const p = prompt.toLowerCase();
  const t = name.trim();
  const named = !!t && new RegExp(`\\b${escapeRegExp(t.toLowerCase())}\\b`).test(p);
  return (
    named ||
    /\byourself\b/.test(p) ||
    /\ba selfie\b/.test(p) ||
    /\b(portrait|picture|photo|image|drawing|painting|selfie|avatar|likeness)\s+of\s+you\b/.test(p) ||
    /\b(draw|paint|render|generate|make|create)\s+you\b/.test(p) ||
    /\byour\s+(self-?portrait|portrait|avatar|likeness)\b/.test(p) ||
    isPairRequest(p)
  );
}

/** True when an image request is of the READER — names their character or self-references them
 * ("myself", "a picture of me", "my portrait", "draw me" — but NOT "draw me a/an/the …", which is
 * "make something FOR me", not a portrait OF me). */
export function isUserPortraitRequest(prompt: string, name: string): boolean {
  const p = prompt.toLowerCase();
  const t = name.trim();
  const named = !!t && new RegExp(`\\b${escapeRegExp(t.toLowerCase())}\\b`).test(p);
  return (
    named ||
    /\bmyself\b/.test(p) ||
    /\b(portrait|picture|photo|image|drawing|painting|selfie|avatar|likeness)\s+of\s+me\b/.test(p) ||
    /\bmy\s+(self-?portrait|portrait|avatar|likeness)\b/.test(p) ||
    /\b(draw|paint|render|sketch)\s+me\b(?!\s+(a|an|the|some|this|that|one)\b)/.test(p) ||
    isPairRequest(p)
  );
}

/** Append the soul's appearance to a prompt (no-op when the soul has no look notes). */
function foldSoulLook(prompt: string, name: string, notes: readonly SoulNote[], fallback: string): string {
  // Portrait prompts historically separate source notes with commas; keep that surface while using
  // the same filtered/capped appearance selection as story character seeding.
  const look = visualSoulNotes(notes).replace(/;\s+/g, ", ");
  if (!look) return prompt;
  return `${prompt} — depict ${name.trim() || fallback} with this appearance: ${look}`;
}
