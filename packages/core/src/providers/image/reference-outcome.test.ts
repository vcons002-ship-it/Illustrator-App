import { describe, expect, it } from "vitest";
import { describeReferenceSources, referenceOutcome } from "./image-provider.js";

describe("referenceOutcome — the answer to \"did my photos get used?\"", () => {
  it("says nothing when no photos were offered", () => {
    expect(referenceOutcome(0, undefined)).toBeUndefined();
    expect(referenceOutcome(0, { supplied: 0, used: 0 })).toBeUndefined();
  });

  it("speaks the silence: a provider that got photos and reported nothing IGNORED them", () => {
    // Automatic1111, Flux, DALL·E and the in-browser provider take the field and drop it. The
    // picture comes out fine and simply isn't of the person, which is the hardest failure to see.
    const r = referenceOutcome(2, undefined)!;
    expect(r.ok).toBe(false);
    expect(r.text).toContain("can't use reference photos");
    expect(r.text).toContain("2 reference photos");
  });

  it("distinguishes the zeros — each has a different fix", () => {
    const r = referenceOutcome(3, { supplied: 3, used: 0, why: "the IP-Adapter nodes aren't installed" })!;
    expect(r.ok).toBe(false);
    expect(r.text).toContain("weren't used");
    expect(r.text).toContain("IP-Adapter nodes aren't installed");
  });

  it("confirms success, and names the route so 'installed' and 'built in' aren't the same word", () => {
    expect(referenceOutcome(2, { supplied: 2, used: 2, how: "ipadapter" })!.text).toBe(
      "🖼 Used 2 reference photos (IP-Adapter).",
    );
    expect(referenceOutcome(1, { supplied: 1, used: 1, how: "reference-latent" })!.text).toBe(
      "🖼 Used 1 reference photo (built into the model).",
    );
    expect(referenceOutcome(2, { supplied: 2, used: 2, how: "native" })!.ok).toBe(true);
  });

  it("reports a PARTIAL use rather than rounding it up to success", () => {
    // Capping is real and invisible: hand IP-Adapter ten photos and four are used.
    const r = referenceOutcome(10, { supplied: 10, used: 4, how: "ipadapter", why: "IP-Adapter uses at most 4" })!;
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Used 4 reference photos of 10");
    expect(r.text).toContain("at most 4");
  });

  it("gets the singular right", () => {
    expect(referenceOutcome(1, undefined)!.text).toContain("1 reference photo ");
  });
});

describe("describeReferenceSources — which photos, in the reader's terms", () => {
  it("names a Soul, because that's the one you can't see for yourself", () => {
    // The picture you attached is right there in the transcript. Your Soul photos are two panels
    // away, and "used 2 reference photos" says nothing about whether they were involved.
    expect(describeReferenceSources({ user: 2 })).toBe("your Soul photos");
    expect(describeReferenceSources({ self: 1, selfName: "Aria" })).toBe("Aria's Soul photos");
  });

  it("falls back to a role when the assistant has no name set", () => {
    expect(describeReferenceSources({ self: 1 })).toBe("the assistant's Soul photos");
    expect(describeReferenceSources({ self: 1, selfName: "   " })).toBe("the assistant's Soul photos");
  });

  it("counts attachments and gets the singular right", () => {
    expect(describeReferenceSources({ attached: 1 })).toBe("the photo you attached");
    expect(describeReferenceSources({ attached: 3 })).toBe("the 3 photos you attached");
  });

  it("reads as a sentence when several sources contributed", () => {
    expect(describeReferenceSources({ attached: 1, self: 2, user: 1, selfName: "Aria" })).toBe(
      "the photo you attached, Aria's Soul photos and your Soul photos",
    );
    expect(describeReferenceSources({ self: 1, user: 1, selfName: "Aria" })).toBe(
      "Aria's Soul photos and your Soul photos",
    );
  });

  it("says nothing when nothing contributed", () => {
    expect(describeReferenceSources({})).toBeUndefined();
    expect(describeReferenceSources({ attached: 0, self: 0, user: 0 })).toBeUndefined();
  });
});

describe("referenceOutcome names the source in every outcome", () => {
  const from = "your Soul photos";
  it("in the success line", () => {
    expect(referenceOutcome(2, { supplied: 2, used: 2, how: "reference-latent" }, from)!.text).toBe(
      "🖼 Used 2 reference photos — from your Soul photos (built into the model).",
    );
  });
  it("in the ignored line — knowing WHICH photos were wasted is the point", () => {
    expect(referenceOutcome(2, undefined, from)!.text).toContain("from your Soul photos");
  });
  it("in the unused line", () => {
    expect(referenceOutcome(2, { supplied: 2, used: 0, why: "the nodes aren't installed" }, from)!.text).toContain(
      "from your Soul photos",
    );
  });
  it("and is omitted cleanly when the caller doesn't know", () => {
    expect(referenceOutcome(1, { supplied: 1, used: 1 })!.text).toBe("🖼 Used 1 reference photo.");
  });
});
