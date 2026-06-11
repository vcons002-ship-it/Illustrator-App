import { describe, it, expect } from "vitest";
import {
  capQualityForVram,
  profileDimensions,
  qualityProfile,
  resolveQuality,
  scaleSteps,
} from "./quality.js";

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

  it("treats large arbitrary page counts as ultra (plenty of reading time)", () => {
    expect(resolveQuality("auto", 8)).toBe("ultra");
    expect(resolveQuality("auto", 25)).toBe("ultra");
  });
});

describe("qualityProfile", () => {
  it("increases steps and resolution with quality", () => {
    expect(qualityProfile("draft").width).toBeLessThan(qualityProfile("ultra").width);
    expect(qualityProfile("draft").steps).toBeLessThan(qualityProfile("ultra").steps);
    expect(qualityProfile("standard").height).toBe(1024);
  });
});

describe("scaleSteps", () => {
  it("scales a natural-language model's recommended count by level", () => {
    // Flux.2 recommends 24 steps.
    expect(scaleSteps(24, "draft")).toBe(14);
    expect(scaleSteps(24, "standard")).toBe(24);
    expect(scaleSteps(24, "high")).toBe(32);
    expect(scaleSteps(24, "ultra")).toBe(40);
  });

  it("clamps to a sane [4, 40] window", () => {
    expect(scaleSteps(50, "ultra")).toBe(40); // never above 40
    expect(scaleSteps(12, "draft")).toBeGreaterThanOrEqual(4);
  });

  it("turbo guard: distilled few-step models (≤10) never scale", () => {
    expect(scaleSteps(8, "ultra")).toBe(8); // Z-Image 8-step turbo
    expect(scaleSteps(6, "high")).toBe(6); // SDXL-Turbo
    expect(scaleSteps(10, "ultra")).toBe(10);
  });
});

describe("capQualityForVram", () => {
  it("caps Auto-resolved quality to a canvas the GPU can render", () => {
    // < 8 GB → ≤1024px (Standard).
    expect(capQualityForVram("ultra", 6144)).toBe("standard");
    // 8–12 GB → ≤1280px (High).
    expect(capQualityForVram("ultra", 10240)).toBe("high");
    // Plenty of VRAM → uncapped.
    expect(capQualityForVram("ultra", 24576)).toBe("ultra");
  });

  it("never raises a level, and is a no-op when VRAM is unknown", () => {
    expect(capQualityForVram("draft", 6144)).toBe("draft");
    expect(capQualityForVram("ultra", undefined)).toBe("ultra");
    expect(capQualityForVram("high", 0)).toBe("high");
  });
});

describe("profileDimensions", () => {
  it("square is the profile's native NxN", () => {
    expect(profileDimensions("standard", "square")).toEqual({ width: 1024, height: 1024 });
    expect(profileDimensions("standard")).toEqual({ width: 1024, height: 1024 });
  });

  it("portrait is taller than wide; landscape wider than tall; both /8", () => {
    const portrait = profileDimensions("standard", "portrait");
    expect(portrait.height).toBeGreaterThan(portrait.width);
    expect(portrait.width % 8).toBe(0);
    expect(portrait.height % 8).toBe(0);

    const landscape = profileDimensions("standard", "landscape");
    expect(landscape.width).toBeGreaterThan(landscape.height);
    // Landscape is the portrait dimensions transposed (same 2:3 area).
    expect(landscape).toEqual({ width: portrait.height, height: portrait.width });
  });

  it("preserves roughly the square's pixel area across orientations", () => {
    const square = profileDimensions("high", "square");
    const portrait = profileDimensions("high", "portrait");
    const squareArea = square.width * square.height;
    const portraitArea = portrait.width * portrait.height;
    expect(Math.abs(portraitArea - squareArea) / squareArea).toBeLessThan(0.05);
  });
});
