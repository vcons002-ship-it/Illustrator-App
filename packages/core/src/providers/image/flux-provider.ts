import { DirectTransport, type Transport } from "../transport/transport.js";
import { base64ToBytes } from "./base64.js";
import type { ImageGenerationInput, ImageGenerationOutput, ImageProvider } from "./image-provider.js";

/**
 * Cloud image provider backed by Black Forest Labs' Flux API (default cloud tier).
 *
 * Flux is asynchronous: you POST a prompt and get back a request id + polling URL,
 * then poll until the result is "Ready" and finally download the image from a
 * short-lived signed URL. This implements that submit → poll → download flow
 * through the injectable `Transport` seam (swap `DirectTransport` for a proxy to
 * make it server-ready). A simpler synchronous provider (e.g. fal.ai, which
 * returns an image URL from a single call) would implement the same
 * `ImageProvider` interface with far less code.
 */

export interface FluxProviderOptions {
  apiKey: string;
  /** Submit endpoint. Defaults to Flux Pro 1.1. */
  endpoint?: string;
  transport?: Transport;
  /** Delay between polls (ms). Lower in tests for determinism. */
  pollIntervalMs?: number;
  /** Max number of polls before giving up. */
  maxPolls?: number;
  /**
   * Mature mode: send `safety_tolerance: 6` (BFL's most permissive; default is 2)
   * so adult source scenes aren't moderation-blocked. Off by default.
   */
  allowMature?: boolean;
}

interface SubmitResponse {
  id: string;
  polling_url: string;
}

interface PollResponse {
  status: string; // "Pending" | "Ready" | "Error" | "Content Moderated" | …
  result?: { sample?: string };
}

export class FluxProvider implements ImageProvider {
  readonly id = "flux";
  private readonly transport: Transport;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly safetyTolerance?: number;

  constructor(opts: FluxProviderOptions) {
    this.transport = opts.transport ?? new DirectTransport();
    this.endpoint = opts.endpoint ?? "https://api.bfl.ai/v1/flux-pro-1.1";
    this.apiKey = opts.apiKey;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.maxPolls = opts.maxPolls ?? 60;
    if (opts.allowMature) this.safetyTolerance = 6;
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    const headers = { "x-key": this.apiKey };
    // Honour the caller's cancellation (pause/book switch) at every stage — without
    // it a pause kept polling (and downloading) a render nobody wanted anymore.
    const signal = input.signal;

    // 1) SUBMIT — returns a request id + polling URL, not the image.
    const submit = await this.transport.send({
      url: this.endpoint,
      method: "POST",
      headers,
      body: {
        prompt: input.prompt,
        // An explicit render seed (e.g. a pinned keyEvent seed) wins, else the identity anchor's
        // seed for character consistency — matching the local backends' `input.seed ?? anchor` order,
        // so a pinned-seed re-render actually reproduces.
        seed: input.seed ?? input.anchors[0]?.seed,
        width: input.width ?? 1024,
        height: input.height ?? 1024,
        steps: input.quality === "sketch" ? 4 : input.quality === "standard" ? 20 : 40,
        ...(this.safetyTolerance !== undefined ? { safety_tolerance: this.safetyTolerance } : {}),
      },
      ...(signal ? { signal } : {}),
    });
    if (!submit.ok) throw new Error(`Flux submit failed with status ${submit.status}`);
    const { id, polling_url } = await submit.json<SubmitResponse>();

    // 2) POLL — until the job is Ready (or fails).
    for (let i = 0; i < this.maxPolls; i++) {
      if (signal?.aborted) throw new Error("Flux generation cancelled");
      const res = await this.transport.send({
        url: `${polling_url}?id=${encodeURIComponent(id)}`,
        method: "GET",
        headers,
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`Flux poll failed with status ${res.status}`);
      const poll = await res.json<PollResponse>();
      if (poll.status === "Ready") {
        const sample = poll.result?.sample;
        if (!sample) throw new Error("Flux reported Ready but returned no image");
        return this.download(sample, signal);
      }
      if (poll.status === "Error" || poll.status === "Content Moderated") {
        throw new Error(`Flux generation failed: ${poll.status}`);
      }
      await delay(this.pollIntervalMs, signal);
    }
    throw new Error("Flux generation timed out");
  }

  // 3) DOWNLOAD — the sample URL is a short-lived signed URL to raw image bytes.
  private async download(sampleUrl: string, signal?: AbortSignal): Promise<ImageGenerationOutput> {
    if (sampleUrl.startsWith("data:")) {
      const b64 = sampleUrl.slice(sampleUrl.indexOf(",") + 1);
      return { bytes: base64ToBytes(b64), mimeType: "image/png" };
    }
    const img = await this.transport.send({
      url: sampleUrl,
      method: "GET",
      ...(signal ? { signal } : {}),
    });
    if (!img.ok) throw new Error(`Flux download failed with status ${img.status}`);
    return { bytes: await img.arrayBuffer(), mimeType: "image/png" };
  }
}

/** Abort-aware delay: a pause mid-interval stops the poll loop at once. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Flux generation cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Flux generation cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
