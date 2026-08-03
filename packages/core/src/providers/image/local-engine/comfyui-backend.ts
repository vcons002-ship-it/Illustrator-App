import { DirectTransport, type Transport, type TransportResponse } from "../../transport/transport.js";
import { catalogEntryForModel } from "../../catalog.js";
import { scaleSteps } from "../../../quality.js";
import type {
  ImageGenerationInput,
  ImageGenerationOutput,
  VideoGenerationInput,
  VideoGenerationOutput,
  VideoModelFiles,
  WanVideoFiles,
  Ltx2VideoFiles,
} from "../image-provider.js";
import { VIDEO_RENDER_DEFAULTS } from "../video-models.js";
import {
  type ModelFamily,
  type SamplerSettings,
  HIRES_DENOISE,
  clampResolution,
  composeSdPositive,
  hiresCeiling,
  hiresTarget,
  isNaturalLanguage,
  nameHandlingFor,
  resolveModelFamily,
  renderPromptRecord,
  resolveNegative,
  samplerFor,
} from "../sd-prompt.js";
import { expandPrompt } from "../bible-injection.js";
import { REGION_STRENGTH, regionPixels, type CastRegion } from "../regional-conditioning.js";
import type { LocalEngineBackend, LocalModelDescriptor } from "./backend.js";

/** Default Wan negative prompt — suppresses the common artifacts + a static (non-moving) result.
 * Exported so the long-video path can EXTEND it (a caller-supplied negative replaces it). */
export const WAN_DEFAULT_NEGATIVE =
  "blurry, low quality, jpeg artifacts, watermark, text, static, still image, frozen, deformed, distorted, extra limbs, bad hands";

interface WanI2VParams {
  /** The uploaded source-image filename (from /upload/image). Omit for text-to-video. */
  startImage?: string;
  /** The uploaded END-frame filename: the clip morphs from startImage to THIS (first+last-frame
   * conditioning via WanFirstLastFrameToVideo). Only honored alongside startImage. */
  endImage?: string;
  models: WanVideoFiles;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  steps: number;
  cfg: number;
  /** Sigma shift (Wan ~8 for video). */
  shift: number;
  seed: number;
}

interface Ltx2I2VParams {
  /** The uploaded source-image filename (from /upload/image). Omit for text-to-video. */
  startImage?: string;
  models: Ltx2VideoFiles;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  steps: number;
  cfg: number;
  seed: number;
  /** High-res two-stage (generate → 2× upscale → refine). False = single-stage at the target size. */
  highRes: boolean;
  /** Generate synchronized audio (faithful audio+video graph → mp4). False = silent video only. */
  audio: boolean;
}

/**
 * The native ComfyUI Wan2.2 14B image-to-video graph: a two-expert (high-noise → low-noise) KSamplerAdvanced
 * chain over the WanImageToVideo conditioning, decoded and saved as an animated WEBP (no custom nodes). Node
 * ids are in the 100s so they never collide with the image graph. The node names + model files mirror the
 * official Wan2.2 native workflow — NEEDS a real-box pass against the user's ComfyUI/Wan install. PURE.
 */
export function buildWanI2VWorkflow(p: WanI2VParams): Record<string, unknown> {
  const half = Math.max(1, Math.round(p.steps / 2));
  const shift = p.shift;
  // Independent per-expert LoRAs (node 114 = high, 115 = low); ModelSamplingSD3 then samples from the
  // LoRA-wrapped model when that expert has a LoRA, or the bare UNET otherwise. Either, both, or neither.
  const loraHigh = p.models.loraHigh?.trim();
  const loraLow = p.models.loraLow?.trim();
  const highModel: [string, number] = loraHigh ? ["114", 0] : ["100", 0];
  const lowModel: [string, number] = loraLow ? ["115", 0] : ["101", 0];
  const graph: Record<string, unknown> = {
    "100": { class_type: "UNETLoader", inputs: { unet_name: p.models.highNoise, weight_dtype: "default" } },
    "101": { class_type: "UNETLoader", inputs: { unet_name: p.models.lowNoise, weight_dtype: "default" } },
    "102": { class_type: "CLIPLoader", inputs: { clip_name: p.models.textEncoder, type: "wan" } },
    "103": { class_type: "VAELoader", inputs: { vae_name: p.models.vae } },
    "104": { class_type: "CLIPTextEncode", inputs: { text: p.prompt, clip: ["102", 0] } },
    "105": { class_type: "CLIPTextEncode", inputs: { text: p.negative, clip: ["102", 0] } },
    // WanImageToVideo's start_image is optional: connect it for image-to-video, omit for text-to-video.
    // With an END frame too, the stock WanFirstLastFrameToVideo node swaps in — same conditioning
    // outputs (positive/negative/latent), plus end_image: the clip is pinned to START at one image
    // and ARRIVE at the other (a controlled morph/camera move between two stills).
    "107": {
      class_type: p.startImage && p.endImage ? "WanFirstLastFrameToVideo" : "WanImageToVideo",
      inputs: {
        positive: ["104", 0],
        negative: ["105", 0],
        vae: ["103", 0],
        width: p.width,
        height: p.height,
        length: p.frames,
        batch_size: 1,
        ...(p.startImage ? { start_image: ["106", 0] } : {}),
        ...(p.startImage && p.endImage ? { end_image: ["116", 0] } : {}),
      },
    },
    "108": { class_type: "ModelSamplingSD3", inputs: { model: highModel, shift } },
    "109": { class_type: "ModelSamplingSD3", inputs: { model: lowModel, shift } },
    // High-noise expert handles the first half of the schedule, leaving leftover noise for the low-noise pass.
    "110": {
      class_type: "KSamplerAdvanced",
      inputs: { add_noise: "enable", noise_seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: "euler", scheduler: "simple", start_at_step: 0, end_at_step: half, return_with_leftover_noise: "enable", model: ["108", 0], positive: ["107", 0], negative: ["107", 1], latent_image: ["107", 2] },
    },
    // Low-noise expert refines from the high-noise latent (no fresh noise) to the end of the schedule.
    "111": {
      class_type: "KSamplerAdvanced",
      inputs: { add_noise: "disable", noise_seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: "euler", scheduler: "simple", start_at_step: half, end_at_step: 10000, return_with_leftover_noise: "disable", model: ["109", 0], positive: ["107", 0], negative: ["107", 1], latent_image: ["110", 0] },
    },
    "112": { class_type: "VAEDecode", inputs: { samples: ["111", 0], vae: ["103", 0] } },
    "113": { class_type: "SaveAnimatedWEBP", inputs: { images: ["112", 0], filename_prefix: "visual-reader-vid", fps: p.fps, lossless: false, quality: 90, method: "default" } },
  };
  if (p.startImage) {
    graph["106"] = { class_type: "LoadImage", inputs: { image: p.startImage } };
  }
  if (p.startImage && p.endImage) {
    graph["116"] = { class_type: "LoadImage", inputs: { image: p.endImage } };
  }
  if (loraHigh) {
    graph["114"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["100", 0], lora_name: loraHigh, strength_model: 1 } };
  }
  if (loraLow) {
    graph["115"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["101", 0], lora_name: loraLow, strength_model: 1 } };
  }
  return graph;
}

/** LTX-2.3's distilled two-stage sigma schedules (from the official i2v template): a 9-step low-res pass
 * then a 4-step refine pass over the 2× upscaled latent. */
const LTX_STAGE1_SIGMAS = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0";
const LTX_STAGE2_SIGMAS = "0.85, 0.7250, 0.4219, 0.0";

/** Round a dimension to a latent-friendly multiple of 32 (min 64). */
function ltxDim(n: number): number {
  return Math.max(64, Math.round(n / 32) * 32);
}

/**
 * The official ComfyUI LTX-2.3 image-to-video graph, VIDEO-ONLY (no audio branch, no prompt-enhancer LLM).
 * Mirrors Lightricks' native i2v template: a CheckpointLoaderSimple + separate Gemma text encoder + the
 * required distilled speed LoRA, then a two-stage distilled render — a half-resolution generation
 * (LTXVImgToVideoInplace → SamplerCustomAdvanced over a 9-step ManualSigmas), a 2× LTXVLatentUpsampler, and
 * a full-resolution refine (LTXVImgToVideoInplace → SamplerCustomAdvanced over a 4-step ManualSigmas, guided
 * by LTXVCropGuides) — decoded (VAEDecodeTiled) and saved as an animated WEBP so the result is fetched
 * exactly like the Wan path. Extra user LoRAs chain onto the distilled one. Node ids 200+ (clear of Wan's
 * 100s). NEEDS a real-box pass against the user's ComfyUI/LTX-2 install. PURE.
 */
export function buildLtx2I2VWorkflow(p: Ltx2I2VParams): Record<string, unknown> {
  // High-res renders stage 1 at half size (the 2× upscaler brings it to target); single-stage renders at
  // the target size directly and skips the upscaler + refine pass.
  const genW = p.highRes ? ltxDim(p.width / 2) : ltxDim(p.width);
  const genH = p.highRes ? ltxDim(p.height / 2) : ltxDim(p.height);
  // The required distilled LoRA (node 202, strength 0.5 per the official graph) is the base; extra user
  // LoRAs (250+) chain onto it. The CFG guider(s) sample from the end of that chain. Blank names dropped.
  const userLoras = (p.models.loras ?? []).map((l) => ({ name: l.name.trim(), strength: l.strength ?? 1 })).filter((l) => l.name);
  let modelRef: [string, number] = ["202", 0];
  const loraNodes: Record<string, unknown> = {};
  userLoras.forEach((l, i) => {
    const id = String(250 + i);
    loraNodes[id] = { class_type: "LoraLoaderModelOnly", inputs: { model: modelRef, lora_name: l.name, strength_model: l.strength } };
    modelRef = [id, 0];
  });
  // Image-to-video injects the source frame (LTXVImgToVideoInplace) into each stage's latent; text-to-video
  // omits the image nodes and samples the empty/upscaled latent directly. Audio runs alongside the video in
  // a combined AV latent (LTXVConcatAVLatent → sample → LTXVSeparateAVLatent), exactly as the official graph.
  const i2v = !!p.startImage;
  const audio = p.audio;
  const graph: Record<string, unknown> = {
    "200": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: p.models.checkpoint } },
    // LTX-2 uses a separate Gemma text encoder (it reads the checkpoint too, for the AV head).
    "201": { class_type: "LTXAVTextEncoderLoader", inputs: { text_encoder: p.models.textEncoder, ckpt_name: p.models.checkpoint, device: "default" } },
    // The distilled speed LoRA the 22B dev checkpoint relies on (extra user LoRAs chain after this).
    "202": { class_type: "LoraLoaderModelOnly", inputs: { model: ["200", 0], lora_name: p.models.distilledLora, strength_model: 0.5 } },
    "203": { class_type: "CLIPTextEncode", inputs: { text: p.prompt, clip: ["201", 0] } },
    "204": { class_type: "CLIPTextEncode", inputs: { text: p.negative, clip: ["201", 0] } },
    "205": { class_type: "LTXVConditioning", inputs: { positive: ["203", 0], negative: ["204", 0], frame_rate: p.fps } },
    "209": { class_type: "EmptyLTXVLatentVideo", inputs: { width: genW, height: genH, length: p.frames, batch_size: 1 } },
    "211": { class_type: "RandomNoise", inputs: { noise_seed: p.seed } },
    "212": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "213": { class_type: "ManualSigmas", inputs: { sigmas: LTX_STAGE1_SIGMAS } },
    "214": { class_type: "CFGGuider", inputs: { model: modelRef, positive: ["205", 0], negative: ["205", 1], cfg: p.cfg } },
  };
  if (i2v) {
    // Source-frame nodes (image-to-video only): load → scale → preprocess → inject. A PrimitiveBoolean drives
    // the inject `bypass` (mirrors the official graph's "Switch to Text to Video?" toggle; false = inject).
    graph["206"] = { class_type: "LoadImage", inputs: { image: p.startImage } };
    graph["207"] = { class_type: "ImageScale", inputs: { image: ["206", 0], upscale_method: "lanczos", width: p.width, height: p.height, crop: "center" } };
    graph["208"] = { class_type: "LTXVPreprocess", inputs: { image: ["207", 0], img_compression: 18 } };
    graph["248"] = { class_type: "PrimitiveBoolean", inputs: { value: false } };
    graph["210"] = { class_type: "LTXVImgToVideoInplace", inputs: { strength: 0.7, bypass: ["248", 0], vae: ["200", 2], image: ["208", 0], latent: ["209", 0] } };
  }
  const stage1Video: [string, number] = i2v ? ["210", 0] : ["209", 0];
  // Audio latent + combine with the video latent for the sampler.
  if (audio) {
    graph["230"] = { class_type: "LTXVAudioVAELoader", inputs: { ckpt_name: p.models.checkpoint } };
    graph["231"] = { class_type: "LTXVEmptyLatentAudio", inputs: { frames_number: p.frames, frame_rate: p.fps, batch_size: 1, audio_vae: ["230", 0] } };
    graph["232"] = { class_type: "LTXVConcatAVLatent", inputs: { video_latent: stage1Video, audio_latent: ["231", 0] } };
  }
  graph["215"] = {
    class_type: "SamplerCustomAdvanced",
    inputs: { noise: ["211", 0], guider: ["214", 0], sampler: ["212", 0], sigmas: ["213", 0], latent_image: audio ? ["232", 0] : stage1Video },
  };
  if (audio) graph["233"] = { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["215", 0] } };
  // After stage 1: the video latent (and audio latent when on).
  const s1Video: [string, number] = audio ? ["233", 0] : ["215", 0];
  const s1Audio: [string, number] | null = audio ? ["233", 1] : null;
  let finalVideo = s1Video;
  let finalAudio = s1Audio;
  if (p.highRes) {
    // ── 2× spatial upscale of the stage-1 video latent, then a full-resolution refine pass ──
    graph["216"] = { class_type: "LatentUpscaleModelLoader", inputs: { model_name: p.models.upscaler } };
    graph["217"] = { class_type: "LTXVLatentUpsampler", inputs: { samples: s1Video, upscale_model: ["216", 0], vae: ["200", 2] } };
    let stage2Video: [string, number] = ["217", 0];
    if (i2v) {
      graph["218"] = { class_type: "LTXVImgToVideoInplace", inputs: { strength: 1, bypass: ["248", 0], vae: ["200", 2], image: ["208", 0], latent: ["217", 0] } };
      stage2Video = ["218", 0];
    }
    graph["219"] = { class_type: "LTXVCropGuides", inputs: { positive: ["205", 0], negative: ["205", 1], latent: s1Video } };
    if (audio) graph["234"] = { class_type: "LTXVConcatAVLatent", inputs: { video_latent: stage2Video, audio_latent: s1Audio! } };
    graph["220"] = { class_type: "RandomNoise", inputs: { noise_seed: p.seed + 1 } };
    graph["221"] = { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } };
    graph["222"] = { class_type: "ManualSigmas", inputs: { sigmas: LTX_STAGE2_SIGMAS } };
    graph["223"] = { class_type: "CFGGuider", inputs: { model: modelRef, positive: ["219", 0], negative: ["219", 1], cfg: p.cfg } };
    graph["224"] = {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: ["220", 0], guider: ["223", 0], sampler: ["221", 0], sigmas: ["222", 0], latent_image: audio ? ["234", 0] : stage2Video },
    };
    if (audio) {
      graph["235"] = { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["224", 0] } };
      finalVideo = ["235", 0];
      finalAudio = ["235", 1];
    } else {
      finalVideo = ["224", 0];
      finalAudio = null;
    }
  }
  graph["225"] = { class_type: "VAEDecodeTiled", inputs: { samples: finalVideo, vae: ["200", 2], tile_size: 768, overlap: 64, temporal_size: 4096, temporal_overlap: 4 } };
  if (audio) {
    // Decode audio + mux into an mp4 (the official CreateVideo → SaveVideo tail).
    graph["236"] = { class_type: "LTXVAudioVAEDecode", inputs: { samples: finalAudio!, audio_vae: ["230", 0] } };
    graph["237"] = { class_type: "CreateVideo", inputs: { fps: p.fps, images: ["225", 0], audio: ["236", 0] } };
    graph["238"] = { class_type: "SaveVideo", inputs: { filename_prefix: "video/visual-reader-vid", format: "auto", codec: "auto", video: ["237", 0] } };
  } else {
    // Silent: save the decoded frames as an animated WEBP (reuses the image fetch path).
    graph["226"] = { class_type: "SaveAnimatedWEBP", inputs: { images: ["225", 0], filename_prefix: "visual-reader-vid", fps: p.fps, lossless: false, quality: 90, method: "default" } };
  }
  Object.assign(graph, loraNodes);
  return graph;
}

/** MIME for a saved ComfyUI artifact, by extension (a video clip vs. an animated image). */
function mimeForFilename(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "mp4") return "video/mp4";
  if (ext === "webm") return "video/webm";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

/**
 * Turn a ComfyUI /prompt rejection into a useful message. A 400 carries a JSON body with `error` +
 * `node_errors` naming the exact node/input that failed validation (a missing custom node, a bad input,
 * a wiring mismatch) — surface that instead of a bare status code so a graph problem is diagnosable.
 */
async function comfyPromptError(res: TransportResponse): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown; node_errors?: Record<string, unknown> };
    const parts: string[] = [];
    if (body.error) parts.push(typeof body.error === "string" ? body.error : JSON.stringify(body.error));
    if (body.node_errors && Object.keys(body.node_errors).length) parts.push(`node_errors: ${JSON.stringify(body.node_errors)}`);
    detail = parts.join(" — ");
  } catch {
    try {
      detail = (await res.text()).slice(0, 800);
    } catch {
      /* body unreadable — fall back to the status alone */
    }
  }
  return `ComfyUI rejected the workflow (status ${res.status})${detail ? `: ${detail}` : ""}`;
}

/** Whether a failed /prompt submit is worth ONE retry: 5xx only — a 4xx is ComfyUI rejecting the
 * workflow itself (bad node/input/model), which resending the identical graph can never fix. */
export function shouldRetryPromptSubmit(status: number): boolean {
  return status >= 500;
}

/** Pause before the single /prompt resubmit — long enough for an engine hiccup/proxy blip to clear. */
const SUBMIT_RETRY_DELAY_MS = 1_500;

/** Discovery/inventory endpoints (/object_info, /system_stats) answer instantly on a live engine —
 * bound them so a wedged connection can't hang model listings forever. Renders are never bounded
 * this way (a slow-but-working render must not be killed; see idleTimeoutMs). */
const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * The checkpoint families IP-ADAPTER can attach to.
 *
 * ComfyUI_IPAdapter_plus resolves its adapter + CLIP-Vision weights from the BASE MODEL's
 * architecture, and the weights that exist are the SD ones. Point it at a Flux, Flux.2, Z-Image,
 * Qwen-Image or HiDream checkpoint and the loader raises instead of degrading — so a reference photo
 * on those families used to take the whole render down with it, which is a bad trade for a likeness.
 *
 * READ THIS AS A LIMIT OF THE MECHANISM, NOT OF THE MODELS. Flux.2 now has its own route here — see
 * REFERENCE_LATENT_FAMILIES — because it reads reference images natively rather than through an
 * adapter. The Kontext/Edit variants of the remaining families are built for that route too; they're
 * separate checkpoints this backend can't yet tell from their text-to-image siblings, so they stay
 * out until it can. For those, the honest statement is "this app can't send them there yet", not
 * "those models can't use them".
 *
 * The cloud side is unaffected: Gemini's native image model and gpt-image-1 read reference photos on
 * any of their own models, because they take them as ordinary image inputs.
 */
const IPADAPTER_FAMILIES: ReadonlySet<ModelFamily> = new Set<ModelFamily>(["sd15", "sdxl"]);

/**
 * How many references each route will actually use — a property of the MECHANISM, not of the caller.
 *
 * IP-Adapter blends every reference into one identity signal, so past a handful it stops resolving a
 * likeness and starts averaging faces, and each one costs another encode and another apply node.
 * Four is where the book pipeline already draws that line.
 *
 * ReferenceLatent doesn't blend: each photo is an independent latent appended to the conditioning,
 * which is what lets Flux.2 take a person from one picture and a setting from another. Its documented
 * ceiling is ten, so ten is the cap — holding it to four would throw away the capability.
 *
 * Capped HERE because here is where the route is known. The chat path can't decide it: the same four
 * attachments mean different things depending on which model is loaded.
 */
const IPADAPTER_MAX_REFS = 4;
const REFERENCE_LATENT_MAX_REFS = 10;

/** Can IP-Adapter condition a render on this checkpoint family? PURE. */
export function ipAdapterSupports(family: ModelFamily): boolean {
  return IPADAPTER_FAMILIES.has(family);
}

/**
 * Families that read a reference photo THEMSELVES, through a ReferenceLatent chain of core ComfyUI
 * nodes — no adapter, no node pack, no extra weights, nothing for the reader to install.
 *
 * Flux.2 only, for now, and deliberately: the Kontext and *-Edit variants of the other families are
 * built for this too, but they're separate checkpoints whose names this backend can't currently tell
 * apart from their text-to-image siblings. Sending a reference latent to a model that isn't an edit
 * model produces a quietly worse picture rather than an error, which is the failure mode hardest to
 * notice — so the roster stays at what's known-good and grows on evidence.
 */
const REFERENCE_LATENT_FAMILIES: ReadonlySet<ModelFamily> = new Set<ModelFamily>(["flux2"]);

/** Does this family take reference photos natively, via ReferenceLatent? PURE. */
export function referenceLatentSupports(family: ModelFamily): boolean {
  return REFERENCE_LATENT_FAMILIES.has(family);
}

/** Can a reference photo condition a local render on this family AT ALL, by either route? PURE. */
export function referencePhotoSupports(family: ModelFamily): boolean {
  return ipAdapterSupports(family) || referenceLatentSupports(family);
}

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
  /** How long to wait for an engine reporting no model files at all (see `awaitComponentFiles`).
   * Injectable so tests don't spend it. */
  engineFilesTimeoutMs?: number;
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

type NodeSchema = { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } };
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
    // A node's saved files appear under a per-type key: "images" (SaveImage / SaveAnimatedWEBP),
    // "gifs"/"videos" (animation/video save nodes like SaveVideo). Collected generically below.
    outputs?: Record<string, Record<string, HistoryImage[] | undefined>>;
    /** Execution status; `messages` carries an `execution_error` with the real cause. */
    status?: {
      status_str?: string;
      messages?: [string, Record<string, unknown>][];
    };
  }
>;

/** One GPU device's VRAM totals (bytes) from ComfyUI's GET /system_stats. */
export interface EngineVramStats {
  /** Device label, e.g. "cuda:0 NVIDIA GeForce RTX 4090". */
  name: string;
  /** Total VRAM in bytes. */
  vramTotal: number;
  /** Free VRAM in bytes (0 when the engine doesn't report it). */
  vramFree: number;
}

/**
 * Parse ComfyUI's GET /system_stats payload into a per-device VRAM list. ComfyUI returns
 * `{ system: {...}, devices: [{ name, vram_total, vram_free, ... }] }`; we keep only the fields
 * the status bar shows and drop devices that don't report a positive numeric total (e.g. a CPU
 * device). Tolerant of shape drift — a missing/garbage payload yields [] rather than throwing.
 */
export function parseSystemStats(json: unknown): EngineVramStats[] {
  const devices = (json as { devices?: unknown } | null | undefined)?.devices;
  if (!Array.isArray(devices)) return [];
  const out: EngineVramStats[] = [];
  for (const d of devices) {
    const dev = d as { name?: unknown; vram_total?: unknown; vram_free?: unknown };
    const total = typeof dev.vram_total === "number" ? dev.vram_total : NaN;
    if (!Number.isFinite(total) || total <= 0) continue;
    const free = typeof dev.vram_free === "number" ? dev.vram_free : NaN;
    out.push({
      name: typeof dev.name === "string" && dev.name ? dev.name : "GPU",
      vramTotal: total,
      vramFree: Number.isFinite(free) ? Math.max(0, Math.min(free, total)) : 0,
    });
  }
  return out;
}

/**
 * Parse `nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader,nounits`
 * output (one "name, totalMb, usedMb" line per GPU) into the neutral per-device shape so the same
 * `summarizeVram` collapses it. nvidia-smi's `memory.used` is the WHOLE board across ALL processes,
 * so a co-resident local LLM (Ollama / the bundled llama-server) is included — unlike ComfyUI's
 * /system_stats, which only sees its own torch context. Blank/garbage lines are skipped; a fully
 * unparseable input yields [].
 */
export function parseNvidiaVramCsv(text: string): EngineVramStats[] {
  const MB = 1024 * 1024;
  const out: EngineVramStats[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",").map((p) => p.trim());
    if (parts.length < 3) continue; // need name + total + used (a name may itself contain commas)
    const totalMb = Number(parts[parts.length - 2]);
    const usedMb = Number(parts[parts.length - 1]);
    if (!Number.isFinite(totalMb) || totalMb <= 0 || !Number.isFinite(usedMb)) continue;
    const name = parts.slice(0, parts.length - 2).join(", ") || "GPU";
    const used = Math.max(0, Math.min(usedMb, totalMb));
    out.push({ name, vramTotal: totalMb * MB, vramFree: (totalMb - used) * MB });
  }
  return out;
}

/** A status-bar-ready VRAM summary (megabytes), collapsed across the engine's GPU device(s). */
export interface VramSummary {
  /** Total VRAM across all GPUs, in MB. */
  totalMb: number;
  /** VRAM in use (total − free), in MB. */
  usedMb: number;
  /** A short device label: the single GPU's name, or "N GPUs" when aggregated. */
  device: string;
}

/** "cuda:0 NVIDIA GeForce RTX 4090" → "NVIDIA GeForce RTX 4090" (drop the cuda:N prefix). */
function shortGpuName(name: string): string {
  return name.replace(/^cuda:\d+\s+/i, "").trim() || name;
}

/**
 * Collapse per-device /system_stats into one status-bar figure: sum VRAM across GPUs and report
 * used = total − free, in MB. A single GPU keeps its (shortened) name; multiple show "N GPUs".
 * Returns undefined when there are no GPU devices — nothing to show.
 */
export function summarizeVram(devices: readonly EngineVramStats[]): VramSummary | undefined {
  const first = devices[0];
  if (!first) return undefined;
  const totalBytes = devices.reduce((a, d) => a + d.vramTotal, 0);
  const freeBytes = devices.reduce((a, d) => a + d.vramFree, 0);
  const toMb = (b: number): number => Math.round(b / (1024 * 1024));
  return {
    totalMb: toMb(totalBytes),
    usedMb: toMb(Math.max(0, totalBytes - freeBytes)),
    device: devices.length === 1 ? shortGpuName(first.name) : `${devices.length} GPUs`,
  };
}

export class ComfyUIBackend implements LocalEngineBackend {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly clientId: string;
  private readonly pollIntervalMs: number;
  private readonly idleTimeoutMs: number;
  private readonly engineFilesTimeoutMs: number;
  private lorasCache?: Promise<Set<string>>;
  private ipAdapterCache?: Promise<IpAdapterCaps | null>;
  private warnedNoIpAdapter = false;
  private warnedIpAdapterFamily = false;
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
    this.engineFilesTimeoutMs = opts.engineFilesTimeoutMs ?? ENGINE_FILES_TIMEOUT_MS;
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

  /**
   * The installed files for the image-to-video graphs, read from the EXACT node enums ComfyUI exposes
   * (so a Settings dropdown offers precisely what the engine will accept): Wan's diffusion models
   * (UNETLoader.unet_name), the LTX 2× upscaler (LatentUpscaleModelLoader.model_name), and the LTX Gemma
   * text encoder (LTXAVTextEncoderLoader.text_encoder). Best-effort — a node ComfyUI lacks yields [].
   */
  async listVideoComponents(): Promise<{ diffusionModels: string[]; upscalers: string[]; ltxTextEncoders: string[] }> {
    // Pull each list from EVERY node/folder it might live in, deduped — so a file shows up wherever the
    // user keeps it (e.g. an upscaler in latent_upscale_models OR upscale_models; the Gemma encoder via
    // the LTX node OR the generic text_encoders listing) rather than the dropdown coming up empty.
    const [diffusionModels, latentUpscalers, upscaleModels, ltxEncoders, clipEncoders] = await Promise.all([
      this.enumValues("UNETLoader", "unet_name"),
      this.enumValues("LatentUpscaleModelLoader", "model_name"),
      this.enumValues("UpscaleModelLoader", "model_name"),
      this.enumValues("LTXAVTextEncoderLoader", "text_encoder"),
      this.enumValues("CLIPLoader", "clip_name"),
    ]);
    const dedupe = (...lists: string[][]): string[] => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const name of lists.flat()) {
        const k = name.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(name);
      }
      return out;
    };
    return {
      diffusionModels,
      upscalers: dedupe(latentUpscalers, upscaleModels),
      ltxTextEncoders: dedupe(ltxEncoders, clipEncoders),
    };
  }

  /** A node's `/object_info` schema, cached per session (failures evicted). */
  /** Drop cached `/object_info` for these nodes so the next read goes back to the engine. */
  private forgetNodeInfo(...nodes: string[]): void {
    for (const n of nodes) this.nodeInfoCache.delete(n);
  }

  /**
   * Wait for an engine that reports NO FILES AT ALL — of any kind.
   *
   * The distinction that matters: an engine which can name the diffusion models on its disk has
   * finished scanning, so empty encoder/VAE lists from it are the truth and must fail immediately
   * with the real message. An engine that reports nothing anywhere — no checkpoints, no UNETs, no
   * encoders, no VAEs — is either still starting up or not answering yet, and its "nothing" is not
   * an answer about the reader's install at all.
   *
   * Telling those apart is the whole point. Waiting on the first kind would make a genuine
   * misconfiguration take a minute to report; failing on the second produced the worst report there
   * is — an error naming two folders whose contents were sitting on disk the whole time. That became
   * routine when the app started relaunching itself to update: the engine goes down with the old
   * process and the new one asks the instant it comes back.
   *
   * Costs one extra read on a warm engine and returns immediately.
   */
  private async awaitComponentFiles(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.engineFilesTimeoutMs;
    for (;;) {
      const [vaes, clips, unets, ckpts] = await Promise.all([
        this.enumValues("VAELoader", "vae_name"),
        this.enumValues("CLIPLoader", "clip_name"),
        this.enumValues("UNETLoader", "unet_name"),
        this.enumValues("CheckpointLoaderSimple", "ckpt_name"),
      ]);
      // Anything at all → the engine has scanned; whatever it says about encoders is real.
      if (vaes.length + clips.length + unets.length + ckpts.length > 0) return;
      if (signal?.aborted || Date.now() >= deadline) return;
      // Cached, an empty list would be re-read forever — drop it so the retry sees the engine.
      this.forgetNodeInfo("CLIPLoader", "DualCLIPLoader", "QuadrupleCLIPLoader", "VAELoader", "UNETLoader", "CheckpointLoaderSimple");
      await delay(ENGINE_FILES_POLL_MS);
    }
  }

  private nodeInfo(node: string): Promise<NodeSchema | undefined> {
    const cached = this.nodeInfoCache.get(node);
    if (cached) return cached;
    const p = (async (): Promise<NodeSchema | undefined> => {
      try {
        const res = await this.transport.send({
          url: `${this.baseUrl}/object_info/${node}`,
          method: "GET",
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });
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

  /** Read a node's input enum (e.g. UNETLoader.unet_name); checks required THEN optional (some loaders —
   * e.g. LatentUpscaleModelLoader / LTXAVTextEncoderLoader — expose the file list as an optional input).
   * [] if unavailable. */
  private async enumValues(node: string, key: string): Promise<string[]> {
    const data = await this.nodeInfo(node);
    const enumVal = data?.input?.required?.[key] ?? data?.input?.optional?.[key];
    if (!Array.isArray(enumVal)) return [];
    // ComfyUI combo inputs are normally `[[...options], {meta}]`; tolerate a bare `[...options]` too.
    if (Array.isArray(enumVal[0])) return (enumVal[0] as unknown[]).filter((v): v is string => typeof v === "string");
    if (typeof enumVal[0] === "string") return enumVal.filter((v): v is string => typeof v === "string");
    return [];
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
    signal?: AbortSignal,
  ): Promise<DiffusionComponents> {
    await this.awaitComponentFiles(signal);
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
      // Distinctness guard: if clip_l and clip_g resolved to the SAME file, the loader gets two
      // 768-wide pooled halves instead of clip_l(768)+clip_g(1280)=2048 → the exact shape crash.
      // Catch it pre-flight with the same clip_g guidance rather than a cryptic runtime error.
      if (clipL === clipG) {
        throw new Error(
          `HiDream resolved the same file (${clipG}) for both clip_l and clip_g, so its pooled text ` +
            "embedding would be 768 instead of the required 2048. Install a genuine, distinct clip_g " +
            "(1280-wide) in models/text_encoders — e.g. clip_g_hidream.safetensors — and pick it under " +
            "Settings → Local model.",
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
    // A MANUAL OVERRIDE IS NOT A HINT. When the reader has picked an exact file in Settings, it is
    // resolved on its own — exact name, or the same file under a different quant/precision suffix —
    // with NO pattern fallback. Letting it fall through to the family patterns meant a choice that
    // stopped matching (a renamed file, a re-scanned engine, a variant that no longer stem-matches)
    // silently became auto-detection again, quietly picking the encoder the reader had switched
    // AWAY from. That is invisible from the outside: the setting still shows their choice, and the
    // render fails downstream — or worse, succeeds wrongly. An explicit choice either resolves or
    // says so.
    const encoder = overrides?.textEncoder
      ? pickComponentAsset(clips, overrides.textEncoder)
      : pickComponentAsset(clips, wantedEncoder, encoderPatterns, []);
    const vae = overrides?.vae
      ? pickComponentAsset(vaes, overrides.vae)
      : pickComponentAsset(vaes, wantedVae, [], h.vae);
    const chosenMissing = [
      ...(overrides?.textEncoder && !encoder
        ? [`text encoder “${overrides.textEncoder}” (ComfyUI lists: ${listOrNone(clips)})`]
        : []),
      ...(overrides?.vae && !vae ? [`VAE “${overrides.vae}” (ComfyUI lists: ${listOrNone(vaes)})`] : []),
    ];
    if (chosenMissing.length > 0) {
      this.forgetNodeInfo("CLIPLoader", "VAELoader");
      throw new Error(
        `The ${chosenMissing.join(" and the ")} you chose in Settings → Local model isn't among the ` +
          "files the engine reports. Pick one of the listed files, or clear the choice to let the app " +
          "detect one. (It is NOT falling back to automatic detection on its own — that would quietly " +
          "use the file you switched away from.)",
      );
    }
    if (!encoder || !vae) {
      // FORGET what we read. A node's file list is cached for the session on the assumption that
      // installed files don't change mid-session — true, except that an EMPTY list is also a
      // perfectly successful response, and the engine reports empty while it is still starting up
      // or re-scanning its models folder. Cached, that turns a few seconds of bad timing into a
      // session where every render fails with "needs a text encoder" and the files are right there
      // on disk. The app now relaunches itself to update, which is exactly when it can come back
      // before the engine is ready, so this stopped being hypothetical. Dropping the entry costs
      // one HTTP round trip and lets the next attempt see the truth.
      this.forgetNodeInfo("CLIPLoader", "DualCLIPLoader", "QuadrupleCLIPLoader", "VAELoader");
      const what = entry?.label ?? h.what;
      const hint = [
        ...(encoder ? [] : [`a text encoder${wantedEncoder ? ` like ${wantedEncoder}` : ""} (models/text_encoders)`]),
        ...(vae ? [] : [`a VAE${wantedVae ? ` like ${wantedVae}` : ""} (models/vae)`]),
      ].join(" and ");
      throw new Error(
        `${what} needs ${hint} installed in ComfyUI (a same-family variant filename is fine). ` +
          "Use the Download button in Settings → Local model to fetch all its files, or pick an " +
          "all-in-one SD/SDXL checkpoint. (If the files ARE installed, the engine was probably still " +
          "starting up when this was asked — it reports an empty list until it has scanned its models " +
          "folder. Try the image again.)",
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
            signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
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
          const res = await this.transport.send({
            url: `${this.baseUrl}/object_info`,
            method: "GET",
            signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
          });
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
    // subject), then upscale the latent ~1.5× toward the family's hires ceiling and refine.
    // Skipped when the native size already meets the ceiling (hiresTarget → null = single pass).
    const hires =
      input.hires === true
        ? (() => {
            // The ceiling is model- and memory-dependent: Low-VRAM (weights offloaded to system
            // RAM) caps low so a big upscale can't exhaust RAM and freeze the PC; the heavy DiT
            // families stay a notch under 2048; everything else can reach 2048.
            const ceiling = hiresCeiling(family, input.lowVram);
            const target = hiresTarget(family, input.width ?? 1024, input.height ?? 1024, ceiling);
            return target ? { width: target.width, height: target.height, denoise: HIRES_DENOISE } : undefined;
          })()
        : undefined;

    // Expand bible terms per the target's text-encoder grade: CLIP/T5 (SD/Flux.1) inject
    // descriptors in place; LLM-grade (Flux.2/Mistral) keep names + a reference block. Then
    // SD families get quality tags + a real negative; Flux gets natural language and none.
    const expanded = expandPrompt(
      input.prompt,
      input.terms ?? [],
      // The reader's explicit choice wins; otherwise the shape this family's encoder suits.
      input.nameHandling ?? nameHandlingFor(family),
      input.worldStyle,
      input.bookTitle,
    );
    let prompt = composeSdPositive(family, expanded);
    // Filtered against what was actually ASKED for: the default negative suppresses portrait /
    // headshot / close-up / simple background, which is right for a book illustration and directly
    // fights a reader who requested one of them.
    const negative = resolveNegative(family, input.negativePrompt, prompt);
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

    // IP-Adapter character consistency — only when refs are passed, the base model is one
    // IP-Adapter can attach to, AND the nodes/models are installed. Anything else renders
    // seed-only (graceful, never an error).
    let ipAdapter: IpAdapterGraph | undefined;
    let referenceLatents: string[] | undefined;
    // Why references didn't reach the model, when they didn't. Every branch below already knows;
    // this is what carries that out to the reader instead of leaving it in a console line.
    let refsSkipped: string | undefined;
    if (input.ipAdapterRefs && input.ipAdapterRefs.length > 0 && referenceLatentSupports(family)) {
      // This family reads the photo itself — no adapter, and nothing to install. Same reference
      // images, a different route into the same render.
      try {
        referenceLatents = await Promise.all(
          input.ipAdapterRefs
            .slice(0, REFERENCE_LATENT_MAX_REFS)
            .map((ref) => this.uploadedReference(ref.bytes, ref.mimeType)),
        );
      } catch {
        referenceLatents = undefined; // upload failed → render without the reference, not at all
        refsSkipped = "the engine wouldn't accept the upload";
      }
    } else if (input.ipAdapterRefs && input.ipAdapterRefs.length > 0 && !ipAdapterSupports(family)) {
      // Splicing the chain in anyway was worse than doing nothing: IPAdapterUnifiedLoader resolves
      // its models from the base model's architecture, so on a Flux/Z-Image/Qwen/HiDream checkpoint
      // it raises rather than degrading, and the whole render fails. A reference photo the model
      // can't use should cost the reader the likeness, not the picture.
      refsSkipped = `this model (${family}) can't use reference photos here`;
      if (!this.warnedIpAdapterFamily) {
        this.warnedIpAdapterFamily = true;
        console.info(
          `[visual-reader] IP-Adapter can't attach to ${family} checkpoints — rendering seed-only. ` +
            "Locally, reference photos condition SD 1.5 / SDXL (IP-Adapter) and Flux.2 (native, nothing " +
            "to install); any Gemini / gpt-image-1 model takes them too.",
        );
      }
    } else if (input.ipAdapterRefs && input.ipAdapterRefs.length > 0) {
      const caps = await this.availableIpAdapter();
      if (caps) {
        try {
          // Cached per buffer (uploaded once per session) and fetched in parallel
          // on a miss; `map` keeps the refs in their original order.
          const refs = await Promise.all(
            input.ipAdapterRefs.slice(0, IPADAPTER_MAX_REFS).map(async (ref) => ({
              filename: await this.uploadedReference(ref.bytes, ref.mimeType),
              weight: ref.weight,
            })),
          );
          ipAdapter = { caps, refs };
        } catch {
          ipAdapter = undefined; // upload failed → fall back to seed-only
          refsSkipped = "the engine wouldn't accept the upload";
        }
      } else if (((refsSkipped = "the IP-Adapter nodes aren't installed"), !this.warnedNoIpAdapter)) {
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
            input.signal,
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
      ...(referenceLatents?.length ? { referenceLatents } : {}),
      ...(initImage ? { initImage } : {}),
      ...(hires ? { hires } : {}),
      ...(input.castRegions && input.castRegions.length > 0 ? { regions: input.castRegions } : {}),
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
      const { prompt_id } = await this.submitPrompt(workflow, signal);
      job.promptId = prompt_id;

      // For HiDream, carry the EXACT clip_l/clip_g files we resolved into the poller so a
      // pooled-shape failure (768 vs 2048) names the culprit file instead of a mystery.
      const hidreamClips =
        family === "hidream" && components?.textEncoder.class_type === "QuadrupleCLIPLoader"
          ? {
              clipL: String(components.textEncoder.inputs.clip_name1 ?? ""),
              clipG: String(components.textEncoder.inputs.clip_name2 ?? ""),
            }
          : undefined;
      const image = await this.pollForImage(prompt_id, signal, family, hidreamClips);
      const view = await this.transport.send({
        url:
          `${this.baseUrl}/view?filename=${encodeURIComponent(image.filename)}` +
          `&subfolder=${encodeURIComponent(image.subfolder)}&type=${encodeURIComponent(image.type)}`,
        method: "GET",
        ...(signal ? { signal } : {}),
      });
      if (!view.ok) throw new Error(`ComfyUI view failed with status ${view.status}`);
      input.onProgress?.(1);
      // `prompt` is what actually went to the encoder — expanded, tagged, LoRA-triggered — plus the
      // NEGATIVE and the sampler settings, so "as sent to the model" is the whole instruction rather
      // than its positive half. The negative is where a subject gets suppressed and it is generated,
      // not typed: without it in the record, an engine that treats a model differently from another
      // can't be compared with one.
      const supplied = input.ipAdapterRefs?.length ?? 0;
      const used = referenceLatents?.length ?? ipAdapter?.refs.length ?? 0;
      const capped =
        used > 0 && used < supplied
          ? referenceLatents
            ? `this model takes at most ${REFERENCE_LATENT_MAX_REFS}`
            : `IP-Adapter uses at most ${IPADAPTER_MAX_REFS}`
          : refsSkipped;
      return {
        bytes: await view.arrayBuffer(),
        mimeType: "image/png",
        prompt: renderPromptRecord(prompt, negative, {
          engine: "ComfyUI",
          model: checkpoint,
          family,
          sampler: sampler.sampler,
          scheduler: sampler.scheduler,
          cfg: sampler.cfg,
          steps,
        }),
        ...(supplied
          ? {
              references: {
                supplied,
                used,
                ...(used > 0 ? { how: referenceLatents ? ("reference-latent" as const) : ("ipadapter" as const) } : {}),
                ...(capped ? { why: capped } : {}),
              },
            }
          : {}),
      };
    } finally {
      socket?.close();
      signal?.removeEventListener("abort", onAbort);
      // LOW-VRAM: ComfyUI keeps the diffusion model resident in VRAM after a render (its model cache),
      // which starves a co-resident local LLM (the prompt/task engine). When low-VRAM is on, explicitly
      // unload the image model + free the VRAM cache so the GPU is handed back between renders. Awaited
      // so the VRAM is actually released by the time generate() resolves and the LLM reloads.
      if (input.lowVram) await this.freeMemory();
    }
  }

  /**
   * Animate a source image into a short video (image-to-video) with a Wan2.2 two-expert (high→low noise)
   * graph. Uploads the source frame, submits the graph, polls /history, and fetches the resulting clip via
   * /view — the MIME comes from the saved file's extension (an animated .webp by default). Reuses the same
   * upload / progress / poll / free machinery as an image render. The Wan node names + model files must
   * match the user's ComfyUI install (NEEDS a real-box pass — can't be exercised in CI here).
   */
  async generateVideo(input: VideoGenerationInput, models: VideoModelFiles): Promise<VideoGenerationOutput> {
    // Image-to-video uploads the source frame; text-to-video (no image) starts from an empty latent.
    const startImage = input.image ? await this.uploadedReference(input.image.bytes, input.image.mimeType) : undefined;
    // First+last-frame conditioning is a Wan-graph feature (WanFirstLastFrameToVideo); the LTX-2
    // graph has no equivalent seam, so fail loudly rather than silently ignoring the end frame.
    if (input.endImage && models.kind !== "wan-i2v") {
      throw new Error("First+last-frame video needs the Wan model — switch the video model to Wan 2.2, or drop the end frame.");
    }
    if (input.endImage && !startImage) {
      throw new Error("First+last-frame video needs a START image too — give it a source image alongside the end frame.");
    }
    const endImage = input.endImage ? await this.uploadedReference(input.endImage.bytes, input.endImage.mimeType) : undefined;
    // Per-family render defaults fill in whatever the caller left blank (Wan ~5s/16fps; LTX longer/24fps).
    const d = VIDEO_RENDER_DEFAULTS[models.kind];
    const common = {
      ...(startImage ? { startImage } : {}),
      prompt: input.prompt,
      negative: input.negativePrompt ?? WAN_DEFAULT_NEGATIVE,
      width: input.width ?? d.width,
      height: input.height ?? d.height,
      frames: input.frames ?? d.frames,
      fps: input.fps ?? d.fps,
      steps: input.steps ?? d.steps,
      cfg: input.cfg ?? d.cfg,
      seed: input.seed ?? Math.floor(Math.random() * 1_000_000_000),
    };
    const workflow =
      models.kind === "ltx2-i2v"
        ? buildLtx2I2VWorkflow({ ...common, models, highRes: input.highRes ?? true, audio: input.audio ?? true })
        : buildWanI2VWorkflow({ ...common, models, shift: input.shift ?? d.shift, ...(endImage ? { endImage } : {}) });
    const relay = (fraction: number): void => input.onProgress?.(fraction);
    const signal = input.signal;
    const onAbort = (): void => {
      void this.interrupt();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const job: { promptId?: string } = {};
    const socket = this.openProgressSocket(relay, job);
    try {
      const { prompt_id } = await this.submitPrompt(workflow, signal);
      job.promptId = prompt_id;
      const file = await this.pollForImage(prompt_id, signal);
      const view = await this.transport.send({
        url:
          `${this.baseUrl}/view?filename=${encodeURIComponent(file.filename)}` +
          `&subfolder=${encodeURIComponent(file.subfolder)}&type=${encodeURIComponent(file.type)}`,
        method: "GET",
        ...(signal ? { signal } : {}),
      });
      if (!view.ok) throw new Error(`ComfyUI view failed with status ${view.status}`);
      input.onProgress?.(1);
      return { bytes: await view.arrayBuffer(), mimeType: mimeForFilename(file.filename) };
    } finally {
      socket?.close();
      signal?.removeEventListener("abort", onAbort);
      // Release the video model's VRAM — it's large, and a chat LLM is usually waiting to reload.
      // EXCEPT in a long-form batch (`keepResident`): freeing here would unload the ~30 GB video
      // model between clips, forcing a full multi-minute reload for every clip; the orchestrator
      // keeps it resident and frees ONCE after the last clip (whose input leaves keepResident unset).
      if (input.keepResident !== true) await this.freeMemory();
    }
  }

  /**
   * POST a workflow to /prompt with ONE retry after a short pause — but ONLY when it's IDEMPOTENT-safe.
   *
   * A resubmit is safe only if ComfyUI provably never accepted the first submit. A definitive 5xx STATUS
   * proves that: the server responded and rejected the submit WITHOUT enqueuing a render (engine
   * restarting, proxy 502), so resending the identical graph can't double-render. A THROWN error (no
   * Response at all) is NOT retried: we can't tell a pre-send failure (connection refused / DNS) from a
   * response-read failure AFTER the POST was already accepted and the render enqueued — and blindly
   * resending the latter would double-render (a 5-minute video rendered twice). Distinguishing the two
   * isn't possible at the Transport seam, so we narrow the retry to 5xx and let a thrown error surface.
   *
   * Residual risk: a genuine pre-send blip while the engine is still starting is now surfaced instead of
   * silently retried; the engine-ready/caller flow re-attempts. That trades a little startup resilience
   * for never double-rendering an accepted job. A user cancel and 4xx rejections are never retried.
   */
  private async submitPrompt(workflow: Record<string, unknown>, signal?: AbortSignal): Promise<PromptResponse> {
    const send = (): Promise<TransportResponse> =>
      this.transport.send({
        url: `${this.baseUrl}/prompt`,
        method: "POST",
        body: { prompt: workflow, client_id: this.clientId },
        ...(signal ? { signal } : {}),
      });
    // No try/catch: a thrown error (network drop / abort) propagates immediately — resending it could
    // double-render an already-accepted job.
    const submit = await send();
    if (!shouldRetryPromptSubmit(submit.status)) {
      if (!submit.ok) throw new Error(await comfyPromptError(submit));
      return submit.json<PromptResponse>();
    }
    await new Promise((r) => setTimeout(r, SUBMIT_RETRY_DELAY_MS));
    const retry = await send();
    if (!retry.ok) throw new Error(await comfyPromptError(retry));
    return retry.json<PromptResponse>();
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
   * The connected ComfyUI's live VRAM per GPU device (GET /system_stats), for the status-bar
   * indicator. Best-effort: a miss (engine down, endpoint absent, non-JSON) returns [] rather than
   * throwing, so the polling that drives the indicator never disrupts the UI. Honors an abort signal.
   */
  async systemStats(signal?: AbortSignal): Promise<EngineVramStats[]> {
    try {
      const res = await this.transport.send({
        url: `${this.baseUrl}/system_stats`,
        method: "GET",
        // Caller's abort still wins; the timeout only stops a hung poll from piling up.
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]) : AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      return parseSystemStats(await res.json());
    } catch {
      return [];
    }
  }

  /**
   * Unload models + free ComfyUI's VRAM cache (POST /free) so a co-resident local LLM can reclaim the
   * GPU after a render. Only called in low-VRAM mode (the default keeps the model hot for the next
   * image). Best-effort: freeing is an optimization, never required for correctness.
   */
  async freeMemory(): Promise<void> {
    try {
      await this.transport.send({
        url: `${this.baseUrl}/free`,
        method: "POST",
        body: { unload_models: true, free_memory: true },
      });
    } catch {
      /* best-effort — the GPU just stays warm if ComfyUI can't free right now */
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
    hidreamClips?: { clipL?: string; clipG?: string },
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
        // A saved artifact can land under any per-type key (images / gifs / videos). Collect every
        // {filename}-shaped entry across all output nodes so a video (SaveVideo) is found like an image.
        const files = Object.values(entry.outputs ?? {}).flatMap((node) =>
          Object.values(node).flatMap((arr) => (Array.isArray(arr) ? arr : [])).filter((f) => f && typeof f.filename === "string"),
        );
        const first = files[0];
        if (first) return first;
        // Finished but no file: surface ComfyUI's REAL execution error (otherwise it's a mystery).
        throw new Error(
          comfyExecutionError(entry.status, family, hidreamClips) ?? "ComfyUI finished but produced no output",
        );
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
  /** Uploaded reference-photo filenames conditioned through a ReferenceLatent chain (Flux.2). */
  referenceLatents?: readonly string[];
  /** Hi-Res two-pass: upscale the first pass's latent to this target size, then refine
   * at `denoise`. The first pass renders at `width`/`height` (the native-safe size). */
  hires?: { width: number; height: number; denoise: number };
  /** Per-character regions (see regional-conditioning.ts): each character's description scoped to
   * their own patch of canvas, combined with the whole-scene conditioning. Empty/absent = off. */
  regions?: readonly CastRegion[];
}

/**
 * Weight each character's description towards their own part of the canvas, combined with the
 * whole-scene conditioning, and return the conditioning to sample from.
 *
 * NOT `ConditioningSetArea`/`SetAreaPercentage`, which is what this first used and what made every
 * figure come out misshapen and at a different scale from its neighbours. Those nodes CROP the
 * sampler to the rectangle and render the conditioning to FILL it — so a full-height, one-third-wide
 * column gets a complete figure composed inside a 341×1024 strip, at an effective scale nothing else
 * in the picture shares. Narrow tall boxes are the worst possible shape for it.
 *
 * `ConditioningSetMask` with `set_cond_area: "default"` samples the WHOLE latent and only weights the
 * conditioning spatially. No crop, no rescale — a bias towards a part of the frame rather than a
 * separate little render inside it. The mask is a plain rectangle: a zero mask the size of the canvas
 * with a solid patch composited onto it (`SolidMask` + `MaskComposite`, both core nodes).
 *
 * Strength is below 1 for the same reason: this is meant to nudge where a description lands, not to
 * overrule the composition.
 *
 * The base conditioning stays underneath and is never replaced: it carries the scene, the setting and
 * the composition, and the regions only add "this person, mostly here". Dropping it would produce a
 * picture of N portraits and no scene.
 *
 * Node ids are in the 400s — clear of the base graph (2–19), the IP-Adapter chain (20+), and the
 * video graphs (100s). "399" is the shared empty canvas mask.
 */
function addRegionalConditioning(
  graph: Record<string, unknown>,
  regions: readonly CastRegion[],
  clipRef: [string, number],
  base: [string, number],
  canvas: { width: number; height: number },
): [string, number] {
  // One empty full-canvas mask, shared: each region composites its own patch onto a copy.
  graph["399"] = {
    class_type: "SolidMask",
    inputs: { value: 0, width: canvas.width, height: canvas.height },
  };
  let combined = base;
  regions.forEach((r, i) => {
    const encode = `${400 + i * 5}`;
    const patch = `${401 + i * 5}`;
    const mask = `${402 + i * 5}`;
    const setMask = `${403 + i * 5}`;
    const combine = `${404 + i * 5}`;
    // Columns in pixels, derived from the shared boundaries — rounding each width on its own is
    // how a one-pixel overlap creeps back in, and an overlapping pixel carries both people's
    // conditioning at once. See `regionPixels`.
    const column = regionPixels(r, canvas.width);
    graph[encode] = { class_type: "CLIPTextEncode", inputs: { text: r.text, clip: clipRef } };
    graph[patch] = {
      class_type: "SolidMask",
      inputs: {
        value: 1,
        width: column.width,
        height: Math.max(1, Math.round(r.height * canvas.height)),
      },
    };
    graph[mask] = {
      class_type: "MaskComposite",
      inputs: {
        destination: ["399", 0],
        source: [patch, 0],
        x: column.x,
        y: Math.round(r.y * canvas.height),
        operation: "add",
      },
    };
    graph[setMask] = {
      class_type: "ConditioningSetMask",
      inputs: {
        conditioning: [encode, 0],
        mask: [mask, 0],
        strength: REGION_STRENGTH,
        // "default" = weight the conditioning over the whole latent. "mask bounds" would crop to the
        // rectangle and reintroduce exactly the rescaling this replaced.
        set_cond_area: "default",
      },
    };
    graph[combine] = {
      class_type: "ConditioningCombine",
      inputs: { conditioning_1: combined, conditioning_2: [setMask, 0] },
    };
    combined = [combine, 0];
  });
  return combined;
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
    // img2img: load the uploaded photo, SCALE it to the clamped target (so a 4032×3024 phone photo
    // doesn't sample at ~12 MP → OOM/artifacts), then encode to the latent the sampler denoises from.
    // Mirrors the LTX graph's LoadImage→ImageScale→… ordering. The scale node sits at "2" (the base
    // graph starts at "3", so "0".."2" are always free) — clear of shift (17), hires (18/19), and the
    // IP-Adapter chain (20+), whatever combination is active.
    graph["15"] = { class_type: "LoadImage", inputs: { image: p.initImage.filename } };
    graph["2"] = {
      class_type: "ImageScale",
      inputs: { image: ["15", 0], upscale_method: "lanczos", width: p.width, height: p.height, crop: "center" },
    };
    graph["16"] = { class_type: "VAEEncode", inputs: { pixels: ["2", 0], vae: vaeRef } };
  } else {
    // HiDream uses the 16-channel SD3 latent (it shares the Flux VAE), matching the official
    // workflow; other families' EmptyLatentImage is channel-fixed by the sampler at run time.
    graph["5"] = {
      class_type: isHiDream ? "EmptySD3LatentImage" : "EmptyLatentImage",
      inputs: { width: p.width, height: p.height, batch_size: 1 },
    };
  }
  // Per-character regions fold into the positive conditioning BEFORE guidance and before the hi-res
  // pass copies the sampler's inputs — so both passes sample from the same combined conditioning.
  let conditioned: [string, number] =
    p.regions && p.regions.length > 0
      ? addRegionalConditioning(graph, p.regions, clipRef, ["6", 0], { width: p.width, height: p.height })
      : ["6", 0];
  // Reference photos, for a family that reads them natively — after the regions (which are about
  // WHERE a description applies) and before guidance, so both the base and hi-res passes see them.
  if (p.referenceLatents && p.referenceLatents.length > 0) {
    conditioned = addReferenceLatents(graph, p.referenceLatents, conditioned, vaeRef);
  }
  if (p.sampler.guidance !== undefined) {
    // Flux embedded guidance — conditioning passes through FluxGuidance before the sampler.
    graph["14"] = {
      class_type: "FluxGuidance",
      inputs: { conditioning: conditioned, guidance: p.sampler.guidance },
    };
  } else if (conditioned[0] !== "6") {
    (graph["3"] as { inputs: Record<string, unknown> }).inputs.positive = conditioned;
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

/**
 * Flux.2's own way of taking a reference photo: a ReferenceLatent chain, not an adapter.
 *
 * IP-Adapter bolts a separately-trained adapter onto an SD model, which is why it exists for SD
 * families and nowhere else. Flux.2 doesn't need one — it reads reference images as part of its
 * conditioning, so the whole path is core ComfyUI nodes: encode the photo to a latent and append it
 * to the positive conditioning. NOTHING TO INSTALL: no custom node pack, no adapter weights, no
 * engine restart. That is the whole reason this is worth having beside the IP-Adapter path rather
 * than instead of it.
 *
 * Chained one node per reference, exactly as the official image_flux2_klein_image_edit template
 * does, so several references compose. Scaled through ImageScaleToTotalPixels first (the template's
 * own step): a full-size photo encodes to an enormous latent, and the cost is per reference.
 *
 * Returns the conditioning ref the sampler should read. PURE (mutates the graph it is handed).
 */
function addReferenceLatents(
  graph: Record<string, unknown>,
  filenames: readonly string[],
  base: [string, number],
  vaeRef: [string, number],
): [string, number] {
  let conditioning = base;
  filenames.forEach((filename, i) => {
    // 300-block: clear of the base graph, img2img (15/16), shift (17), hi-res (18/19), the
    // IP-Adapter chain (20+) and regional conditioning (399+).
    const load = String(300 + i * 4);
    const scale = String(301 + i * 4);
    const encode = String(302 + i * 4);
    const ref = String(303 + i * 4);
    graph[load] = { class_type: "LoadImage", inputs: { image: filename } };
    graph[scale] = {
      class_type: "ImageScaleToTotalPixels",
      // EVERY declared input is sent, including `resolution_steps`. It is marked `advanced` in the
      // node's schema, which controls whether the UI shows it — NOT whether the prompt API requires
      // it. Omitting it was read as a missing required input and the whole workflow was rejected
      // (400 prompt_outputs_failed_validation) before a single step ran. A default in the schema is
      // for the node's own UI; the API fills nothing in.
      inputs: { image: [load, 0], upscale_method: "lanczos", megapixels: 1, resolution_steps: 1 },
    };
    graph[encode] = { class_type: "VAEEncode", inputs: { pixels: [scale, 0], vae: vaeRef } };
    graph[ref] = { class_type: "ReferenceLatent", inputs: { conditioning, latent: [encode, 0] } };
    conditioning = [ref, 0];
  });
  return conditioning;
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

/** How long to wait for an engine that reports no model files at all — see `awaitComponentFiles`.
 * Generous because a cold ComfyUI scanning a large models folder is genuinely slow, and bounded
 * because a truly empty install must still reach its error message. */
const ENGINE_FILES_TIMEOUT_MS = 45_000;
const ENGINE_FILES_POLL_MS = 3_000;

/** A short, readable rendering of what the engine says it has — for an error that must let the
 * reader pick a real filename instead of guessing again. */
function listOrNone(names: readonly string[]): string {
  return names.length === 0 ? "nothing" : names.slice(0, 8).join(", ") + (names.length > 8 ? ", …" : "");
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
  hidreamClips?: { clipL?: string; clipG?: string },
): string | undefined {
  const errMsg = status?.messages?.find(([type]) => type === "execution_error")?.[1];
  const raw = typeof errMsg?.exception_message === "string" ? errMsg.exception_message : undefined;
  // ComfyUI's execution_error names the node that threw (node_type + node_id) — surface it so an opaque
  // Python error ("'NoneType' object has no attribute 'device'") points at the exact failing node.
  const nodeType = typeof errMsg?.node_type === "string" ? errMsg.node_type : undefined;
  const nodeId = errMsg?.node_id !== undefined ? String(errMsg.node_id) : undefined;
  const at = nodeType ? ` [node ${nodeType}${nodeId ? ` #${nodeId}` : ""}]` : "";
  if (!raw) {
    return status?.status_str === "error" ? `ComfyUI reported an execution error${at}.` : undefined;
  }
  if (/shapes cannot be multiplied/i.test(raw)) {
    // HiDream loads FOUR encoders via QuadrupleCLIPLoader. A shape mismatch here is almost
    // always clip_g dropping out of the bundle: its 1280-wide pooled is missing, so the pooled
    // is 768 (clip_l only) where the model's p_embedder expects 2048 — NOT a Mistral encoder.
    if (family === "hidream") {
      // Name the EXACT files we handed the loader so the cause is obvious without digging
      // through the console: if clip_g isn't a real clip_g file (or matches clip_l), that's it;
      // if both look right, it's a ComfyUI build too old for HiDream's long clip_l/clip_g.
      const resolved =
        hidreamClips?.clipL || hidreamClips?.clipG
          ? ` Resolved files: clip_l=${hidreamClips.clipL ?? "?"}, clip_g=${hidreamClips.clipG ?? "?"} —` +
            " if clip_g isn't a genuine clip_g (1280-wide) file, that's the cause."
          : "";
      return (
        "HiDream loaded clip_l but not clip_g, so its pooled text embedding is half the expected " +
        "size (768 vs 2048). ComfyUI didn't recognise the clip_g file in the QuadrupleCLIPLoader — " +
        "usually because the ComfyUI build is older than HiDream's long clip_l/clip_g (update ComfyUI), " +
        "or the clip_g file selected for HiDream isn't an actual clip_g." +
        resolved +
        ` Check the clip_g (Settings → Local model) and that ComfyUI is current. (ComfyUI: ${raw})`
      );
    }
    return (
      "The text encoder doesn't match this model. A split-file model needs its OWN encoder " +
      "(Flux.2-dev → Mistral-Small-3.1; Flux.2 Klein → Qwen-3-8B; Z-Image → Qwen-3-4B). Install " +
      "the matching one and pick it under Settings → Advanced: split-file components. " +
      `(ComfyUI: ${raw})`
    );
  }
  return `ComfyUI${at}: ${raw}`;
}

/** Per-family encoder/VAE matching for split-file models (Flux.2 / Z-Image / Qwen-Image).
 * `clip` matches the text-encoder name; `vae` are VAE name-substring hints; `type` is the
 * CLIPLoader type; `what` names it in errors.
 *
 * The encoder patterns are VARIANT-specific on purpose: Qwen-3 ships a 4B (Z-Image) and an 8B
 * (Flux.2 Klein) that are NOT interchangeable (different hidden size → "shapes cannot be
 * multiplied"), and Qwen-Image wants Qwen-2.5-VL, not Qwen-3 at all. A loose `/qwen/` here would
 * recommend/load the wrong sibling when only it is installed (e.g. Z-Image's 4B getting picked for
 * Klein). The exact catalog filename still matches first via pickComponentAsset; these are the
 * fallback, so we keep them tight rather than cross-match families. */
export const SPLIT_FILE_HEURISTICS: Record<
  string,
  { clip: RegExp; vae: string[]; type: string; what: string }
> = {
  flux2: { clip: /mistral|qwen.?3.?8b/i, vae: ["flux2", "flux.2", "flux", "encoder"], type: "flux2", what: "Flux.2" },
  zimage: { clip: /qwen.?3.?4b/i, vae: ["ae.", "z_image", "z-image"], type: "lumina2", what: "Z-Image" },
  qwenimage: { clip: /qwen.?2[._-]?5|qwen.*vl/i, vae: ["qwen"], type: "qwen_image", what: "Qwen-Image" },
};

/** Flux.2 encoder-name patterns ordered by the diffusion model's name: a **4B** Flux.2 pairs with the
 * Qwen-3 **4B** encoder; Klein (9B) uses Qwen-3 **8B**; dev/pro use Mistral-Small. They are NOT
 * interchangeable. The size is read from the MODEL name — only a model that itself says "4b" gets the
 * 4B encoder, so a loose `/qwen.?3/` can't wrongly grab Z-Image's 4B encoder for a bigger Flux.2. The
 * exact catalog filename still matches first in pickComponentAsset — these are the fallback. */
export function flux2EncoderPatterns(model: string): RegExp[] {
  const m = model.toLowerCase();
  const qwen8b = /qwen.?3.?8b/i;
  const qwen4b = /qwen.?3.?4b/i;
  const mistral = /mistral/i;
  // Klein ALWAYS pairs with Qwen-3 8B — even a Klein distill whose name carries a "4b" size tag.
  if (/klein/.test(m)) return [qwen8b, mistral];
  // A non-Klein 4B Flux.2 variant → the Qwen-3 4B encoder. Guard against 14b/24b/94b (a STANDALONE "4b").
  if (/(?:^|[^0-9])4b(?:[^0-9]|$)/.test(m)) return [qwen4b, mistral, qwen8b];
  // dev / pro / generic flux2 → Mistral; qwen8b is only a last-ditch fallback (never the 4B).
  return [mistral, qwen8b];
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
