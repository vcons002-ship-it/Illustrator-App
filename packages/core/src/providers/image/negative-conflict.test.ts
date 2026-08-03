import { describe, expect, it } from "vitest";
import { DEFAULT_NEGATIVE, resolveNegative, withoutRequestedTerms } from "./sd-prompt.js";

describe("the negative prompt must not fight what was asked for", () => {
  it("drops a term the reader actually requested", () => {
    // The default negative ends "portrait, headshot, close-up, simple background" — right for a book
    // illustration, and directly opposed to "a portrait of me". The render then has the same word
    // pulling both ways and returns a weakened version of the request, with nothing to explain it.
    const out = resolveNegative("sdxl", undefined, "a portrait of me in the garden");
    expect(out).not.toContain("portrait");
    expect(out).toContain("bad hands"); // everything else survives
  });

  it("handles each of the four suppressed subjects", () => {
    expect(resolveNegative("sd15", undefined, "a headshot for my profile")).not.toContain("headshot");
    expect(resolveNegative("sd15", undefined, "extreme close-up of her hands")).not.toContain("close-up");
    expect(resolveNegative("sd15", undefined, "a simple background, nothing behind him")).not.toContain(
      "simple background",
    );
  });

  it("matches the way people actually write it — spacing and case", () => {
    expect(withoutRequestedTerms("close-up, blurry", "a CLOSE UP of the door")).toBe("blurry");
    expect(withoutRequestedTerms("close-up, blurry", "Close-Up shot")).toBe("blurry");
  });

  it("keeps a term that only appears INSIDE another word", () => {
    // "text" must survive "a textured wall"; dropping it would let watermarked lettering back in.
    expect(withoutRequestedTerms("text, blurry", "a textured wall")).toBe("text, blurry");
  });

  it("leaves an unrelated prompt completely alone", () => {
    expect(resolveNegative("sdxl", undefined, "a dragon over a neon city")).toBe(DEFAULT_NEGATIVE);
  });

  it("filters a reader's OWN override too — they can't see that list either", () => {
    expect(resolveNegative("sdxl", "portrait, watermark", "a portrait of me")).toBe("watermark");
  });

  it("still sends nothing for the models that must not get a negative", () => {
    // Flux / Z-Image / Qwen-Image run at cfg≈1: a negative is ignored or harmful.
    for (const family of ["flux", "flux2", "zimage", "qwenimage"] as const) {
      expect(resolveNegative(family, undefined, "a portrait of me")).toBe("");
    }
    // HiDream is the exception — an EMPTY negative crashes its embedder, so it must stay non-empty.
    expect(resolveNegative("hidream", undefined, "a portrait of me").length).toBeGreaterThan(0);
  });
});
