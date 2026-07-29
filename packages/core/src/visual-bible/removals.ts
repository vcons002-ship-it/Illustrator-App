import type {
  BibleEntityKind,
  Character,
  Creature,
  Environment,
  RemovedEntity,
  VisualBible,
} from "../types/bible.js";

/**
 * Deleting an entry from the Visual Bible, and putting it back.
 *
 * The bible is built by a model reading the book, and it gets things wrong in ways no amount of
 * editing can fix: the same person recorded twice under two names, a costume identity or a title
 * promoted to a character of its own, a passing simile filed as a creature, a metaphor filed as a
 * place. Every one of those goes into the pictures — a spurious "person" is drawn standing in the
 * scene — and until now the only surfaces were corrective: you could rewrite an entry, never say
 * it shouldn't exist.
 *
 * Removal is kept as a record rather than a splice for the reason set out on {@link RemovedEntity}:
 * the extractor re-adds by name as it reads on, so a forgotten deletion undoes itself. Everything
 * here is pure — the engine persists the returned bible and broadcasts it.
 */

/** The names an entry answers to, lowercased — its own plus every alias. */
export function entityNames(entity: Character | Creature | Environment): string[] {
  const aliases = entity.aliases ?? [];
  return [entity.name, ...aliases]
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether an entry the extractor just produced was deleted by the reader and must not come back.
 *
 * Matched on ANY shared name, in both directions: the extractor rarely repeats a name exactly the
 * way it first wrote it, and a removed "Ghost Broker" returning as an alias of a fresh entry is
 * the same unwanted entry. Kinds are kept apart, so deleting a place called "The Rook" says
 * nothing about a character of that name.
 */
export function isRemovedEntity(
  bible: Pick<VisualBible, "removed">,
  kind: BibleEntityKind,
  names: readonly string[],
): boolean {
  const removed = bible.removed ?? [];
  if (removed.length === 0) return false;
  const wanted = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) return false;
  return removed.some((r) => r.kind === kind && r.names.some((n) => wanted.includes(n)));
}

/**
 * Drop anything a fresh extraction produced that the reader had deleted.
 *
 * `mergeExtraction` already skips removed entries as it merges, which is the right place to do it —
 * it also stops a removed alias quietly enriching a surviving entry. But the engine hands the whole
 * chapter to an LLM provider and gets a whole bible back, and not every provider is obliged to have
 * gone through that merge. This is the backstop the engine applies to whatever comes back, so the
 * guarantee "a deleted entry does not return" holds for every provider rather than most of them.
 */
export function pruneRemovedEntities(bible: VisualBible): VisualBible {
  if (!bible.removed?.length) return bible;
  const keep = (kind: BibleEntityKind) => (e: Character | Creature | Environment) =>
    !isRemovedEntity(bible, kind, entityNames(e));
  const characters = (bible.characters ?? []).filter(keep("character"));
  const creatures = (bible.creatures ?? []).filter(keep("creature"));
  const environments = (bible.environments ?? []).filter(keep("environment"));
  if (
    characters.length === bible.characters.length &&
    creatures.length === (bible.creatures ?? []).length &&
    environments.length === bible.environments.length
  ) {
    return bible;
  }
  return { ...bible, characters, creatures, environments };
}

/** The list a kind lives in, read tolerantly (older cached bibles may lack `creatures`). */
function listOf(bible: VisualBible, kind: BibleEntityKind): (Character | Creature | Environment)[] {
  if (kind === "character") return bible.characters ?? [];
  if (kind === "creature") return bible.creatures ?? [];
  return bible.environments ?? [];
}

/** Replace one of the bible's three entity lists, preserving the rest. */
function withList(
  bible: VisualBible,
  kind: BibleEntityKind,
  list: (Character | Creature | Environment)[],
): VisualBible {
  if (kind === "character") return { ...bible, characters: list as Character[] };
  if (kind === "creature") return { ...bible, creatures: list as Creature[] };
  return { ...bible, environments: list as Environment[] };
}

/**
 * Drop a stored scene's cast entries naming a removed character.
 *
 * The cast list is what makes a beat inject an outfit and what the prompt's name-rescue falls back
 * on, so a name left there keeps putting a person the reader deleted into new images — the deletion
 * would look like it hadn't taken. Only this structured field is touched: already-written prompt
 * TEXT is left exactly as it is, because rewriting prose the reader may have edited to remove a
 * word is a far worse failure than leaving one stale prompt behind.
 */
function stripFromCast(bible: VisualBible, names: readonly string[]): VisualBible {
  const drop = new Set(names);
  const storyboard = (bible.storyboard ?? []).map((scene) => {
    if (!scene.keyEvents?.length) return scene;
    let changed = false;
    const keyEvents = scene.keyEvents.map((ev) => {
      if (!ev.cast?.length) return ev;
      const cast = ev.cast.filter((m) => !drop.has(m.name.trim().toLowerCase()));
      if (cast.length === ev.cast.length) return ev;
      changed = true;
      return { ...ev, cast };
    });
    return changed ? { ...scene, keyEvents } : scene;
  });
  return { ...bible, storyboard };
}

/**
 * Delete one entry and record the deletion. Returns `undefined` when there is no such entry, so
 * the caller can tell "already gone" from "removed" and skip a pointless write + broadcast.
 */
export function removeBibleEntity(
  bible: VisualBible,
  kind: BibleEntityKind,
  id: string,
): VisualBible | undefined {
  const list = listOf(bible, kind);
  const entity = list.find((e) => e.id === id);
  if (!entity) return undefined;
  const names = entityNames(entity);
  const record: RemovedEntity = { kind, names, entity };
  // Deleting the same id twice can't happen (it's gone from the list), but a re-added entry that is
  // deleted again would duplicate the record — key the list by kind+id so it stays one per entry.
  const removed = [
    ...(bible.removed ?? []).filter((r) => !(r.kind === kind && r.entity.id === id)),
    record,
  ];
  const next = withList({ ...bible, removed }, kind, list.filter((e) => e.id !== id));
  return kind === "character" ? stripFromCast(next, names) : next;
}

/**
 * Put a removed entry back, exactly as it was, and stop suppressing its names.
 *
 * Restoring appends rather than reinstating the original position: the lists are displayed and
 * searched, never indexed into, and an entry that reappears at the end is easier to find than one
 * that silently slots back into the middle. Returns `undefined` when there is no such removal.
 */
export function restoreBibleEntity(
  bible: VisualBible,
  kind: BibleEntityKind,
  id: string,
): VisualBible | undefined {
  const record = (bible.removed ?? []).find((r) => r.kind === kind && r.entity.id === id);
  if (!record) return undefined;
  const removed = (bible.removed ?? []).filter((r) => !(r.kind === kind && r.entity.id === id));
  const list = listOf(bible, kind);
  // Guard the impossible-but-cheap case of the name having been re-extracted under a new id in the
  // meantime: restoring must never leave two entries with the same id.
  const kept = list.filter((e) => e.id !== id);
  return withList({ ...bible, removed }, kind, [...kept, record.entity]);
}
