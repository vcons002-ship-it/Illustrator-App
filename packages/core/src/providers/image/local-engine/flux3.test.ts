import { describe, expect, it } from "vitest";
import { ComfyUIBackend, buildWorkflow, referencePhotoSupports, SPLIT_FILE_HEURISTICS } from "./comfyui-backend.js";
import { catalogEntryForModel, detectCheckpointFamily } from "../../catalog.js";
import { samplerFor, isNaturalLanguage } from "../sd-prompt.js";
import type { Transport } from "../../transport/transport.js";

const params = {
  model: "flux3_image_klein_sd_int8_convrot.safetensors", family: "flux3" as const,
  prompt: "A red fox in a snowy forest", negative: "", seed: 42, steps: 16,
  width: 1024, height: 768, loadKind: "diffusion" as const, sampler: samplerFor("flux3"),
  components: { textEncoder: { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_4b_int8_convrot.safetensors", type: "flux3" } },
    vaeName: "flux2-vae.safetensors", weightDtype: "default", promptUpsampler: "qwen3.5_9b_flux3_prompt_upsampler_int8_convrot.safetensors" },
};
type Node = { class_type: string; inputs: Record<string, unknown> };
function graph(extra = {}) { return buildWorkflow({ ...params, ...extra }) as Record<string, Node>; }

describe("FLUX 3 Image Klein native recipe", () => {
  it("fails closed before submission on an offline/old engine, and retries the probe", async () => {
    const calls: string[] = [];
    const transport = { send: async ({ url }: { url: string }) => {
      calls.push(url); return { ok: true, json: async () => ({}) };
    } } as unknown as Transport;
    const backend = new ComfyUIBackend({ baseUrl: "http://localhost:8188", transport });
    const input = { prompt: "a fox", anchors: [], quality: "standard" as const };
    await expect(backend.generate(input, params.model)).rejects.toThrow(/start\/reconnect/);
    await expect(backend.generate(input, params.model)).rejects.toThrow(/start\/reconnect/);
    expect(calls.filter(url => url.endsWith("/object_info/CLIPLoader"))).toHaveLength(2);
    expect(calls.some(url => url.endsWith("/prompt"))).toBe(false);
  });
  it("rejects base checkpoints instead of applying the distilled sampler", async () => {
    const backend = new ComfyUIBackend({ baseUrl: "http://localhost:8188", transport: {} as Transport });
    await expect(backend.generate({ prompt: "fox", anchors: [], quality: "standard" }, "flux3_image_klein_base_bf16.safetensors"))
      .rejects.toThrow(/distilled/);
  });
  it("detects variants separately from Flux 1/2 and advertises native references", () => {
    for (const name of [params.model, "Flux.3-Klein-bf16.safetensors", "flux-3-image-klein-sd-nvfp4.safetensors"]) {
      expect(detectCheckpointFamily(name)).toBe("flux3");
    }
    expect(isNaturalLanguage("flux3")).toBe(true);
    expect(referencePhotoSupports("flux3")).toBe(true);
    expect(samplerFor("flux3")).toEqual({ cfg: 1, sampler: "euler", scheduler: "simple", steps: 16 });
  });
  it("uses Qwen3-VL 4B, never Flux 2's Qwen3 or Qwen Image 2.1's 8B", () => {
    const pattern = SPLIT_FILE_HEURISTICS.flux3!.clip;
    expect(pattern.test("qwen3vl_4b_int8_convrot.safetensors")).toBe(true);
    expect(pattern.test("qwen_3_4b.safetensors")).toBe(false);
    expect(pattern.test("qwen3vl_8b_int8_convrot.safetensors")).toBe(false);
    expect(catalogEntryForModel(params.model)?.files).toHaveLength(4);
  });
  it("upsamples text before image encoding; uses 128-channel Flux 2 latent and no guidance node", () => {
    const g = graph();
    expect(g["21"]?.class_type).toBe("TextGenerate");
    expect(g["6"]?.inputs.text).toEqual(["21", 0]);
    expect(g["5"]?.class_type).toBe("EmptyFlux2LatentImage");
    expect(g["3"]?.inputs.cfg).toBe(1);
    expect(Object.values(g).some(n => n.class_type === "FluxGuidance")).toBe(false);
  });
  it("routes edit image first, plus all references, to captioner AND both conditioning branches", () => {
    const g = graph({ initImage: { filename: "edit.png", denoise: 0.2 }, referenceLatents: ["soul.png", "search.png"] });
    expect(g["100"]?.inputs.image).toBe("edit.png");
    expect(g["101"]?.inputs.image).toBe("soul.png");
    expect(g["102"]?.inputs.image).toBe("search.png");
    expect(g["21"]?.inputs.image).toEqual(["22", 0]);
    expect(g["22"]?.inputs["images.image2"]).toEqual(["102", 0]);
    expect(g["23"]?.inputs["images.image2"]).toEqual(["102", 0]);
    expect(g["23"]?.inputs.positive).toEqual(["6", 0]);
    expect(g["23"]?.inputs.negative).toEqual(["7", 0]);
    expect(g["3"]?.inputs.positive).toEqual(["23", 0]);
    expect(g["3"]?.inputs.negative).toEqual(["23", 1]);
    expect(g["3"]?.inputs.denoise).toBe(1); // instruction edit, not partial-noise img2img
  });
  it("caps at 10 images including the edit image and refuses missing prompt upsampler", () => {
    const g = graph({ initImage: { filename: "edit.png", denoise: 1 }, referenceLatents: Array.from({ length: 12 }, (_, i) => `${i}.png`) });
    expect(Object.values(g).filter(n => n.class_type === "LoadImage")).toHaveLength(10);
    expect(() => graph({ components: { ...params.components, promptUpsampler: undefined } })).toThrow(/upsampler/);
  });
});
