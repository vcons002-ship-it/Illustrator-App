import type { Character, Creature, Environment, Outfit, VisualBible } from "../../types/bible.js";
import {
  drawableDetail,
  drawableTraits,
  firstAppearanceVariant,
  stripTransientCharacterDetails,
} from "../../visual-bible/character-details.js";

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

/**
 * Cap a descriptor so accumulated multi-chapter detail can't bloat the prompt.
 *
 * A creature, an outfit or a place is a phrase — "massive, black, scarred wings", "crimson silk
 * gown", "cramped, blinking consoles". This bound is comfortable for those.
 */
const MAX_DESCRIPTOR_CHARS = 160;
/**
 * A PERSON gets more room. 160 characters is under two lines: "silver hair falling past the
 * shoulders, sharp grey eyes, late forties, lean, wears a long charcoal coat" is already at the
 * limit before you reach a scar, a build, or a skin tone — so the detail the Visual Bible spent
 * chapters accumulating was being cut off before it reached the picture, silently.
 *
 * ~320 characters is roughly 80 tokens: one CLIP chunk for a single character on an SD checkpoint,
 * and nothing at all to the natural-language encoders (Flux, Z-Image, Qwen-Image, HiDream), which
 * read hundreds of tokens comfortably. It stays a cap rather than becoming unbounded, because a
 * scene with a full cast injects one of these PER PERSON.
 */
export const MAX_CHARACTER_DESCRIPTOR_CHARS = 320;

function capDescriptor(parts: readonly string[], budget = MAX_DESCRIPTOR_CHARS): string {
  const joined = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(", ");
  return joined.length <= budget ? joined : `${joined.slice(0, budget).replace(/,?\s+\S*$/, "")}`;
}

/**
 * The same, with weather taken out — for descriptors where weather is never a fact about the thing
 * being described. See {@link stripWeather} for which those are and why.
 */
function capBodyDescriptor(parts: readonly string[], budget = MAX_DESCRIPTOR_CHARS): string {
  return capDescriptor(parts.map(stripWeather), budget);
}

/**
 * Identity-only descriptor for a character (no outfit — that's a separate term).
 *
 * Two things here exist to stop one person's features landing on another, which is what this
 * descriptor is FOR and what it was quietly undermining:
 *
 * ANCHOR THE ADJECTIVES. The fields are stored bare — hair is "short brown", eyes are "wide,
 * expectant" — and joining them gave "male, short brown, beard, wide, expectant": a bag of loose
 * adjectives, none of which say what they describe. Meanwhile a phrase that DOES carry its noun
 * ("cybernetic eye") is the most bindable thing in the sentence, so the model attaches it to
 * whichever face it finds most salient rather than to its owner. Each field now names its own
 * subject unless the text already does.
 *
 * SAY IT ONCE. `distinguishingMarks` and `eyes` routinely overlap — "cybernetic eye" in one and
 * "one cybernetic eye that whirs as it focuses" in the other — and repeating a feature doubles its
 * weight in a prompt where every other person is competing for it. The more specific wording wins
 * and the duplicate goes.
 */
export function describeCharacterIdentity(c: Character): string {
  const a = c.appearance;
  const fields: string[] = [];
  if (a) {
    // Identity-defining fields in priority order (mirrors the old buildSubject), each with the noun
    // it describes when it needs one.
    // `one` marks a field describing a SINGLE attribute, where accumulated re-wordings are competing
    // answers rather than extra features — see firstAppearanceVariant. The two list fields
    // (distinguishing marks, notes) keep every entry.
    for (const [v, noun, one] of [
      [a.gender, "", true],
      [a.age, "", true],
      [a.height, "", true],
      [a.hair, "hair", true],
      [a.distinguishingMarks, "", false],
      [a.eyes, "eyes", true],
      // Build is left alone: it's already stored as a body phrase ("petite but voluptuous, ample
      // bust"), and anchoring it produced "…ample bust build".
      [a.build, "", true],
      [a.skinTone, "skin", true],
      // Free-form notes are where an exact appearance imported from the reader's "You" data lives.
      // It must remain drawable even after story analysis fills one or two structured fields.
      [a.notes, "", false],
    ] as const) {
      const durable = stripTransientCharacterDetails(v);
      const named = anchorField(drawableDetail(one ? firstAppearanceVariant(durable) : durable), noun);
      if (named) fields.push(named);
    }
  }
  // Older story imports seeded the "You" description here. Include it alongside structured fields
  // rather than only as an all-or-nothing fallback, so re-analysis cannot hide that stored look —
  // but only the traits that describe how someone LOOKS. The rest of this list is personality and
  // biography, which cannot be drawn and drowns out what can (see drawableTraits).
  for (const t of drawableTraits(c.persistentTraits)) fields.push(t);
  return capBodyDescriptor(dedupeFragments(fields.length ? fields : ["person"]), MAX_CHARACTER_DESCRIPTOR_CHARS);
}

/**
 * Words that already say what part of a person is being described. A field containing any of them
 * is left exactly as written.
 *
 * The check is deliberately across ALL of them rather than per-field, because the fields are not
 * kept as tidily as their names suggest: `hair` routinely holds "grey beard", "shaved head" or
 * "close-cropped, wire glasses". Appending the field's own noun to those gives "grey beard hair",
 * which is worse than the bare adjectives it was meant to fix.
 */
const APPEARANCE_NOUNS =
  /\b(hairs?|beards?|moustaches?|mustaches?|braids?|plaits?|ponytails?|buns?|locs|dreadlocks?|afro|bald|shaved|buzzcut|heads?|curls?|fringe|bangs|sideburns|stubble|topknot|undercut|mohawk|glasses|spectacles|eyes?|gaze|stare|pupils?|patch|scars?|skin|complexion|tanned?|freckles?|faces?|jaw|brows?|nose)\b/i;

/**
 * A stored appearance field with its subject attached — "short brown" → "short brown hair" — unless
 * the text already names a part of the body ({@link APPEARANCE_NOUNS}). "" for a blank field. PURE.
 */
function anchorField(value: string, noun: string): string {
  const v = (value ?? "").trim().replace(/[.,;]+$/, "");
  if (!v || !noun || APPEARANCE_NOUNS.test(v)) return v;
  return `${v} ${noun}`;
}

/**
 * Drop fragments already said by another, keeping the more specific wording in the earlier
 * position. Containment either way counts: "cybernetic eye" and "one cybernetic eye that whirs as
 * it focuses" are one feature described twice, and saying it twice is what makes it travel. PURE.
 *
 * Containment alone was not enough. Two chapters describing the same feature in their own words —
 * "cybernetic eye that whirs as it focuses" and "a whirring cybernetic eye" — contain neither, so
 * both survived and the feature arrived at DOUBLE weight in a prompt where every other face is
 * competing for it. That is the mechanism that put Sato's eye on Nico. So a shared body part plus a
 * shared describing word is also one feature: see {@link sameFeature}.
 */
function dedupeFragments(parts: readonly string[]): string[] {
  const kept: string[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const key = part.toLowerCase();
    const covers = kept.findIndex((k) => {
      const other = k.toLowerCase();
      return other.includes(key) || key.includes(other) || sameFeature(key, other);
    });
    if (covers === -1) {
      kept.push(part);
    } else if (part.length > kept[covers]!.length) {
      kept[covers] = part; // the longer wording is the more specific one — keep it, in place
    }
  }
  return kept;
}

/** Words too common to make two fragments about the same thing. */
const FEATURE_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "with", "that", "which", "as", "it", "its", "is", "are",
  "her", "his", "their", "one", "two", "both", "in", "on", "to", "for", "by", "has", "have",
]);

/**
 * Whether two fragments describe the SAME feature in different words: they name the same body part
 * ({@link APPEARANCE_NOUNS}) and share at least one other meaningful word.
 *
 * Both conditions matter. The shared part alone would merge "grey eyes" with "one blind eye", which
 * are two facts about two eyes; the shared adjective alone would merge "dark hair" with "dark skin".
 * Together they mean the fragments agree on both what is being described and something about it —
 * which is what a re-wording is. PURE.
 */
function sameFeature(a: string, b: string): boolean {
  const partA = a.match(APPEARANCE_NOUNS)?.[0]?.toLowerCase();
  const partB = b.match(APPEARANCE_NOUNS)?.[0]?.toLowerCase();
  if (!partA || !partB || partA !== partB) return false;
  const words = (t: string): Set<string> =>
    new Set(
      t
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 2 && w !== partA && !FEATURE_STOPWORDS.has(w))
        // "whirring" and "whirs" are the same word for this purpose; a crude stem is enough.
        .map((w) => w.replace(/(?:ing|ed|es|s)$/u, "")),
    );
  const wa = words(a);
  for (const w of words(b)) if (wa.has(w)) return true;
  return false;
}

/** Descriptor for a creature: kind + accumulated visual description. */
export function describeCreature(c: Creature): string {
  return capBodyDescriptor([c.kind, ...c.description].filter((t) => t && t.trim()));
}

/** Descriptor for an outfit: its garment description. */
export function describeOutfit(o: Outfit): string {
  return capBodyDescriptor([o.description || o.label]);
}

/**
 * Condensed descriptor for a location — weather KEPT.
 *
 * A place is the one entity weather is genuinely about, and it only reaches a picture when that
 * place is in it. Stripping it here is what cost the world its atmosphere: a beat whose prose is all
 * dialogue has nothing else to say what the light and air are like, and the pictures stopped
 * agreeing with each other about the world they were in.
 */
export function describeLocation(e: Environment): string {
  return capDescriptor(e.description);
}

/**
 * Precipitation and storms. Weather belongs to some things and not others, and the line between
 * them is what this module gets right or wrong.
 *
 * WEATHER IS KEPT for a PLACE (`describeLocation`) and for the world facts the prompt writer is
 * given (`promptUserContent`). Those are the two things weather is actually about, and both are
 * SCOPED: a place's description reaches a picture only when that place is in it, and world facts
 * are explicitly "defaults unless the passage says otherwise". This is where a book's atmosphere
 * lives — take it away and a beat that is all dialogue has nothing to say what the light and air
 * are like, and consecutive pictures stop agreeing about the world they are in. That regression is
 * exactly why this doc is worded so emphatically.
 *
 * WEATHER IS STRIPPED from anything that follows a subject around regardless of where they are:
 * a character's appearance, a creature's, an outfit, the book's art-direction line (`worldStyle`)
 * and its TITLE. Those go into every picture. A character first described in a downpour otherwise
 * keeps "rain-plastered hair" forever; a story titled from a rainy premise rains indoors months of
 * story later. Nothing ever takes it back out, because nothing else ever revisits those fields.
 *
 * Neither case touches the beat's own scene prompt, which is where a particular scene's weather
 * belongs and where the writing model puts it.
 */
const WEATHER =
  /\b(rain|rains|raining|rainy|rainfall|raindrops?|downpour|drizzle|drizzling|storm|storms|storming|stormy|thunderstorms?|thunder|thundering|lightning|snow|snows|snowing|snowy|snowfall|snowdrifts?|blizzard|sleet|hail|hailstones?|monsoon|torrential|squall|deluge)\b/i;

/**
 * Drop the clauses of `text` that describe weather, keeping the rest. A sentence that was ONLY
 * weather goes entirely; a clause inside one ("a low stone tavern, rain drumming on the roof, warm
 * firelight") is cut out and its neighbours kept. Returns "" when nothing survives. PURE.
 *
 * A clause that mixes weather with something else ("the streets are rain-slicked and neon-lit")
 * loses both — clause-level is as fine-grained as this can be without parsing English. That trade is
 * deliberate: the neon comes back the moment a scene is actually set on those streets, whereas the
 * rain, left in, follows the book indoors forever.
 */
export function stripWeather(text: string): string {
  if (!text || !WEATHER.test(text)) return text ?? "";
  // Split into sentences by scanning, not by lookbehind — not every engine this ships to has it.
  const sentences: string[] = [];
  let buf = "";
  for (const ch of text) {
    buf += ch;
    if (ch === "." || ch === "!" || ch === "?") {
      sentences.push(buf);
      buf = "";
    }
  }
  if (buf.trim()) sentences.push(buf);
  const kept = sentences
    .map((sentence) => {
      const stop = /[.!?]+\s*$/.exec(sentence)?.[0]?.trim() ?? "";
      const body = stop ? sentence.slice(0, sentence.length - stop.length) : sentence;
      const clauses = body
        .split(/\s*[;,]\s*/)
        .filter((c) => c.trim() && !WEATHER.test(c));
      return clauses.length > 0 ? `${clauses.join(", ").trim()}${stop}` : "";
    })
    .filter((s) => s.trim());
  return kept.join(" ").replace(/\s{2,}/g, " ").trim();
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
 * Who a stored beat DECLARES is in this shot, as distinct people.
 *
 * The cast recorded on a keyEvent is the extraction model's per-beat statement of who is in the
 * frame, written while it had the prose in front of it. That is a different and much smaller set
 * than the people resolved as "present": a page scan returns everyone the page NAMES — including
 * those merely remembered, discussed, or spoken about — and a story beat's tracked cast is who is in
 * the ROOM across the beat. Either one, used as a subject count, describes a crowd that isn't there.
 *
 * Resolved to bible entities so a nickname and a real name are one person, with an unresolvable name
 * kept as itself rather than dropped (it is still someone the beat says is in the shot). Returns an
 * empty list when the beat declares no cast — the caller then falls back to whoever is present.
 */
export function castSubjects(
  cast: readonly { name: string; outfit?: string }[] | undefined,
  bible: VisualBible,
): { name: string }[] {
  if (!cast || cast.length === 0) return [];
  const out: { name: string }[] = [];
  const seen = new Set<string>();
  for (const entry of cast) {
    const name = (entry.name ?? "").trim();
    if (!name) continue;
    const character = bible.characters.find((ch) =>
      [ch.name, ...ch.aliases].some((n) => n.toLowerCase() === name.toLowerCase()),
    );
    const key = (character?.id ?? name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: character?.name ?? name });
  }
  return out;
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
  // OUTFIT LABELS TOO. An outfit is an entity with a name of its own, and that name belongs to the
  // clothes. Extraction records a costume identity as both an outfit and a nickname — "Ghost
  // Broker" — and left claimable, "Lyra wears her Ghost Broker outfit" put a full head-to-toe
  // description of LYRA inside the clothing clause: a second whole person in the sentence, which
  // the image model duly drew. Reserved globally rather than per-character, so it holds when the
  // colliding nickname belongs to somebody ELSE too.
  for (const c of bible.characters) for (const o of c.outfits ?? []) add(o.label);
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
function ownForms(
  entity: { name: string; aliases?: readonly string[] },
  primaries: ReadonlySet<string>,
): string[] {
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
 * Returns two sets of forms (lowercased): every one that won a span, and the subset that won one
 * NAMING ITSELF rather than something named after it — see {@link namesSomethingElse}.
 */
function claimedForms(prompt: string, forms: readonly { form: string }[]): { any: Set<string>; itself: Set<string> } {
  const any = new Set<string>();
  const itself = new Set<string>();
  if (forms.length === 0) return { any, itself };
  const alt = forms.map((f) => escapeRegExp(f.form)).join("|");
  const re = new RegExp(`(^|[^\\p{L}\\p{N}(])(${alt})(['’]s)?(?=[^\\p{L}\\p{N}]|$)`, "giu");
  for (const m of prompt.matchAll(re)) {
    const form = (m[2] ?? "").toLowerCase();
    any.add(form);
    const rest = prompt.slice((m.index ?? 0) + m[0].length);
    if (!(m[3] && namesSomethingElse(rest))) itself.add(form);
  }
  return { any, itself };
}

/**
 * After a possessive, does a CAPITALISED word follow — "Rell's **T**avern", "Mara's **D**iner"?
 *
 * That's the shape of a proper name for something else, and it's how a place named after somebody put
 * that person in the picture. Longest-first matching only rules it out once the place is in the
 * bible, and it usually ISN'T yet: extraction runs in the background while the new beat's image is
 * pushed to the front of the queue, so the beat that first walks into Rell's Tavern renders before
 * the Tavern exists as an entity. This catches that beat.
 *
 * Only the possessive-plus-capital form. "Rell's hand trembled" is lower-case and stays a mention of
 * Rell — as it should be, he's plainly there. And this only suppresses an occurrence, never the
 * character: named anywhere else in the same prompt, they're present as usual.
 */
function namesSomethingElse(rest: string): boolean {
  return /^\s+\p{Lu}/u.test(rest);
}

/**
 * Scan a finished prompt for the bible terms it mentions. Characters, creatures, and
 * locations are matched by name/alias — each name claiming its span longest-first, so a name that
 * only occurs INSIDE a longer one (a place named after someone) isn't a mention of the shorter.
 * `sceneLocation` is the beat's place as extraction named it: claimable, so it takes its own span
 * even before it's a bible entity, but never a term in its own right.
 * Outfit labels are matched **only when their owning character is also named in the prompt**, so a
 * generic label ("cloak", "armor") never over-triggers from incidental prose.
 */
export function findBibleTermsInText(prompt: string, bible: VisualBible, sceneLocation?: string): SceneTerm[] {
  const primaries = primaryNames(bible);
  // EVERY entity's forms first, so the claim pass can see the long ones — a term can only be ruled
  // out by a longer name that's also in the bible, and that name has to be in the running to do it.
  const charForms = bible.characters.map((c) => ownForms(c, primaries));
  const creatureForms = (bible.creatures ?? []).map((cr) => ownForms(cr, primaries));
  const envForms = bible.environments.map((e) => ownForms(e, primaries));
  const seen = new Set<string>();
  const all: { form: string }[] = [];
  // The beat's LOCATION as extraction wrote it, even when it isn't a bible entity yet — it usually
  // isn't on the beat that first walks in. Claimable but never a term of its own: it exists here only
  // to take its own span, so "in rell's tavern" (lower-case, or with no possessive at all) can't be
  // read as a mention of Rell. This is a fact from extraction, not a guess about the phrasing.
  const place = (sceneLocation ?? "").trim();
  if (place) {
    seen.add(place.toLowerCase());
    all.push({ form: place });
  }
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
  const claims = (forms: readonly string[], from: ReadonlySet<string>): boolean =>
    forms.some((f) => from.has(f.trim().toLowerCase()));

  const terms: SceneTerm[] = [];
  bible.characters.forEach((c, i) => {
    const forms = charForms[i]!;
    // A CHARACTER needs an occurrence that names them — not just one inside "<their name>'s Somewhere".
    // Drawing a person into a room merely because it carries their name is the failure this prevents;
    // for places and creatures the same shape is harmless, so they take any occurrence.
    if (!claims(forms, claimed.itself)) return;
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
    if (claims(creatureForms[i]!, claimed.any)) terms.push({ names: creatureForms[i]!, descriptor: describeCreature(cr), kind: "creature" });
  });

  // Aliases cover indirect references ("the fortress" → Basgiliath's details).
  bible.environments.forEach((e, i) => {
    if (claims(envForms[i]!, claimed.any)) terms.push({ names: envForms[i]!, descriptor: describeLocation(e), kind: "location" });
  });

  return terms;
}

/** Build the name→descriptor lookup, longest surface form first (so "Violet
 * Sorrengail" / "flight leathers" win over shorter substrings). */
function orderedForms(terms: readonly SceneTerm[]): { form: string; descriptor: string; owner: string }[] {
  const out: { form: string; descriptor: string; primary: boolean; owner: string }[] = [];
  for (const t of terms) {
    // names[0] is the entity's own name by construction everywhere a SceneTerm is built — so it
    // identifies the ENTITY, whichever of its names a given occurrence used.
    const owner = (t.names[0] ?? "").trim().toLowerCase();
    t.names.forEach((name, i) => {
      const form = name.trim();
      if (form && t.descriptor) out.push({ form, descriptor: t.descriptor, primary: i === 0, owner });
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
export function injectBibleTerms(
  prompt: string,
  terms: readonly SceneTerm[],
  sceneLocation?: string,
  /** Keep the name and add the descriptor beside it ("Nico (a man with a beard)") instead of
   * replacing it. See the `appositive` mode in {@link expandPrompt}. */
  opts: { keepName?: boolean } = {},
): string {
  const forms = orderedForms(terms);
  if (forms.length === 0) return prompt;
  const byForm = new Map(forms.map((f) => [f.form.toLowerCase(), f]));
  // The beat's place is in the alternation but NOT in byForm, so it consumes its own span and comes
  // back unchanged. Without it, a character who IS in the scene still had their descriptor spliced
  // into the place named after them — "in the (shaved head) Tavern", which tells the image model the
  // tavern is a man. Longest-first ordering is what gives it the span over the name inside it.
  const place = (sceneLocation ?? "").trim();
  const scan =
    place && !byForm.has(place.toLowerCase())
      ? [...forms, { form: place, descriptor: "", owner: "" }].sort((a, b) => b.form.length - a.form.length)
      : forms;
  const described = new Set<string>();
  const alt = scan.map((f) => escapeRegExp(f.form)).join("|");
  // Whole-word, case-insensitive, optional possessive; skip a match already opened by "(".
  const re = new RegExp(`(^|[^\\p{L}\\p{N}(])(${alt})(['’]s)?(?=[^\\p{L}\\p{N}]|$)`, "giu");
  return prompt.replace(re, (m: string, lead: string, name: string, poss: string | undefined, offset: number, whole: string) => {
    const hit = byForm.get(name.toLowerCase());
    const descriptor = hit?.descriptor;
    // "Rell's Tavern" keeps its name even when Rell IS in the scene — the place is called that, and
    // swapping in his face there says the tavern looks like a man.
    if (!descriptor || (poss && namesSomethingElse(whole.slice(offset + m.length)))) {
      return `${lead}${name}${poss ?? ""}`;
    }
    // ONE PERSON, ONE DESCRIPTION — keyed by the ENTITY, not by the word used for them. Keying it
    // on the matched form meant a character mentioned once by name and once by nickname ("Lyra …
    // her Ghost Broker outfit", "Rell … the Captain") was described in full TWICE, which reads as
    // two people and is drawn as two people. Whichever of their names comes first carries the
    // description; every later mention, by any name, is just the name.
    if (opts.keepName) {
      if (described.has(hit!.owner)) return `${lead}${name}${poss ?? ""}`;
      described.add(hit!.owner);
      // BEFORE the possessive: "Nico (a man with a beard)'s wrist". After it — "Nico's (a man with
      // a beard) wrist" — the description sits between the owner and the thing owned, where it
      // reads as describing the WRIST.
      return `${lead}${name} (${descriptor})${poss ?? ""}`;
    }
    return `${lead}(${descriptor})${poss ?? ""}`;
  });
}

/** How a prompt names the entities it depicts — see {@link expandPrompt}. */
export type NameHandling = "inject" | "reference" | "appositive";

/**
 * A book title with its weather taken out, WORD by word rather than clause by clause.
 *
 * A title is a label, not prose: "A Rainy Night in Blackwater" is a single clause, so the ordinary
 * clause-level {@link stripWeather} would delete the whole thing and lose Blackwater with it — and
 * the title is the one line in the block that says which world this is. Removing just the weather
 * word keeps that.
 */
export function titleWithoutWeather(title: string): string {
  return (title ?? "")
    .replace(new RegExp(WEATHER.source, "gi"), " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;.–—-]+|[\s,;.–—-]+$/g, "")
    .trim();
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
  // The title rides into EVERY prompt this book ever renders, which makes it the same kind of
  // permanent statement as the world style — and a story titled from its opening premise carries
  // that premise's weather with it. "A Rainy Night in Blackwater" rained on every later picture,
  // indoors and months of story later, from a line nobody thought of as a prompt at all.
  const title = titleWithoutWeather(bookTitle ?? "");
  if (title) lines.push(`Title: ${title}.`);
  if (style) lines.push(`Style: ${style}.`);
  for (const kind of ["character", "creature", "outfit", "location"] as const) {
    const ofKind = terms.filter((t) => t.kind === kind && t.descriptor.trim());
    if (ofKind.length === 0) continue;
    const entries = ofKind.map((t) => `${t.names[0]} = ${t.descriptor}`).join("; ");
    // With SEVERAL people in frame, say plainly that the lists don't mix.
    //
    // This is the only lever these models give us. Attribute bleed between subjects is a known
    // failure of every diffusion text encoder, and it gets worse with each person added; the usual
    // remedy — a negative prompt per subject — is unavailable on the natural-language families
    // (Flux and friends run at CFG 1 with embedded guidance, so the negative branch is never
    // evaluated and `resolveNegative` returns "" for them). What DOES help on an LLM-grade encoder
    // is naming the binding explicitly, so the glossary reads as a set of separate people rather
    // than a bag of features. It isn't a guarantee, and nothing text-only can be.
    const bindingRule =
      kind === "character" && ofKind.length > 1
        ? " Each description belongs to that person ONLY — do not give one person another's hair," +
          " age, build, clothing, or features."
        : "";
    lines.push(`${KIND_HEADING[kind]}: ${entries}.${bindingRule}`);
  }
  return lines.join(" ");
}

/**
 * Strip model/checkpoint junk that must never appear in an art-direction line. A book's
 * `worldStyle` is meant to be prose like "moody cinematic sci-fi" — but it can get
 * contaminated with a model filename or id (e.g. "SD_XL_Base_1_0", "flux1-dev.safetensors"),
 * which then rides into EVERY image prompt as a `Style:` clause and looks like the chosen
 * model changed. This removes filenames (`*.safetensors/.ckpt/.gguf/.pt/.bin`) and bare
 * base-model ids (sd_xl_base_1.0, sdxl, sd15, flux1-dev, …), leaving real style words.
 *
 * It also strips WEATHER ({@link stripWeather}). A style line is applied to every image in the book,
 * so a downpour that got into it rains on the indoor scenes too — see that function for why weather
 * can't live in anything that outlives a scene.
 *
 * Pure; returns "" if nothing usable remains. Applied at both read time (fixes existing books
 * without re-extraction) and write time (extraction).
 */
export function sanitizeWorldStyle(worldStyle?: string): string {
  if (!worldStyle) return "";
  const out = stripWeather(worldStyle)
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
 * Machine instructions that sit INSIDE the scene paragraph rather than in one of their own.
 *
 * Paragraph-level scaffolding was easy to drop; these were not, so the caption opened with
 * "Exactly two people in focus." and closed with "(Wardrobe: …)" — directions to a renderer,
 * read by someone who just wanted to know what they were looking at. They are safe to remove
 * precisely because the caption is no longer the only view of the prompt: the exact text sent to
 * the model is one disclosure away, so the caption's job is to read well and nothing else.
 */
const INLINE_DIRECTIVES: RegExp[] = [
  // Subject count (pipeline's countSceneSubjects) — always the opening sentence.
  /^(?:Exactly |Several |A crowd of )?(?:zero|one|two|three|four|five|six|several|a crowd of)[^.]*?\bin focus\.\s*/i,
  // Wardrobe note (appendSceneWardrobe) and the beat cue for a split scene, both parentheticals.
  /\s*\(Wardrobe:[^)]*\)/gi,
  /\s*\(Part \d+ of this scene's sequence[^)]*\)/gi,
  // Tracked-cast rescue clause (pipeline's nameActiveScene).
  /\s*Scene continuity:[^.]*\.\s*$/i,
];

/**
 * The human-readable caption for a rendered prompt: the scene sentence(s) WITHOUT the machine
 * scaffolding around them — the leading reference block (`Title: … Style: … Characters: …`), the
 * trailing `Style:` / `Layout:` paragraphs, and the inline directives above. The full prompt stays
 * persisted and the UI offers it behind a toggle; this is just the friendly view. Falls back to the
 * input when stripping would leave nothing.
 */
export function displayCaption(prompt: string): string {
  const paragraphs = prompt.split(/\n{2,}/);
  const kept = paragraphs.filter((p) => !SCAFFOLD_PREFIX.test(p.trim()));
  let out = kept.join("\n\n").trim();
  for (const directive of INLINE_DIRECTIVES) out = out.replace(directive, "").trim();
  // Capitalise whatever now leads: dropping the count sentence can leave a lower-case scene.
  out = out.replace(/^\p{Ll}/u, (ch) => ch.toUpperCase());
  return out || prompt;
}

/**
 * Expand a prompt for a target, given its `nameHandling`. Three shapes, and which one binds an
 * attribute to the right person is a property of the ENCODER, not of the prompt:
 *
 *  - `inject` — the name is REPLACED: "(a man with a beard) and (a woman with red hair) sit at a
 *    bar". Every attribute sits adjacent to its subject, which is where a CLIP/T5 encoder's
 *    attention actually binds, so this is the default for SD and Flux.1. It costs the names, so a
 *    later mention in the same prompt has nothing to refer back to.
 *  - `reference` — the names STAY and a glossary is prepended ("Characters: Nico = a man with a
 *    beard; …"). LLM-grade encoders (Flux.2, Z-Image, Qwen, HiDream, and the cloud multimodals)
 *    resolve that indirection well, it keeps the scene sentence readable at any cast size, and it's
 *    the only shape with room for the explicit "these lists don't mix" instruction.
 *  - `appositive` — the names stay AND carry their descriptor at first mention: "Nico (a man with a
 *    beard) and Lyra (a woman with red hair) sit at a bar". Neither indirection nor lost names.
 *    Offered because the glossary form is the one shape where a description is not adjacent to the
 *    person it belongs to, which is a plausible source of the attribute mixing that survives
 *    everything else — but it is an empirical question per model, so it's a setting rather than a
 *    new default. Only the first mention is expanded; repeating it reads as two different people.
 */
export function expandPrompt(
  prompt: string,
  terms: readonly SceneTerm[],
  nameHandling: NameHandling,
  worldStyle?: string,
  bookTitle?: string,
  /** The beat's place, so a name inside it is never swapped for a character's face. */
  sceneLocation?: string,
): string {
  if (nameHandling === "appositive") {
    const named = injectBibleTerms(prompt, terms, sceneLocation, { keepName: true });
    const style = worldStyleClause(worldStyle);
    return style ? `${named}\n\nStyle: ${style}` : named;
  }
  if (nameHandling === "reference") {
    const block = buildReferenceBlock(terms, worldStyle, bookTitle);
    return block ? `${block}\n\n${prompt}` : prompt;
  }
  const injected = injectBibleTerms(prompt, terms, sceneLocation);
  const style = worldStyleClause(worldStyle);
  return style ? `${injected}\n\nStyle: ${style}` : injected;
}
