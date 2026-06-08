import type { VisualBible } from "../../types/bible.js";
import type { VisualRequest } from "../../types/content.js";
import type { EntityExtractionInput, LLMProvider } from "./llm-provider.js";
import { MockLLMProvider } from "./mock-llm-provider.js";
import {
  EXTRACTION_SYSTEM,
  PROMPT_SYSTEM,
  extractionUserContent,
  mergeExtraction,
  promptUserContent,
  type RawExtraction,
} from "./extraction.js";
import type { MLCEngineInterface, InitProgressReport } from "@mlc-ai/web-llm";

/**
 * On-device LLM provider — runs a quantized model in the browser via WebLLM
 * (WebGPU), so the Visual Bible + image prompts are built locally with no API
 * key and no data leaving the machine. Works in both the web app (engine Web
 * Worker) and the desktop app (same renderer); requires WebGPU.
 *
 * The model lazily loads on first use (weights download once, then cached by the
 * browser). `@mlc-ai/web-llm` is imported dynamically so this module never loads
 * it in Node/tests, and the chat call is injectable (`complete`) so the parsing
 * logic is unit-testable without WebGPU. If WebLLM fails (no WebGPU, model load
 * error), it degrades to the mock so reading never breaks.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Completion seam: returns the assistant text for the given messages. */
export type ChatComplete = (
  messages: ChatMessage[],
  opts: { json: boolean; onToken?: (count: number) => void },
) => Promise<string>;

/** Live generation activity, so the UI can show the model is making progress. */
export interface GenerationActivity {
  /** Which step is running: Visual Bible extraction, or an image prompt. */
  phase: "bible" | "prompt";
  /** Tokens produced so far in the current completion. */
  tokens: number;
}

export interface WebLLMProviderOptions {
  /** WebLLM prebuilt model id (see catalog `LOCAL_TEXT_MODELS`). */
  model?: string;
  /** Model download/load progress (0..1 + a status string). */
  onProgress?: (report: { progress: number; text: string }) => void;
  /** Live token progress during generation (bible extraction / prompt writing). */
  onActivity?: (activity: GenerationActivity) => void;
  /** Test/override seam: supply a completion fn instead of loading WebLLM. */
  complete?: ChatComplete;
}

export const DEFAULT_LOCAL_TEXT_MODEL = "Llama-3.2-3B-Instruct-q4f16_1-MLC";

export const EXTRACTION_JSON_INSTRUCTION =
  "Respond with ONLY a JSON object of this exact shape, no markdown, no prose: " +
  '{"characters":[{"name":string,"aliases":string[],"persistentTraits":string[],"clothing":string[]}],' +
  '"environments":[{"name":string,"description":string[]}],' +
  '"spoilers":[{"label":string,"revealHint":string}],' +
  '"summary":string,"keyMoment":string}';

// Module-level engine cache so re-created providers reuse a loaded model
// (loading is slow; the weights are GB-sized).
let enginePromise: Promise<MLCEngineInterface> | undefined;
let engineModel: string | undefined;

// Serialize all on-device completions. A single WebLLM engine can't run two
// chats at once, and with interleaved rendering the background bible extraction
// and per-page prompt building now overlap — this queue makes that safe (and
// avoids GPU contention) by running them one after another.
let llmQueue: Promise<unknown> = Promise.resolve();
function runSerial<T>(fn: () => Promise<T>): Promise<T> {
  const result = llmQueue.then(fn, fn);
  llmQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export class WebLLMProvider implements LLMProvider {
  readonly id = "local";
  private readonly model: string;
  private readonly onProgress: ((r: { progress: number; text: string }) => void) | undefined;
  private readonly onActivity: ((a: GenerationActivity) => void) | undefined;
  private readonly injected: ChatComplete | undefined;
  private readonly fallback = new MockLLMProvider();

  constructor(opts: WebLLMProviderOptions = {}) {
    this.model = opts.model || DEFAULT_LOCAL_TEXT_MODEL;
    this.onProgress = opts.onProgress;
    this.onActivity = opts.onActivity;
    this.injected = opts.complete;
  }

  async extractEntities(input: EntityExtractionInput): Promise<VisualBible> {
    try {
      const complete = await this.completer();
      const content = await complete(
        [
          { role: "system", content: `${EXTRACTION_SYSTEM}\n${EXTRACTION_JSON_INSTRUCTION}` },
          { role: "user", content: extractionUserContent(input) },
        ],
        { json: true, onToken: (tokens) => this.onActivity?.({ phase: "bible", tokens }) },
      );
      return mergeExtraction(input.existing, parseExtraction(content), input.chapterIndex);
    } catch {
      // No WebGPU / model failure → behave like the mock so reading continues.
      return this.fallback.extractEntities(input);
    }
  }

  async buildImagePrompt(request: VisualRequest, bible: VisualBible): Promise<string> {
    try {
      const complete = await this.completer();
      const text = await complete(
        [
          { role: "system", content: PROMPT_SYSTEM },
          { role: "user", content: promptUserContent(request, bible) },
        ],
        { json: false, onToken: (tokens) => this.onActivity?.({ phase: "prompt", tokens }) },
      );
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : this.fallback.buildImagePrompt(request, bible);
    } catch {
      return this.fallback.buildImagePrompt(request, bible);
    }
  }

  private async completer(): Promise<ChatComplete> {
    if (this.injected) return this.injected;
    const engine = await this.engine();
    return (messages, opts) =>
      runSerial(async () => {
        const temperature = opts.json ? 0 : 0.7;
        const responseFormat = opts.json ? ({ type: "json_object" } as const) : undefined;
        // Stream so callers get live token progress (proof the model is working);
        // fall back to a single-shot completion if streaming isn't available.
        try {
          const stream = await engine.chat.completions.create({
            stream: true,
            messages,
            temperature,
            ...(responseFormat ? { response_format: responseFormat } : {}),
          });
          let text = "";
          let tokens = 0;
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content ?? "";
            if (delta) {
              text += delta;
              opts.onToken?.(++tokens);
            }
          }
          return text;
        } catch {
          const res = await engine.chat.completions.create({
            stream: false,
            messages,
            temperature,
            ...(responseFormat ? { response_format: responseFormat } : {}),
          });
          return res.choices[0]?.message?.content ?? "";
        }
      });
  }

  private engine(): Promise<MLCEngineInterface> {
    if (enginePromise && engineModel === this.model) return enginePromise;
    engineModel = this.model;
    enginePromise = (async () => {
      const webllm = await import("@mlc-ai/web-llm");
      return webllm.CreateMLCEngine(this.model, {
        initProgressCallback: (report: InitProgressReport) =>
          this.onProgress?.({ progress: report.progress, text: report.text }),
      });
    })();
    return enginePromise;
  }
}

/** Tolerant parse of the model's JSON into the shared RawExtraction shape. */
export function parseExtraction(content: string): RawExtraction {
  try {
    const json = JSON.parse(stripFences(content)) as Record<string, unknown>;
    return {
      summary: str(json.summary),
      keyMoment: str(json.keyMoment),
      characters: asArray(json.characters).map((c) => {
        const o = c as Record<string, unknown>;
        return {
          name: str(o.name),
          aliases: strArray(o.aliases),
          persistentTraits: strArray(o.persistentTraits),
          clothing: strArray(o.clothing),
        };
      }),
      environments: asArray(json.environments).map((e) => {
        const o = e as Record<string, unknown>;
        return { name: str(o.name), description: strArray(o.description) };
      }),
      spoilers: asArray(json.spoilers).map((s) => {
        const o = s as Record<string, unknown>;
        return { label: str(o.label), revealHint: str(o.revealHint) };
      }),
    };
  } catch {
    return { characters: [], environments: [], spoilers: [] };
  }
}

function stripFences(s: string): string {
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  return (m ? m[1]! : s).trim();
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function strArray(v: unknown): string[] {
  return asArray(v).filter((x): x is string => typeof x === "string");
}
