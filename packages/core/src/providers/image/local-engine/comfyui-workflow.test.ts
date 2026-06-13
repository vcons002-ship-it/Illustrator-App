import { describe, expect, it } from "vitest";
import { buildWorkflow } from "./comfyui-backend.js";
import type { SamplerSettings } from "../sd-prompt.js";

const sampler: SamplerSettings = { cfg: 7, sampler: "euler", scheduler: "normal", steps: 20 };

const base = {
  model: "sd_xl.safetensors",
  prompt: "a fox",
  negative: "blurry",
  seed: 42,
  steps: 20,
  width: 1024,
  height: 1024,
  family: "sdxl" as const,
  sampler,
  loadKind: "checkpoint" as const,
};

/** A graph node's class_type, for terse assertions. */
const classOf = (g: Record<string, unknown>, id: string) =>
  (g[id] as { class_type?: string } | undefined)?.class_type;
const inputsOf = (g: Record<string, unknown>, id: string) =>
  (g[id] as { inputs?: Record<string, unknown> } | undefined)?.inputs ?? {};

describe("buildWorkflow txt2img", () => {
  it("samples from an empty latent at full denoise", () => {
    const g = buildWorkflow(base);
    expect(classOf(g, "5")).toBe("EmptyLatentImage");
    expect(g["15"]).toBeUndefined(); // no LoadImage
    expect(g["16"]).toBeUndefined(); // no VAEEncode
    expect(inputsOf(g, "3").denoise).toBe(1);
    expect(inputsOf(g, "3").latent_image).toEqual(["5", 0]);
  });
});

describe("buildWorkflow img2img", () => {
  it("encodes the base photo and denoises from it (no empty latent)", () => {
    const g = buildWorkflow({ ...base, initImage: { filename: "photo.png", denoise: 0.55 } });
    expect(g["5"]).toBeUndefined(); // empty latent replaced
    expect(classOf(g, "15")).toBe("LoadImage");
    expect(inputsOf(g, "15").image).toBe("photo.png");
    expect(classOf(g, "16")).toBe("VAEEncode");
    // VAEEncode pulls pixels from LoadImage and shares the checkpoint's VAE (node 4, slot 2).
    expect(inputsOf(g, "16").pixels).toEqual(["15", 0]);
    expect(inputsOf(g, "16").vae).toEqual(["4", 2]);
    // The sampler denoises partway, from the encoded latent.
    expect(inputsOf(g, "3").denoise).toBe(0.55);
    expect(inputsOf(g, "3").latent_image).toEqual(["16", 0]);
  });

  it("carries the components' weight_dtype onto the UNET loader (Low-VRAM fp8)", () => {
    const g = buildWorkflow({
      ...base,
      loadKind: "diffusion",
      family: "flux2",
      components: {
        textEncoder: { class_type: "CLIPLoader", inputs: { clip_name: "qwen.safetensors", type: "flux2" } },
        vaeName: "ae.safetensors",
        weightDtype: "fp8_e4m3fn",
      },
    });
    expect(classOf(g, "4")).toBe("UNETLoader");
    expect(inputsOf(g, "4").weight_dtype).toBe("fp8_e4m3fn");
  });

  it("wires VAEEncode to the standalone VAE loader on a diffusion (Flux.2) model", () => {
    const g = buildWorkflow({
      ...base,
      loadKind: "diffusion",
      family: "flux2",
      components: {
        textEncoder: { class_type: "CLIPLoader", inputs: { clip_name: "t5.safetensors", type: "flux" } },
        vaeName: "ae.safetensors",
        weightDtype: "default",
      },
      initImage: { filename: "in.jpg", denoise: 0.7 },
    });
    expect(inputsOf(g, "16").vae).toEqual(["13", 0]); // VAELoader node, not the checkpoint
    expect(inputsOf(g, "3").latent_image).toEqual(["16", 0]);
  });
});
