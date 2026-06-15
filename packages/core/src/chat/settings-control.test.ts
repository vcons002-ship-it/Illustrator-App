import { describe, expect, it } from "vitest";
import { CONTROLLABLE_SETTINGS, controllableSettingsIndex, parseSettingChange } from "./settings-control.js";

describe("parseSettingChange", () => {
  it("coerces boolean toggles from on/off/true/false/yes/no words", () => {
    for (const on of ["on", "true", "yes", "enable", "enabled", true, 1]) {
      const r = parseSettingChange("mature mode", on as never);
      expect(r).toMatchObject({ ok: true, key: "allowMature", value: true, valueLabel: "on", sensitive: true });
    }
    for (const off of ["off", "false", "no", "disable", false, 0]) {
      const r = parseSettingChange("mature mode", off as never);
      expect(r).toMatchObject({ ok: true, key: "allowMature", value: false, valueLabel: "off" });
    }
  });

  it("resolves enum settings by canonical value, label, or a synonym", () => {
    expect(parseSettingChange("image quality", "high")).toMatchObject({ ok: true, key: "imageQuality", value: "high" });
    expect(parseSettingChange("quality", "max")).toMatchObject({ ok: true, value: "ultra", valueLabel: "ultra" });
    expect(parseSettingChange("orientation", "tall")).toMatchObject({ ok: true, key: "aspectRatio", value: "portrait" });
    // numeric enum (panels per view) accepts the number or a word
    expect(parseSettingChange("comic panels", 4)).toMatchObject({ ok: true, key: "panelsPerView", value: 4 });
    expect(parseSettingChange("panels per view", "six")).toMatchObject({ ok: true, value: 6 });
  });

  it("picks the most specific setting (longest alias), not a loose prefix", () => {
    expect(parseSettingChange("automatic task scheduling", "on")).toMatchObject({ ok: true, key: "allowTaskAutomation" });
    expect(parseSettingChange("command execution", "on")).toMatchObject({ ok: true, key: "allowCommands", sensitive: true });
  });

  it("errors helpfully on an unknown setting or a bad value", () => {
    const unknown = parseSettingChange("teleporter", "on");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toMatch(/no controllable setting/i);
    const badEnum = parseSettingChange("image quality", "supreme");
    expect(badEnum.ok).toBe(false);
    if (!badEnum.ok) expect(badEnum.error).toMatch(/auto.*draft.*standard.*high.*ultra/i);
    const badBool = parseSettingChange("mature mode", "maybe");
    expect(badBool.ok).toBe(false);
    if (!badBool.ok) expect(badBool.error).toMatch(/on or off/i);
  });

  it("exposes every controllable setting in the prompt index", () => {
    const idx = controllableSettingsIndex();
    for (const s of CONTROLLABLE_SETTINGS) expect(idx).toContain(s.describe);
  });
});
