import type { SoulEssence, SoulKind } from "@visual-reader/core";

/**
 * Select the Essence a linked phone should show for an authoritative desktop Soul frame.
 *
 * An omitted incoming Essence is an explicit clear: the desktop owns this state, so retaining a
 * phone-only snapshot would make the phone claim an Essence exists when the desktop cannot use it.
 * When an Essence is present, prefer one current for the incoming notes and then the newest copy.
 * This preserves a freshly returned phone refresh result when an older, non-empty mirror frame
 * arrives just behind it.
 */
export function selectMirroredSoulEssence(
  kind: SoulKind,
  notesFingerprint: string,
  incoming: SoulEssence | undefined,
  current: SoulEssence | undefined,
): SoulEssence | undefined {
  if (!incoming) return undefined;

  const candidates = [incoming, current].filter(
    (candidate): candidate is SoulEssence => candidate?.kind === kind,
  );
  const currentCandidates = candidates.filter(
    (candidate) => candidate.sourceFingerprint === notesFingerprint,
  );
  return (currentCandidates.length > 0 ? currentCandidates : candidates)
    .sort((left, right) => right.generatedAt - left.generatedAt)[0];
}
