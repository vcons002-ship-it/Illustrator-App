import { describe, it, expect } from "vitest";
import { qualityProfile, resolveQuality } from "./quality.js";

describe("resolveQuality", () => {
  it("honours an explicit level over the cadence", () => {
    expect(resolveQuality("ultra", 1)).toBe("ultra");
    expect(resolveQuality("draft", "chapter")).toBe("draft");
  });

  it("auto-scales quality with pages-per-image", () => {
    expect(resolveQuality("auto", 1)).toBe("draft");
    expect(resolveQuality("auto", 2)).toBe("standard");
    expect(resolveQuality("auto", 3)).toBe("standard");
    expect(resolveQuality("auto", 5)).toBe("high");
    expect(resolveQuality("auto", "chapter")).toBe("ultra");
    expect(resolveQuality(undefined, "chapter")).toBe("ultra");
  });
});

describe("qualityProfile", () => {
  it("increases steps and resolution with quality", () => {
    expect(qualityProfile("draft").width).toBeLessThan(qualityProfile("ultra").width);
    expect(qualityProfile("draft").steps).toBeLessThan(qualityProfile("ultra").steps);
    expect(qualityProfile("standard").height).toBe(1024);
  });
});
