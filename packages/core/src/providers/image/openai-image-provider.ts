import { DirectTransport, type Transport } from "../transport/transport.js";
import { base64ToBytes } from "./base64.js";
import type { ImageGenerationInput, ImageGenerationOutput, ImageProvider } from "./image-provider.js";

/**
 * Cloud image provider backed by OpenAI's image API (`gpt-image-1`), for users
 * who bring an OpenAI key. Uses the REST images endpoint through the injectable
 * `Transport` seam; the image comes back inline as base64 (`b64_json`).
 */

export interface OpenAIImageProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  transport?: Transport;
}

interface ImagesResponse {
  data?: { b64_json?: string }[];
}

export class OpenAIImageProvider implements ImageProvider {
  readonly id = "openai";
  private readonly transport: Transport;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: OpenAIImageProviderOptions) {
    this.transport = opts.transport ?? new DirectTransport();
    this.model = opts.model ?? "gpt-image-1";
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.apiKey = opts.apiKey;
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    const size = pickSize(input.width, input.height);
    const res = await this.transport.send({
      url: `${this.baseUrl}/images/generations`,
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: { model: this.model, prompt: input.prompt, n: 1, size },
    });
    if (!res.ok) throw new Error(`OpenAI image request failed with status ${res.status}`);
    const data = await res.json<ImagesResponse>();
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error("OpenAI image response contained no image data");
    return { bytes: base64ToBytes(b64), mimeType: "image/png" };
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
