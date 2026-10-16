import { describe, expect, it } from "vitest";
import { dataBackupPayload, updateBackupFilename } from "./data-backup.js";

describe("update recovery backup", () => {
  it("retains every store and settings, with non-secret provenance and counts", () => {
    const backup = { app: "visual-reader" as const, version: 5, at: 1,
      stores: { chats: [{ key: "c", value: { text: "kept" } }], memos: [], chatblobs: [] } };
    const result = dataBackupPayload(backup, '{"theme":"dark"}', "http://tauri.localhost");
    expect(result.stores).toBe(backup.stores);
    expect(result.settings).toBe('{"theme":"dark"}');
    expect(result.counts).toEqual({ chats: 1, memos: 0, chatblobs: 0 });
    expect(result.source).toEqual({ origin: "http://tauri.localhost" });
  });
  it("uses Windows-safe timestamped filenames instead of a daily overwrite", () => {
    expect(updateBackupFilename(new Date("2026-10-16T06:00:01.002Z")))
      .toBe("visual-reader-pre-update-2026-10-16T06-00-01-002Z.json");
  });
});
