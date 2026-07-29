import type { VisualBible } from "../types/bible.js";

/**
 * Active-scene tracking for "story as you go" (the ONE functional divergence from the
 * book illustrator). The book pipeline resolves "who's in frame" by scanning a unit's
 * page text for bible names (`resolvePageEntities`). Chat beats are terser and often
 * name no one — a line of dialogue, a "she nods" — so a story must carry an EXPLICIT
 * active scene across turns: the cast currently present and the current location. Each
 * beat's image then uses the tracked cast/setting, not just names found in that one
 * terse beat. The bible itself is unchanged — this is a chat-layer tracker on top of it.
 *
 * Pure + deterministic: every rule (carry-forward, role-play seed, enter/exit, location
 * change) is a set operation over the bible, so it's exhaustively unit-testable without
 * an LLM or a GPU.
 */
export interface StoryScene {
  /** Character ids currently in the scene, carried across beats until one exits. */
  presentCharacterIds: string[];
  /** The current location's environment id, carried until the narrative moves. */
  locationId?: string;
}

/**
 * What a single beat told us, derived from the beat's extraction (+ an optional text
 * scan). All fields optional — a terse beat may carry nothing, in which case the scene
 * simply carries forward.
 */
export interface StoryBeatSignal {
  /** Character names/aliases mentioned or acting in THIS beat (extraction + text scan). */
  mentionedNames?: string[];
  /** Characters explicitly ENTERING the scene this beat (added to present). */
  enters?: string[];
  /** Characters explicitly LEAVING the scene this beat (removed from present). */
  exits?: string[];
  /** The location NAME this beat takes place in (extraction `location`); moves the scene. */
  location?: string;
  /**
   * The COMPLETE cast of this beat, as the storyboard names it (`keyEvent.cast` — extraction is
   * required to fill it: "the characters PRESENT in that scene"). Authoritative when set: it
   * REPLACES the carried-forward cast rather than adding to it.
   *
   * Without this the present set only ever grew. `exits` is the field that was supposed to shrink it
   * and nothing has ever populated it, so every character named in any beat stayed in the cast of
   * every later picture — name appended to the prompt, description injected — and by a dozen beats in
   * the scene was competing with a cast list that never stopped growing. The model that wrote the
   * beat already knows who is in it; this asks it rather than accumulating guesses.
   */
  castNames?: string[];
}

/**
 * Role-play configuration: the characters being PLAYED (the user's + the buddy's). In a
 * 2-hander both are assumed present every beat unless a beat says one leaves — chat
 * dialogue rarely re-states "X and Y are here", so the played cast is a standing seed.
 */
export interface StoryRoleplay {
  playedCharacterNames: string[];
}

/**
 * The resolved render present-set override the pipeline consumes for a story beat:
 * the cast (character ids) + the setting (environment id). Fed into the SAME render
 * inputs the book illustrator uses (`anchors`/`referenceImagesFor`/term expansion),
 * just sourced from the tracker instead of a per-unit text scan.
 */
export interface StoryPresent {
  characterIds: string[];
  environmentIds: string[];
  creatureIds: string[];
}

export function emptyStoryScene(): StoryScene {
  return { presentCharacterIds: [] };
}

function lc(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Resolve display names/aliases to bible character ids (case-insensitive, order- and
 * dedup-preserving). A name with no matching bible entry is simply dropped — the cast
 * is whoever the bible actually knows, so a not-yet-extracted name resolves on a later
 * beat once it's in the bible.
 *
 * A name that some character OWNS resolves to that character alone. Models hand out aliases that
 * collide with real names — a character called "Rell" picking up the alias "the Captain" while
 * another character IS "The Captain" — and matching aliases blindly put BOTH in the scene. Asking
 * for two characters returned three, and the extra one's descriptor then rode into the image prompt
 * as a third face fused into the scene. An alias only counts when it isn't anyone's own name.
 */
export function namesToCharacterIds(bible: VisualBible, names: readonly string[]): string[] {
  const wanted = new Set(names.map(lc).filter(Boolean));
  if (wanted.size === 0) return [];
  const owned = new Set(bible.characters.map((c) => lc(c.name)).filter(Boolean));
  return bible.characters
    .filter((c) => {
      const own = lc(c.name);
      if (wanted.has(own)) return true;
      return c.aliases.some((a) => {
        const k = lc(a);
        return !!k && k !== own && wanted.has(k) && !owned.has(k);
      });
    })
    .map((c) => c.id);
}

/**
 * Resolve a location NAME (or alias) to an environment id. Tries an exact name/alias
 * match first, then a contains-match in BOTH directions so "the throne room of
 * Highspire" resolves "Highspire" and "Highspire" resolves "Highspire Keep". Returns
 * undefined when the place isn't in the bible yet (the scene then carries its prior
 * location forward).
 */
export function locationToEnvironmentId(
  bible: VisualBible,
  location: string | undefined,
): string | undefined {
  const key = location ? lc(location) : "";
  if (!key) return undefined;
  const names = (e: { name: string; aliases?: string[] }): string[] => [e.name, ...(e.aliases ?? [])];
  const exact = bible.environments.find((e) => names(e).some((n) => lc(n) === key));
  if (exact) return exact.id;
  return bible.environments.find((e) =>
    names(e).some((n) => {
      const ln = lc(n);
      return ln.length > 0 && (key.includes(ln) || ln.includes(key));
    }),
  )?.id;
}

/**
 * Advance the active scene by one beat. Rules (in order):
 *  1. The storyboard's cast for this beat REPLACES the carried-forward one when it has it
 *     (`castNames`); otherwise the prior cast carries forward, as before — a terse beat naming
 *     nobody must not empty the picture.
 *  2. Role-play seed: the played characters are always present (a standing cast).
 *  3. Add anyone newly mentioned or explicitly entering this beat.
 *  4. Remove anyone explicitly exiting this beat.
 *  5. Location: move to this beat's location when it resolves. When the beat NAMES a place that
 *     doesn't resolve, the scene has still moved — drop the old one rather than carry it.
 * Pure — returns a fresh scene, never mutates `prev`.
 */
export function advanceStoryScene(
  prev: StoryScene,
  bible: VisualBible,
  signal: StoryBeatSignal,
  roleplay?: StoryRoleplay,
): StoryScene {
  // (1) The storyboard's own cast for this beat is authoritative — it's the model saying who is in
  // the scene it just described, so it REPLACES what came before rather than adding to it. Only when
  // it has nothing to say does the prior cast carry forward.
  const declared = namesToCharacterIds(bible, signal.castNames ?? []);
  const present = new Set(declared.length > 0 ? declared : prev.presentCharacterIds);
  // (2) Played characters are present by default every beat.
  for (const id of namesToCharacterIds(bible, roleplay?.playedCharacterNames ?? [])) present.add(id);
  // (3) Newly mentioned / entering.
  for (const id of namesToCharacterIds(bible, [...(signal.mentionedNames ?? []), ...(signal.enters ?? [])])) {
    present.add(id);
  }
  // (4) Exits (after adds, so an enter+exit in the same beat nets out to absent).
  for (const id of namesToCharacterIds(bible, signal.exits ?? [])) present.delete(id);
  // (5) Location. A beat that NAMES a place has moved the scene, even when that place isn't in the
  // bible yet — which is the normal state the first time the story walks into it, since extraction
  // runs behind the render. Carrying the old environment there is how the previous scene's setting
  // kept being injected into a picture of somewhere else.
  const moved = locationToEnvironmentId(bible, signal.location);
  const named = (signal.location ?? "").trim().length > 0;
  const locationId = moved ?? (named ? undefined : prev.locationId);
  // Preserve a STABLE order: prior present cast first (in their existing order), then
  // any newcomers in bible order — so the present set doesn't churn between beats.
  const ordered = [
    ...prev.presentCharacterIds.filter((id) => present.has(id)),
    ...bible.characters.map((c) => c.id).filter((id) => present.has(id) && !prev.presentCharacterIds.includes(id)),
  ];
  return { presentCharacterIds: ordered, ...(locationId ? { locationId } : {}) };
}

/**
 * Build the render present-set override from a tracked scene: the present cast + the
 * current location's environment. Creatures are left to the pipeline's text scan
 * (a creature appears when the beat names it), so the override never forces one.
 */
export function presentFromScene(scene: StoryScene): StoryPresent {
  return {
    characterIds: [...scene.presentCharacterIds],
    environmentIds: scene.locationId ? [scene.locationId] : [],
    creatureIds: [],
  };
}
