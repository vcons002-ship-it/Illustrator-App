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

describe("buildWorkflow shift families", () => {
  /** A HiDream render: quad-encoder diffusion model + an SD3 sigma shift. */
  const hidream = {
    ...base,
    family: "hidream" as const,
    loadKind: "diffusion" as const,
    sampler: { cfg: 5, sampler: "uni_pc", scheduler: "simple", steps: 50, shift: 3.0 } as SamplerSettings,
    components: {
      textEncoder: {
        class_type: "QuadrupleCLIPLoader",
        inputs: {
          clip_name1: "clip_l_hidream.safetensors",
          clip_name2: "clip_g_hidream.safetensors",
          clip_name3: "t5xxl_fp8_e4m3fn_scaled.safetensors",
          clip_name4: "llama_3.1_8b_instruct_fp8_scaled.safetensors",
        },
      },
      vaeName: "ae.safetensors",
      weightDtype: "default",
    },
  };

  it("HiDream wraps the model in ModelSamplingSD3 (node 17) and loads the quad encoder", () => {
    const g = buildWorkflow(hidream);
    // Four-encoder loader passes through as the diffusion clip node (12).
    expect(classOf(g, "12")).toBe("QuadrupleCLIPLoader");
    expect(inputsOf(g, "12").clip_name4).toBe("llama_3.1_8b_instruct_fp8_scaled.safetensors");
    // Shift uses the SD3 node, at id 17 (not 15), wrapping the UNET and feeding the sampler.
    expect(classOf(g, "17")).toBe("ModelSamplingSD3");
    expect(inputsOf(g, "17").shift).toBe(3.0);
    expect(inputsOf(g, "17").model).toEqual(["4", 0]); // wraps the UNETLoader
    expect(inputsOf(g, "3").model).toEqual(["17", 0]); // sampler reads the shifted model
    // No FluxGuidance: HiDream uses real CFG, so positive conditioning is the plain encode.
    expect(g["14"]).toBeUndefined();
    expect(inputsOf(g, "3").positive).toEqual(["6", 0]);
  });

  it("Z-Image/Qwen still use ModelSamplingAuraFlow, now also at node 17", () => {
    const g = buildWorkflow({
      ...base,
      family: "zimage",
      loadKind: "diffusion",
      sampler: { cfg: 1, sampler: "res_multistep", scheduler: "simple", steps: 8, shift: 3 },
      components: {
        textEncoder: { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b.safetensors", type: "lumina2" } },
        vaeName: "ae.safetensors",
        weightDtype: "default",
      },
    });
    expect(classOf(g, "17")).toBe("ModelSamplingAuraFlow");
    expect(inputsOf(g, "17").shift).toBe(3);
  });

  it("img2img + shift no longer collide (LoadImage at 15, shift node at 17)", () => {
    const g = buildWorkflow({ ...hidream, initImage: { filename: "photo.png", denoise: 0.6 } });
    expect(classOf(g, "15")).toBe("LoadImage"); // img2img kept its node
    expect(classOf(g, "16")).toBe("VAEEncode");
    expect(classOf(g, "17")).toBe("ModelSamplingSD3"); // shift kept its own node
    expect(inputsOf(g, "16").pixels).toEqual(["15", 0]); // VAEEncode reads the real LoadImage
    expect(inputsOf(g, "3").latent_image).toEqual(["16", 0]);
    expect(inputsOf(g, "3").model).toEqual(["17", 0]); // and still samples the shifted model
  });
});
