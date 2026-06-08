import { describe, it, expect } from "vitest";
import {
  composeSdPositive,
  detectModelFamily,
  emphasizeSubjects,
  negativeFor,
  qualityPreamble,
  resolveModelFamily,
  resolveNegative,
} from "./sd-prompt.js";

describe("detectModelFamily", () => {
  it("classifies by filename, leniently", () => {
    expect(detectModelFamily("flux1-schnell-fp8.safetensors")).toBe("flux");
    expect(detectModelFamily("sd_xl_base_1.0.safetensors")).toBe("sdxl");
    expect(detectModelFamily("realvisxl_v4.safetensors")).toBe("sdxl"); // tricky: looks XL
    expect(detectModelFamily("v1-5-pruned-emaonly-fp16.safetensors")).toBe("sd15");
    expect(detectModelFamily("some-random-checkpoint.safetensors")).toBe("unknown");
  });
});

describe("resolveModelFamily", () => {
  it("honours the override, then the catalog, then the filename", () => {
    // Override wins even when the filename says otherwise.
    expect(resolveModelFamily("flux", "sd_xl_base_1.0.safetensors")).toBe("flux");
    // Catalog filename match.
    expect(resolveModelFamily(undefined, "sd_xl_base_1.0.safetensors")).toBe("sdxl");
    // Falls back to the heuristic for an unknown checkpoint.
    expect(resolveModelFamily(undefined, "mystery_flux_merge.safetensors")).toBe("flux");
    expect(resolveModelFamily(undefined, "whatever.safetensors")).toBe("unknown");
  });
});

describe("formatting by family", () => {
  it("gives SD families a negative + quality tags, and Flux none", () => {
    expect(negativeFor("sd15")).toContain("bad anatomy");
    expect(negativeFor("sdxl")).toContain("bad anatomy");
    expect(negativeFor("unknown")).toContain("bad anatomy"); // conservative: still safe
    expect(negativeFor("flux")).toBe("");

    expect(qualityPreamble("sdxl")).toContain("masterpiece");
    expect(qualityPreamble("flux")).toBe("");
    expect(qualityPreamble("unknown")).toBe("");
  });

  it("composeSdPositive wraps SD prompts but leaves Flux/unknown natural", () => {
    const subjects = [{ name: "Ana", features: "silver hair, green eyes", outfit: "red cloak" }];
    const sd = composeSdPositive("sdxl", "a duel at dawn", subjects);
    expect(sd).toContain("masterpiece");
    expect(sd).toContain("a duel at dawn");
    expect(sd).toContain("(Ana: silver hair, green eyes, wearing red cloak:1.1)");

    expect(composeSdPositive("flux", "a duel at dawn", subjects)).toBe("a duel at dawn");
    expect(composeSdPositive("unknown", "a duel at dawn", subjects)).toBe("a duel at dawn");
  });

  it("emphasizeSubjects keeps a name even when features/outfit are blank (no loss)", () => {
    const out = emphasizeSubjects([{ name: "Bram", features: "", outfit: "" }], "sd15");
    expect(out).toBe("(Bram:1.1)");
    // Flux gets no emphasis at all.
    expect(emphasizeSubjects([{ name: "Bram", features: "", outfit: "" }], "flux")).toBe("");
  });

  it("resolveNegative lets SD override but forces Flux empty", () => {
    expect(resolveNegative("sdxl", "blurry")).toBe("blurry");
    expect(resolveNegative("sdxl", undefined)).toContain("bad anatomy");
    expect(resolveNegative("flux", "blurry")).toBe(""); // Flux ignores negatives
  });
});
