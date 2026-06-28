import { describe, it, expect } from "vitest";
import { chatImageVramFit, defaultLoadedWindow, resolveLoadedContextTokens, staleComfyUrlToFree } from "./catalog.js";

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
