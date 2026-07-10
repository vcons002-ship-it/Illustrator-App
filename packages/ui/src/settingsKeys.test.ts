import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type ReaderSettings } from "./SettingsPanel.js";
import { TUNING_FIELDS, UI_ONLY_FIELDS, identitySettingsKey, tuningSettingsKey } from "./settingsKeys.js";

describe("settingsKeys classification", () => {
  it("classifies every field as exactly one of tuning / ui-only / identity", () => {
    const tuning = new Set<string>(TUNING_FIELDS);
    const uiOnly = new Set<string>(UI_ONLY_FIELDS);
    // Tuning and UI-only are disjoint; everything else falls through to identity by construction.
    for (const k of TUNING_FIELDS) expect(uiOnly.has(k)).toBe(false);
    for (const k of UI_ONLY_FIELDS) expect(tuning.has(k)).toBe(false);
  });

  it("keeps video settings out of the identity key (they're read host-side at render time)", () => {
    // Video model/params/files are TUNING, not identity — changing them must not rebuild the engine.
    for (const k of ["videoModel", "videoParams", "videoFiles"] as const) {
      expect((TUNING_FIELDS as readonly string[]).includes(k)).toBe(true);
    }
    const base = { ...DEFAULT_SETTINGS } as ReaderSettings;
    const changed: ReaderSettings = {
      ...base,
      videoModel: "ltx2.3-i2v-22b",
      videoFiles: { checkpoint: "x.safetensors" },
      videoParams: { "wan-i2v": { frames: 81 } },
    };
    // Identity key is unchanged (no engine dispose) but the tuning key moves.
    expect(identitySettingsKey(changed)).toBe(identitySettingsKey(base));
    expect(tuningSettingsKey(changed)).not.toBe(tuningSettingsKey(base));
  });
});
