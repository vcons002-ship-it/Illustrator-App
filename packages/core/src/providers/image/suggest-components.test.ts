import { describe, it, expect } from "vitest";
import { suggestComponents } from "./suggest-components.js";

const flux2Files = {
  textEncoders: ["qwen_3_8b_fp8mixed.safetensors", "mistral_small_3.1.safetensors", "clip_l.safetensors"],
  vaes: ["flux2_vae.safetensors", "ae.safetensors"],
};

describe("suggestComponents", () => {
  it("SDXL is all-in-one — no components apply", () => {
    const s = suggestComponents("sd_xl_base_1.0.safetensors", "sdxl", { textEncoders: [], vaes: [] });
    expect(s.usesComponents).toBe(false);
    expect(s.encoderApplies).toBe(false);
    expect(s.vaeApplies).toBe(false);
    expect(s.recommendedEncoder).toBeUndefined();
    expect(s.note).toMatch(/all-in-one/i);
  });

  it("Flux.2 Klein → recommends the Qwen-3 encoder (not Mistral) + a Flux.2 VAE", () => {
    const s = suggestComponents("flux-2-klein-4b-fp8.safetensors", "flux2", flux2Files);
    expect(s.usesComponents).toBe(true);
    expect(s.encoderApplies).toBe(true);
    expect(s.recommendedEncoder).toBe("qwen_3_8b_fp8mixed.safetensors");
    expect(s.recommendedVae).toBe("flux2_vae.safetensors");
    expect(s.note).toMatch(/Klein.*Qwen-3/i);
  });

  it("Flux.2 dev → recommends the Mistral encoder first", () => {
    const s = suggestComponents("flux2-dev.safetensors", "flux2", flux2Files);
    expect(s.recommendedEncoder).toBe("mistral_small_3.1.safetensors");
    expect(s.note).toMatch(/dev\/pro.*Mistral/i);
  });

  it("Z-Image → Qwen-3 encoder + the ae VAE", () => {
    const s = suggestComponents("z_image_turbo.safetensors", "zimage", {
      textEncoders: ["qwen_3_4b.safetensors"],
      vaes: ["ae.safetensors", "sdxl_vae.safetensors"],
    });
    expect(s.recommendedEncoder).toBe("qwen_3_4b.safetensors");
    expect(s.recommendedVae).toBe("ae.safetensors");
  });

  it("Flux.1 UNET-only → encoder picker off (auto dual), VAE still applies", () => {
    const s = suggestComponents("flux1-dev.safetensors", "flux", {
      textEncoders: ["t5xxl_fp16.safetensors", "clip_l.safetensors"],
      vaes: ["ae.safetensors"],
    });
    expect(s.usesComponents).toBe(true);
    expect(s.encoderApplies).toBe(false);
    expect(s.recommendedEncoder).toBeUndefined();
    expect(s.vaeApplies).toBe(true);
    expect(s.recommendedVae).toBe("ae.safetensors");
    expect(s.note).toMatch(/dual encoders/i);
  });

  it("split-file family with nothing installed → applies, but no recommendation", () => {
    const s = suggestComponents("flux-2-klein-4b-fp8.safetensors", "flux2", { textEncoders: [], vaes: [] });
    expect(s.usesComponents).toBe(true);
    expect(s.encoderApplies).toBe(true);
    expect(s.recommendedEncoder).toBeUndefined();
    expect(s.recommendedVae).toBeUndefined();
  });

  it("tolerates a same-family encoder variant (different quant) by stem", () => {
    const s = suggestComponents("flux-2-klein.safetensors", "flux2", {
      textEncoders: ["qwen_3_8b.safetensors"], // no fp8mixed variant, but same stem family
      vaes: ["flux2_vae.safetensors"],
    });
    expect(s.recommendedEncoder).toBe("qwen_3_8b.safetensors");
  });
});
