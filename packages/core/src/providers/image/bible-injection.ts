import type { Character, Creature, Environment, Outfit, VisualBible } from "../../types/bible.js";

/**
 * Bible-term expansion for image prompts.
 *
 * Illustration prompts are written **provider-neutral**, referring to characters,
 * creatures, outfits, and locations by their book-specific *name/label* (e.g.
 * "Violet rides Tairn in her flight leathers"). The Visual Bible is the single link
 * from each term to its visual descriptors. How that link is applied depends on the
 * image target's text-encoder grade:
 *
 *  - **inject** (CLIP/T5 encoders — SD1.5, SDXL, Flux.1): names mean nothing, so each
 *    term is replaced *in place* with its descriptor → "(woman, brown hair…) rides
 *    (dragon, massive, black…)". `injectBibleTerms`.
 *  - **reference** (LLM-grade encoders — Flux.2/Mistral, Gemini, GPT-image): these
 *    track a name↔description glossary well, so the names stay in the sentence and a
 *    compact reference block is prepended. `buildReferenceBlock`.
 *
 * `findBibleTermsInText` scans a finished prompt for the bible terms it mentions, so
 * app-written and externally-imported prompts expand identically (no stored snapshot).
 * Pure + dependency-free, so it's fully unit-testable.
 */

/** A bible term found in a prompt, with its visual descriptor. */
export interface SceneTerm {
  /** Name + aliases / outfit label — every surface form to match in the prompt. */
  names: string[];
  /** Visual descriptor injected in its place (or listed in the reference block). */
  descriptor: string;
  kind: "character" | "creature" | "outfit" | "location";
}

/** Cap a descriptor so accumulated multi-chapter detail can't bloat the prompt. */
const MAX_DESCRIPTOR_CHARS = 160;

function capDescriptor(parts: readonly string[]): string {
  const joined = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(", ");
  return joined.length <= MAX_DESCRIPTOR_CHARS
    ? joined
    : `${joined.slice(0, MAX_DESCRIPTOR_CHARS).replace(/,?\s+\S*$/, "")}`;
}

/** Identity-only descriptor for a character (no outfit — that's a separate term). */
export function describeCharacterIdentity(c: Character): string {
  const a = c.appearance;
  const fields: string[] = [];
  if (a) {
    // Identity-defining fields in priority order (mirrors the old buildSubject).
    for (const v of [a.gender, a.age, a.hair, a.distinguishingMarks, a.eyes, a.build, a.skinTone]) {
      if (v && v.trim()) fields.push(v.trim());
    }
  }
  if (fields.length === 0) {
    for (const t of c.persistentTraits) if (t && t.trim()) fields.push(t.trim());
  }
  return capDescriptor(fields.length ? fields : ["person"]);
}

/** Descriptor for a creature: kind + accumulated visual description. */
export function describeCreature(c: Creature): string {
  return capDescriptor([c.kind, ...c.description].filter((t) => t && t.trim()));
}

/** Descriptor for an outfit: its garment description. */
export function describeOutfit(o: Outfit): string {
  return capDescriptor([o.description || o.label]);
}

/** Condensed descriptor for a location. */
export function describeLocation(e: Environment): string {
  return capDescriptor(e.description);
}

/** Regex-escape a literal term. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does `term` appear in `haystack` as a whole word (case-insensitive)? */
function mentions(haystack: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(t)}([^\\p{L}\\p{N}]|$)`, "iu").test(haystack);
}

/**
 * Scan a finished prompt for the bible terms it mentions. Characters, creatures, and
 * locations are matched by name/alias. Outfit labels are matched **only when their
 * owning character is also named in the prompt**, so a generic label ("cloak",
 * "armor") never over-triggers from incidental prose.
 */
export function findBibleTermsInText(prompt: string, bible: VisualBible): SceneTerm[] {
  const terms: SceneTerm[] = [];

  for (const c of bible.characters) {
    const forms = [c.name, ...c.aliases].filter(Boolean);
    if (!forms.some((f) => mentions(prompt, f))) continue;
    terms.push({ names: forms, descriptor: describeCharacterIdentity(c), kind: "character" });
    // Outfit labels only for a character that IS named here.
    for (const o of c.outfits ?? []) {
      if (o.label && mentions(prompt, o.label)) {
        terms.push({ names: [o.label], descriptor: describeOutfit(o), kind: "outfit" });
      }
    }
  }

  for (const cr of bible.creatures ?? []) {
    const forms = [cr.name, ...cr.aliases].filter(Boolean);
    if (forms.some((f) => mentions(prompt, f))) {
      terms.push({ names: forms, descriptor: describeCreature(cr), kind: "creature" });
    }
  }

  for (const e of bible.environments) {
    // Aliases cover indirect references ("the fortress" → Basgiliath's details).
    const forms = [e.name, ...(e.aliases ?? [])].filter(Boolean);
    if (forms.some((f) => mentions(prompt, f))) {
      terms.push({ names: forms, descriptor: describeLocation(e), kind: "location" });
    }
  }

  return terms;
}

/** Build the name→descriptor lookup, longest surface form first (so "Violet
 * Sorrengail" / "flight leathers" win over shorter substrings). */
function orderedForms(terms: readonly SceneTerm[]): { form: string; descriptor: string }[] {
  const out: { form: string; descriptor: string }[] = [];
  for (const t of terms) {
    for (const name of t.names) {
      const form = name.trim();
      if (form && t.descriptor) out.push({ form, descriptor: t.descriptor });
    }
  }
  // Longest first; de-dupe identical forms keeping the first (its descriptor).
  const seen = new Set<string>();
  return out
    .sort((a, b) => b.form.length - a.form.length)
    .filter((x) => {
      const k = x.form.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/**
 * Replace each mentioned bible term in the prompt with `(descriptor)` — for CLIP/T5
 * encoders that can't render an identity from a name. One regex pass with alternation
 * sorted longest-first, so an inserted descriptor is never re-scanned. Possessives are
 * preserved ("Violet's" → "(…)'s").
 */
export function injectBibleTerms(prompt: string, terms: readonly SceneTerm[]): string {
  const forms = orderedForms(terms);
  if (forms.length === 0) return prompt;
  const byForm = new Map(forms.map((f) => [f.form.toLowerCase(), f.descriptor]));
  const alt = forms.map((f) => escapeRegExp(f.form)).join("|");
  // Whole-word, case-insensitive, optional possessive; skip a match already opened by "(".
  const re = new RegExp(`(^|[^\\p{L}\\p{N}(])(${alt})(['’]s)?(?=[^\\p{L}\\p{N}]|$)`, "giu");
  return prompt.replace(re, (_m, lead: string, name: string, poss: string | undefined) => {
    const descriptor = byForm.get(name.toLowerCase());
    if (!descriptor) return `${lead}${name}${poss ?? ""}`;
    return `${lead}(${descriptor})${poss ?? ""}`;
  });
}

/** Title-case a term kind for the reference block heading. */
const KIND_HEADING: Record<SceneTerm["kind"], string> = {
  character: "Characters",
  creature: "Creatures",
  outfit: "Outfits",
  location: "Places",
};

/**
 * A compact reference block prepended to a prompt for LLM-grade encoders (Flux.2,
 * Gemini, GPT-image): the names stay in the sentence and this glossary supplies their
 * look, plus the book title and world style. Returns "" when there's nothing to add.
 */
export function buildReferenceBlock(
  terms: readonly SceneTerm[],
  worldStyle?: string,
  bookTitle?: string,
): string {
  const hasTerms = terms.some((t) => t.descriptor.trim());
  const style = sanitizeWorldStyle(worldStyle);
  // A title on its own isn't worth a block — only add context when there are terms or a style.
  if (!hasTerms && !style) return "";
  const lines: string[] = [];
  if (bookTitle && bookTitle.trim()) lines.push(`Title: ${bookTitle.trim()}.`);
  if (style) lines.push(`Style: ${style}.`);
  for (const kind of ["character", "creature", "outfit", "location"] as const) {
    const ofKind = terms.filter((t) => t.kind === kind && t.descriptor.trim());
    if (ofKind.length === 0) continue;
    const entries = ofKind.map((t) => `${t.names[0]} = ${t.descriptor}`).join("; ");
    lines.push(`${KIND_HEADING[kind]}: ${entries}.`);
  }
  return lines.join(" ");
}

/**
 * Strip model/checkpoint junk that must never appear in an art-direction line. A book's
 * `worldStyle` is meant to be prose like "moody cinematic sci-fi" — but it can get
 * contaminated with a model filename or id (e.g. "SD_XL_Base_1_0", "flux1-dev.safetensors"),
 * which then rides into EVERY image prompt as a `Style:` clause and looks like the chosen
 * model changed. This removes filenames (`*.safetensors/.ckpt/.gguf/.pt/.bin`) and bare
 * base-model ids (sd_xl_base_1.0, sdxl, sd15, flux1-dev, …), leaving real style words. Pure;
 * returns "" if nothing usable remains. Applied at both read time (fixes existing books
 * without re-extraction) and write time (extraction).
 */
export function sanitizeWorldStyle(worldStyle?: string): string {
  if (!worldStyle) return "";
  const out = worldStyle
    // checkpoint/model weight filenames
    .replace(/\b[\w.-]*\.(safetensors|ckpt|gguf|pt|bin)\b/gi, " ")
    // bare base-model ids commonly echoed by a model: sd_xl_base_1.0, SD_XL_Base_1_0, sdxl_base
    .replace(/\bsd[_\s.-]?xl[_\s.-]?(base|refiner|turbo)?[_\s.-]?[\d._]*\b/gi, " ")
    // other bare family/version ids that aren't art direction
    .replace(/\b(sd[_\s.-]?1[._-]?5|sd15|flux[_\s.-]?\d?[_\s.-]?(dev|schnell|klein|pro)?|juggernaut\w*|realvis\w*)\b/gi, " ")
    // tidy up the separators left behind
    .replace(/\s*,\s*,\s*/g, ", ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;.\-_]+|[\s,;.\-_]+$/g, "")
    .trim();
  return out;
}

/** The world-style clause appended to an injected (CLIP/T5) prompt. "" when unset. */
export function worldStyleClause(worldStyle?: string): string {
  return sanitizeWorldStyle(worldStyle);
}

/** Paragraph prefixes that are machine scaffolding, not scene description. */
const SCAFFOLD_PREFIX = /^(Title|Style|Layout|Characters|Creatures|Outfits|Places|Setting reference):\s/;

/**
 * The human-readable caption for a rendered prompt: the scene sentence(s) WITHOUT the
 * machine scaffolding around them — the leading reference block (`Title: … Style: …
 * Characters: …`) and the trailing `Style:` / `Layout:` paragraphs. The full prompt stays
 * persisted for troubleshooting (the UI offers it behind a toggle); this is just the
 * friendly view. Falls back to the input when stripping would leave nothing.
 */
export function displayCaption(prompt: string): string {
  const paragraphs = prompt.split(/\n{2,}/);
  const kept = paragraphs.filter((p) => !SCAFFOLD_PREFIX.test(p.trim()));
  const out = kept.join("\n\n").trim();
  return out || prompt;
}

/**
 * Expand a prompt for a target, given its `nameHandling`. `inject` replaces terms in
 * place and appends the world-style clause; `reference` keeps names and prepends the
 * reference block. Used by the local backends and by the pipeline's cloud pre-expansion.
 */
export function expandPrompt(
  prompt: string,
  terms: readonly SceneTerm[],
  nameHandling: "inject" | "reference",
  worldStyle?: string,
  bookTitle?: string,
): string {
  if (nameHandling === "reference") {
    const block = buildReferenceBlock(terms, worldStyle, bookTitle);
    return block ? `${block}\n\n${prompt}` : prompt;
  }
  const injected = injectBibleTerms(prompt, terms);
  const style = worldStyleClause(worldStyle);
  return style ? `${injected}\n\nStyle: ${style}` : injected;
}
