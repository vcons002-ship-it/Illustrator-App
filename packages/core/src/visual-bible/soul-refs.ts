/**
 * Getting the reader's and the assistant's own faces into a story they are cast in.
 *
 * The Soul panels hold reference photos, and the chat already conditions a self/user PORTRAIT on
 * them. A story never did: `soulCast` renamed the character in the TEXT prompt and stopped there, so
 * a reader who had cast themselves as a character got a stranger in every picture — with their own
 * photos sitting in the app, two panels away, doing nothing.
 *
 * The fix is deliberately not a second reference mechanism. Bible characters already carry reference
 * images, with a per-frame budget, a weight split, a byte cache and a UI to see and remove them. So
 * a cast soul's photos are SEEDED into that character's own slots, and from there every existing
 * path treats them like any other reference — including the reader deleting one they don't want.
 *
 * This module decides WHICH seeds are owed. Doing the copying is the host's job (it owns the stores).
 */
import { referenceIdsOf } from "../types/bible.js";
import type { IdentityAnchor } from "../types/bible.js";

/** Which of the two souls a character is playing. */
export type SoulKindRef = "self" | "user";

/** A character who should receive a soul's photos. */
export interface SoulRefSeed {
  characterId: string;
  kind: SoulKindRef;
}

/** The cast mapping a story carries: which character each soul plays, BY NAME. */
export interface SoulCastNames {
  self?: string;
  user?: string;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Which cast characters are owed their soul's reference photos.
 *
 * Three rules, and each is load-bearing:
 *
 *  - **The reader's own uploads win.** A character that already has references is skipped entirely.
 *    Seeding over them would overwrite a deliberate choice with an automatic one, and it also makes
 *    this idempotent — it can run on every story open without stacking duplicates every time.
 *  - **A soul with no photos owes nothing.** Not an empty seed, not a placeholder: nothing.
 *  - **The name has to actually match a character.** The cast is validated elsewhere, but a bible is
 *    rewritten as a story grows, and a mapping naming a character that no longer exists must resolve
 *    to no seed rather than to the wrong person.
 *
 * PURE — returns the work to do, does none of it.
 */
export function soulRefSeeds(
  cast: SoulCastNames | undefined,
  characters: readonly { id: string; name: string; anchor: IdentityAnchor }[],
  hasPhotos: (kind: SoulKindRef) => boolean,
): SoulRefSeed[] {
  if (!cast) return [];
  const seeds: SoulRefSeed[] = [];
  const taken = new Set<string>();
  for (const kind of ["self", "user"] as const) {
    const name = cast[kind];
    if (!name || !hasPhotos(kind)) continue;
    const character = characters.find((c) => sameName(c.name, name));
    if (!character) continue;
    // One soul per character. A cast that somehow maps both souls to one character (the validator
    // rejects it, but a hand-edited book could carry it) must not seed two sets of faces into one
    // person — that's a worse picture than no reference at all.
    if (taken.has(character.id)) continue;
    if (referenceIdsOf(character.anchor).length > 0) continue;
    taken.add(character.id);
    seeds.push({ characterId: character.id, kind });
  }
  return seeds;
}
