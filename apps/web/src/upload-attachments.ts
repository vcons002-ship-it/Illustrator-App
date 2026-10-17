import { bytesToBase64, MAX_RELAY_COMMAND_BYTES, serializeForRemote } from "@visual-reader/core";
import { importBookFile, type ImportedFile } from "./import-file.js";
import type { ChatSendAttachment, OriginalUpload } from "./remote-sync.js";
export type { OriginalUpload, UploadTarget } from "./remote-sync.js";

export const MAX_ORIGINAL_UPLOAD_BYTES = 100 * 1024 * 1024;
export const ATTACHMENT_TEXT_LIMIT = 30_000;

export async function originalUpload(file: File): Promise<OriginalUpload> {
  if (file.size > MAX_ORIGINAL_UPLOAD_BYTES) throw new Error("File exceeds the 100 MiB original-upload limit.");
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_ORIGINAL_UPLOAD_BYTES) throw new Error("File exceeds the 100 MiB original-upload limit.");
  return { name: file.name, bytes, mimeType: file.type || "application/octet-stream" };
}

/** Text is a derived view only. Never rebuild the original from normalized code/extracted text. */
export function extractedUploadText(imported: ImportedFile): string | undefined {
  if (imported.kind === "image") return undefined;
  return imported.kind === "book"
    ? imported.book.code ?? imported.book.pages.flatMap(p => p.paragraphs.map(par => par.text)).join("\n\n")
    : imported.text;
}

/** Even an unsupported/unreadable document can be faithfully saved; only its chat analysis fails. */
export async function prepareChatUpload(file: File, importer: (file: File) => Promise<ImportedFile> = importBookFile): Promise<ChatSendAttachment> {
  const original = await originalUpload(file);
  try {
    const imported = await importer(file);
    if (imported.kind === "image") return { name: file.name, kind: "image", original, image: { bytes: original.bytes.slice(0), mimeType: imported.mimeType } };
    const text = extractedUploadText(imported) ?? "";
    if (!text.trim() || /[\x00-\x08\x0b\x0e-\x1f]/.test(text))
      return { name: file.name, fileName: file.name, kind: "doc", original, analysisError: "No readable text could be extracted; the original can still be saved." };
    const name = imported.kind === "book" ? imported.book.title : imported.title || file.name;
    const bounded = text.slice(0, ATTACHMENT_TEXT_LIMIT);
    return { name, fileName: file.name, kind: "doc", original, text: bounded, ...(text.length > bounded.length ? { full: text } : {}) };
  } catch (error) {
    return { name: file.name, fileName: file.name, kind: "doc", original, analysisError: `Text extraction unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Measure the actual wire encoding, not ArrayBuffers serialized as empty JSON objects. */
export function faithfulUploadFitsRelay(payload: unknown): boolean {
  try {
    const json = JSON.stringify(serializeForRemote(payload, bytesToBase64));
    return json !== undefined && new TextEncoder().encode(json).byteLength <= MAX_RELAY_COMMAND_BYTES;
  }
  catch { return false; }
}
