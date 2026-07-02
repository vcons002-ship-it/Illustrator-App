import { describe, expect, it } from "vitest";
import type { StoredChatMessage } from "../storage/store.js";
import { collectCreations, creationKey, removeCreationFromMessages } from "./creations.js";

const buf = (n: number) => new ArrayBuffer(n);

const msg = (over: Partial<StoredChatMessage>): StoredChatMessage => ({
  role: "assistant",
  text: "here you go",
  at: 1000,
  ...over,
});

describe("collectCreations", () => {
  it("collects inline images (bytes and externalized) with a caption", () => {
    const items = collectCreations("chat-1", "My chat", [
      msg({ image: { bytes: buf(4), mimeType: "image/png" }, text: "A castle at dusk\nmore detail" }),
      msg({ at: 2000, image: { id: "img-x-2000-0", mimeType: "image/webp" } }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ chatId: "chat-1", chatLabel: "My chat", kind: "image", mimeType: "image/png", label: "A castle at dusk" });
    expect(items[0]!.bytes).toBeDefined();
    expect(items[1]).toMatchObject({ kind: "image", blobId: "img-x-2000-0", mimeType: "image/webp" });
    expect(items[1]!.bytes).toBeUndefined();
  });

  it("collects videos and skips sourceUrl hotlinks, user messages, and byte-less path attachments", () => {
    const items = collectCreations("c", "c", [
      msg({ video: { id: "vid-1", mimeType: "video/mp4" } }),
      msg({ at: 2000, image: { sourceUrl: "https://example.com/x.png" } }),
      msg({ at: 3000, role: "user", image: { bytes: buf(2), mimeType: "image/png" } }),
      msg({ at: 4000, attachments: [{ name: "found.png", mime: "image/png", kind: "image", path: "C:/x/found.png" }] }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "video", blobId: "vid-1" });
  });

  it("de-dups an inline image against its file-card attachment (shared id / shared buffer)", () => {
    const shared = buf(8);
    const items = collectCreations("c", "c", [
      msg({
        image: { id: "img-a", mimeType: "image/png" },
        attachments: [{ name: "render.png", mime: "image/png", kind: "image", id: "img-a" }],
      }),
      msg({
        at: 2000,
        image: { bytes: shared, mimeType: "image/png" },
        attachments: [{ name: "render2.png", mime: "image/png", kind: "image", bytes: shared }],
      }),
    ]);
    expect(items).toHaveLength(2);
  });

  it("keeps extra attachments that are distinct creations (a multi-image turn)", () => {
    const items = collectCreations("c", "c", [
      msg({
        image: { id: "img-a", mimeType: "image/png" },
        attachments: [
          { name: "a.png", mime: "image/png", kind: "image", id: "img-a" },
          { name: "b.png", mime: "image/png", kind: "image", id: "img-b" },
          { name: "notes.txt", mime: "text/plain", kind: "text", id: "t-1" },
        ],
      }),
    ]);
    expect(items.map((i) => i.blobId)).toEqual(["img-a", "img-b"]);
    expect(items[1]!.label).toBe("b.png");
  });

  it("creationKey is stable and unique per blob / per inline-media slot", () => {
    const a = creationKey({ chatId: "c", at: 1, kind: "image", blobId: "x" });
    const b = creationKey({ chatId: "c", at: 1, kind: "image" });
    const v = creationKey({ chatId: "c", at: 1, kind: "video" });
    expect(a).toBe("c::x");
    expect(b).not.toBe(v);
  });
});

describe("removeCreationFromMessages", () => {
  it("strips a blob-id creation from both the inline field and its attachment", () => {
    const messages = [
      msg({
        image: { id: "img-a", mimeType: "image/png" },
        attachments: [
          { name: "a.png", mime: "image/png", kind: "image" as const, id: "img-a" },
          { name: "notes.txt", mime: "text/plain", kind: "text" as const },
        ],
      }),
    ];
    const out = removeCreationFromMessages(messages, { at: 1000, kind: "image", blobId: "img-a" });
    expect(out).not.toBe(messages);
    expect(out[0]!.image).toBeUndefined();
    expect(out[0]!.attachments).toHaveLength(1);
    expect(out[0]!.attachments![0]!.name).toBe("notes.txt");
    expect(out[0]!.text).toBe("here you go"); // the message itself survives
  });

  it("matches an inline-bytes creation by message time + kind and leaves the other kind alone", () => {
    const messages = [
      msg({
        image: { bytes: buf(4), mimeType: "image/png" },
        video: { id: "vid-1", mimeType: "video/mp4" },
      }),
    ];
    const out = removeCreationFromMessages(messages, { at: 1000, kind: "image" });
    expect(out[0]!.image).toBeUndefined();
    expect(out[0]!.video).toBeDefined();
  });

  it("returns the same reference when nothing matches (skips a no-op re-persist)", () => {
    const messages = [msg({ image: { id: "img-a", mimeType: "image/png" } })];
    expect(removeCreationFromMessages(messages, { at: 999, kind: "video", blobId: "nope" })).toBe(messages);
  });

  it("never touches a sourceUrl hotlink even at the same timestamp", () => {
    const messages = [msg({ image: { sourceUrl: "https://example.com/x.png" } })];
    expect(removeCreationFromMessages(messages, { at: 1000, kind: "image" })).toBe(messages);
  });
});
