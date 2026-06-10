import { describe, it, expect } from "vitest";
import {
  clampResolution,
  composeSdPositive,
  detectModelFamily,
  emphasizeSubjects,
  nameHandlingFor,
  negativeFor,
  qualityPreamble,
  resolveModelFamily,
  resolveNegative,
  samplerFor,
} from "./sd-prompt.js";

describe("detectModelFamily", () => {
  it("classifies by filename, leniently", () => {
    expect(detectModelFamily("flux1-schnell-fp8.safetensors")).toBe("flux");
    expect(detectModelFamily("flux2-dev.safetensors")).toBe("flux2"); // flux2 before generic flux
    expect(detectModelFamily("FLUX.2-dev-fp8.safetensors")).toBe("flux2");
    expect(detectModelFamily("z_image_turbo_bf16.safetensors")).toBe("zimage");
    expect(detectModelFamily("qwen_image_fp8_e4m3fn.safetensors")).toBe("qwenimage");
    expect(detectModelFamily("sd_xl_base_1.0.safetensors")).toBe("sdxl");
    expect(detectModelFamily("realvisxl_v4.safetensors")).toBe("sdxl"); // tricky: looks XL
    expect(detectModelFamily("v1-5-pruned-emaonly-fp16.safetensors")).toBe("sd15");
    expect(detectModelFamily("some-random-checkpoint.safetensors")).toBe("unknown");
  });
});

describe("samplerFor", () => {
  it("uses SD cfg/sampler/scheduler for SD families", () => {
    expect(samplerFor("sdxl")).toMatchObject({ cfg: 7, sampler: "euler", scheduler: "normal" });
    expect(samplerFor("sdxl").guidance).toBeUndefined();
  });
  it("uses Flux embedded guidance (cfg 1, simple) for Flux.1 and Flux.2", () => {
    expect(samplerFor("flux")).toMatchObject({ cfg: 1, scheduler: "simple", guidance: 3.5 });
    expect(samplerFor("flux2")).toMatchObject({ cfg: 1, scheduler: "simple", guidance: 4.0 });
  });
  it("uses the official template settings for Z-Image and Qwen-Image", () => {
    expect(samplerFor("zimage")).toMatchObject({ cfg: 1, sampler: "res_multistep", steps: 8, shift: 3 });
    expect(samplerFor("zimage").guidance).toBeUndefined(); // no FluxGuidance node
    expect(samplerFor("qwenimage")).toMatchObject({ cfg: 4, sampler: "euler", steps: 20, shift: 3.1 });
  });
});

describe("nameHandlingFor", () => {
  it("injects for CLIP/T5 families and references for LLM-grade encoders", () => {
    expect(nameHandlingFor("sd15")).toBe("inject");
    expect(nameHandlingFor("sdxl")).toBe("inject");
    expect(nameHandlingFor("flux")).toBe("inject");
    expect(nameHandlingFor("flux2")).toBe("reference");
    expect(nameHandlingFor("zimage")).toBe("reference");
    expect(nameHandlingFor("qwenimage")).toBe("reference");
  });
});

describe("clampResolution", () => {
  it("caps SD1.5 at 768 and others at 1024, rounded to /8", () => {
    expect(clampResolution("sd15", 1536, 1536)).toEqual({ width: 768, height: 768 });
    expect(clampResolution("sdxl", 1536, 1536)).toEqual({ width: 1024, height: 1024 });
    expect(clampResolution("flux2", 1280, 1280)).toEqual({ width: 1024, height: 1024 });
    expect(clampResolution("sdxl", 1000, 1000)).toEqual({ width: 1000, height: 1000 }); // already fine
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
  it("gives SD families a negative + quality tags, and natural-language models none", () => {
    expect(negativeFor("sd15")).toContain("bad anatomy");
    expect(negativeFor("sdxl")).toContain("bad anatomy");
    expect(negativeFor("unknown")).toContain("bad anatomy"); // conservative: still safe
    expect(negativeFor("flux")).toBe("");
    expect(negativeFor("zimage")).toBe("");
    expect(negativeFor("qwenimage")).toBe("");

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
