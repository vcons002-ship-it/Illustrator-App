import type { SpoilerEntity } from "../types/bible.js";

/**
 * "Fog of War" gating. An image stays blurred until the reader's scroll depth
 * has passed every spoiler entity it depicts. Pure function so the UI's reveal
 * behaviour is unit-testable independently of the DOM.
 *
 * @param imageSpoilerIds spoiler ids present in the generated image
 * @param spoilers        the book's spoiler entities (id → revealParagraphId)
 * @param passedParagraphIds paragraph ids the reader has already scrolled past
 */
export function shouldRevealImage(
  imageSpoilerIds: string[],
  spoilers: SpoilerEntity[],
  passedParagraphIds: ReadonlySet<string>,
): boolean {
  if (imageSpoilerIds.length === 0) return true;
  const byId = new Map(spoilers.map((s) => [s.id, s]));
  return imageSpoilerIds.every((id) => {
    const spoiler = byId.get(id);
    // Unknown spoiler id → fail safe by keeping it hidden.
    if (!spoiler) return false;
    return passedParagraphIds.has(spoiler.revealParagraphId);
  });
}
