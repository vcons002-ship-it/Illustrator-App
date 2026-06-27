import { describe, it, expect } from "vitest";
import { chatImageVramFit, defaultLoadedWindow } from "./catalog.js";

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
