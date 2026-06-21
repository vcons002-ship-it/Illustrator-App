import { describe, it, expect } from "vitest";
import {
  HIRES_MAX_DIMENSION,
  HIRES_MAX_DIMENSION_LOWVRAM,
  clampResolution,
  composeSdPositive,
  detectModelFamily,
  hiresTarget,
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
    expect(detectModelFamily("hidream_i1_full_fp16.safetensors")).toBe("hidream");
    expect(detectModelFamily("hidream_i1_dev_fp8.safetensors")).toBe("hidream");
    expect(detectModelFamily("HiDream-O1-Image-BF16.safetensors")).toBe("hidream"); // tolerant of O1 naming
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
  it("defaults HiDream to the CFG-based Full recipe with an SD3 shift (no FluxGuidance)", () => {
    expect(samplerFor("hidream")).toMatchObject({ cfg: 5, sampler: "uni_pc", scheduler: "simple", steps: 50, shift: 3.0 });
    expect(samplerFor("hidream").guidance).toBeUndefined();
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
    expect(nameHandlingFor("hidream")).toBe("reference"); // has a Llama-3.1 encoder
  });
});

describe("clampResolution", () => {
  it("caps per family — NL models reach 1280/1536, SDXL 1024, SD1.5 768 (rounded /8)", () => {
    expect(clampResolution("sd15", 1536, 1536)).toEqual({ width: 768, height: 768 });
    expect(clampResolution("sdxl", 1536, 1536)).toEqual({ width: 1024, height: 1024 });
    // Natural-language families now reach the larger High/Ultra canvases.
    expect(clampResolution("flux2", 1536, 1536)).toEqual({ width: 1536, height: 1536 });
    expect(clampResolution("flux", 1280, 1280)).toEqual({ width: 1280, height: 1280 });
    expect(clampResolution("qwenimage", 1536, 1536)).toEqual({ width: 1536, height: 1536 });
    expect(clampResolution("zimage", 1536, 1536)).toEqual({ width: 1280, height: 1280 }); // turbo cap
    expect(clampResolution("hidream", 1536, 1536)).toEqual({ width: 1216, height: 1216 }); // ~1 MP buckets
    expect(clampResolution("sdxl", 1000, 1000)).toEqual({ width: 1000, height: 1000 }); // already fine
  });

  it("preserves aspect ratio when capping (the LONG side hits the cap, not each axis)", () => {
    // A portrait canvas over the SDXL cap scales BOTH axes by the same factor — the
    // long side lands on 1024 and the short side stays proportional (not squashed to square).
    const { width, height } = clampResolution("sdxl", 1248, 1872); // 2:3-ish, over cap
    expect(height).toBe(1024); // long side capped
    expect(width).toBeLessThan(height); // still portrait
    // Ratio preserved within rounding (~0.667).
    expect(Math.abs(width / height - 1248 / 1872)).toBeLessThan(0.02);
  });
});

describe("hiresTarget", () => {
  it("upscales the native-safe size ~2× toward the 2048 ceiling, per family", () => {
    // HiDream/SDXL render small natively, so the second pass reaches the 2048 ceiling.
    expect(hiresTarget("hidream", 2048, 2048)).toEqual({ width: 2048, height: 2048 }); // from 1216
    expect(hiresTarget("sdxl", 1024, 1024)).toEqual({ width: 2048, height: 2048 }); // from 1024
    // SD1.5 caps at 768 native → 2× = 1536 (under the ceiling).
    expect(hiresTarget("sd15", 1024, 1024)).toEqual({ width: 1536, height: 1536 });
    // The long side never exceeds the ceiling.
    const t = hiresTarget("flux", 4096, 4096);
    expect(Math.max(t!.width, t!.height)).toBe(HIRES_MAX_DIMENSION);
  });

  it("keeps the requested aspect ratio through the upscale", () => {
    const t = hiresTarget("sdxl", 768, 1024); // 3:4 portrait → native 768×1024, upscale toward 2048
    expect(t).not.toBeNull();
    expect(t!.height).toBeGreaterThan(t!.width); // still portrait
    expect(Math.max(t!.width, t!.height)).toBe(HIRES_MAX_DIMENSION); // long side at the ceiling
    expect(Math.abs(t!.width / t!.height - 768 / 1024)).toBeLessThan(0.02);
  });

  it("always has headroom to upscale (clamp caps native ≤1536, below the 2048 ceiling)", () => {
    // Every family's native size is below the ceiling, so a target always exists — never a
    // single-pass no-op. (The null path guards a future family whose native ≥ ceiling.)
    for (const f of ["sd15", "sdxl", "flux", "flux2", "qwenimage", "zimage", "hidream"] as const) {
      expect(hiresTarget(f, 2048, 2048)).not.toBeNull();
    }
  });

  it("honours a lower ceiling (Low-VRAM caps the second pass at 1536, not 2048)", () => {
    expect(hiresTarget("sdxl", 2048, 2048, HIRES_MAX_DIMENSION_LOWVRAM)).toEqual({ width: 1536, height: 1536 });
    // Native already ≥ the low ceiling → no second pass (would only add memory pressure).
    expect(hiresTarget("flux", 2048, 2048, HIRES_MAX_DIMENSION_LOWVRAM)).toBeNull(); // flux native 1536
  });
});

describe("resolveModelFamily", () => {
  it("honours the override, then the catalog, then the filename", () => {
    // Override wins even when the filename says otherwise.
    expect(resolveModelFamily("flux", "sd_xl_base_1.0.safetensors")).toBe("flux");
    // Catalog filename match.
    expect(resolveModelFamily(undefined, "sd_xl_base_1.0.safetensors")).toBe("sdxl");
    // Catalog match for a HiDream entry's main filename.
    expect(resolveModelFamily(undefined, "hidream_i1_dev_fp8.safetensors")).toBe("hidream");
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
    // HiDream is the natural-language exception: it runs at real CFG and REQUIRES a non-empty
    // negative (empty → None pooled crash), but still gets no booru quality tags on the positive.
    expect(negativeFor("hidream")).toContain("bad anatomy");
    expect(resolveNegative("hidream", undefined)).toContain("bad anatomy");
    expect(resolveNegative("hidream", "my own negative")).toBe("my own negative");
    expect(qualityPreamble("hidream")).toBe(""); // and no SD quality tags

    expect(qualityPreamble("sdxl")).toContain("masterpiece");
    expect(qualityPreamble("flux")).toBe("");
    expect(qualityPreamble("unknown")).toBe("");
  });

  it("composeSdPositive wraps SD prompts but leaves Flux/unknown natural", () => {
    const sd = composeSdPositive("sdxl", "a duel at dawn");
    expect(sd).toContain("masterpiece");
    expect(sd).toContain("a duel at dawn");

    expect(composeSdPositive("flux", "a duel at dawn")).toBe("a duel at dawn");
    expect(composeSdPositive("unknown", "a duel at dawn")).toBe("a duel at dawn");
  });

  it("resolveNegative lets SD override but forces Flux empty", () => {
    expect(resolveNegative("sdxl", "blurry")).toBe("blurry");
    expect(resolveNegative("sdxl", undefined)).toContain("bad anatomy");
    expect(resolveNegative("flux", "blurry")).toBe(""); // Flux ignores negatives
  });
});
