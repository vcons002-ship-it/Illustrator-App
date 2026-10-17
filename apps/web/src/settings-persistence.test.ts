import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSettingsPersistence } from "./settings-persistence.js";

describe("backup settings survive reload autosave", () => {
  it("retains inaccessible encrypted keys across unrelated settings saves", async () => {
    let held = "";
    const persistence = createSettingsPersistence({ setItem: (_key, value) => { held = value; } });
    const encrypted = { iv: [1], ciphertext: [2] };
    persistence.preserveEncryptedSecrets(encrypted);
    await persistence.save(async () => JSON.stringify({ textProvider: "local" }));
    expect(JSON.parse(held)).toEqual({ textProvider: "local", keysEnc: encrypted });
    await persistence.save(async () => JSON.stringify({ keysEnc: { iv: [3], ciphertext: [4] } }));
    await persistence.save(async () => JSON.stringify({ textProvider: "local" }));
    expect(JSON.parse(held).keysEnc).toBeUndefined();
  });
  const restored = JSON.stringify({ textProvider: "local", localContextTokens: 50000, keysEnc: { iv: [1], ciphertext: [2] } });
  it("blocks old pending and pagehide saves after a restore, including encryption already in flight", async () => {
    let held = "old";
    const persistence = createSettingsPersistence({ setItem: (_key, value) => { held = value; } });
    let finish!: (raw: string) => void;
    const inFlight = persistence.save(() => new Promise<string>(resolve => { finish = resolve; }));
    persistence.restore(restored);
    finish("old encrypted settings");
    await inFlight;
    await persistence.save(async () => "old debounced/pagehide settings");
    expect(held).toBe(restored);
    // A reload creates a fresh controller and permits ordinary setting changes again.
    const nextPage = createSettingsPersistence({ setItem: (_key, value) => { held = value; } });
    await nextPage.save(async () => "new user setting");
    expect(held).toBe("new user setting");
  });
  it.each(["bad JSON", "null", "[]", "123"])("rejects invalid settings without suspending normal persistence: %s", async raw => {
    let held = "old";
    const persistence = createSettingsPersistence({ setItem: (_key, value) => { held = value; } });
    expect(() => persistence.restore(raw)).toThrow();
    expect(held).toBe("old");
    await persistence.save(async () => "still saves");
    expect(held).toBe("still saves");
  });
  it("surfaces restore storage failures and resumes normal persistence", async () => {
    let writes = 0;
    const persistence = createSettingsPersistence({ setItem: () => { if (++writes === 1) throw new Error("quota exceeded"); } });
    expect(() => persistence.restore(restored)).toThrow("quota exceeded");
    await persistence.save(async () => "normal");
    expect(writes).toBe(2);
  });
  it("routes hydration, debounce, pagehide, and import through the same controller", () => {
    const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    expect(app).toContain("saveSettings(resolved, settingsPersistence)");
    expect(app).toContain("saveSettings(settings, settingsPersistence)");
    expect(app).toContain("saveSettings(settingsRef.current, settingsPersistence)");
    expect(app).toContain("settingsPersistence.restore(parsed.settings)");
    expect(app).toContain("await persistence.save(async () =>");
    expect(app).not.toContain('localStorage.setItem("vr-settings", parsed.settings)');
  });
});
