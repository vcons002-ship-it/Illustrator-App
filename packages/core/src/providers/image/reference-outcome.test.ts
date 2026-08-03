import { describe, expect, it } from "vitest";
import { referenceOutcome } from "./image-provider.js";

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
