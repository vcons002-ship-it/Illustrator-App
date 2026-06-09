import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { VisualBible } from "../../types/bible.js";
import type { VisualRequest } from "../../types/content.js";
import {
  EXTRACTION_SYSTEM,
  PROMPT_SYSTEM,
  extractionUserContent,
  mergeExtraction,
  promptUserContent,
} from "./extraction.js";
import type { EntityExtractionInput, LLMProvider } from "./llm-provider.js";

/**
 * Cloud LLM provider backed by Claude (the default cloud tier).
 *
 * - Entity extraction uses structured outputs (`messages.parse` + a Zod schema)
 *   so the Visual Bible comes back as validated JSON, no fragile parsing.
 * - `baseUrl` / `fetch` are injectable: today they default to the Anthropic API
 *   with a BYO key, but a hosted proxy ("server-ready") can be slotted in
 *   without touching this class — the Transport seam, expressed through the SDK.
 */

const ExtractionSchema = z.object({
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
          context: z.string(),
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
      revealHint: z.string(),
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

export class ClaudeProvider implements LLMProvider {
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
        system: EXTRACTION_SYSTEM,
        messages: [{ role: "user", content: extractionUserContent(input) }],
        output_format: betaZodOutputFormat(ExtractionSchema),
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

  async buildImagePrompt(request: VisualRequest, bible: VisualBible, signal?: AbortSignal): Promise<string> {
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 512,
        system: PROMPT_SYSTEM,
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
