import { describe, it, expect } from "vitest";
import { externalizeChatImages, externalizedImageId, externalizedVideoId, restoreInlineImages } from "./chat-image-blobs.js";
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

  it("de-dups a video clip's shared inline + card buffer to ONE blob (no inline-video byte leak on disk)", () => {
    const clip = bytesOf(9, 8, 7);
    const msg: StoredChatMessage = {
      role: "tool",
      text: "🎬 a puppy",
      at: 7,
      video: { bytes: clip, mimeType: "video/mp4" },
      attachments: [{ id: "vid-1", name: "puppy.mp4", mime: "video/mp4", kind: "video", bytes: clip }],
    };
    const { message, blobs } = externalizeChatImages(msg, () => "should-not-mint");
    expect(blobs).toHaveLength(1);
    expect(blobs[0]).toEqual({ id: "vid-1", bytes: clip, mimeType: "video/mp4" });
    expect(message.video).toEqual({ id: "vid-1", mimeType: "video/mp4" }); // byte-less on disk
    expect((message.attachments?.[0] as { bytes?: ArrayBuffer }).bytes).toBeUndefined();
  });
});

describe("externalizedVideoId", () => {
  it("returns undefined for a byte-bearing or absent clip, else the byte-less clip id", () => {
    expect(externalizedVideoId({ role: "tool", text: "", at: 1 })).toBeUndefined();
    expect(externalizedVideoId({ role: "tool", text: "", at: 1, video: { bytes: bytesOf(1), mimeType: "video/mp4" } })).toBeUndefined();
    expect(externalizedVideoId({ role: "tool", text: "", at: 1, video: { id: "vid-9", mimeType: "video/mp4" } })).toBe("vid-9");
  });

  it("falls back to the byte-less video file-card attachment id when there's no inline video at all (the phone-mirror path, which drops `video` entirely rather than leaving a byte-less placeholder)", () => {
    expect(
      externalizedVideoId({
        role: "tool",
        text: "",
        at: 1,
        attachments: [{ id: "vid-att", name: "clip.mp4", mime: "video/mp4", kind: "video" }],
      }),
    ).toBe("vid-att");
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

  it("re-inlines a stripped VIDEO clip from the cache (round-trip of externalize)", () => {
    const clip = bytesOf(4, 4, 4);
    const original: StoredChatMessage = {
      role: "tool",
      text: "🎬 clip",
      at: 5,
      video: { bytes: clip, mimeType: "video/mp4" },
      attachments: [{ id: "vid-1", name: "clip.mp4", mime: "video/mp4", kind: "video", bytes: clip }],
    };
    const { message: stripped, blobs } = externalizeChatImages(original, () => "x");
    const cache = new Map(blobs.map((b) => [b.id, { bytes: b.bytes, mimeType: b.mimeType }]));
    const [restored] = restoreInlineImages([stripped], cache);
    expect(restored!.video).toEqual({ bytes: clip, mimeType: "video/mp4", id: "vid-1" });
  });
});
