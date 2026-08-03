import { DirectTransport, type Transport } from "../transport/transport.js";
import { MATURE_SAFETY_SETTINGS } from "../gemini-safety.js";
import { base64ToBytes, bytesToBase64 } from "./base64.js";
import type { ImageGenerationInput, ImageGenerationOutput, ImageProvider } from "./image-provider.js";

/**
 * Native multimodal image provider for Gemini ("one API" mode): the SAME vendor
 * that read the book also draws it, via the multimodal `generateContent` endpoint
 * instead of the text-only Imagen `:predict` path. Its advantage is image INPUTS —
 * the user's uploaded character reference photos are sent inline, so cloud renders
 * get the character-consistency conditioning that previously needed a local ComfyUI
 * + IP-Adapter setup. Falls back to plain text-to-image when no reference photos are
 * present, so it degrades cleanly.
 *
 * Model selection is AUTOMATIC so any Google key "just works": on first use it lists
 * the models the key can actually access and picks the best image-capable Gemini one
 * (preferring "Pro" — Nano Banana Pro — over "Flash" — Nano Banana). This avoids
 * hardcoding a model id a given key/project may not be entitled to. An explicit
 * `model` option pins one and skips discovery; if discovery fails, a safe default is
 * used.
 */

export interface GeminiNativeImageProviderOptions {
  apiKey: string;
  /** Pin a specific model (skips auto-discovery). */
  model?: string;
  baseUrl?: string;
  transport?: Transport;
  /** Mature mode: BLOCK_NONE safetySettings so adult source scenes aren't filtered. */
  allowMature?: boolean;
}

/** Used when discovery fails AND no model was pinned — broadly available on a standard key. */
export const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";

interface GenerateContentResponse {
  candidates?: {
    content?: {
      parts?: {
        text?: string;
        inlineData?: { mimeType?: string; data?: string };
        inline_data?: { mime_type?: string; data?: string };
      }[];
    };
  }[];
}

interface ModelsListResponse {
  models?: { name?: string; supportedGenerationMethods?: string[] }[];
}

/**
 * Reference photos are stable per character for the whole book, but were being
 * re-encoded to base64 (multi-MB string churn) on every render. The pipeline
 * passes the same ArrayBuffer objects each time, so identity-keyed memoisation
 * encodes each upload once per session.
 */
const refBase64Cache = new WeakMap<ArrayBuffer, string>();
function cachedBase64(bytes: ArrayBuffer): string {
  let b64 = refBase64Cache.get(bytes);
  if (b64 === undefined) {
    b64 = bytesToBase64(bytes);
    refBase64Cache.set(bytes, b64);
  }
  return b64;
}

export class GeminiNativeImageProvider implements ImageProvider {
  readonly id = "gemini";
  private readonly transport: Transport;
  private readonly explicitModel: string | undefined;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly safetySettings?: readonly { category: string; threshold: string }[];
  /** Memoised model resolution (discovery runs once, then is reused). */
  private modelPromise: Promise<string> | undefined;

  constructor(opts: GeminiNativeImageProviderOptions) {
    this.transport = opts.transport ?? new DirectTransport();
    this.explicitModel = opts.model;
    this.baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.apiKey = opts.apiKey;
    if (opts.allowMature) this.safetySettings = MATURE_SAFETY_SETTINGS;
  }

  /** The image model to use — a pinned one, or the best the key can access (cached). */
  private resolveModel(): Promise<string> {
    if (this.explicitModel) return Promise.resolve(this.explicitModel);
    // Assign the promise synchronously so concurrent first renders share one discovery.
    if (!this.modelPromise) this.modelPromise = this.discoverModel();
    return this.modelPromise;
  }

  private async discoverModel(): Promise<string> {
    try {
      const res = await this.transport.send({
        url: `${this.baseUrl}/models?key=${this.apiKey}&pageSize=1000`,
        method: "GET",
      });
      if (res.ok) {
        const data = await res.json<ModelsListResponse>();
        const best = pickBestGeminiImageModel(data.models ?? []);
        if (best) return best;
      }
    } catch {
      /* network/parse failure → fall back to the default below */
    }
    return DEFAULT_GEMINI_IMAGE_MODEL;
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    const model = await this.resolveModel();
    // The prompt text, then each reference photo as an inline image part — the model
    // treats them as "make the character look like this" conditioning.
    const parts: Record<string, unknown>[] = [{ text: input.prompt }];
    // img2img base photo first (the image to transform), then any character refs.
    if (input.initImage) {
      parts.push({
        inline_data: { mime_type: input.initImage.mimeType, data: cachedBase64(input.initImage.bytes) },
      });
    }
    for (const ref of input.ipAdapterRefs ?? []) {
      parts.push({
        inline_data: { mime_type: ref.mimeType, data: cachedBase64(ref.bytes) },
      });
    }
    const res = await this.transport.send({
      url: `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`,
      method: "POST",
      body: {
        contents: [{ role: "user", parts }],
        // Ask for an image back; some models also emit a stray text part — we ignore it.
        // imageConfig carries the canvas orientation (the API takes a ratio, not pixels).
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: geminiAspectRatio(input.width, input.height) },
        },
        ...(this.safetySettings ? { safetySettings: this.safetySettings } : {}),
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!res.ok) throw new Error(`Gemini native image request failed with status ${res.status}`);
    const data = await res.json<GenerateContentResponse>();
    for (const part of data.candidates?.[0]?.content?.parts ?? []) {
      const inline = part.inlineData ?? part.inline_data;
      const b64 = inline?.data;
      if (b64) {
        const mimeType =
          (part.inlineData?.mimeType ?? part.inline_data?.mime_type) || "image/png";
        // Every reference rides as its own inline part, so all of them reached the model. Said out
        // loud because "did my photos get used?" is otherwise unanswerable from the picture.
        const supplied = input.ipAdapterRefs?.length ?? 0;
        return {
          bytes: base64ToBytes(b64),
          mimeType,
          ...(supplied ? { references: { supplied, used: supplied, how: "native" as const } } : {}),
        };
      }
    }
    throw new Error("Gemini native image response contained no image data");
  }
}

/**
 * Map requested pixel dimensions to the closest aspect ratio the generateContent
 * imageConfig supports. Our portrait/landscape canvases are 2:3 / 3:2, which the API
 * offers directly; square stays 1:1.
 */
export function geminiAspectRatio(width?: number, height?: number): string {
  const w = width ?? 1024;
  const h = height ?? 1024;
  if (h > w) return "2:3";
  if (w > h) return "3:2";
  return "1:1";
}

/**
 * From a `models.list` response, pick the best Gemini IMAGE model the key can use.
 * Ranked by capability so any key auto-selects the best it's entitled to:
 *   Pro (Nano Banana Pro) > Flash (Nano Banana), then higher version, stable over preview.
 * Matched by NAME (the stable field) rather than capability flags whose shape varies.
 * Imagen (a `:predict` model, not `generateContent`) is excluded — this provider only
 * speaks generateContent. Returns undefined when the key exposes no Gemini image model.
 */
export function pickBestGeminiImageModel(
  models: { name?: string; supportedGenerationMethods?: string[] }[],
): string | undefined {
  const candidates = models
    .map((m) => ({ name: (m.name ?? "").replace(/^models\//, ""), methods: m.supportedGenerationMethods }))
    .filter((m) => /gemini/i.test(m.name) && /image/i.test(m.name) && !/vision/i.test(m.name))
    // If the API reports methods, require generateContent; if it doesn't, keep it (tolerant).
    .filter((m) => !m.methods || m.methods.some((x) => /generatecontent/i.test(x)));
  if (candidates.length === 0) return undefined;
  return candidates.map((m) => m.name).sort((a, b) => scoreModel(b) - scoreModel(a))[0];
}

function scoreModel(name: string): number {
  let s = 0;
  if (/\bpro\b|-pro/i.test(name)) s += 1000;
  else if (/flash/i.test(name)) s += 500;
  const version = name.match(/gemini-(\d+(?:\.\d+)?)/i);
  if (version) s += parseFloat(version[1]!) * 10;
  if (/preview|exp\b/i.test(name)) s -= 1; // prefer a stable id when both exist
  return s;
}
