import type { SoulKind } from "@visual-reader/core";

/** Wait for a real conversational lull before taking the selected text model. */
export const SOUL_ESSENCE_IDLE_DELAY_MS = 2 * 60_000;
/** Coalesce a burst of Soul-note edits before deriving a new revision. */
export const SOUL_ESSENCE_DIRTY_DELAY_MS = 2 * 60_000;
/** App-level polling cadence. The worker remains the owner of the actual model job. */
export const SOUL_ESSENCE_IDLE_SWEEP_MS = 15_000;
/** Match the worker's failed-generation cooldown so an idle sweep cannot retry-spam a model. */
export const SOUL_ESSENCE_IDLE_RETRY_MS = 10 * 60_000;

export interface SoulEssenceIdleSource {
  kind: SoulKind;
  noteCount: number;
  notesFingerprint: string;
  essenceFingerprint: string | undefined;
}

/**
 * App-owned scheduling state for one Soul. The Essence itself remains worker/store-owned; this only
 * remembers when the current note revision first became dirty and when an idle attempt last began.
 */
export interface SoulEssenceIdleCandidate extends SoulEssenceIdleSource {
  firstDirtyAt: number | null;
  lastAttemptAt: number | null;
}

export interface SoulEssenceIdleSelectionContext {
  now: number;
  lastUserRequestAt: number;
  isRemoteClient: boolean;
  processActive: boolean;
  essenceActive: boolean;
}

function isDirty(source: SoulEssenceIdleSource): boolean {
  return (
    source.noteCount > 0 &&
    source.notesFingerprint.length > 0 &&
    source.notesFingerprint !== source.essenceFingerprint
  );
}

function pastTimestamp(value: number | null, now: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  // A clock correction must not leave an idle rebuild disabled until a future timestamp catches up.
  return Math.min(value, now);
}

function elapsed(now: number, since: number): number {
  return Math.max(0, now - Math.min(since, now));
}

/**
 * Reconcile live note/Essence fingerprints with the prior scheduler state.
 *
 * The first dirty timestamp and retry backoff survive ordinary re-renders for the same note
 * revision. A new note revision gets its own quiet period and may be attempted without inheriting a
 * failed older revision's cooldown. Becoming current (or empty) clears all pending scheduling state.
 */
export function trackSoulEssenceIdleCandidate(
  previous: SoulEssenceIdleCandidate | undefined,
  source: SoulEssenceIdleSource,
  now: number,
): SoulEssenceIdleCandidate {
  if (!isDirty(source)) {
    return {
      ...source,
      firstDirtyAt: null,
      lastAttemptAt: null,
    };
  }

  const sameDirtyRevision =
    previous !== undefined &&
    previous.notesFingerprint === source.notesFingerprint &&
    previous.firstDirtyAt !== null;

  return {
    ...source,
    firstDirtyAt: sameDirtyRevision
      ? (pastTimestamp(previous.firstDirtyAt, now) ?? now)
      : now,
    lastAttemptAt: sameDirtyRevision
      ? pastTimestamp(previous.lastAttemptAt, now)
      : null,
  };
}

/** Record dispatch before starting the fire-and-forget worker request. */
export function markSoulEssenceIdleAttempt(
  candidate: SoulEssenceIdleCandidate,
  now: number,
): SoulEssenceIdleCandidate {
  if (!isDirty(candidate)) return candidate;
  return { ...candidate, lastAttemptAt: now };
}

/**
 * Select at most one rebuild. Callers pass Self and User together; the oldest dirty revision wins,
 * with Self as a deterministic tie-breaker. Global gates ensure a linked phone never becomes a
 * second scheduler and background maintenance never competes with active app/model work.
 */
export function selectSoulEssenceIdleCandidate(
  candidates: readonly SoulEssenceIdleCandidate[],
  context: SoulEssenceIdleSelectionContext,
): SoulEssenceIdleCandidate | undefined {
  if (
    context.isRemoteClient ||
    context.processActive ||
    context.essenceActive ||
    elapsed(context.now, context.lastUserRequestAt) < SOUL_ESSENCE_IDLE_DELAY_MS
  ) {
    return undefined;
  }

  return candidates
    .filter((candidate) => {
      if (!isDirty(candidate) || candidate.firstDirtyAt === null) return false;
      if (
        elapsed(context.now, candidate.firstDirtyAt) <
        SOUL_ESSENCE_DIRTY_DELAY_MS
      ) {
        return false;
      }
      return (
        candidate.lastAttemptAt === null ||
        elapsed(context.now, candidate.lastAttemptAt) >=
          SOUL_ESSENCE_IDLE_RETRY_MS
      );
    })
    .sort(
      (left, right) =>
        left.firstDirtyAt! - right.firstDirtyAt! ||
        (left.kind === right.kind ? 0 : left.kind === "self" ? -1 : 1),
    )[0];
}
