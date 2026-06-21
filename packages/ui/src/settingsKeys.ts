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
  // Read when building the buddy prompt; toggling it must not rebuild the engine.
  "allowCommands",
  "autonomousWorkspace",
  "commandShell",
  "autoResolveConflicts",
  "allowTaskAutomation",
  "allowTradingViewBridge",
  "autoLearnSkills",
  "remoteBus",
  "mcpServers",
  // Read at scan time (the focus email query); changing it must not rebuild the engine.
  "scanFocus",
  // Read per turn when fanning sub-agents out; changing them must not rebuild the engine.
  "agentConcurrency",
  "subAgentServerUrl",
  "subAgentModel",
] as const satisfies readonly (keyof ReaderSettings)[];

/** Settings the engine never needs at all (pure presentation). */
export const UI_ONLY_FIELDS = ["panelsPerView"] as const satisfies readonly (keyof ReaderSettings)[];

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
