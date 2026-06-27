import { describe, it, expect } from "vitest";
import { externalizeChatImages, externalizedImageId, restoreInlineImages } from "./chat-image-blobs.js";
import type { StoredChatMessage } from "../storage/store.js";

const bytesOf = (...n: number[]) => new Uint8Array(n).buffer;

describe("externalizeChatImages", () => {
  it("passes a byte-less message through unchanged (same reference)", () => {
    const msg: StoredChatMessage = { role: "assistant", text: "hi", at: 1 };
    const out = externalizeChatImages(msg, () => "x");
    expect(out.message).toBe(msg);
    expect(out.blobs).toEqual([]);
  });

  it("de-dups a generated image's shared inline + file-card buffer to ONE blob", () => {
    const buf = bytesOf(1, 2, 3);
    const msg: StoredChatMessage = {
      role: "tool",
      text: "🖼 a castle",
      at: 5,
      image: { bytes: buf, mimeType: "image/png" },
      attachments: [{ id: "img-1", name: "castle.png", mime: "image/png", kind: "image", bytes: buf }],
    };
    const { message, blobs } = externalizeChatImages(msg, () => "should-not-mint");
    // ONE blob under the attachment's stable id; both copies point at it.
    expect(blobs).toHaveLength(1);
    expect(blobs[0]).toEqual({ id: "img-1", bytes: buf, mimeType: "image/png" });
    expect(message.image).toEqual({ id: "img-1", mimeType: "image/png" });
    expect(message.attachments?.[0]).toMatchObject({ id: "img-1", kind: "image" });
    expect((message.attachments?.[0] as { bytes?: ArrayBuffer }).bytes).toBeUndefined();
  });

  it("mints a stable id for an inline-only image (no attachment)", () => {
    const msg: StoredChatMessage = {
      role: "user",
      text: "🖼 photo.jpg",
      at: 9,
      image: { bytes: bytesOf(4, 5), mimeType: "image/jpeg" },
    };
    let k = 0;
    const { message, blobs } = externalizeChatImages(msg, () => `mint-${k++}`);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.id).toBe("mint-0");
    expect(message.image).toEqual({ id: "mint-0", mimeType: "image/jpeg" });
  });

  it("reuses an id the inline image already carries (re-persist doesn't orphan the blob)", () => {
    const msg: StoredChatMessage = {
      role: "tool",
      text: "🖼 x",
      at: 3,
      image: { bytes: bytesOf(7), mimeType: "image/png", id: "img-existing" },
    };
    const { message, blobs } = externalizeChatImages(msg, () => "fresh-mint");
    expect(blobs[0]!.id).toBe("img-existing");
    expect(message.image).toEqual({ id: "img-existing", mimeType: "image/png" });
  });
});

describe("externalizedImageId", () => {
  it("returns undefined for a byte-bearing or absent image", () => {
    expect(externalizedImageId({ role: "assistant", text: "", at: 1 })).toBeUndefined();
    expect(externalizedImageId({ role: "assistant", text: "", at: 1, image: { bytes: bytesOf(1), mimeType: "image/png" } })).toBeUndefined();
    expect(externalizedImageId({ role: "assistant", text: "", at: 1, image: { sourceUrl: "http://x" } })).toBeUndefined();
  });

  it("returns the byte-less inline image id, else the byte-less image attachment id", () => {
    expect(externalizedImageId({ role: "tool", text: "", at: 1, image: { id: "inline-id", mimeType: "image/png" } })).toBe("inline-id");
    expect(
      externalizedImageId({
        role: "tool",
        text: "",
        at: 1,
        attachments: [{ id: "att-id", name: "a.png", mime: "image/png", kind: "image" }],
      }),
    ).toBe("att-id");
  });
});

describe("restoreInlineImages", () => {
  it("re-inlines a stripped image from the cache, keeping its id, and is a round-trip of externalize", () => {
    const buf = bytesOf(1, 2, 3);
    const original: StoredChatMessage = {
      role: "tool",
      text: "🖼 a castle",
      at: 5,
      image: { bytes: buf, mimeType: "image/png" },
      attachments: [{ id: "img-1", name: "castle.png", mime: "image/png", kind: "image", bytes: buf }],
    };
    const { message: stripped, blobs } = externalizeChatImages(original, () => "x");
    const cache = new Map(blobs.map((b) => [b.id, { bytes: b.bytes, mimeType: b.mimeType }]));
    const [restored] = restoreInlineImages([stripped], cache);
    expect(restored!.image).toEqual({ bytes: buf, mimeType: "image/png", id: "img-1" });
  });

  it("returns the SAME array when nothing matches the cache", () => {
    const msgs: StoredChatMessage[] = [{ role: "assistant", text: "no image", at: 1 }];
    expect(restoreInlineImages(msgs, new Map([["other", { bytes: bytesOf(1), mimeType: "image/png" }]]))).toBe(msgs);
  });
});
