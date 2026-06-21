import { DirectTransport, type Transport } from "../../transport/transport.js";
import { catalogEntryForModel } from "../../catalog.js";
import { scaleSteps } from "../../../quality.js";
import type { ImageGenerationInput, ImageGenerationOutput } from "../image-provider.js";
import {
  type ModelFamily,
  type SamplerSettings,
  HIRES_DENOISE,
  clampResolution,
  composeSdPositive,
  hiresTarget,
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
  /** Sustained-outage backstop: fail only after ComfyUI is UNREACHABLE for this long (it likely
   * crashed). A slow-but-working render is never failed — only the reader's cancel stops it. */
  idleTimeoutMs?: number;
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
  {
    outputs?: Record<string, { images?: HistoryImage[] }>;
    /** Execution status; `messages` carries an `execution_error` with the real cause. */
    status?: {
      status_str?: string;
      messages?: [string, Record<string, unknown>][];
    };
  }
>;

export class ComfyUIBackend implements LocalEngineBackend {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly clientId: string;
  private readonly pollIntervalMs: number;
  private readonly idleTimeoutMs: number;
  private lorasCache?: Promise<Set<string>>;
  private ipAdapterCache?: Promise<IpAdapterCaps | null>;
  private warnedNoIpAdapter = false;
  /**
   * `/object_info/<node>` responses per node. Installed files are stable for an
   * engine session (the same assumption as `lorasCache`; a Settings reconnect
   * builds a fresh backend), but resolving a render's load kind + components was
   * re-fetching the same enums 2–5× per image. Failures are evicted so a
   * transient error doesn't stick for the session.
   */
  private readonly nodeInfoCache = new Map<string, Promise<NodeSchema | undefined>>();
  /**
   * Uploaded-reference filenames per byte buffer. The pipeline hands the SAME
   * buffers to every render, but each render re-POSTed the photos under
   * seed-unique names — pure upload waste plus unbounded growth of ComfyUI's
   * input folder. WeakMap: dropped with the buffers, never serves stale bytes.
   */
  private readonly uploadedRefs = new WeakMap<ArrayBuffer, Promise<string>>();
  private uploadCounter = 0;

  constructor(opts: ComfyUIBackendOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.transport = opts.transport ?? new DirectTransport();
    this.clientId = opts.clientId ?? "visual-reader";
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 180000; // 3 min of ComfyUI being UNREACHABLE
  }

  async listModels(): Promise<LocalModelDescriptor[]> {
    const info = await this.nodeInfo("CheckpointLoaderSimple");
    if (!info) throw new Error("ComfyUI listModels failed (couldn't read /object_info)");
    const ckpt = info.input?.required?.["ckpt_name"];
    const checkpoints = Array.isArray(ckpt) && Array.isArray(ckpt[0]) ? (ckpt[0] as string[]) : [];
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

  /**
   * The separate text-encoder + VAE files ComfyUI has on disk — for the Settings dropdowns +
   * the model-aware suggestion. Text encoders are the union of the single CLIPLoader
   * (`clip_name`, used by Flux.2 / Z-Image / Qwen-Image) and the DualCLIPLoader
   * (`clip_name1`, used by UNET-only Flux.1), deduped case-insensitively. Best-effort:
   * a node ComfyUI doesn't expose just contributes nothing.
   */
  async listComponents(): Promise<{ textEncoders: string[]; vaes: string[] }> {
    const [clip, dualClip, vaes] = await Promise.all([
      this.enumValues("CLIPLoader", "clip_name"),
      this.enumValues("DualCLIPLoader", "clip_name1"),
      this.enumValues("VAELoader", "vae_name"),
    ]);
    const seen = new Set<string>();
    const textEncoders: string[] = [];
    for (const name of [...clip, ...dualClip]) {
      const k = name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      textEncoders.push(name);
    }
    return { textEncoders, vaes };
  }

  /** A node's `/object_info` schema, cached per session (failures evicted). */
  private nodeInfo(node: string): Promise<NodeSchema | undefined> {
    const cached = this.nodeInfoCache.get(node);
    if (cached) return cached;
    const p = (async (): Promise<NodeSchema | undefined> => {
      try {
        const res = await this.transport.send({ url: `${this.baseUrl}/object_info/${node}`, method: "GET" });
        if (!res.ok) return undefined;
        return (await res.json<Record<string, NodeSchema>>())[node];
      } catch {
        return undefined;
      }
    })();
    this.nodeInfoCache.set(node, p);
    void p.then((info) => {
      if (info === undefined) this.nodeInfoCache.delete(node);
    });
    return p;
  }

  /** Read a node's required-input enum (e.g. UNETLoader.unet_name); [] if unavailable. */
  private async enumValues(node: string, key: string): Promise<string[]> {
    const data = await this.nodeInfo(node);
    const enumVal = data?.input?.required?.[key];
    return Array.isArray(enumVal) && Array.isArray(enumVal[0]) ? (enumVal[0] as string[]) : [];
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
  private async resolveComponents(
    family: ModelFamily,
    model: string,
    overrides?: { textEncoder?: string; vae?: string },
    lowVram?: boolean,
  ): Promise<DiffusionComponents> {
    const vaes = await this.enumValues("VAELoader", "vae_name");

    // HiDream: FOUR text encoders (clip_l + clip_g + t5xxl + llama_3.1_8b) bundled by a
    // single QuadrupleCLIPLoader, plus the Flux VAE (ae.safetensors). Each slot is resolved
    // catalog-first then by name pattern, tolerating same-family variant filenames — like
    // the other split-file families, just across all four encoder slots at once.
    if (family === "hidream") {
      // QuadrupleCLIPLoader's slots draw from the text_encoders folder, same as CLIPLoader;
      // union both enums so detection works whichever node ComfyUI advertises.
      const clips = [
        ...(await this.enumValues("QuadrupleCLIPLoader", "clip_name1")),
        ...(await this.enumValues("CLIPLoader", "clip_name")),
      ];
      const entry = catalogEntryForModel(model);
      const teWanted = (entry?.files ?? [])
        .filter((f) => f.folder === "text_encoders")
        .map((f) => f.filename);
      const wantBy = (re: RegExp): string | undefined => teWanted.find((f) => re.test(f));
      const clipL = pickComponentAsset(clips, wantBy(/clip[_-]?l/i), [/clip[_-]?l/i]);
      const clipG = pickComponentAsset(clips, wantBy(/clip[_-]?g/i), [/clip[_-]?g/i]);
      const t5 = pickComponentAsset(clips, wantBy(/t5/i), [/t5/i]);
      const llama = pickComponentAsset(clips, wantBy(/llama/i), [/llama/i]);
      const wantedVae = entry?.files?.find((f) => f.folder === "vae")?.filename;
      const vae = pickComponentAsset(vaes, overrides?.vae ?? wantedVae, [], ["ae", "flux"]);
      if (!clipL || !clipG || !t5 || !llama || !vae) {
        const missing = [
          ...(clipL ? [] : ["clip_l"]),
          ...(clipG ? [] : ["clip_g"]),
          ...(t5 ? [] : ["t5xxl"]),
          ...(llama ? [] : ["llama_3.1_8b_instruct"]),
          ...(vae ? [] : ["the Flux VAE (ae.safetensors)"]),
        ].join(", ");
        throw new Error(
          "HiDream needs four text encoders (clip_l, clip_g, t5xxl, llama_3.1_8b_instruct) in " +
            `models/text_encoders and the Flux VAE (ae.safetensors) in models/vae — missing: ${missing}. ` +
            "Use the Download button in Settings → Local model to fetch all of HiDream's files, or pick " +
            "an all-in-one SD/SDXL checkpoint. (If you just added the files, restart the engine.)",
        );
      }
      // Diagnostic: the EXACT four files we hand QuadrupleCLIPLoader (clip_name1..4) + the VAE,
      // so a "wrong pooled size" can be traced to a mis-picked/duplicate encoder at a glance.
      console.info(
        `[visual-reader] HiDream QuadrupleCLIPLoader → clip_l=${clipL} clip_g=${clipG} ` +
          `t5xxl=${t5} llama=${llama} vae=${vae}`,
      );
      return {
        textEncoder: {
          class_type: "QuadrupleCLIPLoader",
          inputs: { clip_name1: clipL, clip_name2: clipG, clip_name3: t5, clip_name4: llama },
        },
        vaeName: vae,
        // Low-VRAM: load the 17B UNET in fp8 (≈half the diffusion weights). The big T5 +
        // Llama encoders are shrunk by the engine's --lowvram offloading (no dtype input here).
        weightDtype: lowVram ? "fp8_e4m3fn" : "default",
      };
    }

    // Flux.1 UNET-only (not a split-file catalog family): DualCLIPLoader (t5xxl + clip_l).
    if (family !== "flux2" && family !== "zimage" && family !== "qwenimage") {
      const clips = await this.enumValues("DualCLIPLoader", "clip_name1");
      const t5 = clips.find((c) => /t5/i.test(c));
      const clipL = clips.find((c) => /clip[_-]?l/i.test(c)) ?? clips.find((c) => /clip/i.test(c) && !/t5/i.test(c));
      // A manual VAE override wins (a UNET-only Flux.1 has two encoders, so we don't
      // override those — pick an all-in-one checkpoint if auto-detection is wrong there).
      const vae = pickComponentAsset(vaes, overrides?.vae, [], ["ae", "flux"]);
      if (!t5 || !clipL || !vae) {
        throw new Error(
          "This Flux model is diffusion-only and needs t5xxl + clip_l text encoders and the " +
            "Flux VAE (ae.safetensors) installed in ComfyUI, or use an all-in-one Flux checkpoint.",
        );
      }
      return {
        textEncoder: { class_type: "DualCLIPLoader", inputs: { clip_name1: t5, clip_name2: clipL, type: "flux" } },
        vaeName: vae,
        weightDtype: lowVram ? "fp8_e4m3fn" : "default",
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
    // Flux.2 has TWO encoder families that aren't interchangeable: dev uses Mistral-Small,
    // Klein uses Qwen-3-8B (a mismatch → "shapes cannot be multiplied"). Order the patterns
    // by the diffusion model's name so the right one is auto-picked when both are installed.
    const encoderPatterns = family === "flux2" ? flux2EncoderPatterns(model) : [h.clip];
    // A manual override (the user picked the exact file) takes precedence over the
    // catalog's wanted name; the family pattern/hints still backstop a near miss.
    const encoder = pickComponentAsset(clips, overrides?.textEncoder ?? wantedEncoder, encoderPatterns, []);
    const vae = pickComponentAsset(vaes, overrides?.vae ?? wantedVae, [], h.vae);
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
      // Low-VRAM: load the UNET in fp8 (≈half the diffusion weights in VRAM). The big
      // text encoder (Qwen-3/T5/Mistral) is shrunk by the engine's --lowvram offloading,
      // not here (CLIPLoader has no dtype input). Only applies to UNETLoader families.
      weightDtype: lowVram ? "fp8_e4m3fn" : "default",
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

  /** The reference's uploaded name — uploading at most once per buffer per session.
   * (ComfyUI suffixes a clashing name and returns the stored one, which we use.) */
  private uploadedReference(bytes: ArrayBuffer, mimeType: string): Promise<string> {
    const cached = this.uploadedRefs.get(bytes);
    if (cached) return cached;
    const p = this.uploadReference(bytes, mimeType, `vr-ref-${Date.now()}-${this.uploadCounter++}.png`);
    this.uploadedRefs.set(bytes, p);
    // A failed upload must not pin the failure for the rest of the session.
    p.catch(() => this.uploadedRefs.delete(bytes));
    return p;
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
    const baseSampler = catalogEntryForModel(checkpoint)?.sampler ?? samplerFor(family);
    // Steps: distilled few-step models (turbo) never scale — extra steps hurt them.
    // Natural-language families scale their recommended count by the quality level;
    // SD families follow the profile step ladder. A manual override wins for EVERY family.
    const recommended = baseSampler.steps;
    const level = input.renderQuality ?? "standard";
    let steps =
      recommended <= 10
        ? recommended
        : isNaturalLanguage(family)
          ? scaleSteps(recommended, level)
          : (input.steps ?? (input.quality === "sketch" ? 6 : input.quality === "standard" ? 20 : 35));
    if (input.stepsOverride && input.stepsOverride > 0) steps = Math.round(input.stepsOverride);
    // CFG override: for guidance-distilled Flux the tunable knob is the embedded GUIDANCE
    // value (KSampler cfg stays 1); for everything else it's the real CFG scale.
    let sampler =
      input.cfgOverride !== undefined && input.cfgOverride >= 0
        ? baseSampler.guidance !== undefined
          ? { ...baseSampler, guidance: input.cfgOverride }
          : { ...baseSampler, cfg: input.cfgOverride }
        : baseSampler;
    // Advanced sampler/scheduler overrides (blank = keep the family/catalog default).
    if (input.localSampler) sampler = { ...sampler, sampler: input.localSampler };
    if (input.localScheduler) sampler = { ...sampler, scheduler: input.localScheduler };
    const { width, height } = clampResolution(family, input.width ?? 1024, input.height ?? 1024);
    // Hi-Res two-pass: keep the FIRST pass at the native-safe size (single coherent
    // subject), then upscale the latent toward ~2× / the hires ceiling and refine. Skipped
    // when the native size already meets the ceiling (hiresTarget → null = single pass).
    const hires =
      input.hires === true
        ? (() => {
            const target = hiresTarget(family, input.width ?? 1024, input.height ?? 1024);
            return target ? { width: target.width, height: target.height, denoise: HIRES_DENOISE } : undefined;
          })()
        : undefined;

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
    let prompt = composeSdPositive(family, expanded);
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
          // Cached per buffer (uploaded once per session) and fetched in parallel
          // on a miss; `map` keeps the refs in their original order.
          const refs = await Promise.all(
            input.ipAdapterRefs.map(async (ref) => ({
              filename: await this.uploadedReference(ref.bytes, ref.mimeType),
              weight: ref.weight,
            })),
          );
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
      loadKind === "diffusion"
        ? await this.resolveComponents(
            family,
            checkpoint,
            {
              ...(input.textEncoder ? { textEncoder: input.textEncoder } : {}),
              ...(input.vae ? { vae: input.vae } : {}),
            },
            input.lowVram,
          )
        : undefined;

    // img2img: upload the base photo (reuses the per-session reference cache) and
    // denoise from it. Clamp the strength to a sane working band.
    let initImage: { filename: string; denoise: number } | undefined;
    if (input.initImage) {
      try {
        const filename = await this.uploadedReference(input.initImage.bytes, input.initImage.mimeType);
        const denoise = Math.min(1, Math.max(0.05, input.denoise ?? 0.65));
        initImage = { filename, denoise };
      } catch {
        initImage = undefined; // upload failed → fall back to txt2img
      }
    }

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
      ...(initImage ? { initImage } : {}),
      ...(hires ? { hires } : {}),
    });

    // Best-effort live progress: ComfyUI broadcasts per-step `progress` messages
    // over its websocket to the client with our clientId. Open it *before*
    // submitting so we don't miss early steps. We also use it to keep the render
    // alive: as long as ComfyUI reports progress we never time out (a slow-but-
    // working render must not be killed). Completion + image come from /history
    // polling below (a no-op socket in tests / where WebSocket is unavailable).
    const relay = (fraction: number): void => input.onProgress?.(fraction);
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

      const image = await this.pollForImage(prompt_id, signal, family);
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
    signal?: AbortSignal,
    family?: ModelFamily,
  ): Promise<HistoryImage> {
    // A render is NEVER timed out for being slow — only the reader's cancel (the abort signal)
    // stops a live job. We poll /history for the result, and treat the prompt as alive as long as
    // ComfyUI still lists it in its QUEUE (running or pending). A render under heavy VRAM pressure
    // can sit queued/sampling for many minutes; the old fixed timeout would give up while ComfyUI
    // kept working, then never collect the finished image — exactly the bug this fixes. The only
    // genuine failures: the reader cancels, ComfyUI is unreachable for a sustained window, or the
    // prompt vanishes from BOTH history and the queue (ComfyUI dropped it).
    let unreachableSinceMs = 0; // 0 = reachable; else the ms it first failed
    let lostPolls = 0; // consecutive polls where the prompt is in neither history nor the queue
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      let history: HistoryResponse;
      try {
        const res = await this.transport.send({
          url: `${this.baseUrl}/history/${encodeURIComponent(promptId)}`,
          method: "GET",
          ...(signal ? { signal } : {}),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        history = await res.json<HistoryResponse>();
        unreachableSinceMs = 0;
      } catch (err) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        // Transient blip vs sustained outage: tolerate hiccups, fail only after idleTimeoutMs of
        // ComfyUI being unreachable (it likely crashed) — not because a render is slow.
        if (unreachableSinceMs === 0) unreachableSinceMs = Date.now();
        if (Date.now() - unreachableSinceMs > this.idleTimeoutMs) {
          throw new Error(`ComfyUI became unreachable during the render (${err instanceof Error ? err.message : String(err)})`);
        }
        await delay(this.pollIntervalMs);
        continue;
      }
      const entry = history[promptId];
      if (entry) {
        const images = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? []);
        const first = images[0];
        if (first) return first;
        // Finished but no image: surface ComfyUI's REAL execution error (otherwise it's a mystery).
        throw new Error(comfyExecutionError(entry.status, family) ?? "ComfyUI finished but produced no image");
      }
      // Not done yet — still queued/running in ComfyUI? Then keep waiting, however long it takes.
      if (await this.isPromptQueued(promptId, signal)) {
        lostPolls = 0;
      } else {
        // In neither history nor queue: usually the brief hand-off as it finishes (history catches
        // up next poll); only fail if it stays missing past a short grace window.
        lostPolls++;
        if (lostPolls > LOST_GRACE_POLLS) {
          throw new Error("ComfyUI dropped the render (it left the queue without producing an image)");
        }
      }
      await delay(this.pollIntervalMs);
    }
  }

  /** Whether ComfyUI still lists `promptId` in its queue (running or pending). On any read error,
   * assume alive — never fail a working render because the liveness check itself hiccuped. */
  private async isPromptQueued(promptId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await this.transport.send({
        url: `${this.baseUrl}/queue`,
        method: "GET",
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) return true;
      const q = await res.json<{ queue_running?: unknown[][]; queue_pending?: unknown[][] }>();
      const has = (list?: unknown[][]): boolean =>
        (list ?? []).some((e) => Array.isArray(e) && e[1] === promptId);
      return has(q.queue_running) || has(q.queue_pending);
    } catch {
      return true; // can't tell → don't kill a render that may still be running
    }
  }
}

/** Polls the prompt may be absent from BOTH history and the queue (the finishing hand-off) before
 * we conclude ComfyUI genuinely dropped it. At the 1s poll interval, ~8s of grace. */
const LOST_GRACE_POLLS = 8;

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
  /** img2img: an already-uploaded base image (LoadImage name) + denoise strength. */
  initImage?: { filename: string; denoise: number };
  /** Hi-Res two-pass: upscale the first pass's latent to this target size, then refine
   * at `denoise`. The first pass renders at `width`/`height` (the native-safe size). */
  hires?: { width: number; height: number; denoise: number };
}

/**
 * txt2img ComfyUI graph. Two shapes:
 *  - **checkpoint:** CheckpointLoaderSimple → [LoRA] → [IP-Adapter] → sampler → VAE → save
 *    (SD / Flux.1 all-in-one).
 *  - **diffusion:** UNETLoader + text-encoder loader + VAELoader → [LoRA] → sampler → save
 *    (Flux.2, and any UNET-only Flux.1 file — fixes "clip input is invalid: None").
 * Flux families also get a FluxGuidance node (embedded guidance) with KSampler cfg=1.
 *
 * A style LoRA threads through BOTH shapes: the checkpoint path uses LoraLoader (model +
 * clip); the diffusion path uses LoraLoaderModelOnly (a UNETLoader has no clip output), so
 * LoRAs apply to Flux.2 / Z-Image / Qwen-Image too — not just SD checkpoints.
 */
export function buildWorkflow(p: WorkflowParams): Record<string, unknown> {
  const diffusion = p.loadKind === "diffusion";
  // Source refs for model / clip / vae, depending on the load shape. A LoRA wraps the
  // model output: node "10" (LoraLoader) on the checkpoint path, "11" (LoraLoaderModelOnly)
  // on the diffusion path.
  const modelRef: [string, number] = diffusion
    ? p.lora
      ? ["11", 0]
      : ["4", 0]
    : p.lora
      ? ["10", 0]
      : ["4", 0];
  const clipRef: [string, number] = diffusion ? ["12", 0] : p.lora ? ["10", 1] : ["4", 1];
  const vaeRef: [string, number] = diffusion ? ["13", 0] : ["4", 2];
  // Positive conditioning: Flux routes through a FluxGuidance node ("14").
  const positiveRef: [string, number] = p.sampler.guidance !== undefined ? ["14", 0] : ["6", 0];
  // img2img: the sampler starts from the encoded photo's latent (node "16") and
  // denoises only partway (denoise < 1). txt2img starts from an empty latent ("5").
  const latentRef: [string, number] = p.initImage ? ["16", 0] : ["5", 0];
  // HiDream's QuadrupleCLIPLoader already bundles all four encoders; the plain CLIPTextEncode
  // reads the full pooled (clip_l 768 + clip_g 1280 = 2048) straight off that CLIP — exactly
  // like the official template. (We tried the specialised CLIPTextEncodeHiDream node, but it
  // emitted a 768-wide pooled — only clip_l — which the model's p_embedder rejects.)
  const isHiDream = p.family === "hidream";
  const graph: Record<string, unknown> = {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.sampler.cfg,
        sampler_name: p.sampler.sampler,
        scheduler: p.sampler.scheduler,
        denoise: p.initImage ? p.initImage.denoise : 1,
        model: modelRef,
        positive: positiveRef,
        negative: ["7", 0],
        latent_image: latentRef,
      },
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
  if (p.initImage) {
    // img2img: load the uploaded photo and encode it to the latent the sampler denoises from.
    graph["15"] = { class_type: "LoadImage", inputs: { image: p.initImage.filename } };
    graph["16"] = { class_type: "VAEEncode", inputs: { pixels: ["15", 0], vae: vaeRef } };
  } else {
    // HiDream uses the 16-channel SD3 latent (it shares the Flux VAE), matching the official
    // workflow; other families' EmptyLatentImage is channel-fixed by the sampler at run time.
    graph["5"] = {
      class_type: isHiDream ? "EmptySD3LatentImage" : "EmptyLatentImage",
      inputs: { width: p.width, height: p.height, batch_size: 1 },
    };
  }
  if (p.sampler.guidance !== undefined) {
    // Flux embedded guidance — conditioning passes through FluxGuidance before the sampler.
    graph["14"] = {
      class_type: "FluxGuidance",
      inputs: { conditioning: ["6", 0], guidance: p.sampler.guidance },
    };
  }
  if (p.lora) {
    if (diffusion) {
      // UNET-only models: model-only LoRA (no clip output to thread through). The
      // trigger words, if any, are already prepended to the prompt by the caller.
      graph["11"] = {
        class_type: "LoraLoaderModelOnly",
        inputs: { lora_name: p.lora.name, strength_model: p.lora.strength, model: ["4", 0] },
      };
    } else {
      // All-in-one checkpoint: standard LoRA over both model and clip.
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
    // Sigma shift — wrap whatever model ref currently feeds the sampler (UNET / LoRA /
    // IP-Adapter chain). HiDream uses a ModelSamplingSD3 node; Z-Image / Qwen-Image use
    // ModelSamplingAuraFlow. Node id "17" (not "15") so it never clobbers img2img's
    // LoadImage / VAEEncode at "15" / "16" when a shift family also denoises from a photo.
    const ks = graph["3"] as { inputs: Record<string, unknown> };
    graph["17"] = {
      class_type: p.family === "hidream" ? "ModelSamplingSD3" : "ModelSamplingAuraFlow",
      inputs: { shift: p.sampler.shift, model: ks.inputs.model },
    };
    ks.inputs.model = ["17", 0];
  }
  if (p.hires) {
    // Hi-Res two-pass. The first KSampler ("3") produced a latent at the native-safe size
    // (its model/conditioning are now fully resolved — LoRA / IP-Adapter / shift all applied
    // above). Upscale that latent to the target, then a SECOND KSampler ("19") refines it at
    // low denoise so the upscaled image gains real detail without re-deciding the composition
    // (which is what duplicates subjects when you sample large from scratch). VAEDecode then
    // reads the refined latent. Node ids 18/19 sit clear of img2img (15/16), shift (17), and
    // the IP-Adapter chain (20+).
    const ks = graph["3"] as { inputs: Record<string, unknown> };
    graph["18"] = {
      class_type: "LatentUpscale",
      inputs: {
        samples: ["3", 0],
        upscale_method: "nearest-exact",
        width: p.hires.width,
        height: p.hires.height,
        crop: "disabled",
      },
    };
    graph["19"] = {
      class_type: "KSampler",
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.sampler.cfg,
        sampler_name: p.sampler.sampler,
        scheduler: p.sampler.scheduler,
        denoise: p.hires.denoise,
        model: ks.inputs.model,
        positive: ks.inputs.positive,
        negative: ks.inputs.negative,
        latent_image: ["18", 0],
      },
    };
    (graph["8"] as { inputs: Record<string, unknown> }).inputs.samples = ["19", 0];
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

/**
 * Extract ComfyUI's real execution error from a history entry's status messages, and
 * translate the cryptic ones. The flagship case: a "mat1 and mat2 shapes cannot be
 * multiplied" inside the diffusion model means the TEXT ENCODER doesn't match the
 * model — Flux.2-dev needs the Mistral-Small encoder, Flux.2 Klein the Qwen-3-8B one —
 * so we say that instead of a linear-algebra dump. Returns undefined when the status
 * carries no error.
 */
export function comfyExecutionError(
  status: HistoryResponse[string]["status"],
  family?: ModelFamily,
): string | undefined {
  const errMsg = status?.messages?.find(([type]) => type === "execution_error")?.[1];
  const raw = typeof errMsg?.exception_message === "string" ? errMsg.exception_message : undefined;
  if (!raw) {
    return status?.status_str === "error" ? "ComfyUI reported an execution error." : undefined;
  }
  if (/shapes cannot be multiplied/i.test(raw)) {
    // HiDream loads FOUR encoders via QuadrupleCLIPLoader. A shape mismatch here is almost
    // always clip_g dropping out of the bundle: its 1280-wide pooled is missing, so the pooled
    // is 768 (clip_l only) where the model's p_embedder expects 2048 — NOT a Mistral encoder.
    if (family === "hidream") {
      return (
        "HiDream loaded clip_l but not clip_g, so its pooled text embedding is half the expected " +
        "size (768 vs 2048). ComfyUI didn't recognise the clip_g file in the QuadrupleCLIPLoader — " +
        "usually because the ComfyUI build is older than HiDream's long clip_l/clip_g (update ComfyUI), " +
        "or the clip_g file selected for HiDream isn't an actual clip_g. Check the clip_g (Settings → " +
        `Local model) and that ComfyUI is current. (ComfyUI: ${raw})`
      );
    }
    return (
      "The text encoder doesn't match this model. A split-file model needs its OWN encoder " +
      "(Flux.2-dev → Mistral-Small-3.1; Flux.2 Klein → Qwen-3-8B; Z-Image → Qwen-3-4B). Install " +
      "the matching one and pick it under Settings → Advanced: split-file components. " +
      `(ComfyUI: ${raw})`
    );
  }
  return `ComfyUI: ${raw}`;
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

/** Flux.2 encoder-name patterns ordered by the diffusion model's name: Klein → Qwen-3
 * first, dev/pro → Mistral first; otherwise the combined pattern. Picks the right one when
 * both a Mistral and a Qwen encoder are installed (they're NOT interchangeable). */
export function flux2EncoderPatterns(model: string): RegExp[] {
  const m = model.toLowerCase();
  const qwen = /qwen.?3/i;
  const mistral = /mistral/i;
  const both = SPLIT_FILE_HEURISTICS.flux2!.clip;
  if (/klein/.test(m)) return [qwen, mistral, both];
  if (/dev|pro/.test(m)) return [mistral, qwen, both];
  return [both];
}

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
