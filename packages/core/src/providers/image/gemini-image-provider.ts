import { DirectTransport, type Transport } from "../transport/transport.js";
import { base64ToBytes } from "./base64.js";
import type { ImageGenerationInput, ImageGenerationOutput, ImageProvider } from "./image-provider.js";

/**
 * Cloud image provider backed by Google's Imagen (via the Gemini API), for users
 * who bring a Gemini key. Uses the REST `:predict` endpoint through the
 * injectable `Transport` seam; the image comes back inline as base64.
 */

export interface GeminiImageProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  transport?: Transport;
}

interface PredictResponse {
  predictions?: { bytesBase64Encoded?: string; mimeType?: string }[];
}

export class GeminiImageProvider implements ImageProvider {
  readonly id = "gemini";
  private readonly transport: Transport;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: GeminiImageProviderOptions) {
    this.transport = opts.transport ?? new DirectTransport();
    this.model = opts.model ?? "imagen-3.0-generate-002";
    this.baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.apiKey = opts.apiKey;
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    const res = await this.transport.send({
      url: `${this.baseUrl}/models/${this.model}:predict?key=${this.apiKey}`,
      method: "POST",
      body: {
        instances: [{ prompt: input.prompt }],
        parameters: { sampleCount: 1, aspectRatio: imagenAspectRatio(input.width, input.height) },
      },
    });
    if (!res.ok) throw new Error(`Gemini image request failed with status ${res.status}`);
    const data = await res.json<PredictResponse>();
    const prediction = data.predictions?.[0];
    if (!prediction?.bytesBase64Encoded) {
      throw new Error("Gemini image response contained no image data");
    }
    return {
      bytes: base64ToBytes(prediction.bytesBase64Encoded),
      mimeType: prediction.mimeType ?? "image/png",
    };
  }
}

/**
 * Map requested pixel dimensions to the nearest aspect ratio Imagen supports
 * ("1:1" / "3:4" portrait / "4:3" landscape). Our portrait/landscape canvases are 2:3
 * / 3:2, which Imagen doesn't offer exactly, so the closest supported orientation is used.
 */
function imagenAspectRatio(width?: number, height?: number): string {
  const w = width ?? 1024;
  const h = height ?? 1024;
  if (h > w) return "3:4";
  if (w > h) return "4:3";
  return "1:1";
}
