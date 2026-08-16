import { describe, it, expect } from "vitest";
import {
  chatImageVramFit,
  comfyUrlForVideo,
  detectCheckpointFamily,
  imageModelVramCostGb,
  defaultLoadedWindow,
  resolveLoadedContextTokens,
  shouldDeferLocalEngineAutostart,
  staleA1111UrlToFree,
  staleComfyUrlToFree,
} from "./catalog.js";

describe("chatImageVramFit (keep-both-resident decision)", () => {
  it("returns 'unknown' when VRAM or a model size is unknown (caller keeps the model loaded)", () => {
    expect(chatImageVramFit({ imageGb: 8, chatGb: 4 })).toBe("unknown"); // no gpuVramMb
    expect(chatImageVramFit({ gpuVramMb: 0, imageGb: 8, chatGb: 4 })).toBe("unknown");
    expect(chatImageVramFit({ gpuVramMb: 24_000, imageGb: 0, chatGb: 4 })).toBe("unknown"); // image size unknown
    expect(chatImageVramFit({ gpuVramMb: 24_000, imageGb: 8, chatGb: 0 })).toBe("unknown"); // chat size unknown
  });

  it("returns 'fit' when both models + headroom fit the GPU", () => {
    // (8 + 4 + 2) * 1024 = 14336 MB <= 24000
    expect(chatImageVramFit({ gpuVramMb: 24_000, imageGb: 8, chatGb: 4 })).toBe("fit");
  });

  it("returns 'nofit' when they provably don't both fit", () => {
    // (12 + 10 + 2) * 1024 = 24576 MB > 16000
    expect(chatImageVramFit({ gpuVramMb: 16_000, imageGb: 12, chatGb: 10 })).toBe("nofit");
  });

  it("honors a custom headroom", () => {
    // (8 + 4 + 8) * 1024 = 20480 > 16000 → nofit with a big headroom, fit with none
    expect(chatImageVramFit({ gpuVramMb: 16_000, imageGb: 8, chatGb: 4, headroomGb: 8 })).toBe("nofit");
    expect(chatImageVramFit({ gpuVramMb: 16_000, imageGb: 8, chatGb: 4, headroomGb: 0 })).toBe("fit");
  });
});

describe("shouldDeferLocalEngineAutostart (boot-time VRAM gate for local image engines)", () => {
  const SDXL = "sd_xl_base_1.0.safetensors"; // catalog sizeGB 6.6

  it("always defers when the manual low-VRAM toggle is on, regardless of fit", () => {
    expect(shouldDeferLocalEngineAutostart({ lowVram: true, gpuVramMb: 999_999, imageModel: SDXL, chatBackend: "bundled" })).toBe(true);
  });

  it("defers only when the bundled chat LLM + image model provably don't fit", () => {
    // (6.6 + 4 + 2) * 1024 ≈ 12902 MB
    expect(shouldDeferLocalEngineAutostart({ gpuVramMb: 24_000, imageModel: SDXL, chatBackend: "bundled" })).toBe(false);
    expect(shouldDeferLocalEngineAutostart({ gpuVramMb: 8_000, imageModel: SDXL, chatBackend: "bundled" })).toBe(true);
  });

  it("estimates a local-server (Ollama) chat model's cost the same way canFreeChatLlm does", () => {
    expect(shouldDeferLocalEngineAutostart({ gpuVramMb: 24_000, imageModel: SDXL, chatBackend: "server", serverTextModel: "gemma2:2b" })).toBe(false);
    expect(shouldDeferLocalEngineAutostart({ gpuVramMb: 16_000, imageModel: SDXL, chatBackend: "server", serverTextModel: "llama3.1:70b-q4_K_M" })).toBe(true);
  });

  it("never defers when there's no local chat LLM competing for VRAM (webgpu, cloud, or unset)", () => {
    expect(shouldDeferLocalEngineAutostart({ gpuVramMb: 1_000, imageModel: SDXL, chatBackend: "webgpu" })).toBe(false);
    expect(shouldDeferLocalEngineAutostart({ gpuVramMb: 1_000, imageModel: SDXL })).toBe(false);
  });
});

describe("defaultLoadedWindow (Ollama num_ctx default)", () => {
  it("falls back to the conservative minimum when VRAM is unknown", () => {
    expect(defaultLoadedWindow("gemma3:4b")).toBe(8192);
    expect(defaultLoadedWindow("gemma3:4b", 0)).toBe(8192);
  });

  it("clamps to the 8192..32768 range and aligns to a 2048 boundary", () => {
    for (const vram of [4_000, 8_000, 12_000, 24_000, 48_000, 80_000]) {
      const w = defaultLoadedWindow("llama3.1:8b", vram);
      expect(w).toBeGreaterThanOrEqual(8192);
      expect(w).toBeLessThanOrEqual(32768);
      expect(w % 2048).toBe(0);
    }
  });

  it("gives a bigger window when more VRAM is free (monotonic, never shrinking)", () => {
    const small = defaultLoadedWindow("gemma3:4b", 8_000);
    const big = defaultLoadedWindow("gemma3:4b", 48_000);
    expect(big).toBeGreaterThanOrEqual(small);
  });
});

describe("resolveLoadedContextTokens (budget = actually-loaded window)", () => {
  it("Ollama path budgets to the sent num_ctx (defaultLoadedWindow), NOT the Modelfile or 4096", () => {
    const sent = defaultLoadedWindow("qwen3:27b", 48_000);
    // A stale Modelfile num_ctx of 4096 must NOT win — our per-request num_ctx overrode it.
    const ctx = resolveLoadedContextTokens({ isOllama: true, model: "qwen3:27b", gpuVramMb: 48_000, infoLoaded: 4096, infoMax: 262_144 });
    expect(ctx).toBe(sent);
    expect(ctx).toBeGreaterThan(4096);
  });

  it("Ollama path caps the sent window by the architectural max", () => {
    // Tiny arch max → the loaded window can't exceed it.
    expect(resolveLoadedContextTokens({ isOllama: true, model: "tiny:1b", gpuVramMb: 48_000, infoMax: 2048 })).toBe(2048);
  });

  it("non-Ollama (bundled / LM Studio) trusts the Modelfile-loaded value, else arch max capped at the Ollama default", () => {
    expect(resolveLoadedContextTokens({ isOllama: false, model: "bundled", infoLoaded: 8192, infoMax: 32768 })).toBe(8192);
    expect(resolveLoadedContextTokens({ isOllama: false, model: "x", infoMax: 32768, ollamaDefault: 4096 })).toBe(4096);
    expect(resolveLoadedContextTokens({ isOllama: false, model: "x" })).toBeUndefined();
  });
});

describe("staleComfyUrlToFree (free a leftover ComfyUI's VRAM before an A1111 render)", () => {
  const comfy = "http://127.0.0.1:8188";
  const a1111 = "http://127.0.0.1:7860";
  it("returns the remembered ComfyUI URL when A1111 is the active backend", () => {
    expect(staleComfyUrlToFree({ localBackend: "a1111", localServerUrl: a1111, localServerUrlByBackend: { comfyui: comfy } })).toBe(comfy);
    // engineBackend (resolved) wins over localBackend
    expect(staleComfyUrlToFree({ engineBackend: "a1111", localBackend: "comfyui", engineBaseUrl: a1111, localServerUrlByBackend: { comfyui: comfy } })).toBe(comfy);
  });
  it("does nothing when ComfyUI is the active backend", () => {
    expect(staleComfyUrlToFree({ localBackend: "comfyui", localServerUrl: comfy, localServerUrlByBackend: { comfyui: comfy } })).toBeUndefined();
  });
  it("does nothing without a remembered ComfyUI URL", () => {
    expect(staleComfyUrlToFree({ localBackend: "a1111", localServerUrl: a1111 })).toBeUndefined();
    expect(staleComfyUrlToFree({ localBackend: "a1111", localServerUrl: a1111, localServerUrlByBackend: { comfyui: "  " } })).toBeUndefined();
  });
  it("does nothing when the ComfyUI URL is the same server as A1111", () => {
    expect(staleComfyUrlToFree({ localBackend: "a1111", localServerUrl: comfy, localServerUrlByBackend: { comfyui: comfy } })).toBeUndefined();
  });
});

describe("comfyUrlForVideo (ComfyUI URL for a video render, whatever drives images)", () => {
  const comfy = "http://127.0.0.1:8188";
  const a1111 = "http://127.0.0.1:7860";
  it("prefers the remembered ComfyUI URL even when A1111 is the active image backend", () => {
    expect(comfyUrlForVideo({ localBackend: "a1111", localServerUrl: a1111, localServerUrlByBackend: { comfyui: comfy } })).toBe(comfy);
    expect(comfyUrlForVideo({ engineBackend: "a1111", engineBaseUrl: a1111, localServerUrlByBackend: { comfyui: comfy } })).toBe(comfy);
  });
  it("falls back to the active URL when ComfyUI IS the active backend", () => {
    expect(comfyUrlForVideo({ localBackend: "comfyui", localServerUrl: comfy })).toBe(comfy);
    expect(comfyUrlForVideo({ engineBackend: "comfyui", engineBaseUrl: comfy })).toBe(comfy);
  });
  it("is undefined when no ComfyUI is known (A1111 active, none remembered)", () => {
    expect(comfyUrlForVideo({ localBackend: "a1111", localServerUrl: a1111 })).toBeUndefined();
    expect(comfyUrlForVideo({ localBackend: "a1111", localServerUrl: a1111, localServerUrlByBackend: { comfyui: "  " } })).toBeUndefined();
  });
});

describe("staleA1111UrlToFree (free a leftover A1111's VRAM before a ComfyUI video render)", () => {
  const comfy = "http://127.0.0.1:8188";
  const a1111 = "http://127.0.0.1:7860";
  it("returns the remembered A1111 URL when ComfyUI is the active op", () => {
    expect(staleA1111UrlToFree({ localBackend: "comfyui", localServerUrl: comfy, localServerUrlByBackend: { comfyui: comfy, a1111 } })).toBe(a1111);
    // Also when the image backend is A1111 but we're resolving for a ComfyUI video (engineBackend comfyui)
    expect(staleA1111UrlToFree({ engineBackend: "comfyui", engineBaseUrl: comfy, localServerUrlByBackend: { comfyui: comfy, a1111 } })).toBe(a1111);
  });
  it("does nothing when A1111 is the active backend (don't free what's in use)", () => {
    expect(staleA1111UrlToFree({ localBackend: "a1111", localServerUrl: a1111, localServerUrlByBackend: { comfyui: comfy, a1111 } })).toBeUndefined();
  });
  it("does nothing without a remembered A1111 URL", () => {
    expect(staleA1111UrlToFree({ localBackend: "comfyui", localServerUrl: comfy, localServerUrlByBackend: { comfyui: comfy } })).toBeUndefined();
    expect(staleA1111UrlToFree({ localBackend: "comfyui", localServerUrl: comfy, localServerUrlByBackend: { comfyui: comfy, a1111: "  " } })).toBeUndefined();
  });
  it("does nothing when the A1111 URL is the same server as ComfyUI", () => {
    expect(staleA1111UrlToFree({ localBackend: "comfyui", localServerUrl: comfy, localServerUrlByBackend: { comfyui: comfy, a1111: comfy } })).toBeUndefined();
  });
});

/**
 * THE CATALOG IS NOT THE WORLD.
 *
 * `imageModelVramCostGb` used to answer only for models the app itself downloads. Every VRAM
 * decision reads 0 as "unknown" and unknown as "keep both models resident" — so switching the image
 * backend to AUTOMATIC1111, whose checkpoints are never in the catalog, silently turned the entire
 * chat-LLM/image-model hand-off off. The chat model was never freed before a render, and it then
 * failed to load back onto a GPU an SDXL checkpoint had claimed.
 */
describe("imageModelVramCostGb outside the managed catalog", () => {
  it("still uses the catalog's own figure when it has one", () => {
    expect(imageModelVramCostGb("sd_xl_base_1.0.safetensors")).toBeGreaterThan(0);
  });

  it("sizes an AUTOMATIC1111 checkpoint from its title, hash suffix and all", () => {
    // A1111 reports models by `title`, which carries a bracketed hash and no size at all.
    expect(imageModelVramCostGb("juggernautXL_v9Rundiffusion.safetensors [c9e3e68f]")).toBe(7);
    expect(imageModelVramCostGb("realisticVisionV60B1_v51VAE.safetensors [15012c538f]")).toBe(4);
    expect(imageModelVramCostGb("flux1-dev-fp8.safetensors [4610115bb0]")).toBe(12);
  });

  it("sizes a ComfyUI checkpoint the reader installed themselves", () => {
    expect(imageModelVramCostGb("myFavouriteXLMerge.safetensors")).toBe(7);
    expect(imageModelVramCostGb("qwen_image_custom.safetensors")).toBe(20);
  });

  it("still says 0 when the name genuinely says nothing", () => {
    // 0 is "unknown", and callers keep both models resident on unknown. A name with no family in it
    // is the one case where that is still the honest answer.
    expect(imageModelVramCostGb("model.safetensors")).toBe(0);
    expect(imageModelVramCostGb("")).toBe(0);
  });

  it("lets the fit math actually reach a verdict on an A1111 checkpoint", () => {
    // The reported setup: a ~27B local chat model beside SDXL. Before this, imageGb was 0, the fit
    // was "unknown", and nothing was ever freed.
    const imageGb = imageModelVramCostGb("juggernautXL_v9.safetensors [abc12345]");
    expect(chatImageVramFit({ gpuVramMb: 24_000, imageGb, chatGb: 18 })).toBe("nofit");
    expect(chatImageVramFit({ gpuVramMb: 48_000, imageGb, chatGb: 18 })).toBe("fit");
  });
});

describe("detectCheckpointFamily", () => {
  it("reads the family off a filename, and admits when it can't", () => {
    expect(detectCheckpointFamily("HiDream-I1-Full.safetensors")).toBe("hidream");
    expect(detectCheckpointFamily("z_image_turbo.safetensors")).toBe("zimage");
    expect(detectCheckpointFamily("qwen-image.safetensors")).toBe("qwenimage");
    expect(detectCheckpointFamily("flux.2-klein.safetensors")).toBe("flux2");
    expect(detectCheckpointFamily("flux1-schnell.safetensors")).toBe("flux");
    expect(detectCheckpointFamily("realvisxlV40.safetensors")).toBe("sdxl");
    expect(detectCheckpointFamily("v1-5-pruned-emaonly.safetensors")).toBe("sd15");
    expect(detectCheckpointFamily("mystery.safetensors")).toBeUndefined();
  });

  it("has an entry in the size table for every family it can return", () => {
    // A family added to the ladder without a size would fall back to 0 — the exact silent
    // "unknown, so keep both resident" this whole section exists to remove.
    for (const name of [
      "HiDream.safetensors",
      "z-image.safetensors",
      "qwen_image.safetensors",
      "flux2.safetensors",
      "flux1.safetensors",
      "sdxl.safetensors",
      "sd15.safetensors",
    ]) {
      expect(imageModelVramCostGb(name), name).toBeGreaterThan(0);
    }
  });
});
