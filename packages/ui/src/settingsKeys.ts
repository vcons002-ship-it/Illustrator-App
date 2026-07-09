import type { ReaderSettings } from "./SettingsPanel.js";

/**
 * Settings changes take two paths so a style tweak never interrupts running work:
 *  - IDENTITY changes (providers, keys, models, pages-per-image, …) rebuild the
 *    providers and re-open the book — the old engine is disposed (aborting its
 *    in-flight work) because the providers themselves are different now.
 *  - TUNING changes (style, quality, aspect, sampler overrides, …) only affect how
 *    FUTURE renders are made: the live engine's tier is updated in place. Nothing
 *    is aborted, results stay, the bible build keeps running.
 * Shared by the web app's worker hook and the extension overlay, so both hosts
 * split the two paths identically.
 */
export const TUNING_FIELDS = [
  "imageStyle",
  "imageQuality",
  "aspectRatio",
  "drawAsComicPage",
  "imageModelFamily",
  "localSteps",
  "localCfg",
  "localSampler",
  "localScheduler",
  "localTextEncoder",
  "localVae",
  "styleLoraOverride",
  "gpuVramMb",
  // Chat-only provider overrides: read at chat time, so changing them must not
  // dispose the engine mid-book.
  "chatTextProvider",
  "chatLocalModel",
  "chatImageProvider",
  "localContextTokens",
  // Read per chat turn (passed as reasoning_effort); changing it must not rebuild the engine.
  "localThinkingEffort",
  // Read when building the buddy prompt; toggling it must not rebuild the engine.
  "allowCommands",
  "autonomousWorkspace",
  "delegateCoding",
  "codingAgentBackend",
  "commandShell",
  "autoResolveConflicts",
  "allowTaskAutomation",
  "allowTradingViewBridge",
  // Read when building the buddy prompt (gate the markets / sub-agent tool groups); toggling must
  // not rebuild the engine.
  "allowMarkets",
  "allowSubAgents",
  "autoLearnSkills",
  "remoteBus",
  // Read at chat/persist time + drives the desktop privacy curtain; toggling it must not rebuild.
  "incognitoRemote",
  "mcpServers",
  // Read at scan time (the focus email query); changing it must not rebuild the engine.
  "scanFocus",
  // Read per turn when fanning sub-agents out; changing them must not rebuild the engine.
  "agentConcurrency",
  "subAgentServerUrl",
  "subAgentModel",
  // Video is rendered host-side at video-render time (the book engine never reads these): the model,
  // the per-kind render params (frames/fps/steps…), and the resolved model files. Switching the video
  // model or nudging frames/fps while a book is open must NOT dispose the engine — that would abort the
  // bible build and wipe the already-rendered illustrations for a setting the engine doesn't consult.
  "videoModel",
  "videoParams",
  "videoFiles",
] as const satisfies readonly (keyof ReaderSettings)[];

/** Settings the engine never needs at all (pure presentation / bookkeeping). */
export const UI_ONLY_FIELDS = [
  "panelsPerView",
  // Per-model encoder/VAE memory: the engine reads the RESOLVED localTextEncoder/localVae (tuning
  // fields); this map only drives what those default to on model select. Changing it must not
  // rebuild the engine.
  "localComponentsByModel",
  // Per-backend server-URL memory: the engine reads the RESOLVED localServerUrl; this map only drives
  // what the URL field restores when the ComfyUI/A1111 dropdown is flipped. No engine rebuild.
  "localServerUrlByBackend",
  // Phone-link tunnel hostname: only used to BUILD the internet link in the Link-a-phone panel; the
  // engine never reads it, so editing it must not rebuild.
  "remoteLinkHost",
] as const satisfies readonly (keyof ReaderSettings)[];

/** Dependency key over just the tuning fields. */
export function tuningSettingsKey(s: ReaderSettings): string {
  return JSON.stringify(TUNING_FIELDS.map((k) => s[k]));
}

/**
 * Dependency key over everything EXCEPT tuning + UI-only fields — providers, keys,
 * models, pages-per-image, server URLs… A field added to ReaderSettings later lands
 * here by default (full rebuild: always correct, just not maximally cheap).
 */
export function identitySettingsKey(s: ReaderSettings): string {
  const skip = new Set<string>([...TUNING_FIELDS, ...UI_ONLY_FIELDS]);
  const rest: Record<string, unknown> = {};
  for (const k of Object.keys(s).sort()) {
    if (!skip.has(k)) rest[k] = (s as unknown as Record<string, unknown>)[k];
  }
  return JSON.stringify(rest);
}
