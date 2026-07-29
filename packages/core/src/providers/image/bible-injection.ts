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
    // Every descriptor this builds is a PERMANENT statement about an entity, injected into every
    // picture it appears in — so weather cannot be in any of them (see `stripWeather`). Places were
    // filtered first, but the same accumulation happens to people: a character first described in a
    // downpour keeps "rain-soaked hair" in their appearance, an outfit recorded outdoors keeps
    // "beaded with rain", and both then ride into every later image — indoors included. Filtering
    // here covers all four builders at once, which is the point of them sharing this funnel.
    .map((p) => stripWeather(p).trim())
    .filter(Boolean)
    .join(", ");
  return joined.length <= budget ? joined : `${joined.slice(0, budget).replace(/,?\s+\S*$/, "")}`;
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
  return capDescriptor(fields.length ? fields : ["person"], MAX_CHARACTER_DESCRIPTOR_CHARS);
}

/** Descriptor for a creature: kind + accumulated visual description. */
export function describeCreature(c: Creature): string {
  return capDescriptor([c.kind, ...c.description].filter((t) => t && t.trim()));
}

/** Descriptor for an outfit: its garment description. */
export function describeOutfit(o: Outfit): string {
  return capDescriptor([o.description || o.label]);
}

/** Condensed descriptor for a location. (Weather is stripped by `capDescriptor`, as for every
 * descriptor — see {@link stripWeather}.) */
export function describeLocation(e: Environment): string {
  return capDescriptor(e.description);
}

/**
 * Precipitation and storms: transient conditions, never permanent facts about a place or a book.
 *
 * WHY. A place's description ACCUMULATES across chapters (see `mergeExtraction`) and a book's
 * `worldStyle` is applied to EVERY image. Weather ends up in both — a beat where rain lashes the
 * tavern windows adds "rain lashing the windows" to the tavern's permanent description, and a
 * chapter that opens in a downpour can leave "rain-slicked" sitting in the book's art direction.
 * From then on it rains in every picture, including the ones set indoors, because nothing ever
 * takes it back out. Weather changes; a descriptor that outlives the scene must not claim it does.
 *
 * This does NOT touch the beat's own scene prompt, which is where weather belongs and where the
 * writing model puts it — so a scene that IS in the rain still renders in the rain. It only stops
 * one wet afternoon from raining on the rest of the book.
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
  const byForm = new Map(forms.map((f) => [f.form.toLowerCase(), f.descriptor]));
  // The beat's place is in the alternation but NOT in byForm, so it consumes its own span and comes
  // back unchanged. Without it, a character who IS in the scene still had their descriptor spliced
  // into the place named after them — "in the (shaved head) Tavern", which tells the image model the
  // tavern is a man. Longest-first ordering is what gives it the span over the name inside it.
  const place = (sceneLocation ?? "").trim();
  const scan =
    place && !byForm.has(place.toLowerCase())
      ? [...forms, { form: place, descriptor: "" }].sort((a, b) => b.form.length - a.form.length)
      : forms;
  const described = new Set<string>();
  const alt = scan.map((f) => escapeRegExp(f.form)).join("|");
  // Whole-word, case-insensitive, optional possessive; skip a match already opened by "(".
  const re = new RegExp(`(^|[^\\p{L}\\p{N}(])(${alt})(['’]s)?(?=[^\\p{L}\\p{N}]|$)`, "giu");
  return prompt.replace(re, (m: string, lead: string, name: string, poss: string | undefined, offset: number, whole: string) => {
    const descriptor = byForm.get(name.toLowerCase());
    // "Rell's Tavern" keeps its name even when Rell IS in the scene — the place is called that, and
    // swapping in his face there says the tavern looks like a man.
    if (!descriptor || (poss && namesSomethingElse(whole.slice(offset + m.length)))) {
      return `${lead}${name}${poss ?? ""}`;
    }
    // Only the FIRST mention gets the descriptor in keepName mode — repeating it at every mention
    // reads as two different people and is the bleed we're trying to avoid.
    if (opts.keepName) {
      if (described.has(name.toLowerCase())) return `${lead}${name}${poss ?? ""}`;
      described.add(name.toLowerCase());
      return `${lead}${name}${poss ?? ""} (${descriptor})`;
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
