import { describe, expect, it } from "vitest";
import { mergeChatReferences, type ChatReferenceImage } from "./chat-references.js";

const ref = (label?: string, byte = 1): ChatReferenceImage => ({
  bytes: new Uint8Array([byte]).buffer,
  mimeType: "image/jpeg",
  ...(label ? { label } : {}),
});
const labels = (rs: readonly ChatReferenceImage[]): (string | undefined)[] => rs.map((r) => r.label);

describe("mergeChatReferences — one rule for every way a picture gets in", () => {
  it("ADDS to the set instead of replacing it", () => {
    // The bug: adopting appended, but the paperclip ASSIGNED. So search → adopt → then attach one of
    // your own left the attachment alone, and the render drew from one picture where the reader had
    // chosen several. Nothing about attaching says "forget the others".
    const saved = [ref("terrace.jpg"), ref("dog.png")];
    expect(labels(mergeChatReferences(saved, [ref("my-photo.jpg")], 10))).toEqual([
      "terrace.jpg",
      "dog.png",
      "my-photo.jpg",
    ]);
  });

  it("replaces by label rather than keeping two copies of one picture", () => {
    // Two copies condition the render on that face twice, weighting it against everything else in
    // the picture — and the reader is told "2 in use" for one picture they chose once.
    const merged = mergeChatReferences([ref("a.jpg", 1), ref("b.jpg", 2)], [ref("a.jpg", 9)], 10);
    expect(labels(merged)).toEqual(["b.jpg", "a.jpg"]);
    // The NEWER bytes win — a second adoption is the reader pointing at it again.
    expect(new Uint8Array(merged[1]!.bytes)[0]).toBe(9);
  });

  it("never dedupes an UNLABELLED reference — there's nothing to match it on", () => {
    const merged = mergeChatReferences([ref(undefined), ref(undefined)], [ref(undefined)], 10);
    expect(merged).toHaveLength(3);
  });

  it("keeps the NEWEST when the set is over the cap", () => {
    const saved = [ref("1"), ref("2"), ref("3")];
    expect(labels(mergeChatReferences(saved, [ref("4")], 2))).toEqual(["3", "4"]);
  });

  it("takes several at once, in order (a multi-photo attach)", () => {
    expect(labels(mergeChatReferences([ref("old")], [ref("a"), ref("b")], 10))).toEqual(["old", "a", "b"]);
  });

  it("handles the degenerate cases without throwing", () => {
    expect(mergeChatReferences([], [], 10)).toEqual([]);
    expect(mergeChatReferences([ref("a")], [], 10)).toHaveLength(1);
    expect(mergeChatReferences([ref("a")], [ref("b")], 0)).toEqual([]);
    expect(mergeChatReferences([ref("a")], [ref("b")], -3)).toEqual([]);
  });

  it("doesn't mutate what it was given", () => {
    const saved = [ref("a")];
    const incoming = [ref("b")];
    mergeChatReferences(saved, incoming, 10);
    expect(labels(saved)).toEqual(["a"]);
    expect(labels(incoming)).toEqual(["b"]);
  });
});
