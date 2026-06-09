import { base64ToBytes } from "../base64.js";
import { DirectTransport, type Transport } from "../../transport/transport.js";
import type { ImageGenerationInput, ImageGenerationOutput } from "../image-provider.js";
import { composeSdPositive, resolveModelFamily, resolveNegative } from "../sd-prompt.js";
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
    });
    if (!res.ok) throw new Error(`Automatic1111 listModels failed with status ${res.status}`);
    const data = await res.json<SdModel[]>();
    return (data ?? []).map((m) => ({ id: m.title, label: m.model_name || m.title, sizeGB: 0 }));
  }

  async generate(input: ImageGenerationInput, model: string): Promise<ImageGenerationOutput> {
    const seed = input.anchors[0]?.seed ?? Math.floor(Math.random() * 1_000_000_000);
    const steps =
      input.steps ?? (input.quality === "sketch" ? 6 : input.quality === "standard" ? 20 : 35);

    // Style checkpoint override when installed; else keep the user's model.
    let checkpoint = model;
    if (input.styleCheckpoint) {
      const resolved = await this.resolveCheckpoint(input.styleCheckpoint);
      if (resolved) checkpoint = resolved;
    }

    // Format the prompt for the model family: SD models get quality tags + light
    // identity emphasis + a real negative prompt; Flux gets natural language only.
    const family = resolveModelFamily(input.modelFamily, checkpoint);
    let prompt = composeSdPositive(family, input.prompt, input.subjects);
    if (input.styleLora) {
      const trigger = input.styleLora.trigger ? `${input.styleLora.trigger}, ` : "";
      prompt = `${trigger}${prompt} <lora:${input.styleLora.name}:${input.styleLora.strength}>`;
    }

    const body: Record<string, unknown> = {
      prompt,
      negative_prompt: resolveNegative(family, input.negativePrompt),
      steps,
      cfg_scale: this.cfgScale,
      sampler_name: this.sampler,
      seed,
      width: input.width ?? 1024,
      height: input.height ?? 1024,
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
      const res = await this.transport.send({
        url: `${this.baseUrl}/sdapi/v1/txt2img`,
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`Automatic1111 txt2img failed with status ${res.status}`);
      const data = await res.json<Txt2ImgResponse>();
      const b64 = data.images?.[0];
      if (!b64) throw new Error("Automatic1111 returned no image");
      // Some builds prefix with "data:image/png;base64,"; strip it if present.
      const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
      return { bytes: base64ToBytes(clean), mimeType: "image/png" };
    } finally {
      signal?.removeEventListener("abort", onAbort);
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
}
