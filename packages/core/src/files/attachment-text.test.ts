import { describe, expect, it } from "vitest";
import { extractAttachmentText, isTextLikeMime } from "./attachment-text.js";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("isTextLikeMime", () => {
  it("recognises text-like MIME types and extensions, rejects binaries", () => {
    expect(isTextLikeMime("text/plain")).toBe(true);
    expect(isTextLikeMime("application/json")).toBe(true);
    expect(isTextLikeMime("text/csv")).toBe(true);
    expect(isTextLikeMime("application/octet-stream", "notes.md")).toBe(true); // by extension
    expect(isTextLikeMime("application/pdf")).toBe(false);
    expect(isTextLikeMime("image/png")).toBe(false);
  });
});

describe("extractAttachmentText", () => {
  it("decodes plain text and CSV", () => {
    expect(extractAttachmentText(bytes("Confirmation #ABC123"), "text/plain")).toBe("Confirmation #ABC123");
    expect(extractAttachmentText(bytes("a,b\n1,2"), "text/csv")).toBe("a,b\n1,2");
  });

  it("strips HTML to its visible text", () => {
    const html = "<html><body><h1>Trip</h1><p>Flight <b>UA123</b></p><script>evil()</script></body></html>";
    const out = extractAttachmentText(bytes(html), "text/html")!;
    expect(out).toContain("Trip");
    expect(out).toContain("UA123");
    expect(out).not.toContain("evil");
    expect(out).not.toContain("<");
  });

  it("returns undefined for binary types (caller handles PDF/images separately)", () => {
    expect(extractAttachmentText(bytes("%PDF-1.7…"), "application/pdf", "itinerary.pdf")).toBeUndefined();
    expect(extractAttachmentText(new Uint8Array([0x89, 0x50]), "image/png")).toBeUndefined();
  });
});
