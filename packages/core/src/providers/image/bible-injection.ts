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

const STOP = new Set(["with", "and", "the", "her", "his", "their", "a", "an", "of", "in", "on"]);

/** Does the prompt paraphrase an outfit — i.e. contain a distinctive 2-word content phrase from its
 * label/description ("crimson gown" matching label "red gown", description "crimson silk gown")? The
 * runtime fallback for older Bibles where the exact label wasn't written into the prompt. */
function outfitDescribedIn(prompt: string, o: Outfit): boolean {
  const words = `${o.label} ${o.description}`.toLowerCase().match(/\p{L}{3,}/gu) ?? [];
  const content = words.filter((w) => !STOP.has(w));
  for (let i = 0; i < content.length - 1; i++) {
    if (mentions(prompt, `${content[i]} ${content[i + 1]}`)) return true;
  }
  return false;
}

/**
 * Deterministically dress the present cast: append the EXACT stored outfit label for each character
 * the storyboard tagged for this scene (KeyEvent.cast), so every downstream path (CLIP inject, the
 * reference block, local family-aware expansion) surfaces the right clothes — without depending on
 * the render LLM re-naming the outfit. A no-op when the prompt already names the character + label.
 */
export function appendSceneWardrobe(
  prompt: string,
  cast: readonly { name: string; outfit?: string }[] | undefined,
  bible: VisualBible,
): string {
  if (!cast || cast.length === 0) return prompt;
  const clauses: string[] = [];
  for (const entry of cast) {
    const label = (entry.outfit ?? "").trim();
    const name = (entry.name ?? "").trim();
    if (!label || !name) continue;
    const c = bible.characters.find((ch) => [ch.name, ...ch.aliases].some((n) => n.toLowerCase() === name.toLowerCase()));
    if (!c) continue;
    const outfit = (c.outfits ?? []).find((o) => o.label.toLowerCase() === label.toLowerCase());
    if (!outfit) continue;
    if (mentions(prompt, c.name) && mentions(prompt, outfit.label)) continue; // already there
    clauses.push(`${c.name} in ${outfit.label}`);
  }
  return clauses.length ? `${prompt} (Wardrobe: ${clauses.join("; ")}.)` : prompt;
}

/**
 * Every entity's PRIMARY name, lowercased. A primary name belongs to exactly one entity, so no other
 * entity's ALIAS may claim it — see {@link ownForms}.
 */
function primaryNames(bible: VisualBible): Set<string> {
  const out = new Set<string>();
  const add = (n: string | undefined): void => {
    const k = (n ?? "").trim().toLowerCase();
    if (k) out.add(k);
  };
  for (const c of bible.characters) add(c.name);
  for (const cr of bible.creatures ?? []) add(cr.name);
  for (const e of bible.environments) add(e.name);
  return out;
}

/**
 * The surface forms an entity may actually claim: its own name, plus any alias that ISN'T someone
 * else's primary name.
 *
 * Models hand out aliases freely, and they collide with real names — a character called "Rell" gets
 * the alias "the Captain" while another character IS "The Captain". Left alone, that alias made Rell
 * match any prompt mentioning the Captain, put Rell in the reference block for a scene he isn't in,
 * and — in inject mode, where each name is swapped for its descriptor — handed the Captain's name
 * RELL's face. Two characters in the prompt, a third one's features on one of them.
 *
 * A primary name is the specific, deliberate form; an alias that duplicates one is a collision, not a
 * mention. (The same reasoning as `sameNamedPerson` in extraction, which refuses to merge on shared
 * aliases for exactly this reason.)
 */
function ownForms(entity: { name: string; aliases?: readonly string[] }, primaries: ReadonlySet<string>): string[] {
  const own = entity.name.trim().toLowerCase();
  return [entity.name, ...(entity.aliases ?? [])]
    .filter(Boolean)
    .filter((f) => {
      const k = f.trim().toLowerCase();
      return !!k && (k === own || !primaries.has(k));
    });
}

/**
 * Which of these forms actually CLAIM a piece of the prompt.
 *
 * One greedy left-to-right pass with the forms ordered longest-first, so an enclosing name takes the
 * span and the shorter name inside it never sees it. This is what stops a character being counted as
 * present because the scene happens to be set in a place named after them: "Mara sits alone in Rell's
 * Tavern" mentions Mara and the Tavern — not Rell. It's the SAME scan (and the same ordering) that
 * `injectBibleTerms` uses to substitute, so what a prompt is judged to mention and what gets replaced
 * in it can't disagree.
 *
 * Returns the set of forms (lowercased) that won a span.
 */
function claimedForms(prompt: string, forms: readonly { form: string }[]): Set<string> {
  const claimed = new Set<string>();
  if (forms.length === 0) return claimed;
  const alt = forms.map((f) => escapeRegExp(f.form)).join("|");
  const re = new RegExp(`(^|[^\\p{L}\\p{N}(])(${alt})(['’]s)?(?=[^\\p{L}\\p{N}]|$)`, "giu");
  for (const m of prompt.matchAll(re)) claimed.add((m[2] ?? "").toLowerCase());
  return claimed;
}

/**
 * Scan a finished prompt for the bible terms it mentions. Characters, creatures, and
 * locations are matched by name/alias — each name claiming its span longest-first, so a name that
 * only occurs INSIDE a longer one (a place named after someone) isn't a mention of the shorter.
 * Outfit labels are matched **only when their owning character is also named in the prompt**, so a
 * generic label ("cloak", "armor") never over-triggers from incidental prose.
 */
export function findBibleTermsInText(prompt: string, bible: VisualBible): SceneTerm[] {
  const primaries = primaryNames(bible);
  // EVERY entity's forms first, so the claim pass can see the long ones — a term can only be ruled
  // out by a longer name that's also in the bible, and that name has to be in the running to do it.
  const charForms = bible.characters.map((c) => ownForms(c, primaries));
  const creatureForms = (bible.creatures ?? []).map((cr) => ownForms(cr, primaries));
  const envForms = bible.environments.map((e) => ownForms(e, primaries));
  const seen = new Set<string>();
  const all: { form: string }[] = [];
  for (const forms of [...charForms, ...creatureForms, ...envForms]) {
    for (const raw of forms) {
      const form = raw.trim();
      const k = form.toLowerCase();
      if (!form || seen.has(k)) continue;
      seen.add(k);
      all.push({ form });
    }
  }
  // Longest first: that ordering IS the rule that gives an enclosing name the span.
  all.sort((a, b) => b.form.length - a.form.length);
  const claimed = claimedForms(prompt, all);
  const claims = (forms: readonly string[]): boolean => forms.some((f) => claimed.has(f.trim().toLowerCase()));

  const terms: SceneTerm[] = [];
  bible.characters.forEach((c, i) => {
    const forms = charForms[i]!;
    if (!claims(forms)) return;
    terms.push({ names: forms, descriptor: describeCharacterIdentity(c), kind: "character" });
    // Outfit labels only for a character that IS named here.
    let matched = false;
    for (const o of c.outfits ?? []) {
      if (o.label && mentions(prompt, o.label)) {
        terms.push({ names: [o.label], descriptor: describeOutfit(o), kind: "outfit" });
        matched = true;
      }
    }
    // Fallback (older Bibles without a per-scene cast tag): the LLM paraphrased or omitted the label.
    // A single known outfit is unambiguous; otherwise match one by a distinctive description phrase.
    if (!matched && (c.outfits?.length ?? 0) > 0) {
      const guess = c.outfits!.length === 1 ? c.outfits![0]! : c.outfits!.find((o) => outfitDescribedIn(prompt, o));
      if (guess) terms.push({ names: [guess.label], descriptor: describeOutfit(guess), kind: "outfit" });
    }
  });

  (bible.creatures ?? []).forEach((cr, i) => {
    if (claims(creatureForms[i]!)) terms.push({ names: creatureForms[i]!, descriptor: describeCreature(cr), kind: "creature" });
  });

  // Aliases cover indirect references ("the fortress" → Basgiliath's details).
  bible.environments.forEach((e, i) => {
    if (claims(envForms[i]!)) terms.push({ names: envForms[i]!, descriptor: describeLocation(e), kind: "location" });
  });

  return terms;
}

/** Build the name→descriptor lookup, longest surface form first (so "Violet
 * Sorrengail" / "flight leathers" win over shorter substrings). */
function orderedForms(terms: readonly SceneTerm[]): { form: string; descriptor: string }[] {
  const out: { form: string; descriptor: string; primary: boolean }[] = [];
  for (const t of terms) {
    t.names.forEach((name, i) => {
      const form = name.trim();
      // names[0] is the entity's own name by construction everywhere a SceneTerm is built.
      if (form && t.descriptor) out.push({ form, descriptor: t.descriptor, primary: i === 0 });
    });
  }
  // LONGEST first — "Violet Sorrengail" beats "Violet", and "Rell's Tavern" beats the "Rell" inside
  // it. Ordering primaries ahead of aliases outright (as this briefly did) breaks exactly that: a
  // character's own short name then won against a longer place ALIAS containing it, and the place got
  // the character's face. Ownership is only the tie-break, for two entities laying claim to the SAME
  // string — which is the collision it was added for.
  const seen = new Set<string>();
  return out
    .sort((a, b) => (b.form.length !== a.form.length ? b.form.length - a.form.length : a.primary === b.primary ? 0 : a.primary ? -1 : 1))
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
