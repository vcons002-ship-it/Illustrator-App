import { DirectTransport, type Transport } from "../../transport/transport.js";
import type { ImageGenerationInput, ImageGenerationOutput } from "../image-provider.js";
import type { LocalEngineBackend, LocalModelDescriptor } from "./backend.js";

/**
 * ComfyUI engine backend. Drives a local ComfyUI server (which the desktop shell
 * launches) over its HTTP API:
 *  - listModels → GET /object_info/CheckpointLoaderSimple (the checkpoint enum)
 *  - generate   → POST /prompt (a txt2img workflow graph), poll /history/{id},
 *                 then GET /view to download the rendered image
 *
 * ComfyUI supports the full range of `.safetensors` checkpoints (SD / SDXL /
 * Flux), so this is the path that runs 8GB+ models at full GPU. The base URL and
 * `Transport` are injected, so the same code runs in tests (fake transport),
 * against a real localhost server, or through a proxy.
 */

export interface ComfyUIBackendOptions {
  /** Base URL of the running engine, supplied by the desktop shell. */
  baseUrl: string;
  transport?: Transport;
  clientId?: string;
  pollIntervalMs?: number;
  maxPolls?: number;
}

interface ObjectInfoResponse {
  CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: [string[], unknown] } } };
}

interface PromptResponse {
  prompt_id: string;
}

interface HistoryImage {
  filename: string;
  subfolder: string;
  type: string;
}

type HistoryResponse = Record<
  string,
  { outputs?: Record<string, { images?: HistoryImage[] }> }
>;

export class ComfyUIBackend implements LocalEngineBackend {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly clientId: string;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;

  constructor(opts: ComfyUIBackendOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.transport = opts.transport ?? new DirectTransport();
    this.clientId = opts.clientId ?? "visual-reader";
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.maxPolls = opts.maxPolls ?? 600;
  }

  async listModels(): Promise<LocalModelDescriptor[]> {
    const res = await this.transport.send({
      url: `${this.baseUrl}/object_info/CheckpointLoaderSimple`,
      method: "GET",
    });
    if (!res.ok) throw new Error(`ComfyUI listModels failed with status ${res.status}`);
    const data = await res.json<ObjectInfoResponse>();
    const names = data.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
    return names.map((id) => ({ id, label: id, sizeGB: 0 }));
  }

  async generate(input: ImageGenerationInput, model: string): Promise<ImageGenerationOutput> {
    const seed = input.anchors[0]?.seed ?? Math.floor(Math.random() * 1_000_000_000);
    const steps = input.quality === "sketch" ? 6 : input.quality === "standard" ? 20 : 35;
    const workflow = buildWorkflow({
      model,
      prompt: input.prompt,
      seed,
      steps,
      width: input.width ?? 1024,
      height: input.height ?? 1024,
    });

    const submit = await this.transport.send({
      url: `${this.baseUrl}/prompt`,
      method: "POST",
      body: { prompt: workflow, client_id: this.clientId },
    });
    if (!submit.ok) throw new Error(`ComfyUI prompt failed with status ${submit.status}`);
    const { prompt_id } = await submit.json<PromptResponse>();

    const image = await this.pollForImage(prompt_id);
    const view = await this.transport.send({
      url:
        `${this.baseUrl}/view?filename=${encodeURIComponent(image.filename)}` +
        `&subfolder=${encodeURIComponent(image.subfolder)}&type=${encodeURIComponent(image.type)}`,
      method: "GET",
    });
    if (!view.ok) throw new Error(`ComfyUI view failed with status ${view.status}`);
    return { bytes: await view.arrayBuffer(), mimeType: "image/png" };
  }

  private async pollForImage(promptId: string): Promise<HistoryImage> {
    for (let i = 0; i < this.maxPolls; i++) {
      const res = await this.transport.send({
        url: `${this.baseUrl}/history/${encodeURIComponent(promptId)}`,
        method: "GET",
      });
      if (!res.ok) throw new Error(`ComfyUI history failed with status ${res.status}`);
      const history = await res.json<HistoryResponse>();
      const entry = history[promptId];
      if (entry) {
        const images = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? []);
        const first = images[0];
        if (first) return first;
        throw new Error("ComfyUI finished but produced no image");
      }
      await delay(this.pollIntervalMs);
    }
    throw new Error("ComfyUI generation timed out");
  }
}

interface WorkflowParams {
  model: string;
  prompt: string;
  seed: number;
  steps: number;
  width: number;
  height: number;
}

/** Minimal txt2img ComfyUI graph (checkpoint → CLIP → sampler → VAE → save). */
function buildWorkflow(p: WorkflowParams): Record<string, unknown> {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: p.model } },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: p.width, height: p.height, batch_size: 1 },
    },
    "6": { class_type: "CLIPTextEncode", inputs: { text: p.prompt, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "visual-reader", images: ["8", 0] } },
  };
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
