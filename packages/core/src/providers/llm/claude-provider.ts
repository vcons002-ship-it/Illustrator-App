import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { VisualBible } from "../../types/bible.js";
import type { VisualRequest } from "../../types/content.js";
import {
  extractionSystemFor,
  promptSystemFor,
  extractionUserContent,
  mergeExtraction,
  promptUserContent,
} from "./extraction.js";
import type { EntityExtractionInput, LLMProvider } from "./llm-provider.js";
import {
  DEFAULT_CHAT_MAX_TOKENS,
  splitSystem,
  systemCacheBlocks,
  type ChatCapable,
  type ChatOptions,
  type ChatTurn,
  type VisionCapable,
} from "./chat.js";
import { bytesToBase64 } from "../image/base64.js";

/**
 * Cloud LLM provider backed by Claude (the default cloud tier).
 *
 * - Entity extraction uses structured outputs (`messages.parse` + a Zod schema)
 *   so the Visual Bible comes back as validated JSON, no fragile parsing.
 * - `baseUrl` / `fetch` are injectable: today they default to the Anthropic API
 *   with a BYO key, but a hosted proxy ("server-ready") can be slotted in
 *   without touching this class — the Transport seam, expressed through the SDK.
 */

/** Exported so tests can assert key parity with EXTRACTION_JSON_SCHEMA (the two
 * schemas describe the SAME shape for different providers and must not drift). */
export const CLAUDE_EXTRACTION_SCHEMA = z.object({
  characters: z.array(
    z.object({
      name: z.string(),
      aliases: z.array(z.string()),
      appearance: z.object({
        hair: z.string(),
        eyes: z.string(),
        gender: z.string(),
        build: z.string(),
        height: z.string(),
        skinTone: z.string(),
        age: z.string(),
        distinguishingMarks: z.string(),
        notes: z.string(),
      }),
      persistentTraits: z.array(z.string()),
      outfits: z.array(
        z.object({
          label: z.string(),
          description: z.string(),
        }),
      ),
    }),
  ),
  glossary: z.array(
    z.object({
      term: z.string(),
      definition: z.string(),
    }),
  ),
  environments: z.array(
    z.object({
      name: z.string(),
      description: z.array(z.string()),
    }),
  ),
  creatures: z.array(
    z.object({
      name: z.string(),
      aliases: z.array(z.string()),
      kind: z.string(),
      description: z.array(z.string()),
    }),
  ),
  spoilers: z.array(
    z.object({
      label: z.string(),
    }),
  ),
  summary: z.string(),
  keyMoment: z.string(),
  location: z.string(),
  locationChange: z.string(),
  keyEvents: z.array(
    z.object({
      subject: z.string(),
      action: z.string(),
      environment: z.string(),
      mood: z.string(),
      composition: z.string(),
      location: z.string(),
    }),
  ),
  worldStyle: z.string(),
  datasets: z.array(
    z.object({
      title: z.string(),
      unit: z.string(),
      xLabel: z.string(),
      yLabel: z.string(),
      kind: z.string(),
      points: z.array(
        z.object({
          label: z.string(),
          x: z.number(),
          y: z.number(),
        }),
      ),
      source: z.string(),
    }),
  ),
  infographics: z.array(
    z.object({
      kind: z.string(),
      title: z.string(),
      anchor: z.string(),
      bullets: z.array(z.string()),
      nodes: z.array(z.object({ id: z.string(), label: z.string(), shape: z.string() })),
      edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() })),
      parts: z.array(z.object({ label: z.string(), note: z.string() })),
      caption: z.string(),
      unit: z.string().default(""),
      tasks: z
        .array(z.object({ id: z.string(), label: z.string(), start: z.number(), end: z.number() }))
        .default([]),
    }),
  ),
});

export interface ClaudeProviderOptions {
  apiKey: string;
  /** Model for extraction + prompt building. User chose Haiku 4.5 / Sonnet 4.6. */
  model?: string;
  /** Override for the API base URL — point this at a proxy when server-ready. */
  baseUrl?: string;
  /** Custom fetch (e.g. a proxy transport). Defaults to the platform fetch. */
  fetch?: typeof fetch;
}

export class ClaudeProvider implements LLMProvider, ChatCapable, VisionCapable {
  readonly id = "claude";
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: ClaudeProviderOptions) {
    this.model = opts.model ?? "claude-haiku-4-5";
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseUrl !== undefined ? { baseURL: opts.baseUrl } : {}),
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
      // The engine runs client-side with a user-supplied key in v1.
      dangerouslyAllowBrowser: true,
    });
  }

  async extractEntities(input: EntityExtractionInput): Promise<VisualBible> {
    const response = await this.client.beta.messages.parse(
      {
        model: this.model,
        max_tokens: 4096,
        // The system prompt is identical for every chapter of a build — mark it
        // cacheable so chapters 2..N read it from the prompt cache (same output,
        // lower input cost/latency; ignored when under the model's cache minimum).
        system: [
          {
            type: "text" as const,
            text: extractionSystemFor(input.contentMode),
            cache_control: { type: "ephemeral" as const },
          },
        ],
        messages: [{ role: "user", content: extractionUserContent(input) }],
        output_format: betaZodOutputFormat(CLAUDE_EXTRACTION_SCHEMA),
      },
      input.signal ? { signal: input.signal } : undefined,
    );

    const parsed = response.parsed_output;
    if (!parsed) {
      return mergeExtraction(
        input.existing,
        { characters: [], glossary: [], environments: [], spoilers: [] },
        input.chapterIndex,
        input.unitRanges,
      );
    }
    return mergeExtraction(input.existing, parsed, input.chapterIndex, input.unitRanges);
  }

  /** Reading-companion chat (buffered; `onToken` unused — the seam allows that). */
  async chat(messages: ChatTurn[], opts: ChatOptions = {}): Promise<string> {
    const { system, turns } = splitSystem(messages);
    // Mark a cache breakpoint after the stable prefix (tool defs + guard) so a
    // multi-turn conversation re-reads it instead of re-prefilling the whole system
    // prompt each turn. Sent as text blocks; the volatile book/bible tail trails it
    // uncached. The API ignores cache_control under its per-model token floor.
    const systemBlocks = systemCacheBlocks(system, opts.cachePrefix).map((b) =>
      b.cache
        ? { type: "text" as const, text: b.text, cache_control: { type: "ephemeral" as const } }
        : { type: "text" as const, text: b.text },
    );
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: opts.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS,
        ...(system ? { system: systemBlocks } : {}),
        messages: turns,
      },
      opts.signal ? { signal: opts.signal } : undefined,
    );
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  /** Vision: look at an image and answer the prompt in text. */
  async describeImage(input: {
    bytes: ArrayBuffer;
    mimeType: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const mediaType = (/png|jpe?g|webp|gif/i.exec(input.mimeType)?.[0] ?? "png").replace("jpg", "jpeg");
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: input.prompt },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: `image/${mediaType}` as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
                  data: bytesToBase64(input.bytes),
                },
              },
            ],
          },
        ],
      },
      input.signal ? { signal: input.signal } : undefined,
    );
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  async buildImagePrompt(request: VisualRequest, bible: VisualBible, signal?: AbortSignal): Promise<string> {
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 512,
        // Static per kind and sent once per story unit — cacheable across the
        // whole prompt pass (ignored when under the model's cache minimum).
        system: [
          {
            type: "text" as const,
            text: promptSystemFor(request.kind),
            cache_control: { type: "ephemeral" as const },
          },
        ],
        messages: [{ role: "user", content: promptUserContent(request, bible) }],
      },
      signal ? { signal } : undefined,
    );

    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }
}
