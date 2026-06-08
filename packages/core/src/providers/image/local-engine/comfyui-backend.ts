import { DirectTransport, type Transport } from "../../transport/transport.js";
import type { ImageGenerationInput, ImageGenerationOutput } from "../image-provider.js";
import { composeSdPositive, resolveModelFamily, resolveNegative } from "../sd-prompt.js";
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
  /** Fail only after this many ms of NO progress once the render has started. */
  idleTimeoutMs?: number;
}

interface ObjectInfoResponse {
  CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: [string[], unknown] } } };
}

interface LoraObjectInfo {
  LoraLoader?: { input?: { required?: { lora_name?: [string[], unknown] } } };
}

/** What the connected ComfyUI offers for IP-Adapter (null = not usable). */
interface IpAdapterCaps {
  /** Which apply node is installed (input keys differ between versions). */
  apply: "advanced" | "apply";
  /** Modern path: IPAdapterUnifiedLoader bundles ipadapter + clip-vision. */
  unified: boolean;
  /** Classic path needs an explicit ipadapter model + clip-vision model. */
  ipadapterModel?: string;
  clipVisionModel?: string;
}

/** Uploaded reference image, as ComfyUI's LoadImage refers to it. */
interface UploadedImage {
  name: string;
}

type NodeSchema = { input?: { required?: Record<string, unknown> } };
type ObjectInfoNodes = Record<string, NodeSchema | undefined>;

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
  private readonly idleTimeoutMs: number;
  private lorasCache?: Promise<Set<string>>;
  private ipAdapterCache?: Promise<IpAdapterCaps | null>;
  private warnedNoIpAdapter = false;

  constructor(opts: ComfyUIBackendOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.transport = opts.transport ?? new DirectTransport();
    this.clientId = opts.clientId ?? "visual-reader";
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.maxPolls = opts.maxPolls ?? 600;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 180000; // 3 min of no progress
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

  /**
   * Detect IP-Adapter support, tolerating ComfyUI_IPAdapter_plus version drift.
   * Returns the usable node set (preferring the modern UnifiedLoader/Advanced
   * path) or null when nothing usable is installed. Cached.
   */
  private availableIpAdapter(): Promise<IpAdapterCaps | null> {
    if (!this.ipAdapterCache) {
      this.ipAdapterCache = (async () => {
        try {
          const res = await this.transport.send({ url: `${this.baseUrl}/object_info`, method: "GET" });
          if (!res.ok) return null;
          const nodes = await res.json<ObjectInfoNodes>();
          const has = (n: string): boolean => Boolean(nodes[n]);
          const apply: IpAdapterCaps["apply"] | undefined = has("IPAdapterAdvanced")
            ? "advanced"
            : has("IPAdapterApply")
              ? "apply"
              : undefined;
          if (!apply) return null;
          // Modern path: one UnifiedLoader bundles the ipadapter + clip-vision models.
          if (has("IPAdapterUnifiedLoader")) return { apply, unified: true };
          // Classic path: needs explicit model loaders + at least one of each model.
          if (has("IPAdapterModelLoader") && has("CLIPVisionLoader")) {
            const ip = firstEnum(nodes.IPAdapterModelLoader, "ipadapter_file");
            const cv = firstEnum(nodes.CLIPVisionLoader, "clip_name");
            if (ip && cv) return { apply, unified: false, ipadapterModel: ip, clipVisionModel: cv };
          }
          return null;
        } catch {
          return null;
        }
      })();
    }
    return this.ipAdapterCache;
  }

  /** Upload a reference image to ComfyUI's input folder; returns its LoadImage name. */
  private async uploadReference(bytes: ArrayBuffer, mimeType: string, name: string): Promise<string> {
    const res = await this.transport.send({
      url: `${this.baseUrl}/upload/image`,
      method: "POST",
      form: { field: "image", bytes, filename: name, contentType: mimeType || "image/png" },
    });
    if (!res.ok) throw new Error(`ComfyUI upload failed with status ${res.status}`);
    const data = await res.json<UploadedImage>();
    return data.name ?? name;
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

    // Format for the model family: SD models get quality tags + identity emphasis
    // + a real negative prompt; Flux gets natural language and no negative.
    const family = resolveModelFamily(input.modelFamily, checkpoint);
    let prompt = composeSdPositive(family, input.prompt, input.subjects);
    const negative = resolveNegative(family, input.negativePrompt);

    // Style LoRA (only when installed); prepend any trigger words to the prompt.
    let lora: { name: string; strength: number } | undefined;
    if (input.styleLora) {
      const resolved = resolveAssetName(await this.availableLoras(), input.styleLora.name);
      if (resolved) {
        lora = { name: resolved, strength: input.styleLora.strength };
        if (input.styleLora.trigger) prompt = `${input.styleLora.trigger}, ${prompt}`;
      }
    }

    // IP-Adapter character consistency — only when refs are passed AND the nodes/
    // models are installed; otherwise render seed-only (graceful, never an error).
    let ipAdapter: IpAdapterGraph | undefined;
    if (input.ipAdapterRefs && input.ipAdapterRefs.length > 0) {
      const caps = await this.availableIpAdapter();
      if (caps) {
        try {
          const refs: { filename: string; weight: number }[] = [];
          for (let i = 0; i < input.ipAdapterRefs.length; i++) {
            const ref = input.ipAdapterRefs[i]!;
            const filename = await this.uploadReference(ref.bytes, ref.mimeType, `vr-ref-${seed}-${i}.png`);
            refs.push({ filename, weight: ref.weight });
          }
          ipAdapter = { caps, refs };
        } catch {
          ipAdapter = undefined; // upload failed → fall back to seed-only
        }
      } else if (!this.warnedNoIpAdapter) {
        this.warnedNoIpAdapter = true;
        console.info(
          "[visual-reader] ComfyUI IP-Adapter nodes/models not installed — using seed-only character consistency.",
        );
      }
    }

    const workflow = buildWorkflow({
      model: checkpoint,
      prompt,
      negative,
      seed,
      steps,
      width: input.width ?? 1024,
      height: input.height ?? 1024,
      ...(lora ? { lora } : {}),
      ...(ipAdapter ? { ipAdapter } : {}),
    });

    // Best-effort live progress: ComfyUI broadcasts per-step `progress` messages
    // over its websocket to the client with our clientId. Open it *before*
    // submitting so we don't miss early steps. We also use it to keep the render
    // alive: as long as ComfyUI reports progress we never time out (a slow-but-
    // working render must not be killed). Completion + image come from /history
    // polling below (a no-op socket in tests / where WebSocket is unavailable).
    const progress = { lastMs: Date.now(), everProgressed: false };
    const relay = (fraction: number): void => {
      progress.lastMs = Date.now();
      progress.everProgressed = true;
      input.onProgress?.(fraction);
    };
    const socket = this.openProgressSocket(relay);
    try {
      const submit = await this.transport.send({
        url: `${this.baseUrl}/prompt`,
        method: "POST",
        body: { prompt: workflow, client_id: this.clientId },
      });
      if (!submit.ok) throw new Error(`ComfyUI prompt failed with status ${submit.status}`);
      const { prompt_id } = await submit.json<PromptResponse>();

      const image = await this.pollForImage(prompt_id, progress);
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

  private async pollForImage(
    promptId: string,
    progress: { lastMs: number; everProgressed: boolean },
  ): Promise<HistoryImage> {
    // Two stop conditions: an absolute backstop (`maxPolls`) used when no progress
    // info is available, and — once the websocket has reported ANY progress — an
    // idle window: keep polling indefinitely while ComfyUI is still working, only
    // failing after `idleTimeoutMs` of silence. So a slow render is never killed.
    for (let i = 0; ; i++) {
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
      if (progress.everProgressed) {
        if (Date.now() - progress.lastMs > this.idleTimeoutMs) {
          throw new Error("ComfyUI generation stalled (no progress)");
        }
      } else if (i >= this.maxPolls) {
        throw new Error("ComfyUI generation timed out");
      }
      await delay(this.pollIntervalMs);
    }
  }
}

/** IP-Adapter inputs for the graph builder (already-uploaded reference filenames). */
interface IpAdapterGraph {
  caps: IpAdapterCaps;
  refs: { filename: string; weight: number }[];
}

interface WorkflowParams {
  model: string;
  prompt: string;
  /** Negative prompt (empty for Flux). */
  negative: string;
  seed: number;
  steps: number;
  width: number;
  height: number;
  /** Optional style LoRA, inserted as a LoraLoader between checkpoint and sampler. */
  lora?: { name: string; strength: number };
  /** Optional IP-Adapter conditioning (character reference images). */
  ipAdapter?: IpAdapterGraph;
}

/** Minimal txt2img ComfyUI graph (checkpoint → [LoRA] → [IP-Adapter] → sampler → VAE → save). */
function buildWorkflow(p: WorkflowParams): Record<string, unknown> {
  // With a LoRA, the sampler model + CLIP encoders read from the LoraLoader ("10")
  // instead of the checkpoint ("4") directly.
  const modelRef: [string, number] = p.lora ? ["10", 0] : ["4", 0];
  const clipRef: [string, number] = p.lora ? ["10", 1] : ["4", 1];
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
    "7": { class_type: "CLIPTextEncode", inputs: { text: p.negative, clip: clipRef } },
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
  if (p.ipAdapter && p.ipAdapter.refs.length > 0) {
    // Chain one apply node per reference, threading MODEL through; the final
    // node's MODEL output feeds the sampler. Branch on the detected node version.
    const ks = graph["3"] as { inputs: Record<string, unknown> };
    ks.inputs.model = p.ipAdapter.caps.unified
      ? addUnifiedIpAdapter(graph, p.ipAdapter, modelRef)
      : addClassicIpAdapter(graph, p.ipAdapter, modelRef);
  }
  return graph;
}

/** Modern path: IPAdapterUnifiedLoader (bundles ipadapter + clip-vision) → IPAdapterAdvanced. */
function addUnifiedIpAdapter(
  graph: Record<string, unknown>,
  ip: IpAdapterGraph,
  baseModel: [string, number],
): [string, number] {
  graph["20"] = {
    class_type: "IPAdapterUnifiedLoader",
    inputs: { model: baseModel, preset: "PLUS (high strength)" },
  };
  let current: [string, number] = ["20", 0];
  ip.refs.forEach((ref, i) => {
    const imgId = String(21 + i * 2);
    const applyId = String(22 + i * 2);
    graph[imgId] = { class_type: "LoadImage", inputs: { image: ref.filename } };
    graph[applyId] = {
      class_type: "IPAdapterAdvanced",
      inputs: {
        model: current,
        ipadapter: ["20", 1],
        image: [imgId, 0],
        weight: ref.weight,
        weight_type: "linear",
        start_at: 0,
        end_at: 1,
      },
    };
    current = [applyId, 0];
  });
  return current;
}

/** Classic path: IPAdapterModelLoader + CLIPVisionLoader → IPAdapterApply/Advanced. */
function addClassicIpAdapter(
  graph: Record<string, unknown>,
  ip: IpAdapterGraph,
  baseModel: [string, number],
): [string, number] {
  graph["20"] = {
    class_type: "IPAdapterModelLoader",
    inputs: { ipadapter_file: ip.caps.ipadapterModel },
  };
  graph["21"] = {
    class_type: "CLIPVisionLoader",
    inputs: { clip_name: ip.caps.clipVisionModel },
  };
  let current: [string, number] = baseModel;
  ip.refs.forEach((ref, i) => {
    const imgId = String(22 + i * 2);
    const applyId = String(23 + i * 2);
    graph[imgId] = { class_type: "LoadImage", inputs: { image: ref.filename } };
    graph[applyId] =
      ip.caps.apply === "advanced"
        ? {
            class_type: "IPAdapterAdvanced",
            inputs: {
              model: current,
              ipadapter: ["20", 0],
              image: [imgId, 0],
              clip_vision: ["21", 0],
              weight: ref.weight,
              weight_type: "linear",
              start_at: 0,
              end_at: 1,
            },
          }
        : {
            class_type: "IPAdapterApply",
            inputs: {
              ipadapter: ["20", 0],
              clip_vision: ["21", 0],
              image: [imgId, 0],
              model: current,
              weight: ref.weight,
            },
          };
    current = [applyId, 0];
  });
  return current;
}

/** First value of a node's required enum input (e.g. an installed model name). */
function firstEnum(node: NodeSchema | undefined, key: string): string | undefined {
  const spec = node?.input?.required?.[key];
  if (Array.isArray(spec) && Array.isArray(spec[0])) {
    const first = (spec[0] as unknown[])[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
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
