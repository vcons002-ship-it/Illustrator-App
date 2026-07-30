import type { CharacterAppearance } from "../types/bible.js";

/**
 * Expressions, gestures, and emotional states describe one illustrated beat, not a
 * character's reusable identity. The extractor is instructed accordingly, but this
 * deterministic guard also protects the Bible from occasional model mistakes and
 * cleans legacy entries the next time they are merged or rendered.
 */
const TRANSIENT_CHARACTER_DETAIL =
  /\b(?:grins?|grinning|smiles?|smiling|smirks?|smirking|frowns?|frowning|scowls?|scowling|sneers?|sneering|grimaces?|grimacing|winces?|wincing|pouts?|pouting|laughs?|laughing|cries|crying|tearful|teary[- ]eyed|blush(?:es|ed|ing)?|flushed|open[- ]mouthed|raised (?:an? |her |his |their )?eyebrows?|furrowed (?:her |his |their )?brows?|(?:her |his |their )?brows? furrowed|(?:narrowed eyes|eyes narrowed|widened eyes|eyes widened)|crossed (?:her |his |their )?arms|arms crossed|clenched (?:her |his |their )?(?:jaw|fists?)|hands? on (?:her |his |their )?hips?|tilted (?:her |his |their )?head)\b/i;

/** Wording that explicitly makes an otherwise transient expression a defining feature. */
const DURABLE_EXPRESSION =
  /\b(?:permanent(?:ly)?|habitual(?:ly)?|characteristic|signature|fixed|constant(?:ly)?|usual(?:ly)?|always|ever[- ]present|trademark|resting expression)\b/i;

/** A durability-sounding word can still be explicitly scoped to the current beat. */
const SCENE_BOUND_DETAIL =
  /\b(?:this (?:scene|moment|beat)|right now|currently|at the moment|for (?:a|the) moment)\b/i;

/** A smile/grin can also describe the shape of a genuinely permanent mark. */
const EXPRESSION_SHAPED_MARK =
  /\b(?:smile|grin)(?:-shaped)? (?:scar|tattoo|birthmark|lines?)\b|\b(?:scar|tattoo|birthmark) (?:shaped like|in the shape of) (?:a )?(?:smile|grin)\b/i;

/**
 * What the SCENE is doing to someone, mistaken for what they look like.
 *
 * "The iridescent purple of the broth reflects in her eyes", "her silhouette is highlighted by neon
 * light" — true of one shot, in one room, under one light, and recorded as a permanent fact about a
 * person. Then injected into every later picture, where it drags that scene's lighting into a
 * daylight street. This is the class the Visual Bible must never hold: the bible is what someone
 * looks like independent of any scene, and lighting belongs to the scene prompt, which is written
 * fresh for every image and is exactly where "light reflecting in her eyes" is worth saying.
 */
const SCENE_LIGHTING_DETAIL =
  /\b(?:reflect(?:s|ed|ing)?|refract(?:s|ed|ing)?|lit(?: by| from)?|illuminat(?:es|ed|ing)|highlighted|silhouett?e(?:d)?|backlit|underlit|bathed in|washed in|glow(?:s|ing) (?:in|on|against)|catch(?:es|ing) the light|cast(?:s|ing)? (?:a )?shadows?|shadowed by|haloed|rim light|neon light|firelight|lamplight|candlelight|moonlight|sunlight)\b/i;

/**
 * Gaze, expression, and bearing — the mood of a moment written as a feature.
 *
 * "Intense gaze", "a look of quiet intensity", "intense hunger in her gaze", "moves with grace":
 * none of these is a physical characteristic, all of them arrive attached to one beat, and
 * accumulated across a book they crowd out the hair and eye colour that can actually be drawn. The
 * eyes THEMSELVES are physical ("wide, grey"); what the eyes are DOING is not.
 */
const EXPRESSION_OR_BEARING_DETAIL =
  /\b(?:gazes?|gazing|stares?|staring|glares?|glaring|glance[sd]?|expressions?|intensity|demeano(?:u)?r|bearing|aura|presence|air of|look of|hunger|longing|sorrow|melancholy|determination|confiden(?:ce|t)|moves? with|movements? are|walks? with|carries? (?:her|him|them)self|holds? (?:her|him|them)self|posture of)\b/i;

/**
 * Prose wrappers the extractor writes when it forgets it is filling a field rather than describing a
 * person to a reader: "possesses soft features", "has a whirring cybernetic eye", "Her hair is red".
 *
 * Removed rather than rejected — the detail inside is real and drawable, it is only wrapped. It also
 * makes duplicate detection work: "possesses soft features and pouty lips" and "has a look of quiet
 * intensity and pouty lips" share nothing until the wrappers come off.
 */
const PROSE_WRAPPER =
  /^(?:(?:s?he|they|his|her|their|the (?:character|figure|man|woman))\s+)?(?:is |are |was |were |has |have |possesses |possessing |displays |shows |bears |sports |features |appears (?:to be )?)+(?:an?\s+|the\s+)?/i;

export function isTransientCharacterDetail(value: string): boolean {
  const detail = value.trim();
  if (!detail) return false;
  // Lighting and bearing are never durable — no "permanently" makes a reflection a feature of a
  // face, so these are not subject to the DURABLE_EXPRESSION escape hatch that expressions get.
  if (SCENE_LIGHTING_DETAIL.test(detail) || EXPRESSION_OR_BEARING_DETAIL.test(detail)) return true;
  return (
    TRANSIENT_CHARACTER_DETAIL.test(detail) &&
    (!DURABLE_EXPRESSION.test(detail) || SCENE_BOUND_DETAIL.test(detail)) &&
    !EXPRESSION_SHAPED_MARK.test(detail)
  );
}

/** Split a conjunction only when at least one side is independently transient. */
function splitTransientConjunctions(value: string): string[] {
  const tokens = value.split(/(\s+(?:and|while)\s+)/i);
  if (tokens.length < 3) return [value];
  const parts: string[] = [];
  let current = tokens[0] ?? "";
  for (let index = 1; index < tokens.length; index += 2) {
    const separator = tokens[index] ?? " and ";
    const next = tokens[index + 1] ?? "";
    if (isTransientCharacterDetail(current) || isTransientCharacterDetail(next)) {
      if (current.trim()) parts.push(current.trim());
      current = next;
    } else {
      current += separator + next;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * A whole sentence about one feature — "Her hair is auburn", "His eyes are grey".
 *
 * Turned around rather than trimmed: dropping the wrapper would leave a bare "auburn" that has lost
 * the thing it describes, which is the loose-adjective problem `anchorField` exists to prevent. The
 * noun is kept and the complement moved in front of it, giving the noun phrase the field wanted.
 */
const FEATURE_SENTENCE = /^(?:her|his|their|its|the)\s+([\p{L}-]+)\s+(?:is|are|was|were)\s+(.+)$/iu;

/** A stored value reduced to the noun phrase it was meant to be. PURE. */
export function unwrapAppearancePhrase(value: string): string {
  const plain = value.trim().replace(/\s*[.!]+$/, "").trim();
  const sentence = plain.match(FEATURE_SENTENCE);
  if (sentence) return `${sentence[2]!.trim()} ${sentence[1]!.trim()}`.replace(/\s+/g, " ");
  const bare = plain.replace(PROSE_WRAPPER, "").trim();
  return bare || plain;
}

/**
 * Remove transient clauses while preserving durable detail in a mixed value such
 * as "auburn hair; a broad grin". Values without a transient marker are returned
 * byte-for-byte so ordinary appearance prose is not reformatted.
 */
export function stripTransientCharacterDetails(value: string): string {
  const detail = value.trim();
  if (!detail) return "";
  const parts = detail
    .split(/\s*(?:;|\r?\n|,\s+)\s*/)
    .flatMap(splitTransientConjunctions)
    .map((part) => part.trim())
    .filter(Boolean);
  const kept = parts
    .filter((part) => !isTransientCharacterDetail(part))
    .map(unwrapAppearancePhrase)
    .filter(Boolean);
  // Preserve exact formatting when nothing was removed or unwrapped.
  if (kept.length === parts.length && kept.every((part, index) => part === parts[index])) return detail;
  return kept.join(", ");
}

/**
 * What the extractor writes when it has nothing to write. It is an admission of ignorance, and
 * injected into a prompt it becomes an instruction — "unspecified skin" is a thing the model will
 * try to draw.
 */
const PLACEHOLDER_DETAIL =
  /^(?:unspecified|unknown|unclear|not (?:specified|mentioned|stated|described|given|known)|no(?:ne|t applicable)?|n\/?a|null|undefined|tbd|[-–—]+|\?+)$/i;

/**
 * A clause that describes someone by comparison to someone else — "a head taller than most others",
 * "as tall as Sawyer and built as Dain".
 *
 * Two reasons it cannot stay. It is not drawable: an image model has no other figure to measure
 * against, so the words contribute nothing but length. And it names OTHER PEOPLE inside this
 * person's descriptor, which is the exact mechanism behind every feature-bleed we have chased — a
 * name in a descriptor is a name the model will find a face for.
 */
const COMPARATIVE_CLAUSE =
  /\b(?:as \w+ as|(?:taller|shorter|larger|smaller|bigger|thinner|heavier|older|younger|paler|darker) than|than (?:most|the )?(?:others?|everyone|anyone)|compared (?:to|with)|built (?:like|as)|similar to)\b/i;

/**
 * Vocabulary that makes a bare phrase VISUAL. Used only where a phrase has no field to vouch for it
 * (see {@link drawableTraits}); a stored `eyes` field is visual because it is the eyes field, but a
 * loose trait has to earn it.
 */
const VISUAL_VOCABULARY =
  /\b(?:hairs?|beards?|moustaches?|mustaches?|braids?|plaits?|ponytails?|buns?|locs|dreadlocks?|afro|bald|shaved|buzzcut|stubble|sideburns|curls?|fringe|bangs|topknot|undercut|mohawk|heads?|faces?|jaw|chin|cheeks?|brows?|nose|lips?|mouth|teeth|ears?|eyes?|pupils?|glasses|spectacles|patch|scars?|tattoos?|birthmarks?|freckles?|marks?|burns?|skin|complexion|tanned?|pale|olive|ebony|bronze|freckled|tall|short|slender|slim|lean|stocky|burly|broad|wiry|petite|muscular|athletic|plump|gaunt|frail|build|frame|shoulders?|chest|waist|hips?|arms?|hands?|legs?|feet|posture|limp|prosthetic|cybernetic|wings?|horns?|tail|scales?|fur|feathers?|claws?|coats?|cloaks?|robes?|gowns?|dress(?:es)?|shirts?|tunics?|trousers?|leathers?|armou?r|uniforms?|boots?|gloves?|hats?|hoods?|masks?|jewell?ery|rings?|necklaces?|earrings?|piercings?|black|white|grey|gray|brown|blonde?|red|auburn|ginger|silver|golden|blue|green|hazel|amber|violet|copper|crimson|scarlet|teal|years old|middle[- ]aged|elderly|young|teenage|adolescent|child|eyed|haired|skinned|shouldered|armed|legged|handed|faced|bodied|limbed|footed|nosed|lipped|chinned|browed|bearded|whiskered|scarred|tattooed|pierced|maned|winged|horned|tailed|clawed|feathered|furred|hooded|cloaked|robed|uniformed|armou?red|booted|gloved|bespectacled|one[- ]eyed|missing an? \w+)\b/i;

/** True for a value that says nothing at all — the extractor's stand-in for "I don't know". */
export function isPlaceholderDetail(value: string): boolean {
  return PLACEHOLDER_DETAIL.test(value.trim().replace(/[.,;]+$/, ""));
}

/**
 * A stored appearance value with the undrawable clauses taken out: placeholders and comparisons to
 * other people. Clause-wise, so one bad clause costs a clause rather than the whole field.
 *
 * Deliberately NOT a visual-vocabulary test. These values arrive in a NAMED field — the eyes field
 * makes "kind" mean kind eyes — so demanding that each one look visual on its own would throw away
 * detail the field itself vouches for. PURE.
 */
export function drawableDetail(value: string): string {
  const detail = value.trim();
  if (!detail) return "";
  const parts = splitClauses(detail).filter((p) => !isPlaceholderDetail(p) && !COMPARATIVE_CLAUSE.test(p));
  // Unchanged input keeps its exact wording (including any separators we don't split on).
  return parts.length === splitClauses(detail).length ? detail : parts.join(", ");
}

/**
 * The FIRST value of a single-attribute field.
 *
 * Merging accumulates: each chapter that re-describes someone's eyes appends its own wording, so the
 * field ends up "arctic blue; icy-blue; glacial blue" — three attempts at one pair of eyes, not
 * three features. Injected whole, the prompt asks for eyes of three different colours and spends a
 * third of the character's budget doing it. The first wording is the earliest and most-established
 * one, and one answer is what the field is for.
 *
 * Applies ONLY to fields describing a single attribute (hair, eyes, build, height, skin). A list
 * field — distinguishing marks, free-form notes — keeps every entry: "a relic up his wrist; a
 * dimple" is two real features. PURE.
 */
export function firstAppearanceVariant(value: string): string {
  const detail = value.trim();
  const first = detail.split(/\s*;\s*/)[0]?.trim() ?? "";
  return first || detail;
}

/**
 * The traits that describe how someone LOOKS, out of a list that mixes in everything else.
 *
 * `persistentTraits` is where the extractor puts whatever seems durable, and most of that is not
 * appearance: "vicious, bully, hostile, cowardly, sadistic" is a personality, "top cadet of his
 * year, son of the disgraced Colonel Isaac Mairi" is a biography. None of it can be drawn, and all
 * of it competes for the model's attention with the hair and eye colour that can — an image model
 * given eleven personality adjectives and one hair colour will not weight them the way a reader
 * would. So a trait has to name something visible to travel to a picture. It stays in the bible
 * either way: this filters what reaches the PROMPT, not what is stored.
 *
 * A whitelist, not a list of banned personality words, because the banned list could never be
 * finished — and the failure of a whitelist (dropping a real detail phrased oddly) costs one
 * feature, while the failure of a blacklist costs the whole descriptor. PURE.
 */
export function drawableTraits(values: readonly string[]): string[] {
  return durableCharacterDetails(values)
    .map((t) => drawableDetail(t))
    .filter((t) => t && !isPlaceholderDetail(t) && VISUAL_VOCABULARY.test(t));
}

/** Clause boundaries inside a stored appearance value: semicolons, newlines, and ", ". */
function splitClauses(value: string): string[] {
  return value
    .split(/\s*(?:;|\r?\n|,\s+)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function durableCharacterDetails(values: readonly string[]): string[] {
  return values.map(stripTransientCharacterDetails).filter(Boolean);
}

export function sanitizeAppearanceDetails(
  appearance: Partial<CharacterAppearance>,
): Partial<CharacterAppearance> {
  const clean: Partial<CharacterAppearance> = {};
  for (const key of Object.keys(appearance) as (keyof CharacterAppearance)[]) {
    clean[key] = stripTransientCharacterDetails(appearance[key] ?? "");
  }
  return clean;
}
