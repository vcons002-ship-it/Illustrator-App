import { DirectTransport, type Transport } from "../../transport/transport.js";
import { catalogEntryForModel } from "../../catalog.js";
import type { ImageGenerationInput, ImageGenerationOutput } from "../image-provider.js";
import {
  type ModelFamily,
  type SamplerSettings,
  clampResolution,
  composeSdPositive,
  isNaturalLanguage,
  nameHandlingFor,
  resolveModelFamily,
  resolveNegative,
  samplerFor,
} from "../sd-prompt.js";
import { expandPrompt } from "../bible-injection.js";
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
    const checkpoints = data.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
    // Also surface diffusion-only models (Flux.2 / UNET-only Flux.1) so they appear in the
    // picker and route to the separate-component graph. Best-effort: ignore if absent.
    const unets = await this.enumValues("UNETLoader", "unet_name");
    const seen = new Set(checkpoints.map((n) => n.toLowerCase()));
    const names = [...checkpoints];
    for (const u of unets) {
      if (!seen.has(u.toLowerCase())) {
        seen.add(u.toLowerCase());
        names.push(u);
      }
    }
    return names.map((id) => ({ id, label: id, sizeGB: 0 }));
  }

  /** Read a node's required-input enum (e.g. UNETLoader.unet_name); [] if unavailable. */
  private async enumValues(node: string, key: string): Promise<string[]> {
    try {
      const res = await this.transport.send({ url: `${this.baseUrl}/object_info/${node}`, method: "GET" });
      if (!res.ok) return [];
      const data = (await res.json<Record<string, NodeSchema>>())[node];
      const enumVal = data?.input?.required?.[key];
      return Array.isArray(enumVal) && Array.isArray(enumVal[0]) ? (enumVal[0] as string[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Decide how a model must be loaded. SD1.5/SDXL are always all-in-one (no probe — keeps
   * the common path request-free). The natural-language families vary: Flux.1 fp8 ships
   * as an all-in-one checkpoint, while Flux.2 / Z-Image / Qwen-Image / UNET-only Flux.1
   * are diffusion-only — so for those families, ask ComfyUI which list the file is
   * actually in. A file in neither list defaults by family: Flux.1 → "checkpoint",
   * the rest → "diffusion" (their only distribution).
   */
  private async resolveLoadKind(
    model: string,
    family: ModelFamily,
  ): Promise<"checkpoint" | "diffusion"> {
    if (!isNaturalLanguage(family)) return "checkpoint";
    const checkpoints = new Set(
      (await this.enumValues("CheckpointLoaderSimple", "ckpt_name")).map((n) => n.toLowerCase()),
    );
    if (checkpoints.has(model.toLowerCase())) return "checkpoint";
    const unets = new Set((await this.enumValues("UNETLoader", "unet_name")).map((n) => n.toLowerCase()));
    if (unets.has(model.toLowerCase())) return "diffusion";
    return family === "flux" ? "checkpoint" : "diffusion";
  }

  /**
   * Resolve the text encoder + VAE for a separate-component model, accepting same-family
   * VARIANTS so a differently-named/quantised file still runs. Resolution order per
   * component: exact catalog filename → variant by stem (ignoring fp8/fp16/Q4… + extension)
   * → family heuristic (encoder by CLIP-type regex, VAE by name hints). Families: Flux.1
   * (UNET-only) uses DualCLIPLoader (t5xxl + clip_l, type "flux"); Flux.2 a Mistral-3/Qwen-3
   * encoder (type "flux2"); Z-Image a Qwen-3 encoder (type "lumina2"); Qwen-Image a
   * Qwen-2.5-VL encoder (type "qwen_image"). Throws an actionable error when nothing
   * compatible is installed, instead of letting the graph fail cryptically.
   */
  private async resolveComponents(family: ModelFamily, model: string): Promise<DiffusionComponents> {
    const vaes = await this.enumValues("VAELoader", "vae_name");

    // Flux.1 UNET-only (not a split-file catalog family): DualCLIPLoader (t5xxl + clip_l).
    if (family !== "flux2" && family !== "zimage" && family !== "qwenimage") {
      const clips = await this.enumValues("DualCLIPLoader", "clip_name1");
      const t5 = clips.find((c) => /t5/i.test(c));
      const clipL = clips.find((c) => /clip[_-]?l/i.test(c)) ?? clips.find((c) => /clip/i.test(c) && !/t5/i.test(c));
      const vae = pickComponentAsset(vaes, undefined, [], ["ae", "flux"]);
      if (!t5 || !clipL || !vae) {
        throw new Error(
          "This Flux model is diffusion-only and needs t5xxl + clip_l text encoders and the " +
            "Flux VAE (ae.safetensors) installed in ComfyUI, or use an all-in-one Flux checkpoint.",
        );
      }
      return {
        textEncoder: { class_type: "DualCLIPLoader", inputs: { clip_name1: t5, clip_name2: clipL, type: "flux" } },
        vaeName: vae,
        weightDtype: "default",
      };
    }

    // Split-file families. The catalog entry (when the chosen model is one) supplies the
    // exact wanted filenames + CLIPLoader `type`; otherwise the family heuristic does.
    const clips = await this.enumValues("CLIPLoader", "clip_name");
    const entry = catalogEntryForModel(model);
    const wantedEncoder = entry?.files?.find((f) => f.folder === "text_encoders")?.filename;
    const wantedVae = entry?.files?.find((f) => f.folder === "vae")?.filename;
    const h = SPLIT_FILE_HEURISTICS[family]!;
    const clipType = entry?.clipType ?? h.type;
    const encoder = pickComponentAsset(clips, wantedEncoder, [h.clip], []);
    const vae = pickComponentAsset(vaes, wantedVae, [], h.vae);
    if (!encoder || !vae) {
      const what = entry?.label ?? h.what;
      const hint = [
        ...(encoder ? [] : [`a text encoder${wantedEncoder ? ` like ${wantedEncoder}` : ""} (models/text_encoders)`]),
        ...(vae ? [] : [`a VAE${wantedVae ? ` like ${wantedVae}` : ""} (models/vae)`]),
      ].join(" and ");
      throw new Error(
        `${what} needs ${hint} installed in ComfyUI (a same-family variant filename is fine). ` +
          "Use the Download button in Settings → Local model to fetch all its files, or pick an " +
          "all-in-one SD/SDXL checkpoint. (If you just added the files, restart the engine.)",
      );
    }
    return {
      textEncoder: { class_type: "CLIPLoader", inputs: { clip_name: encoder, type: clipType } },
      vaeName: vae,
      weightDtype: "default",
    };
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
    const seed = input.seed ?? input.anchors[0]?.seed ?? Math.floor(Math.random() * 1_000_000_000);

    // Style checkpoint override (only when that checkpoint is installed).
    let checkpoint = model;
    if (input.styleCheckpoint) {
      const installed = new Set((await this.listModels()).map((m) => m.id));
      const resolved = resolveAssetName(installed, input.styleCheckpoint);
      if (resolved) checkpoint = resolved;
    }

    // Resolve the model family and how it should be sampled/loaded. A catalog
    // entry's own sampler settings win over the family defaults (e.g. Flux.2 Klein
    // base needs real CFG 5, unlike guidance-distilled Flux.2-dev). Natural-language
    // models ignore the quality-profile step count (more steps don't help).
    const family = resolveModelFamily(input.modelFamily, checkpoint);
    const sampler = catalogEntryForModel(checkpoint)?.sampler ?? samplerFor(family);
    const steps = isNaturalLanguage(family)
      ? sampler.steps
      : (input.steps ?? (input.quality === "sketch" ? 6 : input.quality === "standard" ? 20 : 35));
    const { width, height } = clampResolution(family, input.width ?? 1024, input.height ?? 1024);

    // Expand bible terms per the target's text-encoder grade: CLIP/T5 (SD/Flux.1) inject
    // descriptors in place; LLM-grade (Flux.2/Mistral) keep names + a reference block. Then
    // SD families get quality tags + a real negative; Flux gets natural language and none.
    const expanded = expandPrompt(
      input.prompt,
      input.terms ?? [],
      nameHandlingFor(family),
      input.worldStyle,
      input.bookTitle,
    );
    let prompt = composeSdPositive(family, expanded, input.subjects);
    const negative = resolveNegative(family, input.negativePrompt);
    // Flux.2 (and any UNET-only diffusion file) can't load via CheckpointLoaderSimple —
    // it needs a separate text-encoder + VAE; pick the load kind once here.
    const loadKind = await this.resolveLoadKind(checkpoint, family);

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

    // For a separate-component model (Flux.2 / Z-Image / Qwen-Image / UNET-only
    // Flux.1), resolve the text encoder + VAE (catalog-first, else discovered from
    // the engine); if they're missing, fail with an actionable message instead of
    // the cryptic "clip input is invalid: None".
    const components =
      loadKind === "diffusion" ? await this.resolveComponents(family, checkpoint) : undefined;

    const workflow = buildWorkflow({
      model: checkpoint,
      prompt,
      negative,
      seed,
      steps,
      width,
      height,
      family,
      sampler,
      loadKind,
      ...(components ? { components } : {}),
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
    // Cancellation (user paused images): abort the in-flight HTTP AND tell ComfyUI to
    // interrupt the running job so the GPU frees immediately, not after it finishes.
    const signal = input.signal;
    const onAbort = (): void => {
      void this.interrupt();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Filter websocket progress to THIS job's prompt_id (the clientId is shared across
    // concurrent renders, so unfiltered we'd receive a sibling render's progress and could
    // keep a genuinely-stalled job's idle timer alive). Set once submit returns the id.
    const job: { promptId?: string } = {};
    const socket = this.openProgressSocket(relay, job);
    try {
      const submit = await this.transport.send({
        url: `${this.baseUrl}/prompt`,
        method: "POST",
        body: { prompt: workflow, client_id: this.clientId },
        ...(signal ? { signal } : {}),
      });
      if (!submit.ok) throw new Error(`ComfyUI prompt failed with status ${submit.status}`);
      const { prompt_id } = await submit.json<PromptResponse>();
      job.promptId = prompt_id;

      const image = await this.pollForImage(prompt_id, progress, signal);
      const view = await this.transport.send({
        url:
          `${this.baseUrl}/view?filename=${encodeURIComponent(image.filename)}` +
          `&subfolder=${encodeURIComponent(image.subfolder)}&type=${encodeURIComponent(image.type)}`,
        method: "GET",
        ...(signal ? { signal } : {}),
      });
      if (!view.ok) throw new Error(`ComfyUI view failed with status ${view.status}`);
      input.onProgress?.(1);
      return { bytes: await view.arrayBuffer(), mimeType: "image/png" };
    } finally {
      socket?.close();
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Tell ComfyUI to interrupt the running job (best-effort; ignores errors). */
  private async interrupt(): Promise<void> {
    try {
      await this.transport.send({ url: `${this.baseUrl}/interrupt`, method: "POST", body: {} });
    } catch {
      /* best-effort — the HTTP abort already stopped us waiting */
    }
  }

  /**
   * Open a websocket to ComfyUI and forward per-step sampling progress (0..1) to
   * `onProgress`. Returns a closer, or undefined where WebSocket isn't available
   * (Node/tests) — progress is always optional, never required for correctness.
   */
  private openProgressSocket(
    onProgress: (fraction: number) => void,
    job: { promptId?: string },
  ): { close: () => void } | undefined {
    if (typeof WebSocket === "undefined") return undefined;
    try {
      const wsUrl =
        this.baseUrl.replace(/^http/, "ws") + `/ws?clientId=${encodeURIComponent(this.clientId)}`;
      const ws = new WebSocket(wsUrl);
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== "string") return; // binary frames are preview images
        try {
          const msg = JSON.parse(ev.data) as {
            type?: string;
            data?: { value?: number; max?: number; prompt_id?: string };
          };
          // Ignore another concurrent render's progress (shared clientId).
          if (msg.data?.prompt_id && job.promptId && msg.data.prompt_id !== job.promptId) return;
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
    signal?: AbortSignal,
  ): Promise<HistoryImage> {
    // Two stop conditions: an absolute backstop (`maxPolls`) used when no progress
    // info is available, and — once the websocket has reported ANY progress — an
    // idle window: keep polling indefinitely while ComfyUI is still working, only
    // failing after `idleTimeoutMs` of silence. So a slow render is never killed.
    for (let i = 0; ; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const res = await this.transport.send({
        url: `${this.baseUrl}/history/${encodeURIComponent(promptId)}`,
        method: "GET",
        ...(signal ? { signal } : {}),
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

/** Loaders + filenames for a separate-component (Flux.2 / UNET-only) model. */
interface DiffusionComponents {
  /** Text-encoder loader node (DualCLIPLoader for Flux.1; a single CLIPLoader for Flux.2). */
  textEncoder: { class_type: string; inputs: Record<string, unknown> };
  /** VAE filename for VAELoader. */
  vaeName: string;
  /** UNETLoader weight dtype, e.g. "default" / "fp8_e4m3fn". */
  weightDtype: string;
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
  family: ModelFamily;
  sampler: SamplerSettings;
  /** "checkpoint" = all-in-one CheckpointLoaderSimple; "diffusion" = UNET + encoder + VAE. */
  loadKind: "checkpoint" | "diffusion";
  /** Required when loadKind === "diffusion". */
  components?: DiffusionComponents;
  /** Optional style LoRA, inserted as a LoraLoader between checkpoint and sampler. */
  lora?: { name: string; strength: number };
  /** Optional IP-Adapter conditioning (character reference images). */
  ipAdapter?: IpAdapterGraph;
}

/**
 * txt2img ComfyUI graph. Two shapes:
 *  - **checkpoint:** CheckpointLoaderSimple → [LoRA] → [IP-Adapter] → sampler → VAE → save
 *    (SD / Flux.1 all-in-one).
 *  - **diffusion:** UNETLoader + text-encoder loader + VAELoader → sampler → save
 *    (Flux.2, and any UNET-only Flux.1 file — fixes "clip input is invalid: None").
 * Flux families also get a FluxGuidance node (embedded guidance) with KSampler cfg=1.
 */
function buildWorkflow(p: WorkflowParams): Record<string, unknown> {
  const diffusion = p.loadKind === "diffusion";
  // Source refs for model / clip / vae, depending on the load shape. LoRA (an SD-style
  // feature) is only wired into the checkpoint path.
  const modelRef: [string, number] = diffusion ? ["4", 0] : p.lora ? ["10", 0] : ["4", 0];
  const clipRef: [string, number] = diffusion ? ["12", 0] : p.lora ? ["10", 1] : ["4", 1];
  const vaeRef: [string, number] = diffusion ? ["13", 0] : ["4", 2];
  // Positive conditioning: Flux routes through a FluxGuidance node ("14").
  const positiveRef: [string, number] = p.sampler.guidance !== undefined ? ["14", 0] : ["6", 0];
  const graph: Record<string, unknown> = {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.sampler.cfg,
        sampler_name: p.sampler.sampler,
        scheduler: p.sampler.scheduler,
        denoise: 1,
        model: modelRef,
        positive: positiveRef,
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: p.width, height: p.height, batch_size: 1 },
    },
    "6": { class_type: "CLIPTextEncode", inputs: { text: p.prompt, clip: clipRef } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: p.negative, clip: clipRef } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: vaeRef } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "visual-reader", images: ["8", 0] } },
  };
  if (diffusion) {
    const c = p.components!;
    // Separate-component loaders (Flux.2 / UNET-only Flux.1).
    graph["4"] = { class_type: "UNETLoader", inputs: { unet_name: p.model, weight_dtype: c.weightDtype } };
    graph["12"] = c.textEncoder;
    graph["13"] = { class_type: "VAELoader", inputs: { vae_name: c.vaeName } };
  } else {
    graph["4"] = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: p.model } };
  }
  if (p.sampler.guidance !== undefined) {
    // Flux embedded guidance — conditioning passes through FluxGuidance before the sampler.
    graph["14"] = {
      class_type: "FluxGuidance",
      inputs: { conditioning: ["6", 0], guidance: p.sampler.guidance },
    };
  }
  if (p.lora && !diffusion) {
    // LoRA is an SD-style feature wired into the all-in-one checkpoint path only (a
    // UNETLoader has no clip output to thread through).
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
  if (p.sampler.shift !== undefined) {
    // Z-Image / Qwen-Image sigma shift — wrap whatever model ref feeds the sampler.
    const ks = graph["3"] as { inputs: Record<string, unknown> };
    graph["15"] = {
      class_type: "ModelSamplingAuraFlow",
      inputs: { shift: p.sampler.shift, model: ks.inputs.model },
    };
    ks.inputs.model = ["15", 0];
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
    // STANDARD (not "PLUS (high strength)") so the reference guides identity without
    // overpowering the composition the prompt describes.
    inputs: { model: baseModel, preset: "STANDARD" },
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
        // End IP-Adapter partway so early diffusion steps establish the scene/action
        // composition; identity is refined after, not dictated from step 0 (no portrait).
        end_at: 0.55,
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

/** Per-family encoder/VAE matching for split-file models (Flux.2 / Z-Image / Qwen-Image).
 * `clip` matches the text-encoder name; `vae` are VAE name-substring hints; `type` is the
 * CLIPLoader type; `what` names it in errors. Flux.2-dev ships a Mistral-3 encoder, Klein
 * a Qwen-3 one — both accepted. */
export const SPLIT_FILE_HEURISTICS: Record<
  string,
  { clip: RegExp; vae: string[]; type: string; what: string }
> = {
  flux2: { clip: /mistral|flux.?2|qwen.?3/i, vae: ["flux2", "flux.2", "flux", "encoder"], type: "flux2", what: "Flux.2" },
  zimage: { clip: /qwen.?3|qwen/i, vae: ["ae.", "z_image", "z-image"], type: "lumina2", what: "Z-Image" },
  qwenimage: { clip: /qwen.?2\.5|qwen.*vl|qwen/i, vae: ["qwen"], type: "qwen_image", what: "Qwen-Image" },
};

/**
 * The model "stem": filename minus its extension and trailing precision/quant qualifiers
 * (fp8, fp16, bf16, Q4_K_M, e4m3fn, mixed, scaled, gguf, pruned, emaonly…), separators
 * normalised. So `qwen_3_8b_fp8mixed.safetensors` and `qwen_3_8b.safetensors` share the
 * stem `qwen-3-8b` — i.e. they're recognised as the SAME component in a different variant.
 */
export function assetStem(name: string): string {
  let s = name.toLowerCase().replace(/\.(safetensors|ckpt|pt|gguf|bin|sft|pth)$/i, "");
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s.replace(/[._-](fp\d+\w*|bf\d+\w*|f\d+|q\d+\w*|k[_-]?[ms]|int\d+|e\dm\d\w*|gguf|mixed|scaled|pruned|emaonly|fixed)$/i, "");
  }
  return s.replace(/[._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Pick an installed file for a component, tolerating same-family variants:
 *   1. exact wanted filename (case-insensitive)
 *   2. a variant with the same stem (different quant/precision/naming)
 *   3. a family pattern (e.g. the encoder's CLIP-type regex)
 *   4. a name-substring hint (e.g. the VAE hints)
 * Returns undefined when nothing compatible is installed.
 */
export function pickComponentAsset(
  available: readonly string[],
  wantedExact: string | undefined,
  patterns: readonly RegExp[] = [],
  hints: readonly string[] = [],
): string | undefined {
  if (wantedExact) {
    const w = wantedExact.toLowerCase();
    const exact = available.find((a) => a.toLowerCase() === w);
    if (exact) return exact;
    const ws = assetStem(wantedExact);
    const stemMatch = available.find((a) => {
      const s = assetStem(a);
      return s === ws || s.startsWith(`${ws}-`) || ws.startsWith(`${s}-`);
    });
    if (stemMatch) return stemMatch;
  }
  for (const re of patterns) {
    const m = available.find((a) => re.test(a));
    if (m) return m;
  }
  if (hints.length) {
    const hit = available.find((a) => hints.some((h) => a.toLowerCase().includes(h)));
    if (hit) return hit;
  }
  return undefined;
}
