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

interface LoraObjectInfo {
  LoraLoader?: { input?: { required?: { lora_name?: [string[], unknown] } } };
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
  private lorasCache?: Promise<Set<string>>;

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

  /** Installed LoRA names (cached). Used to apply a style LoRA only when present. */
  private availableLoras(): Promise<Set<string>> {
    if (!this.lorasCache) {
      this.lorasCache = (async () => {
        try {
          const res = await this.transport.send({
            url: `${this.baseUrl}/object_info/LoraLoader`,
            method: "GET",
          });
          if (!res.ok) return new Set<string>();
          const data = await res.json<LoraObjectInfo>();
          return new Set(data.LoraLoader?.input?.required?.lora_name?.[0] ?? []);
        } catch {
          return new Set<string>();
        }
      })();
    }
    return this.lorasCache;
  }

  async generate(input: ImageGenerationInput, model: string): Promise<ImageGenerationOutput> {
    const seed = input.anchors[0]?.seed ?? Math.floor(Math.random() * 1_000_000_000);
    const steps =
      input.steps ?? (input.quality === "sketch" ? 6 : input.quality === "standard" ? 20 : 35);

    // Style checkpoint override (only when that checkpoint is installed).
    let checkpoint = model;
    if (input.styleCheckpoint) {
      const installed = new Set((await this.listModels()).map((m) => m.id));
      const resolved = resolveAssetName(installed, input.styleCheckpoint);
      if (resolved) checkpoint = resolved;
    }

    // Style LoRA (only when installed); prepend any trigger words to the prompt.
    let prompt = input.prompt;
    let lora: { name: string; strength: number } | undefined;
    if (input.styleLora) {
      const resolved = resolveAssetName(await this.availableLoras(), input.styleLora.name);
      if (resolved) {
        lora = { name: resolved, strength: input.styleLora.strength };
        if (input.styleLora.trigger) prompt = `${input.styleLora.trigger}, ${prompt}`;
      }
    }

    const workflow = buildWorkflow({
      model: checkpoint,
      prompt,
      seed,
      steps,
      width: input.width ?? 1024,
      height: input.height ?? 1024,
      ...(lora ? { lora } : {}),
    });

    // Best-effort live progress: ComfyUI broadcasts per-step `progress` messages
    // over its websocket to the client with our clientId. Open it *before*
    // submitting so we don't miss early steps. Completion + image retrieval still
    // come from /history polling below, so this is a pure side channel (and a
    // no-op in tests / where WebSocket is unavailable).
    const socket = input.onProgress ? this.openProgressSocket(input.onProgress) : undefined;
    try {
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
      input.onProgress?.(1);
      return { bytes: await view.arrayBuffer(), mimeType: "image/png" };
    } finally {
      socket?.close();
    }
  }

  /**
   * Open a websocket to ComfyUI and forward per-step sampling progress (0..1) to
   * `onProgress`. Returns a closer, or undefined where WebSocket isn't available
   * (Node/tests) — progress is always optional, never required for correctness.
   */
  private openProgressSocket(onProgress: (fraction: number) => void): { close: () => void } | undefined {
    if (typeof WebSocket === "undefined") return undefined;
    try {
      const wsUrl =
        this.baseUrl.replace(/^http/, "ws") + `/ws?clientId=${encodeURIComponent(this.clientId)}`;
      const ws = new WebSocket(wsUrl);
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== "string") return; // binary frames are preview images
        try {
          const msg = JSON.parse(ev.data) as { type?: string; data?: { value?: number; max?: number } };
          if (msg.type === "progress" && msg.data && typeof msg.data.value === "number" && msg.data.max) {
            onProgress(Math.max(0, Math.min(1, msg.data.value / msg.data.max)));
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onerror = () => {
        /* progress is best-effort; ignore socket errors */
      };
      return {
        close: () => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      };
    } catch {
      return undefined;
    }
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
  /** Optional style LoRA, inserted as a LoraLoader between checkpoint and sampler. */
  lora?: { name: string; strength: number };
}

/** Minimal txt2img ComfyUI graph (checkpoint → [LoRA] → CLIP → sampler → VAE → save). */
function buildWorkflow(p: WorkflowParams): Record<string, unknown> {
  // With a LoRA, the sampler model + CLIP encoders read from the LoraLoader ("10")
  // instead of the checkpoint ("4") directly.
  const modelRef = p.lora ? ["10", 0] : ["4", 0];
  const clipRef = p.lora ? ["10", 1] : ["4", 1];
  const graph: Record<string, unknown> = {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: modelRef,
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
    "6": { class_type: "CLIPTextEncode", inputs: { text: p.prompt, clip: clipRef } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "", clip: clipRef } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "visual-reader", images: ["8", 0] } },
  };
  if (p.lora) {
    graph["10"] = {
      class_type: "LoraLoader",
      inputs: {
        lora_name: p.lora.name,
        strength_model: p.lora.strength,
        strength_clip: p.lora.strength,
        model: ["4", 0],
        clip: ["4", 1],
      },
    };
  }
  return graph;
}

/** Match a wanted asset (e.g. "anime") against engine names ("anime.safetensors"). */
export function resolveAssetName(available: ReadonlySet<string>, wanted: string): string | undefined {
  if (available.has(wanted)) return wanted;
  const target = wanted.toLowerCase();
  for (const name of available) {
    const base = name.replace(/\.[^./\\]+$/, "").toLowerCase();
    if (base === target || name.toLowerCase() === target) return name;
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
