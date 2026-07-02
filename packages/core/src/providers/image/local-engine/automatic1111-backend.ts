import { base64ToBytes } from "../base64.js";
import { DirectTransport, type Transport, type TransportResponse } from "../../transport/transport.js";
import { scaleSteps } from "../../../quality.js";
import type { ImageGenerationInput, ImageGenerationOutput } from "../image-provider.js";
import {
  clampResolution,
  composeSdPositive,
  isFlux,
  isNaturalLanguage,
  nameHandlingFor,
  resolveModelFamily,
  resolveNegative,
  samplerFor,
} from "../sd-prompt.js";
import { expandPrompt } from "../bible-injection.js";
import type { LocalEngineBackend, LocalModelDescriptor } from "./backend.js";

/**
 * AUTOMATIC1111 (Stable Diffusion web UI) engine backend. Drives a local A1111
 * server over its REST API (started with `--api`):
 *  - listModels → GET  /sdapi/v1/sd-models  (the installed checkpoints)
 *  - generate   → POST /sdapi/v1/txt2img    (returns the image as base64 PNG)
 *
 * Same `LocalEngineBackend` contract as `ComfyUIBackend`, so the provider and UI
 * treat the two interchangeably — the user just picks which one to talk to. The
 * base URL and `Transport` are injected, so it is unit-testable with a fake
 * transport and runs unchanged against a real localhost server or a proxy.
 *
 * For the browser to reach the server, A1111 must allow the app origin, e.g.:
 *   ./webui.sh --api --cors-allow-origins=http://localhost:5173
 */

export interface Automatic1111BackendOptions {
  /** Base URL of the running A1111 server (default port is 7860). */
  baseUrl: string;
  transport?: Transport;
  /** Sampler name as A1111 knows it (default "Euler"). */
  sampler?: string;
  cfgScale?: number;
}

/**
 * A1111 base URLs whose checkpoint we UNLOADED via `freeMemory` (VRAM hand-off) and haven't reloaded yet.
 * `/sdapi/v1/unload-checkpoint` moves the model OFF the GPU and A1111 does NOT auto-reload it on the next
 * txt2img — worse, a same-name `override_settings.sd_model_checkpoint` reads as "no change" and is skipped,
 * so the render runs against an unloaded model (blank/`NoneType`). The render must explicitly
 * `/sdapi/v1/reload-checkpoint` first. Module-level (a Set of base URLs) so it survives the throwaway
 * backend instances the app builds per call — freeMemory and generate are usually different instances.
 */
const unloadedCheckpoints = new Set<string>();

interface SdModel {
  /** "model.safetensors [hash]" — the value `sd_model_checkpoint` expects. */
  title: string;
  /** Friendlier short name for the picker. */
  model_name: string;
}

interface Txt2ImgResponse {
  /** Base64-encoded images (no `data:` prefix in current A1111, but tolerate it). */
  images?: string[];
}

export class Automatic1111Backend implements LocalEngineBackend {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly sampler: string;
  private readonly cfgScale: number;
  private modelsCache?: Promise<LocalModelDescriptor[]>;

  constructor(opts: Automatic1111BackendOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.transport = opts.transport ?? new DirectTransport();
    this.sampler = opts.sampler ?? "Euler";
    this.cfgScale = opts.cfgScale ?? 7;
  }

  /** Resolve a wanted checkpoint to an installed model title, or undefined. */
  private async resolveCheckpoint(wanted: string): Promise<string | undefined> {
    try {
      if (!this.modelsCache) this.modelsCache = this.listModels();
      const target = wanted.toLowerCase();
      const hit = (await this.modelsCache).find(
        (m) =>
          m.id.toLowerCase() === target ||
          m.label.toLowerCase() === target ||
          m.id.toLowerCase().startsWith(target) ||
          m.label.toLowerCase().startsWith(target),
      );
      return hit?.id;
    } catch {
      return undefined;
    }
  }

  async listModels(): Promise<LocalModelDescriptor[]> {
    const res = await this.transport.send({
      url: `${this.baseUrl}/sdapi/v1/sd-models`,
      method: "GET",
      // Inventory endpoint: answers instantly on a live engine — never let it hang a model listing.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(await a1111Error("listModels", res));
    const data = await res.json<SdModel[]>();
    return (data ?? []).map((m) => ({ id: m.title, label: m.model_name || m.title, sizeGB: 0 }));
  }

  /** AUTOMATIC1111 serves all-in-one SD/SDXL checkpoints — the text encoder + VAE are baked
   * into the checkpoint, so there are no separate component files to pick. */
  async listComponents(): Promise<{ textEncoders: string[]; vaes: string[] }> {
    return { textEncoders: [], vaes: [] };
  }

  async generate(input: ImageGenerationInput, model: string): Promise<ImageGenerationOutput> {
    const seed = input.seed ?? input.anchors[0]?.seed ?? Math.floor(Math.random() * 1_000_000_000);

    // Style checkpoint override when installed; else keep the user's model.
    let checkpoint = model;
    if (input.styleCheckpoint) {
      const resolved = await this.resolveCheckpoint(input.styleCheckpoint);
      if (resolved) checkpoint = resolved;
    }

    const family = resolveModelFamily(input.modelFamily, checkpoint);
    // Diffusion-only split-file models (separate text encoder(s) + VAE) have no
    // AUTOMATIC1111 equivalent here — HiDream additionally needs a four-encoder
    // QuadrupleCLIPLoader. Point the user at the ComfyUI engine instead.
    if (family === "flux2") {
      throw new Error("Flux.2 isn't supported on the AUTOMATIC1111 engine — use the ComfyUI engine for Flux.2.");
    }
    if (family === "hidream") {
      throw new Error("HiDream isn't supported on the AUTOMATIC1111 engine — use the ComfyUI engine for HiDream.");
    }
    // Family-aware sampler: Flux uses embedded guidance (cfg≈1) + its own step count;
    // SD keeps the configured sampler/cfg and the quality-profile steps. Distilled
    // few-step models (recommended ≤ 10) never scale; NL families scale by level.
    const sampler = samplerFor(family);
    const level = input.renderQuality ?? "standard";
    const steps =
      sampler.steps <= 10
        ? sampler.steps
        : isNaturalLanguage(family)
          ? scaleSteps(sampler.steps, level)
          : (input.steps ?? (input.quality === "sketch" ? 6 : input.quality === "standard" ? 20 : 35));
    const { width, height } = clampResolution(family, input.width ?? 1024, input.height ?? 1024);

    // Expand bible terms (inject descriptors for CLIP/T5 families), then SD tags/negative.
    const expanded = expandPrompt(
      input.prompt,
      input.terms ?? [],
      nameHandlingFor(family),
      input.worldStyle,
      input.bookTitle,
    );
    let prompt = composeSdPositive(family, expanded);
    if (input.styleLora) {
      const trigger = input.styleLora.trigger ? `${input.styleLora.trigger}, ` : "";
      prompt = `${trigger}${prompt} <lora:${input.styleLora.name}:${input.styleLora.strength}>`;
    }

    const body: Record<string, unknown> = {
      prompt,
      negative_prompt: resolveNegative(family, input.negativePrompt),
      steps,
      cfg_scale: isFlux(family) ? sampler.cfg : this.cfgScale,
      sampler_name: this.sampler,
      seed,
      width,
      height,
    };
    // Pin a specific checkpoint when one is chosen; otherwise A1111 uses whatever
    // it currently has loaded.
    if (checkpoint) body.override_settings = { sd_model_checkpoint: checkpoint };

    // Cancellation (user paused images): abort the HTTP AND tell A1111 to interrupt
    // the running job so the GPU frees immediately.
    const signal = input.signal;
    const onAbort = (): void => {
      void this.interrupt();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // If we unloaded this A1111's checkpoint for a VRAM hand-off, bring it back onto the GPU FIRST —
      // txt2img won't reload it on its own, and our same-name override_settings won't trigger a reload.
      await this.ensureCheckpointLoaded(signal);
      const res = await this.transport.send({
        url: `${this.baseUrl}/sdapi/v1/txt2img`,
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(await a1111Error("txt2img", res));
      const data = await res.json<Txt2ImgResponse>();
      const b64 = data.images?.[0];
      if (!b64) throw new Error("Automatic1111 returned no image");
      // The render succeeded, so the checkpoint is definitely loaded now — clear any stale unloaded mark.
      unloadedCheckpoints.delete(this.baseUrl);
      // Some builds prefix with "data:image/png;base64,"; strip it if present.
      const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
      return { bytes: base64ToBytes(clean), mimeType: "image/png" };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Reload the checkpoint onto the GPU when a prior `freeMemory` unloaded it (see `unloadedCheckpoints`).
   * `/sdapi/v1/reload-checkpoint` loads A1111's currently-selected checkpoint; the render's
   * `override_settings` then switches to a different one if needed (a name change DOES trigger a load).
   * Best-effort + awaited so the model is on the GPU before txt2img; leaves the mark set if it fails so a
   * later render retries.
   */
  private async ensureCheckpointLoaded(signal?: AbortSignal): Promise<void> {
    if (!unloadedCheckpoints.has(this.baseUrl)) return;
    try {
      await this.transport.send({
        url: `${this.baseUrl}/sdapi/v1/reload-checkpoint`,
        method: "POST",
        body: {},
        ...(signal ? { signal } : {}),
      });
    } catch {
      /* best-effort — the render's override_settings may still bring the checkpoint back */
    }
  }

  /** Tell A1111 to interrupt the running job (best-effort; ignores errors). */
  private async interrupt(): Promise<void> {
    try {
      await this.transport.send({ url: `${this.baseUrl}/sdapi/v1/interrupt`, method: "POST", body: {} });
    } catch {
      /* best-effort — the HTTP abort already stopped us waiting */
    }
  }

  /**
   * Unload A1111's checkpoint from VRAM (POST /sdapi/v1/unload-checkpoint) so a co-resident local LLM (or a
   * ComfyUI video render) can reclaim the GPU — the same hand-off ComfyUI's /free gives. A1111 does NOT
   * reload on its own, so we MARK this base URL as unloaded (`unloadedCheckpoints`) and the next `generate`
   * reloads the checkpoint before rendering. Crucially this also lets the app FREE the chat LLM before an
   * A1111 render: A1111 picks its VRAM/shared-RAM split at load time from whatever's free, so loading into a
   * GPU still occupied by the LLM permanently strands part of the model in slow shared RAM. Best-effort:
   * freeing is an optimization, never required for correctness.
   */
  async freeMemory(): Promise<void> {
    try {
      await this.transport.send({ url: `${this.baseUrl}/sdapi/v1/unload-checkpoint`, method: "POST", body: {} });
      unloadedCheckpoints.add(this.baseUrl); // the next render must reload-checkpoint before txt2img
    } catch {
      /* best-effort — the GPU just stays warm if A1111 can't unload right now (e.g. an older build) */
    }
  }
}

/**
 * Turn an A1111 error response into a message that names the actual cause. A1111 returns a JSON body on
 * failures — `{ error, detail, errors }` (e.g. error: "OutOfMemoryError", or detail naming a checkpoint it
 * couldn't load) — so a bare "status 500" hides the one fact that explains it. Read that body and surface
 * it; fall back to a truncated text snippet, then to the status alone if the body is unreadable.
 */
async function a1111Error(verb: string, res: TransportResponse): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown; detail?: unknown; errors?: unknown };
    const parts: string[] = [];
    for (const v of [body.error, body.detail, body.errors]) {
      if (v) parts.push(typeof v === "string" ? v : JSON.stringify(v));
    }
    detail = parts.join(" — ");
  } catch {
    try {
      detail = (await res.text()).slice(0, 600).trim();
    } catch {
      /* body unreadable — fall back to the status alone */
    }
  }
  // A 500 on txt2img is most often a checkpoint the server doesn't have (a stale/blank model setting — common
  // after a fresh/incognito session loses its saved settings) or a CUDA out-of-memory.
  const hint =
    res.status === 500 && verb === "txt2img"
      ? " (often a checkpoint the server doesn't have — check the selected model in Settings — or a GPU out-of-memory)"
      : "";
  return `Automatic1111 ${verb} failed with status ${res.status}${detail ? `: ${detail}` : ""}${hint}`;
}
