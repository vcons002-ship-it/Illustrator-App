import { describe, it, expect } from "vitest";
import { classifyLoraHeader, detectLoraFamily } from "./lora-detect.js";

describe("detectLoraFamily (metadata)", () => {
  it("reads the kohya base-model-version metadata", () => {
    expect(detectLoraFamily({ ss_base_model_version: "sdxl_base_v1-0" }, [])).toBe("sdxl");
    expect(detectLoraFamily({ ss_base_model_version: "sd_v1-5" }, [])).toBe("sd15");
  });

  it("reads the modelspec.architecture metadata, incl. Flux variants", () => {
    expect(detectLoraFamily({ "modelspec.architecture": "flux-1-dev/lora" }, [])).toBe("flux");
    expect(detectLoraFamily({ "modelspec.architecture": "flux.2-dev/lora" }, [])).toBe("flux2");
    expect(detectLoraFamily({ "modelspec.architecture": "qwen-image" }, [])).toBe("qwenimage");
    expect(detectLoraFamily({ "modelspec.architecture": "z-image-turbo" }, [])).toBe("zimage");
  });
});

describe("detectLoraFamily (key fallback when metadata is absent)", () => {
  it("Flux from double/single block names", () => {
    expect(detectLoraFamily(undefined, ["lora_unet_double_blocks_0_img_attn", "single_blocks_1"])).toBe(
      "flux",
    );
  });

  it("SDXL from a second text encoder", () => {
    expect(detectLoraFamily(undefined, ["lora_te2_text_model_encoder", "lora_unet_down_blocks_0"])).toBe(
      "sdxl",
    );
  });

  it("SD1.5 from a plain UNet with no second encoder", () => {
    expect(detectLoraFamily(undefined, ["lora_unet_down_blocks_0", "lora_te_text_model"])).toBe("sd15");
  });

  it("unknown when nothing is conclusive", () => {
    expect(detectLoraFamily(undefined, ["some_random_tensor"])).toBe("unknown");
    expect(detectLoraFamily({}, [])).toBe("unknown");
  });
});

describe("classifyLoraHeader", () => {
  it("parses a safetensors header JSON (metadata + tensor keys) and classifies", () => {
    const header = JSON.stringify({
      __metadata__: { ss_base_model_version: "sdxl_base_v1-0" },
      "lora_unet_down_blocks_0.lora_up.weight": { dtype: "F16", shape: [4, 320], data_offsets: [0, 2560] },
    });
    expect(classifyLoraHeader(header)).toBe("sdxl");
  });

  it("falls back to keys when there's no metadata block", () => {
    const header = JSON.stringify({
      "lora_unet_single_blocks_0.lora_down.weight": { dtype: "F16", shape: [4, 3072], data_offsets: [0, 1] },
    });
    expect(classifyLoraHeader(header)).toBe("flux");
  });

  it("never throws on malformed input", () => {
    expect(classifyLoraHeader("not json")).toBe("unknown");
    expect(classifyLoraHeader("")).toBe("unknown");
  });
});
