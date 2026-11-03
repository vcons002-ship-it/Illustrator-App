import { describe, expect, it } from "vitest";
import { buildLtx2I2VWorkflow, ComfyUIBackend, comfyExecutionError } from "./comfyui-backend.js";
import { resolveVideoModelFiles } from "../video-models.js";
import type { Ltx25VideoFiles } from "../image-provider.js";
import type { Transport, TransportRequest, TransportResponse } from "../../transport/transport.js";

const models = resolveVideoModelFiles("ltx2.5-i2v-22b") as Ltx25VideoFiles;
const params = {
  models, prompt: "The fox turns its head; wind moves the leaves. Soft forest ambience.",
  negative: "blurry, watermark", width: 768, height: 512, frames: 121, fps: 24,
  steps: 8, cfg: 1, seed: 25, highRes: true, audio: true,
};
type Node = { class_type: string; inputs: Record<string, unknown> };
const workflow = (patch: Partial<typeof params> & { startImage?: string } = {}) =>
  buildLtx2I2VWorkflow({ ...params, ...patch }) as Record<string, Node>;

describe("LTX-2.5 native split workflow", () => {
  it("uses the transformer, projected Gemma-4 encoder and separate VAEs, never the 2.3 loaders", () => {
    const graph = workflow({ startImage: "fox.png" });
    expect(graph["200"]).toEqual({ class_type: "UNETLoader", inputs: { unet_name: models.diffusionModel, weight_dtype: "default" } });
    expect(graph["201"]).toEqual({ class_type: "CLIPLoader", inputs: { clip_name: models.textEncoder, type: "ltxv", device: "default" } });
    expect(graph["249"]!.inputs.vae_name).toBe(models.vae);
    expect(graph["230"]!.inputs.vae_name).toBe(models.audioVae);
    expect(Object.values(graph).some((n) => ["CheckpointLoaderSimple", "LTXAVTextEncoderLoader", "LTXVAudioVAELoader"].includes(n.class_type))).toBe(false);
    expect(graph["202"]).toBeUndefined(); // no obsolete speed LoRA
    for (const id of ["210", "217", "218", "225"]) expect(graph[id]!.inputs.vae).toEqual(["249", 0]);
  });

  it("matches the official eight-step dual-CFG AV recipe and optional three-step refinement", () => {
    const graph = workflow();
    expect(graph["214"]).toEqual({ class_type: "LTXVDualCFGGuider", inputs: { model: ["200", 0], positive: ["205", 0], negative: ["205", 1], video_cfg: 1, audio_cfg: 1 } });
    expect(graph["223"]!.inputs.positive).toEqual(["205", 0]);
    expect(graph["212"]!.inputs.sampler_name).toBe("euler_ancestral");
    expect(graph["213"]!.inputs.sigmas).toBe("1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0");
    expect(graph["222"]!.inputs.sigmas).toBe("0.85, 0.7250, 0.4219, 0.0");
    expect(graph["215"]!.inputs.latent_image).toEqual(["232", 0]);
    expect(graph["234"]!.inputs.audio_latent).toEqual(["233", 1]);
    expect(graph["224"]!.inputs.latent_image).toEqual(["234", 0]);
    expect(graph["225"]!.inputs).toMatchObject({ samples: ["235", 0], tile_size: 512, temporal_size: 64, temporal_overlap: 16 });
    expect(graph["237"]!.inputs.audio).toEqual(["236", 0]);
    expect(graph["238"]!.class_type).toBe("SaveVideo");
  });

  it("preserves image conditioning and optional user LoRA stacks without injecting a speed adapter", () => {
    const graph = workflow({ startImage: "fox.png", models: { ...models, loras: [{ name: "style.safetensors", strength: 0.6 }] } });
    expect(graph["206"]!.inputs.image).toBe("fox.png");
    expect(graph["210"]!.inputs.latent).toEqual(["209", 0]);
    expect(graph["218"]!.inputs.latent).toEqual(["217", 0]);
    expect(graph["250"]!.inputs).toEqual({ model: ["200", 0], lora_name: "style.safetensors", strength_model: 0.6 });
    expect(graph["214"]!.inputs.model).toEqual(["250", 0]);
    expect(graph["223"]!.inputs.model).toEqual(["250", 0]);
  });

  it("single-stage text-to-video skips image conditioning and the upscaler", () => {
    const graph = workflow({ highRes: false });
    expect(graph["206"]).toBeUndefined();
    expect(graph["216"]).toBeUndefined();
    expect(graph["224"]).toBeUndefined();
    expect(graph["209"]!.inputs).toMatchObject({ width: 768, height: 512, length: 121 });
    expect(graph["232"]!.inputs.video_latent).toEqual(["209", 0]);
    expect(graph["225"]!.inputs.samples).toEqual(["233", 0]);
  });

  it("silent output retains the joint AV sampler but omits audio decode/mux", () => {
    const graph = workflow({ audio: false });
    expect(graph["230"]!.class_type).toBe("VAELoader");
    expect(graph["232"]!.class_type).toBe("LTXVConcatAVLatent");
    expect(graph["236"]).toBeUndefined();
    expect(graph["238"]).toBeUndefined();
    expect(graph["226"]!.class_type).toBe("SaveAnimatedWEBP");
  });

  it.each([false, true])("has no dangling links with highRes=%s", (highRes) => {
    for (const audio of [false, true]) for (const startImage of [undefined, "fox.png"]) {
      const graph = workflow({ highRes, audio, ...(startImage ? { startImage } : {}) });
      for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) {
        if (Array.isArray(value)) expect(graph[value[0] as string]).toBeDefined();
      }
    }
  });
});

function response(body: unknown): TransportResponse {
  return { ok: true, status: 200, json: async () => body } as TransportResponse;
}

describe("LTX-2.5 preflight", () => {
  it("reports an engine interruption instead of an opaque execution failure", () => {
    const status = { status_str: "error", completed: false, messages: [["execution_interrupted", { node_id: "224", node_type: "SamplerCustomAdvanced" }]] as [string, Record<string, unknown>][] };
    expect(comfyExecutionError(status)).toMatch(/generation was interrupted/);
  });

  it("accepts the native V3 COMBO options list for the installed spatial upscaler", async () => {
    const calls: TransportRequest[] = [];
    const transport: Transport = { send: async (request) => {
      calls.push(request);
      const node = request.url.split("/").at(-1)!;
      if (node === "LTXVDualCFGGuider") return response({ [node]: { input: {} } });
      if (node === "UNETLoader") return response({ [node]: { input: { required: { unet_name: [[models.diffusionModel]] } } } });
      if (node === "CLIPLoader") return response({ [node]: { input: { required: { clip_name: [[models.textEncoder]] } } } });
      if (node === "VAELoader") return response({ [node]: { input: { required: { vae_name: [[models.vae, models.audioVae]] } } } });
      if (node === "LatentUpscaleModelLoader") return response({ [node]: { input: { required: { model_name: ["COMBO", { options: [models.upscaler], multiselect: false }] } } } });
      if (node === "prompt") throw new Error("evaluation submission reached");
      return response({});
    } };
    await expect(new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport })
      .generateVideo({ prompt: "move", highRes: true }, models))
      .rejects.toThrow("evaluation submission reached");
    expect(calls.some((call) => call.url.endsWith("/prompt"))).toBe(true);
  });

  it("reports an old engine before uploading any image or submitting work", async () => {
    const calls: TransportRequest[] = [];
    const transport: Transport = { send: async (request) => { calls.push(request); return response({}); } };
    await expect(new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport })
      .generateVideo({ prompt: "move", image: { bytes: new ArrayBuffer(8), mimeType: "image/png" } }, models))
      .rejects.toThrow(/updated ComfyUI.*LTXVDualCFGGuider/);
    expect(calls).toHaveLength(1);
  });

  it("reports exact missing split files and the gated source without uploading or rendering", async () => {
    const calls: TransportRequest[] = [];
    const transport: Transport = { send: async (request) => {
      calls.push(request);
      return response(request.url.endsWith("LTXVDualCFGGuider") ? { LTXVDualCFGGuider: { input: {} } } : {});
    } };
    await expect(new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport })
      .generateVideo({ prompt: "move", highRes: false }, models))
      .rejects.toThrow(/models\/diffusion_models\/ltx-2.5.*Lightricks\/LTX-2.5/);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.some((call) => call.url.includes("LatentUpscaleModelLoader"))).toBe(false);
  });
});
