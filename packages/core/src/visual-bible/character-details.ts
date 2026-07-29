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

export function isTransientCharacterDetail(value: string): boolean {
  const detail = value.trim();
  return (
    !!detail &&
    TRANSIENT_CHARACTER_DETAIL.test(detail) &&
    (!DURABLE_EXPRESSION.test(detail) || SCENE_BOUND_DETAIL.test(detail)) &&
    !EXPRESSION_SHAPED_MARK.test(detail)
  );
}

/**
 * Remove transient clauses while preserving durable detail in a mixed value such
 * as "auburn hair; a broad grin". Values without a transient marker are returned
 * byte-for-byte so ordinary appearance prose is not reformatted.
 */
export function stripTransientCharacterDetails(value: string): string {
  const detail = value.trim();
  if (!isTransientCharacterDetail(detail)) return detail;

  return detail
    .split(/\s*(?:;|\r?\n|,\s+)\s*/)
    .map((part) => part.trim())
    .filter((part) => part && !isTransientCharacterDetail(part))
    .join(", ");
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
