import { DirectTransport, type Transport } from "../transport/transport.js";
import { base64ToBytes } from "./base64.js";
import type { ImageGenerationInput, ImageGenerationOutput, ImageProvider } from "./image-provider.js";

/**
 * Native image provider for OpenAI ("one API" mode): the same vendor that read the
 * book also draws it. Its advantage over the plain text-to-image path is image
 * INPUTS — when the user has uploaded character reference photos, they're sent to
 * the `/images/edits` endpoint (gpt-image-1 accepts several `image[]` references),
 * so cloud renders get character-consistency conditioning. With no reference photos
 * it falls back to `/images/generations` (plain text-to-image), so it degrades
 * cleanly.
 *
 * Engages only when the user runs OpenAI for both text and images (see
 * buildProviders' native detection).
 */

export interface OpenAINativeImageProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  transport?: Transport;
}

interface ImagesResponse {
  data?: { b64_json?: string }[];
}

export class OpenAINativeImageProvider implements ImageProvider {
  readonly id = "openai";
  private readonly transport: Transport;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: OpenAINativeImageProviderOptions) {
    this.transport = opts.transport ?? new DirectTransport();
    this.model = opts.model ?? "gpt-image-1";
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.apiKey = opts.apiKey;
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    const size = pickSize(input.width, input.height);
    const refs = input.ipAdapterRefs ?? [];
    // /images/edits conditions on input photos: the img2img base first (the image to
    // transform), then any character references. Plain generation when there are none.
    const editFiles = [
      ...(input.initImage
        ? [
            {
              field: "image[]",
              bytes: input.initImage.bytes,
              filename: "base.png",
              contentType: input.initImage.mimeType || "image/png",
            },
          ]
        : []),
      ...refs.map((ref, i) => ({
        field: "image[]",
        bytes: ref.bytes,
        filename: `reference-${i}.png`,
        contentType: ref.mimeType || "image/png",
      })),
    ];
    const res = editFiles.length
      ? await this.transport.send({
          url: `${this.baseUrl}/images/edits`,
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}` },
          multipart: {
            fields: { model: this.model, prompt: input.prompt, n: "1", size },
            files: editFiles,
          },
          ...(input.signal ? { signal: input.signal } : {}),
        })
      : await this.transport.send({
          url: `${this.baseUrl}/images/generations`,
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}` },
          body: { model: this.model, prompt: input.prompt, n: 1, size },
          ...(input.signal ? { signal: input.signal } : {}),
        });
    if (!res.ok) throw new Error(`OpenAI native image request failed with status ${res.status}`);
    const data = await res.json<ImagesResponse>();
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error("OpenAI native image response contained no image data");
    const supplied = refs.length;
    return {
      bytes: base64ToBytes(b64),
      mimeType: "image/png",
      // Each reference went up as a file on /images/edits, so all of them reached the model.
      ...(supplied ? { references: { supplied, used: supplied, how: "native" as const } } : {}),
    };
  }
}

/** gpt-image-1 accepts a fixed set of sizes; map the request to the closest. */
function pickSize(width?: number, height?: number): string {
  const w = width ?? 1024;
  const h = height ?? 1024;
  if (w > h) return "1536x1024";
  if (h > w) return "1024x1536";
  return "1024x1024";
}
