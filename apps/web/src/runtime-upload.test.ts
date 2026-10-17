import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
describe("original upload runtime bridge", () => {
  it("sends exact bytes, explicit workspace and an independent extracted-text field", async () => {
    const invoke = vi.fn(async () => ({ path: "uploads/report.pdf", absolutePath: "C:/project/uploads/report.pdf", bytes: 5, renamed: false, extractedPath: "uploads/report.pdf.extracted.txt" }));
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
    const { saveWorkspaceUpload } = await import("./runtime.js");
    const raw = new Uint8Array([37, 80, 0, 255, 128]).buffer;
    const result = await saveWorkspaceUpload("report.pdf", raw, "C:/project", "Readable text");
    expect(result.path).toBe("uploads/report.pdf");
    expect(invoke).toHaveBeenCalledWith("save_workspace_upload", { filename: "report.pdf", bodyBase64: Buffer.from(raw).toString("base64"), dir: "C:/project", extractedText: "Readable text" });
  });
  it("never falls back to the shared workspace and surfaces native save errors", async () => {
    const invoke = vi.fn(async () => { throw new Error("disk full"); });
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
    const { saveWorkspaceUpload } = await import("./runtime.js");
    await expect(saveWorkspaceUpload("photo.png", new ArrayBuffer(2), "")).rejects.toThrow("explicit upload workspace");
    expect(invoke).not.toHaveBeenCalled();
    await expect(saveWorkspaceUpload("photo.png", new ArrayBuffer(2), "C:/project")).rejects.toThrow("disk full");
  });
  it("does not silently substitute text saving on an older desktop", async () => {
    const invoke = vi.fn(async () => { throw new Error("unknown command save_workspace_upload"); });
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
    const { saveWorkspaceUpload } = await import("./runtime.js");
    await expect(saveWorkspaceUpload("document.docx", new ArrayBuffer(1), "C:/project")).rejects.toThrow("unknown command");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
