import { describe, expect, it } from "vitest";
import { deserializeFromRemote, serializeForRemote, bytesToBase64, base64ToBytes } from "@visual-reader/core";
import { extractedUploadText, faithfulUploadFitsRelay, MAX_ORIGINAL_UPLOAD_BYTES, originalUpload, prepareChatUpload } from "./upload-attachments.js";

function file(name: string, bytes: number[], type = "application/octet-stream"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}
describe("faithful upload preparation", () => {
  it("keeps source BOM, CRLF and trailing spaces even when code parsing normalizes its view", async () => {
    const bytes = new TextEncoder().encode("\ufefffunction f() {\r\n  return 1;  \r\n}\r\n");
    const prepared = await prepareChatUpload(file("source.js", Array.from(bytes)), async () => ({ kind: "book", book: { id: "source", title: "source", contentMode: "code", code: "function f() {\n  return 1;\n}", pages: [], chapters: [] } }));
    expect(new Uint8Array(prepared.original!.bytes)).toEqual(bytes);
    expect(prepared.original?.name).toBe("source.js");
    expect(prepared.text).toContain("function f()");
    expect(prepared.text).not.toContain("\r\n");
  });
  it("keeps PDF/binary originals separate from extracted text and its chat cap", async () => {
    const bytes = [37, 80, 68, 70, 0, 255, 128];
    const text = "text ".repeat(7000);
    const prepared = await prepareChatUpload(file("invoice.pdf", bytes, "application/pdf"), async () => ({ kind: "text", title: "Invoice title", text }));
    expect(Array.from(new Uint8Array(prepared.original!.bytes))).toEqual(bytes);
    expect(prepared.text?.length).toBe(30_000);
    expect(prepared.full).toBe(text);
    expect(prepared.fileName).toBe("invoice.pdf");
  });
  it("keeps image originals independent from previews and conditioning copies", async () => {
    const bytes = [137, 80, 78, 71, 0, 255, 128];
    const prepared = await prepareChatUpload(file("photo.png", bytes, "image/png"), async () => ({ kind: "image", name: "photo.png", bytes: new Uint8Array([1, 2]).buffer, mimeType: "image/png" }));
    expect(prepared.kind).toBe("image");
    expect(Array.from(new Uint8Array(prepared.original!.bytes))).toEqual(bytes);
    new Uint8Array(prepared.image!.bytes).fill(0);
    expect(Array.from(new Uint8Array(prepared.original!.bytes))).toEqual(bytes);
  });
  it("preserves unreadable documents, unknown binary formats and empty files for saving", async () => {
    const failed = await prepareChatUpload(file("scan.pdf", [0, 255]), async () => { throw new Error("parser unavailable"); });
    expect(failed.original?.bytes.byteLength).toBe(2);
    expect(failed.analysisError).toContain("parser unavailable");
    const binary = await prepareChatUpload(file("archive.zip", [0, 255]), async () => ({ kind: "text", title: "Archive", text: "binary\0garbage" }));
    expect(binary.text).toBeUndefined();
    expect(binary.original?.name).toBe("archive.zip");
    const empty = await prepareChatUpload(file("empty.txt", []), async () => ({ kind: "text", title: "Empty", text: "" }));
    expect(empty.original?.bytes.byteLength).toBe(0);
  });
  it("rejects oversized files before reading their bytes", async () => {
    let read = false;
    await expect(originalUpload({ size: MAX_ORIGINAL_UPLOAD_BYTES + 1, arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } } as File)).rejects.toThrow("100 MiB");
    expect(read).toBe(false);
  });
  it("round-trips original bytes through the actual relay codec, not extracted text", async () => {
    const upload = await originalUpload(file("photo.jpg", [255, 216, 0, 128, 255, 217], "image/jpeg"));
    const payload = { type: "vrcmd:saveUpload", original: upload };
    const decoded = deserializeFromRemote(JSON.parse(JSON.stringify(serializeForRemote(payload, bytesToBase64))), base64ToBytes) as typeof payload;
    expect(new Uint8Array(decoded.original.bytes)).toEqual(new Uint8Array(upload.bytes));
    expect(decoded.original.name).toBe("photo.jpg");
  });
  it("measures base64 expansion and UTF-8 bytes, including untouched originals", () => {
    expect(faithfulUploadFitsRelay({ original: { bytes: new ArrayBuffer(100) } })).toBe(true);
    expect(faithfulUploadFitsRelay({ original: { bytes: new ArrayBuffer(2_400_000) } })).toBe(false);
    expect(faithfulUploadFitsRelay({ text: "漢".repeat(1_100_000) })).toBe(false);
    expect(faithfulUploadFitsRelay(undefined)).toBe(false);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(faithfulUploadFitsRelay(cyclic)).toBe(false);
  });
  it("extracts book text as a separate view, never image bytes", () => {
    expect(extractedUploadText({ kind: "image", name: "a.png", bytes: new ArrayBuffer(2), mimeType: "image/png" })).toBeUndefined();
    expect(extractedUploadText({ kind: "text", title: "a", text: "Text" })).toBe("Text");
  });
});
