import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Character, Environment, VisualBible } from "../../types/bible.js";
import type { VisualRequest } from "../../types/content.js";
import { deterministicSeed } from "./mock-llm-provider.js";
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
      persistentTraits: z.array(z.string()),
      clothing: z.array(z.string()),
    }),
  ),
  environments: z.array(
    z.object({
      name: z.string(),
      description: z.array(z.string()),
    }),
  ),
  spoilers: z.array(
    z.object({
      label: z.string(),
      revealHint: z.string(),
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
    const known = new Set(input.existing.characters.map((c) => c.name.toLowerCase()));
    const knownEnv = new Set(input.existing.environments.map((e) => e.name.toLowerCase()));

    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 4096,
      system:
        "You are building a 'Visual Bible' for illustrating a novel. Extract only " +
        "entities that recur or are visually significant. For characters, capture " +
        "traits that persist across the book (build, hair, eyes, distinguishing marks) " +
        "and current clothing. For spoilers, flag reveals that would spoil the plot if " +
        "shown in an illustration before the reader reaches them.",
      messages: [
        {
          role: "user",
          content: `Chapter ${input.chapterIndex} text:\n\n${input.chapterText}`,
        },
      ],
      output_format: betaZodOutputFormat(ExtractionSchema),
    });

    const parsed = response.parsed_output;
    const bible: VisualBible = {
      ...input.existing,
      characters: [...input.existing.characters],
      environments: [...input.existing.environments],
      spoilers: [...input.existing.spoilers],
      processedChapters: [...input.existing.processedChapters],
    };
    if (!parsed) return this.markProcessed(bible, input.chapterIndex);

    for (const c of parsed.characters) {
      if (known.has(c.name.toLowerCase())) continue;
      known.add(c.name.toLowerCase());
      const character: Character = {
        id: `char-${slug(c.name)}`,
        name: c.name,
        aliases: c.aliases,
        persistentTraits: c.persistentTraits,
        clothing: c.clothing,
        anchor: { seed: deterministicSeed(c.name) },
        firstSeenChapter: input.chapterIndex,
      };
      bible.characters.push(character);
    }
    for (const e of parsed.environments) {
      if (knownEnv.has(e.name.toLowerCase())) continue;
      knownEnv.add(e.name.toLowerCase());
      const env: Environment = {
        id: `env-${slug(e.name)}`,
        name: e.name,
        description: e.description,
        firstSeenChapter: input.chapterIndex,
      };
      bible.environments.push(env);
    }
    for (const s of parsed.spoilers) {
      bible.spoilers.push({
        id: `spoiler-${slug(s.label)}-${input.chapterIndex}`,
        label: s.label,
        // The pipeline resolves the hint to a concrete paragraph id later.
        revealParagraphId: s.revealHint,
      });
    }

    return this.markProcessed(bible, input.chapterIndex);
  }

  async buildImagePrompt(request: VisualRequest, bible: VisualBible): Promise<string> {
    const chars = bible.characters.filter((c) => request.characterIds.includes(c.id));
    const envs = bible.environments.filter((e) => request.environmentIds.includes(e.id));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      system:
        "You write vivid, concrete image-generation prompts for a single illustration " +
        "of the given book passage. Keep character and setting descriptions consistent " +
        "with the supplied Visual Bible. Output only the prompt text, no preamble.",
      messages: [
        {
          role: "user",
          content: [
            chars.length
              ? `Characters present:\n${chars
                  .map((c) => `- ${c.name}: ${c.persistentTraits.join(", ")}; wearing ${c.clothing.join(", ") || "unspecified"}`)
                  .join("\n")}`
              : "",
            envs.length
              ? `Setting:\n${envs.map((e) => `- ${e.name}: ${e.description.join(", ")}`).join("\n")}`
              : "",
            `Passage:\n${request.sourceText}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    });

    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  private markProcessed(bible: VisualBible, chapterIndex: number): VisualBible {
    if (!bible.processedChapters.includes(chapterIndex)) {
      bible.processedChapters.push(chapterIndex);
    }
    return bible;
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
