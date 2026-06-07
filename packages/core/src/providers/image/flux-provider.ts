import { DirectTransport, type Transport } from "../transport/transport.js";
import type { ImageGenerationInput, ImageGenerationOutput, ImageProvider } from "./image-provider.js";

/**
 * Cloud image provider backed by a Flux-style diffusion API (default cloud tier).
 *
 * There is no first-party SDK for image generation, so this goes through the
 * `Transport` seam — swap `DirectTransport` for a proxy transport to make it
 * server-ready without changing this class. The exact request/response shape is
 * provider-specific; this targets the common "submit prompt → poll → fetch png"
 * pattern and is deliberately small so other providers (Midjourney, SDXL) can
 * follow the same interface.
 */

export interface FluxProviderOptions {
  apiKey: string;
  /** Endpoint that accepts a prompt and returns image bytes (or a URL). */
  endpoint?: string;
  transport?: Transport;
}

interface FluxResponse {
  /** Base64-encoded image, when returned inline. */
  image?: string;
  /** URL to fetch the image from, when returned by reference. */
  imageUrl?: string;
}

export class FluxProvider implements ImageProvider {
  readonly id = "flux";
  private readonly transport: Transport;
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(opts: FluxProviderOptions) {
    this.transport = opts.transport ?? new DirectTransport();
    this.endpoint = opts.endpoint ?? "https://api.bfl.ai/v1/flux";
    this.apiKey = opts.apiKey;
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    const res = await this.transport.send({
      url: this.endpoint,
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        prompt: input.prompt,
        // Identity anchors → deterministic seed for character consistency.
        seed: input.anchors[0]?.seed,
        width: input.width ?? 1024,
        height: input.height ?? 1024,
        steps: input.quality === "sketch" ? 4 : input.quality === "standard" ? 20 : 40,
      },
    });
    if (!res.ok) {
      throw new Error(`Flux request failed with status ${res.status}`);
    }

    const data = await res.json<FluxResponse>();
    if (data.image) {
      return { bytes: base64ToBytes(data.image), mimeType: "image/png" };
    }
    if (data.imageUrl) {
      const img = await this.transport.send({ url: data.imageUrl, method: "GET" });
      return { bytes: await img.arrayBuffer(), mimeType: "image/png" };
    }
    throw new Error("Flux response contained no image data");
  }
}

function base64ToBytes(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
