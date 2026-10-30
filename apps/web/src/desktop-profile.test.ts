import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { attachBackedUpProfile, verifyDesktopProfile, type ProfileAnchor } from "./desktop-profile.js";

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

  it.each([null, "changed-local-marker"])("repairs Local Storage %s from the database anchor, only after native validation", async (local) => {
    const storage = { getItem: () => local, setItem: vi.fn() };
    const anchor = { read: async () => "expected-database-profile", write: vi.fn(async () => {}) };
    const check = vi.fn(async (id: string) => { expect(id).toBe("expected-database-profile"); });
    await verifyDesktopProfile(storage, check, () => "new-local-profile", anchor);
    expect(check).toHaveBeenCalledOnce();
    expect(anchor.write).toHaveBeenCalledWith("expected-database-profile");
    expect(storage.setItem).toHaveBeenLastCalledWith("vr-desktop-profile-id", "expected-database-profile");
  });

  it("does not use a matching local marker to conceal a genuinely different database", async () => {
    const storage = { getItem: () => "native-expected-profile", setItem: vi.fn() };
    const anchor = { read: async () => "another-database-profile", write: vi.fn() };
    const check = vi.fn(async () => { throw Error("database mismatch"); });
    await expect(verifyDesktopProfile(storage, check, () => "new", anchor)).rejects.toThrow("database mismatch");
    expect(check).toHaveBeenCalledWith("another-database-profile");
    expect(anchor.write).not.toHaveBeenCalled();
  });

  it("does not treat an unreadable database anchor as an absent anchor", async () => {
    const anchor = { read: async () => { throw Error("database read failed"); }, write: vi.fn() };
    const check = vi.fn();
    await expect(verifyDesktopProfile({ getItem: () => "existing-local-profile", setItem: vi.fn() }, check, () => "new", anchor)).rejects.toThrow("database read failed");
    expect(check).not.toHaveBeenCalled();
    expect(anchor.write).not.toHaveBeenCalled();
  });

  it("migrates a validated legacy profile into the chat database and reuses it after Local Storage is cleared", async () => {
    let local: string | null = "legacy-valid-profile";
    let durable: string | undefined;
    const storage = { getItem: () => local, setItem: (_key: string, id: string) => { local = id; } };
    const anchor: ProfileAnchor = { read: async () => durable, write: async (id) => { durable = id; } };
    const check = vi.fn(async (id: string) => { if (id !== "legacy-valid-profile") throw Error("wrong profile"); });
    await verifyDesktopProfile(storage, check, () => "newly-generated-profile", anchor);
    local = null;
    await verifyDesktopProfile(storage, check, () => "newly-generated-profile", anchor);
    expect(local).toBe("legacy-valid-profile");
    expect(durable).toBe("legacy-valid-profile");
  });

  it("keeps startup closed if the database anchor cannot be persisted", async () => {
    const anchor = { read: async () => undefined, write: async () => { throw Error("disk full"); } };
    await expect(verifyDesktopProfile({ getItem: () => "valid-profile", setItem: vi.fn() }, async () => {}, () => "new", anchor)).rejects.toThrow("disk full");
  });

  it("recovery validates the backed-up native identity before changing either renderer marker", async () => {
    const events: string[] = [];
    await attachBackedUpProfile("native-existing-profile", { setItem: () => { events.push("local"); } },
      { read: async () => undefined, write: async () => { events.push("database"); } }, async () => { events.push("validate"); });
    expect(events).toEqual(["validate", "database", "local"]);
  });

  it("cannot recover to a rejected identity or overwrite the database anchor on rejection", async () => {
    const storage = { setItem: vi.fn() };
    const anchor = { read: async () => undefined, write: vi.fn() };
    await expect(attachBackedUpProfile("wrong-profile", storage, anchor, async () => { throw Error("rejected"); })).rejects.toThrow("rejected");
    expect(anchor.write).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("gates manual reattachment on a completed native backup and a nonempty inspected database", () => {
    const gate = readFileSync(new URL("./DesktopSessionGate.tsx", import.meta.url), "utf8");
    expect(gate).toContain('disabled={!populated || working}');
    expect(gate).toContain('setReceipt(await saveProfileRecovery(');
    expect(gate).toContain('if (!receipt || working) return');
    expect(gate).toContain('await attachBackedUpProfile(receipt.profileId');
    expect(gate).toContain('location.reload()');
    expect(gate).not.toContain('importData(');
  });
});
