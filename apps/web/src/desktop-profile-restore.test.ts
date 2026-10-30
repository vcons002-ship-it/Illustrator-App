import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { StoreBackup } from "@visual-reader/core";
import { restoreProfileBackup } from "./desktop-profile-restore.js";

const empty: StoreBackup = { app: "visual-reader", version: 5, at: 1, stores: { chats: [], books: [], bibles: [], memos: [], chatblobs: [] } };
const populated = { ...empty, settings: '{"localSource":"server"}', stores: { ...empty.stores,
  chats: [{ key: "saved-chat", value: [{ role: "assistant", text: "saved", at: 1 }] }] } };
function fixture() {
  const events: string[] = [];
  return { events, options: {
    raw: JSON.stringify(populated), origin: "http://tauri.localhost",
    store: { exportData: vi.fn(async () => empty), importData: vi.fn(async () => { events.push("import"); }) },
    storage: { getItem: () => '{"theme":"old"}', setItem: vi.fn((key: string) => { events.push(key); }) },
    anchor: { read: async () => undefined, write: vi.fn(async () => { events.push("anchor"); }) },
    check: vi.fn(async () => { events.push("validate"); }),
    saveCurrent: vi.fn(async (_json: string) => { events.push("backup-destination"); }),
    saveIncoming: vi.fn(async () => { events.push("backup-source"); return { profileId: "native-existing-profile" }; }),
  } };
}
describe("blocked desktop profile backup restore", () => {
  it("backs up both sides, validates, merges and restores settings before attaching the identity", async () => {
    const { options, events } = fixture();
    await restoreProfileBackup(options);
    expect(events).toEqual(["backup-destination", "backup-source", "validate", "import", "vr-settings", "validate", "anchor", "vr-desktop-profile-id"]);
    expect(options.store.importData).toHaveBeenCalledWith(populated);
    expect(JSON.parse(options.saveCurrent.mock.calls[0]![0]).stores).toEqual(empty.stores);
  });
  it.each(["destination", "source", "identity"])("never imports when %s backup/validation fails", async (failure) => {
    const { options } = fixture();
    if (failure === "destination") options.saveCurrent.mockRejectedValue(Error("disk full"));
    if (failure === "source") options.saveIncoming.mockRejectedValue(Error("disk full"));
    if (failure === "identity") options.check.mockRejectedValue(Error("mismatch"));
    await expect(restoreProfileBackup(options)).rejects.toThrow();
    expect(options.store.importData).not.toHaveBeenCalled();
    expect(options.anchor.write).not.toHaveBeenCalled();
    expect(options.storage.setItem).not.toHaveBeenCalled();
  });
  it.each(["{}", "null", JSON.stringify(empty), JSON.stringify({ ...populated, settings: "[]" })])("rejects invalid/empty input before any writes", async (raw) => {
    const { options } = fixture();
    await expect(restoreProfileBackup({ ...options, raw })).rejects.toThrow();
    expect(options.saveCurrent).not.toHaveBeenCalled();
    expect(options.store.importData).not.toHaveBeenCalled();
  });
  it("keeps startup blocked on import failure, with both recovery copies already saved", async () => {
    const { options } = fixture();
    options.store.importData.mockRejectedValue(Error("write failed"));
    await expect(restoreProfileBackup(options)).rejects.toThrow("write failed");
    expect(options.saveCurrent).toHaveBeenCalledOnce();
    expect(options.saveIncoming).toHaveBeenCalledOnce();
    expect(options.anchor.write).not.toHaveBeenCalled();
  });
  it("offers restore even for an empty inspected database, without mounting App or using its import callback", () => {
    const gate = readFileSync(new URL("./DesktopSessionGate.tsx", import.meta.url), "utf8");
    expect(gate).toContain('await restoreProfileBackup(');
    expect(gate).toContain('accept=".json,application/json" disabled={working}');
    expect(gate).not.toContain('onImportData');
    expect(gate).toContain('if (state === "ready") return children');
  });
});
