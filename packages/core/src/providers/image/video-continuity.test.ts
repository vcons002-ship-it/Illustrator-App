import { describe, expect, it } from "vitest";
import { IN_FRAME_CLAUSE, SCENE_LOCK_NEGATIVE, anchorClipPrompt, longVideoNegative } from "./video-continuity.js";

describe("anchorClipPrompt", () => {
  it("prepends the subject anchor and appends the in-frame clause", () => {
    const p = anchorClipPrompt("a red vintage pickup truck on a desert highway", "the truck accelerates, dust trailing");
    expect(p).toBe(`a red vintage pickup truck on a desert highway. the truck accelerates, dust trailing. ${IN_FRAME_CLAUSE}`);
  });

  it("doesn't double-anchor a shot that already re-states the subject verbatim", () => {
    const subject = "a red vintage pickup truck";
    const clip = "A red vintage pickup truck drifts around the bend";
    const p = anchorClipPrompt(subject, clip);
    expect(p).toBe(`${clip}. ${IN_FRAME_CLAUSE}`);
    expect(p.toLowerCase().indexOf("pickup truck")).toBe(p.toLowerCase().lastIndexOf("pickup truck"));
  });

  it("works without a subject (clause only) and normalizes trailing punctuation", () => {
    expect(anchorClipPrompt(undefined, "the camera slowly zooms in.")).toBe(`the camera slowly zooms in. ${IN_FRAME_CLAUSE}`);
    expect(anchorClipPrompt("a knight in silver armor... ", "he raises the sword")).toBe(
      `a knight in silver armor. he raises the sword. ${IN_FRAME_CLAUSE}`,
    );
  });
});

describe("longVideoNegative", () => {
  it("extends the family default with the scene-lock terms (a caller negative REPLACES the default)", () => {
    const base = "blurry, watermark";
    const n = longVideoNegative(base);
    expect(n.startsWith(SCENE_LOCK_NEGATIVE)).toBe(true);
    expect(n.endsWith(base)).toBe(true);
    expect(n).toContain("scene change");
    expect(n).toContain("subject leaves the frame");
  });
});
