import { DirectTransport, type Transport } from "../transport/transport.js";
import { base64ToBytes, bytesToBase64 } from "./base64.js";
import type { ImageGenerationInput, ImageGenerationOutput, ImageProvider } from "./image-provider.js";

/**
 * Native multimodal image provider for Gemini ("one API" mode): the SAME vendor
 * that read the book also draws it, via the multimodal `generateContent` endpoint
 * (gemini-2.5-flash-image, aka "Nano Banana") instead of the text-only Imagen
 * `:predict` path. Its advantage is image INPUTS — the user's uploaded character
 * reference photos are sent inline, so cloud renders get the character-consistency
 * conditioning that previously needed a local ComfyUI + IP-Adapter setup.
 *
 * Engages only when the user runs Gemini for both text and images (see
 * buildProviders' native detection). Falls back to plain text-to-image when no
 * reference photos are present, so it degrades cleanly.
 */

export interface GeminiNativeImageProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  transport?: Transport;
}

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

export class GeminiNativeImageProvider implements ImageProvider {
  readonly id = "gemini";
  private readonly transport: Transport;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: GeminiNativeImageProviderOptions) {
    this.transport = opts.transport ?? new DirectTransport();
    this.model = opts.model ?? "gemini-2.5-flash-image";
    this.baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.apiKey = opts.apiKey;
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    // The prompt text, then each reference photo as an inline image part — the model
    // treats them as "make the character look like this" conditioning.
    const parts: Record<string, unknown>[] = [{ text: input.prompt }];
    for (const ref of input.ipAdapterRefs ?? []) {
      parts.push({
        inline_data: { mime_type: ref.mimeType, data: bytesToBase64(ref.bytes) },
      });
    }
    const res = await this.transport.send({
      url: `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
      method: "POST",
      body: {
        contents: [{ role: "user", parts }],
        // Ask for an image back; some models also emit a stray text part — we ignore it.
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
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
        return { bytes: base64ToBytes(b64), mimeType };
      }
    }
    throw new Error("Gemini native image response contained no image data");
  }
}
