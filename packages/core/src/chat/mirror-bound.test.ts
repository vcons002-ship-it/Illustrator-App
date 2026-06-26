import { describe, expect, it } from "vitest";
import type { StoredChatMessage } from "../storage/store.js";
import { boundChatHistoryForMirror } from "./mirror-bound.js";

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
