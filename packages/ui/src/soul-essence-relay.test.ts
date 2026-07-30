import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SOUL_ESSENCE_SCHEMA_VERSION,
  type SoulEssence,
} from "@visual-reader/core";
import type {
  AppSyncMessage,
  SoulEssenceJobProgress,
} from "../../../apps/web/src/remote-sync.js";
import {
  useRemoteMirror,
  type RemoteMirrorDeps,
} from "../../../apps/web/src/useRemoteMirror.js";

const reactHarness = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  stateWrites: [] as unknown[],
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) reactHarness.cleanups.push(cleanup);
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial?: unknown) => {
    let current =
      typeof initial === "function" ? (initial as () => unknown)() : initial;
    const setState = (next: unknown): void => {
      current =
        typeof next === "function"
          ? (next as (previous: unknown) => unknown)(current)
          : next;
      reactHarness.stateWrites.push(current);
    };
    return [current, setState];
  },
}));

vi.mock("../../../apps/web/src/runtime.js", () => ({
  restartApp: vi.fn(async () => undefined),
}));

const ESSENCE = {
  schemaVersion: SOUL_ESSENCE_SCHEMA_VERSION,
  kind: "self",
  sourceFingerprint: `soul-v${SOUL_ESSENCE_SCHEMA_VERSION}-test`,
  generatedAt: 123,
  generalizedEssence: { text: "Warm, curious, and direct", sourceIds: [] },
  facets: {
    coreDisposition: { text: "Warm", sourceIds: [] },
    conversationalVoice: { text: "Direct", sourceIds: [] },
    thinkingStyle: { text: "Reflective", sourceIds: [] },
    valuesAndMotivations: { text: "Curiosity", sourceIds: [] },
    relationalStyle: { text: "Attentive", sourceIds: [] },
    personalityDirections: { text: "Stay grounded", sourceIds: [] },
    tensionsAndNuance: { text: "Playful but precise", sourceIds: [] },
  },
  exactAppearance: [],
  exactPersonalityDirections: [],
} satisfies SoulEssence;

function makeDeps(
  isRemoteClient: boolean,
  sendAppSync: (message: AppSyncMessage) => void,
  setAppSyncHandler: (handler: (message: AppSyncMessage) => void) => void,
  overrides: Partial<RemoteMirrorDeps> = {},
): RemoteMirrorDeps {
  const noop = (): void => undefined;
  return {
    isRemoteClient,
    sendAppSync,
    setAppSyncHandler,
    libraryStore: {},
    library: [],
    settings: {},
    engineInventory: {},
    memories: [],
    skills: [],
    souls: {
      self: { name: "Sage", notes: [] },
      user: { name: "Reader", notes: [] },
    },
    scheduled: [],
    book: undefined,
    bible: undefined,
    effectiveVram: undefined,
    setLibrary: noop,
    setSettings: noop,
    applyInventory: noop,
    setMemories: noop,
    setSkills: noop,
    applySoul: noop,
    refreshSoul: noop,
    generateSoulEssence: async () => ({}),
    cancelSoulEssenceRequest: noop,
    setScheduled: noop,
    setBook: noop,
    setBible: noop,
    setRemoteVram: noop,
    setRemoteHost: noop,
    openBook: noop,
    closeBook: noop,
    refreshSkills: noop,
    clearBuddyPlan: noop,
    applyScheduledCommand: noop,
    bookRef: { current: undefined },
    settingsRef: { current: {} },
    phoneExitedBookId: { current: undefined },
    buddyMessagesRef: { current: [] },
    activeBuddyIdRef: { current: "chat-1" },
    ...overrides,
  } as unknown as RemoteMirrorDeps;
}

function soulRefreshCommands(
  messages: readonly AppSyncMessage[],
): Array<Extract<AppSyncMessage, { type: "vrcmd:soulEssenceRefresh" }>> {
  return messages.filter(
    (
      message,
    ): message is Extract<AppSyncMessage, { type: "vrcmd:soulEssenceRefresh" }> =>
      message.type === "vrcmd:soulEssenceRefresh",
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  reactHarness.cleanups.splice(0);
  reactHarness.stateWrites.splice(0);
});

afterEach(() => {
  for (const cleanup of reactHarness.cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe("Soul Essence phone relay", () => {
  it("rearms the inactivity watchdog on progress and resolves the matching result", async () => {
    const sendAppSync = vi.fn<(message: AppSyncMessage) => void>();
    let relayHandler: ((message: AppSyncMessage) => void) | undefined;
    const mirror = useRemoteMirror(
      makeDeps(true, sendAppSync, (handler) => {
        relayHandler = handler;
      }),
    );

    const resultPromise = mirror.requestSoulEssenceRefresh("self");
    const requestId = soulRefreshCommands(
      sendAppSync.mock.calls.map(([message]) => message),
    )[0]!.requestId;
    expect(sendAppSync).toHaveBeenCalledWith({
      type: "vrcmd:soulEssenceRefresh",
      requestId,
      kind: "self",
    });

    vi.advanceTimersByTime(10 * 60_000);
    const progress: SoulEssenceJobProgress = {
      phase: "analyzing",
      message: "Analyzing source chunk 2 of 5",
      pass: 2,
      total: 5,
      tokens: 1_234,
      startedAt: 10,
    };
    relayHandler?.({
      type: "vrsync:soulEssenceProgress",
      requestId,
      kind: "self",
      progress,
    });
    vi.advanceTimersByTime(10 * 60_000);

    expect(sendAppSync).not.toHaveBeenCalledWith({
      type: "vrcmd:soulEssenceCancel",
      requestId,
      kind: "self",
    });
    expect(reactHarness.stateWrites).toContainEqual({
      active: true,
      requestId,
      kind: "self",
      ...progress,
    });

    relayHandler?.({
      type: "vrsync:soulEssenceResult",
      requestId,
      kind: "self",
      essence: ESSENCE,
    });
    await expect(resultPromise).resolves.toEqual({ essence: ESSENCE });
  });

  it("cancels only the requested Soul and ignores its stale result during a retry", async () => {
    const sendAppSync = vi.fn<(message: AppSyncMessage) => void>();
    let relayHandler: ((message: AppSyncMessage) => void) | undefined;
    const mirror = useRemoteMirror(
      makeDeps(true, sendAppSync, (handler) => {
        relayHandler = handler;
      }),
    );

    const cancelled = mirror.requestSoulEssenceRefresh("self");
    const otherSoul = mirror.requestSoulEssenceRefresh("user");
    const [cancelledRequest, otherRequest] = soulRefreshCommands(
      sendAppSync.mock.calls.map(([message]) => message),
    );
    mirror.cancelSoulEssenceRefresh("self");

    relayHandler?.({
      type: "vrsync:soulEssenceResult",
      requestId: cancelledRequest!.requestId,
      kind: "self",
      error: "Soul Essence generation was cancelled.",
    });
    await expect(cancelled).resolves.toEqual({
      error: "Soul Essence generation was cancelled.",
    });
    expect(sendAppSync).toHaveBeenCalledWith({
      type: "vrcmd:soulEssenceCancel",
      requestId: cancelledRequest!.requestId,
      kind: "self",
    });
    expect(sendAppSync).not.toHaveBeenCalledWith({
      type: "vrcmd:soulEssenceCancel",
      requestId: otherRequest!.requestId,
      kind: "user",
    });

    const retry = mirror.requestSoulEssenceRefresh("self");
    const retryRequest = soulRefreshCommands(
      sendAppSync.mock.calls.map(([message]) => message),
    )[2]!;
    let retrySettled = false;
    void retry.then(() => {
      retrySettled = true;
    });
    relayHandler?.({
      type: "vrsync:soulEssenceResult",
      requestId: cancelledRequest!.requestId,
      kind: "self",
      essence: ESSENCE,
    });
    await Promise.resolve();
    expect(retrySettled).toBe(false);

    relayHandler?.({
      type: "vrsync:soulEssenceResult",
      requestId: retryRequest.requestId,
      kind: "self",
      essence: ESSENCE,
    });
    await expect(retry).resolves.toEqual({ essence: ESSENCE });

    relayHandler?.({
      type: "vrsync:soulEssenceResult",
      requestId: otherRequest!.requestId,
      kind: "user",
      error: "User Soul failed",
    });
    await expect(otherSoul).resolves.toEqual({ error: "User Soul failed" });
  });
});

describe("Soul Essence desktop relay", () => {
  it("relays progress under the phone ID but cancels the exact correlated worker ID", async () => {
    const sendAppSync = vi.fn<(message: AppSyncMessage) => void>();
    let relayHandler: ((message: AppSyncMessage) => void) | undefined;
    let resolveGeneration:
      | ((result: { essence?: SoulEssence; error?: string }) => void)
      | undefined;
    const cancelSoulEssenceRequest = vi.fn<(requestId: number) => void>(() => {
      resolveGeneration?.({ error: "Soul Essence generation was cancelled." });
    });
    const progress: SoulEssenceJobProgress = {
      phase: "merging",
      message: "Integrating Soul pass 3",
      pass: 3,
      total: 4,
      tokens: 900,
      startedAt: 20,
    };
    const generateSoulEssence = vi.fn(
      (
        _kind: "self" | "user",
        onProgress?: (event: SoulEssenceJobProgress) => void,
        onRequestId?: (requestId: number) => void,
      ) =>
        new Promise<{ essence?: SoulEssence; error?: string }>((resolve) => {
          resolveGeneration = resolve;
          onRequestId?.(77);
          onProgress?.(progress);
        }),
    );
    useRemoteMirror(
      makeDeps(
        false,
        sendAppSync,
        (handler) => {
          relayHandler = handler;
        },
        { generateSoulEssence, cancelSoulEssenceRequest },
      ),
    );

    relayHandler?.({
      type: "vrcmd:soulEssenceRefresh",
      requestId: "phone-a:12",
      kind: "self",
    });
    expect(sendAppSync).toHaveBeenCalledWith({
      type: "vrsync:soulEssenceProgress",
      requestId: "phone-a:12",
      kind: "self",
      progress,
    });

    relayHandler?.({
      type: "vrcmd:soulEssenceCancel",
      requestId: "phone-a:999",
      kind: "self",
    });
    expect(cancelSoulEssenceRequest).not.toHaveBeenCalled();
    relayHandler?.({
      type: "vrcmd:soulEssenceCancel",
      requestId: "phone-a:12",
      kind: "self",
    });
    expect(cancelSoulEssenceRequest).toHaveBeenCalledOnce();
    expect(cancelSoulEssenceRequest).toHaveBeenCalledWith(77);

    // Drain the catch -> then -> finally chain used by the relay.
    for (let step = 0; step < 4; step += 1) await Promise.resolve();
    expect(sendAppSync).toHaveBeenCalledWith({
      type: "vrsync:soulEssenceResult",
      requestId: "phone-a:12",
      kind: "self",
      error: "Soul Essence generation was cancelled.",
    });

    relayHandler?.({
      type: "vrcmd:soulEssenceCancel",
      requestId: "phone-a:12",
      kind: "self",
    });
    expect(cancelSoulEssenceRequest).toHaveBeenCalledOnce();
  });
});
