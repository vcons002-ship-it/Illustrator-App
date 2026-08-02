import { describe, expect, it } from "vitest";
import type { StoredChatMessage } from "../storage/store.js";
import {
  boundChatHistoryForMirror,
  chunkArrayBuffer,
  concatArrayBuffers,
  fitsOneRelayFrame,
  FILE_CHUNK_BYTES,
  MAX_RELAY_COMMAND_BYTES,
} from "./mirror-bound.js";

const buf = (n: number) => new ArrayBuffer(n);
const msg = (over: Partial<StoredChatMessage>): StoredChatMessage => ({ role: "assistant", text: "x", at: 0, ...over });

describe("boundChatHistoryForMirror", () => {
  it("returns the same reference when there's nothing heavy to trim", () => {
    const msgs = [msg({ text: "hi" }), msg({ text: "there" })];
    expect(boundChatHistoryForMirror(msgs, 3_000_000)).toBe(msgs);
  });

  it("keeps recent image bytes and strips older ones beyond the budget", () => {
    const msgs = [
      msg({ text: "old", image: { bytes: buf(2_000_000), mimeType: "image/png" } }),
      msg({ text: "new", image: { bytes: buf(2_000_000), mimeType: "image/png" } }),
    ];
    const out = boundChatHistoryForMirror(msgs, 3_000_000);
    expect(out[1]!.image).toBeDefined(); // newest kept (2MB <= 3MB)
    expect(out[0]!.image).toBeUndefined(); // older dropped (budget spent)
    expect(out[0]!.text).toBe("old"); // bubble text preserved
  });

  it("strips the file-card attachment bytes too — they were unbounded before", () => {
    const msgs = [
      msg({
        text: "img card",
        image: { bytes: buf(2_000_000), mimeType: "image/png" },
        attachments: [{ id: "img-1", name: "art.png", mime: "image/png", kind: "image", bytes: buf(2_000_000) }],
      }),
      msg({ text: "fills the budget", image: { bytes: buf(3_000_000), mimeType: "image/png" } }),
    ];
    const out = boundChatHistoryForMirror(msgs, 3_000_000);
    // The newest (3MB) eats the whole budget; the older message's inline + card bytes are both dropped,
    // but the card METADATA (incl. the id the phone fetches bytes back by) stays so the card still works.
    expect(out[0]!.image).toBeUndefined();
    expect(out[0]!.attachments?.[0]!.bytes).toBeUndefined();
    expect(out[0]!.attachments?.[0]!.name).toBe("art.png");
    expect(out[0]!.attachments?.[0]!.kind).toBe("image");
    expect(out[0]!.attachments?.[0]!.id).toBe("img-1");
  });

  it("counts inline + attachment bytes of the SAME message under one budget", () => {
    // One message carrying 2MB inline + 2MB card = 4MB > 3MB budget → dropped whole.
    const msgs = [
      msg({
        text: "heavy",
        image: { bytes: buf(2_000_000), mimeType: "image/png" },
        attachments: [{ name: "a.png", mime: "image/png", kind: "image", bytes: buf(2_000_000) }],
      }),
    ];
    const out = boundChatHistoryForMirror(msgs, 3_000_000);
    expect(out[0]!.image).toBeUndefined();
    expect(out[0]!.attachments?.[0]!.bytes).toBeUndefined();
  });

  it("counts + strips the inline VIDEO clip (video clips are far larger than images)", () => {
    // A 5MB clip alone blows the 3MB budget — its inline bytes must drop, not ride every mirror frame.
    const msgs = [
      msg({
        text: "clip",
        video: { bytes: buf(5_000_000), mimeType: "video/mp4" },
        attachments: [{ id: "vid-1", name: "clip.mp4", mime: "video/mp4", kind: "video", bytes: buf(5_000_000) }],
      }),
    ];
    const out = boundChatHistoryForMirror(msgs, 3_000_000);
    expect(out[0]!.video).toBeUndefined(); // inline clip bytes dropped (the fix)
    expect(out[0]!.attachments?.[0]!.bytes).toBeUndefined(); // card bytes dropped too
    expect(out[0]!.attachments?.[0]!.id).toBe("vid-1"); // card id kept so the phone can fetch it back
    expect(out[0]!.text).toBe("clip");
  });

  it("keeps a small recent clip inline within budget", () => {
    const msgs = [msg({ text: "tiny clip", video: { bytes: buf(1_000_000), mimeType: "video/mp4" } })];
    const out = boundChatHistoryForMirror(msgs, 3_000_000);
    expect(out[0]!.video).toBeDefined(); // 1MB <= 3MB → kept
    expect(out).toBe(msgs); // nothing trimmed → same reference
  });

  it("leaves non-image attachments' metadata intact (only bytes are dropped)", () => {
    const msgs = [
      msg({ text: "big", image: { bytes: buf(4_000_000), mimeType: "image/png" } }),
      msg({ text: "doc", attachments: [{ name: "report.pdf", mime: "application/pdf", kind: "doc", bytes: buf(2_000_000) }] }),
    ];
    const out = boundChatHistoryForMirror(msgs, 3_000_000);
    // newest "doc" (2MB) fits; the 4MB image is dropped.
    expect(out[1]!.attachments?.[0]!.bytes).toBeDefined();
    expect(out[0]!.image).toBeUndefined();
  });
});

describe("chunkArrayBuffer / concatArrayBuffers (on-demand chunked file sync)", () => {
  const filled = (n: number, val: number) => {
    const u = new Uint8Array(n);
    u.fill(val);
    return u.buffer;
  };

  it("returns a single chunk when the buffer already fits", () => {
    const b = filled(500, 7);
    const chunks = chunkArrayBuffer(b, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(b);
  });

  it("splits a big buffer into <= size pieces and reassembles to the exact original", () => {
    const u = new Uint8Array(2_500);
    for (let i = 0; i < u.length; i++) u[i] = i % 256;
    const chunks = chunkArrayBuffer(u.buffer, 1000);
    expect(chunks.map((c) => c.byteLength)).toEqual([1000, 1000, 500]);
    expect([...new Uint8Array(concatArrayBuffers(chunks))]).toEqual([...u]); // 2500 elems — cheap
  });

  it("a real-ish 3.2 MB image round-trips byte-for-byte through chunk → concat", () => {
    const u = new Uint8Array(3_200_000);
    for (let i = 0; i < u.length; i += 7) u[i] = (i * 31) % 256;
    const chunks = chunkArrayBuffer(u.buffer);
    expect(chunks.length).toBe(Math.ceil(u.length / FILE_CHUNK_BYTES));
    // O(n) compare — a multi-million-element toEqual is pathologically slow in vitest.
    const back = new Uint8Array(concatArrayBuffers(chunks));
    let firstMismatch = -1;
    for (let i = 0; i < u.length; i++) {
      if (back[i] !== u[i]) {
        firstMismatch = i;
        break;
      }
    }
    expect(firstMismatch).toBe(-1);
    expect(back.byteLength).toBe(u.byteLength);
  });
});

describe("fitsOneRelayFrame — a command that can't arrive must not be sent", () => {
  it("passes ordinary commands", () => {
    expect(fitsOneRelayFrame({ type: "vrcmd:open", bookId: "b1" })).toBe(true);
    expect(fitsOneRelayFrame({ type: "vrcmd:libraryAdd", book: { id: "b", title: "T", text: "x".repeat(50_000) } })).toBe(true);
  });

  it("rejects a payload too big for one frame", () => {
    // An oversized frame doesn't fail loudly — the tunnel drops it and the phone never learns. So the
    // size is checked before sending, and the reader is told, instead of a silent "added".
    expect(fitsOneRelayFrame({ book: { text: "x".repeat(MAX_RELAY_COMMAND_BYTES + 1) } })).toBe(false);
    expect(fitsOneRelayFrame({ text: "x".repeat(20) }, 10)).toBe(false);
  });

  it("measures the SERIALIZED form, which is what actually travels", () => {
    // 8 characters of text, but escaping makes it longer on the wire.
    expect(fitsOneRelayFrame({ a: '""""""""' }, 12)).toBe(false);
  });

  it("rejects anything that can't be serialized at all", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(fitsOneRelayFrame(cyclic)).toBe(false);
    expect(fitsOneRelayFrame(undefined)).toBe(false);
  });
});
