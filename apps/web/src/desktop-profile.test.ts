import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { verifyDesktopProfile } from "./desktop-profile.js";

describe("desktop profile startup gate", () => {
  it("reuses a durable browser identity across overlapping startup checks", async () => {
    let id: string | null = null;
    const storage = { getItem: () => id, setItem: (_key: string, value: string) => { id = value; } };
    const makeId = vi.fn(() => "profile-original-123");
    const check = vi.fn(async () => {});
    await Promise.all([verifyDesktopProfile(storage, check, makeId), verifyDesktopProfile(storage, check, makeId)]);
    expect(makeId).toHaveBeenCalledTimes(1);
    expect(check.mock.calls).toEqual([["profile-original-123"], ["profile-original-123"]]);
  });
  it("propagates identity rejection rather than silently establishing another profile", async () => {
    const storage = { getItem: () => "unexpected-profile-123", setItem: vi.fn() };
    const makeId = vi.fn(() => "replacement-profile-456");
    await expect(verifyDesktopProfile(storage, async () => { throw Error("profile mismatch"); }, makeId)).rejects.toThrow("profile mismatch");
    expect(makeId).not.toHaveBeenCalled();
    expect(storage.setItem).toHaveBeenCalledWith("vr-desktop-profile-id", "unexpected-profile-123");
  });
  it("wraps App and permits its autosaves only after validation", () => {
    const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    const gate = readFileSync(new URL("./DesktopSessionGate.tsx", import.meta.url), "utf8");
    expect(main).toContain("<DesktopSessionGate><App /></DesktopSessionGate>");
    expect(gate).toContain('if (state === "ready") return children');
    expect(gate).toContain("await verifyDesktopProfile");
  });
});
