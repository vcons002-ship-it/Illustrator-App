import { describe, expect, it } from "vitest";
import { applyLocalModelComponents, DEFAULT_SETTINGS, type ReaderSettings } from "./SettingsPanel.js";

describe("applyLocalModelComponents (per-model encoder/VAE memory)", () => {
  it("restores the text-encoder + VAE combo last used with the selected model", () => {
    const s: ReaderSettings = {
      ...DEFAULT_SETTINGS,
      localTextEncoder: "leftover_encoder.safetensors",
      localVae: "leftover_vae.safetensors",
      localComponentsByModel: {
        "flux2-klein.safetensors": { textEncoder: "qwen_3_8b_fp8mixed.safetensors", vae: "flux2-vae.safetensors" },
        "z_image.safetensors": { textEncoder: "qwen_3_4b.safetensors", vae: "ae.safetensors" },
      },
    };
    const next = applyLocalModelComponents(s, "flux2-klein.safetensors");
    expect(next.localModel).toBe("flux2-klein.safetensors");
    expect(next.localTextEncoder).toBe("qwen_3_8b_fp8mixed.safetensors");
    expect(next.localVae).toBe("flux2-vae.safetensors");
    // Switching to the other remembered model restores ITS combo, not the previous one.
    const z = applyLocalModelComponents(next, "z_image.safetensors");
    expect(z.localTextEncoder).toBe("qwen_3_4b.safetensors");
    expect(z.localVae).toBe("ae.safetensors");
  });

  it('clears to auto ("") when the model has no remembered combo, so the prev model\'s files don\'t linger', () => {
    const s: ReaderSettings = {
      ...DEFAULT_SETTINGS,
      localTextEncoder: "qwen_3_4b.safetensors",
      localVae: "ae.safetensors",
      localComponentsByModel: { "z_image.safetensors": { textEncoder: "qwen_3_4b.safetensors", vae: "ae.safetensors" } },
    };
    const next = applyLocalModelComponents(s, "brand_new.safetensors");
    expect(next.localModel).toBe("brand_new.safetensors");
    expect(next.localTextEncoder).toBe("");
    expect(next.localVae).toBe("");
    // The map is preserved (other models keep their memory).
    expect(next.localComponentsByModel?.["z_image.safetensors"]?.textEncoder).toBe("qwen_3_4b.safetensors");
  });
});
