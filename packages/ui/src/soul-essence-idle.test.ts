import { describe, expect, it } from "vitest";
import {
  SOUL_ESSENCE_DIRTY_DELAY_MS,
  SOUL_ESSENCE_IDLE_DELAY_MS,
  SOUL_ESSENCE_IDLE_RETRY_MS,
  SOUL_ESSENCE_IDLE_SWEEP_MS,
  markSoulEssenceIdleAttempt,
  selectSoulEssenceIdleCandidate,
  trackSoulEssenceIdleCandidate,
  type SoulEssenceIdleCandidate,
  type SoulEssenceIdleSelectionContext,
  type SoulEssenceIdleSource,
} from "../../../apps/web/src/soul-essence-idle.js";

const NOW = 10_000_000;

function source(
  kind: "self" | "user",
  notesFingerprint: string,
  essenceFingerprint?: string,
  noteCount = 1,
): SoulEssenceIdleSource {
  return {
    kind,
    noteCount,
    notesFingerprint,
    essenceFingerprint,
  };
}

function eligibleContext(
  overrides: Partial<SoulEssenceIdleSelectionContext> = {},
): SoulEssenceIdleSelectionContext {
  return {
    now: NOW,
    lastUserRequestAt: NOW - SOUL_ESSENCE_IDLE_DELAY_MS,
    isRemoteClient: false,
    processActive: false,
    essenceActive: false,
    ...overrides,
  };
}

function eligibleCandidate(
  kind: "self" | "user" = "self",
  firstDirtyAt = NOW - SOUL_ESSENCE_DIRTY_DELAY_MS,
): SoulEssenceIdleCandidate {
  return {
    ...source(kind, `${kind}-notes-v2`, `${kind}-notes-v1`),
    firstDirtyAt,
    lastAttemptAt: null,
  };
}

describe("Soul Essence idle scheduling", () => {
  it("uses the agreed quiet, sweep, and retry intervals", () => {
    expect(SOUL_ESSENCE_IDLE_DELAY_MS).toBe(120_000);
    expect(SOUL_ESSENCE_DIRTY_DELAY_MS).toBe(120_000);
    expect(SOUL_ESSENCE_IDLE_SWEEP_MS).toBe(15_000);
    expect(SOUL_ESSENCE_IDLE_RETRY_MS).toBe(600_000);
  });

  it("preserves the first dirty time and attempt for the same note revision", () => {
    const first = trackSoulEssenceIdleCandidate(
      undefined,
      source("self", "notes-v2", "notes-v1"),
      NOW - 300_000,
    );
    const attempted = markSoulEssenceIdleAttempt(first, NOW - 240_000);
    const rerendered = trackSoulEssenceIdleCandidate(
      attempted,
      source("self", "notes-v2", "another-stale-essence"),
      NOW,
    );

    expect(rerendered.firstDirtyAt).toBe(NOW - 300_000);
    expect(rerendered.lastAttemptAt).toBe(NOW - 240_000);
  });

  it("starts a fresh quiet period and clears backoff for a new note revision", () => {
    const old = markSoulEssenceIdleAttempt(
      {
        ...source("user", "notes-v2", "notes-v1"),
        firstDirtyAt: NOW - 500_000,
        lastAttemptAt: null,
      },
      NOW - 5_000,
    );
    const changed = trackSoulEssenceIdleCandidate(
      old,
      source("user", "notes-v3", "notes-v1"),
      NOW,
    );

    expect(changed.firstDirtyAt).toBe(NOW);
    expect(changed.lastAttemptAt).toBeNull();
  });

  it("clears pending state when the Essence catches up or the Soul becomes empty", () => {
    const dirty = eligibleCandidate();
    const current = trackSoulEssenceIdleCandidate(
      dirty,
      source("self", "notes-v2", "notes-v2"),
      NOW,
    );
    const empty = trackSoulEssenceIdleCandidate(
      dirty,
      source("self", "empty", undefined, 0),
      NOW,
    );

    expect(current.firstDirtyAt).toBeNull();
    expect(current.lastAttemptAt).toBeNull();
    expect(empty.firstDirtyAt).toBeNull();
    expect(empty.lastAttemptAt).toBeNull();
    expect(selectSoulEssenceIdleCandidate([current, empty], eligibleContext()))
      .toBeUndefined();
  });

  it("requires desktop ownership, user idleness, and no active process or Essence job", () => {
    const candidate = eligibleCandidate();

    expect(
      selectSoulEssenceIdleCandidate(
        [candidate],
        eligibleContext({ isRemoteClient: true }),
      ),
    ).toBeUndefined();
    expect(
      selectSoulEssenceIdleCandidate(
        [candidate],
        eligibleContext({ processActive: true }),
      ),
    ).toBeUndefined();
    expect(
      selectSoulEssenceIdleCandidate(
        [candidate],
        eligibleContext({ essenceActive: true }),
      ),
    ).toBeUndefined();
    expect(
      selectSoulEssenceIdleCandidate(
        [candidate],
        eligibleContext({
          lastUserRequestAt: NOW - SOUL_ESSENCE_IDLE_DELAY_MS + 1,
        }),
      ),
    ).toBeUndefined();
    expect(selectSoulEssenceIdleCandidate([candidate], eligibleContext())).toBe(
      candidate,
    );
  });

  it("waits for the note-edit quiet period before selecting a revision", () => {
    const almostReady = eligibleCandidate(
      "self",
      NOW - SOUL_ESSENCE_DIRTY_DELAY_MS + 1,
    );
    const ready = {
      ...almostReady,
      firstDirtyAt: almostReady.firstDirtyAt! - 1,
    };

    expect(
      selectSoulEssenceIdleCandidate([almostReady], eligibleContext()),
    ).toBeUndefined();
    expect(selectSoulEssenceIdleCandidate([ready], eligibleContext())).toBe(
      ready,
    );
  });

  it("backs off a failed/recent attempt for ten minutes", () => {
    const candidate = markSoulEssenceIdleAttempt(
      eligibleCandidate(),
      NOW - SOUL_ESSENCE_IDLE_RETRY_MS + 1,
    );
    const retryable = {
      ...candidate,
      lastAttemptAt: candidate.lastAttemptAt! - 1,
    };

    expect(
      selectSoulEssenceIdleCandidate([candidate], eligibleContext()),
    ).toBeUndefined();
    expect(selectSoulEssenceIdleCandidate([retryable], eligibleContext())).toBe(
      retryable,
    );
  });

  it("selects only the oldest eligible Soul with a deterministic Self tie-break", () => {
    const newerSelf = eligibleCandidate("self", NOW - 300_000);
    const olderUser = eligibleCandidate("user", NOW - 400_000);
    expect(
      selectSoulEssenceIdleCandidate(
        [newerSelf, olderUser],
        eligibleContext(),
      ),
    ).toBe(olderUser);

    const tiedUser = { ...olderUser, firstDirtyAt: newerSelf.firstDirtyAt };
    expect(
      selectSoulEssenceIdleCandidate(
        [tiedUser, newerSelf],
        eligibleContext(),
      ),
    ).toBe(newerSelf);
  });

  it("recovers safely from future scheduler timestamps after a clock correction", () => {
    const future = trackSoulEssenceIdleCandidate(
      {
        ...eligibleCandidate(),
        firstDirtyAt: NOW + 1_000_000,
        lastAttemptAt: NOW + 1_000_000,
      },
      source("self", "self-notes-v2", "self-notes-v1"),
      NOW,
    );

    expect(future.firstDirtyAt).toBe(NOW);
    expect(future.lastAttemptAt).toBe(NOW);
    expect(
      selectSoulEssenceIdleCandidate(
        [future],
        eligibleContext({ now: NOW + SOUL_ESSENCE_IDLE_RETRY_MS }),
      ),
    ).toBe(future);
  });
});
