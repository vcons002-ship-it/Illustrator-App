import type { VisualBible } from "../../types/bible.js";
import type { VisualRequest } from "../../types/content.js";
import type { EntityExtractionInput, LLMProvider } from "./llm-provider.js";
import { MockLLMProvider } from "./mock-llm-provider.js";
import {
  extractionSystemFor,
  promptSystemFor,
  extractionUserContent,
  mergeExtraction,
  promptUserContent,
  stripThink,
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
  opts: { json: boolean; onToken?: (count: number) => void; signal?: AbortSignal },
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
  /**
   * Fired when the on-device model can't be used (no WebGPU, a failed or stalled
   * load) and this call degraded to the mock. Lets the UI say so out loud instead
   * of silently producing placeholder analysis.
   */
  onFallback?: (reason: string) => void;
  /** Test/override seam: supply a completion fn instead of loading WebLLM. */
  complete?: ChatComplete;
}

export const DEFAULT_LOCAL_TEXT_MODEL = "Llama-3.2-3B-Instruct-q4f16_1-MLC";

export const EXTRACTION_JSON_INSTRUCTION =
  "Respond with ONLY a JSON object of this exact shape, no markdown, no prose: " +
  '{"characters":[{"name":string,"aliases":string[],' +
  '"appearance":{"hair":string,"eyes":string,"gender":string,"build":string,"height":string,' +
  '"skinTone":string,"age":string,"distinguishingMarks":string,"notes":string},' +
  '"persistentTraits":string[],' +
  '"outfits":[{"label":string,"description":string}]}],' +
  '"glossary":[{"term":string,"definition":string}],' +
  '"environments":[{"name":string,"description":string[]}],' +
  '"creatures":[{"name":string,"aliases":string[],"kind":string,"description":string[]}],' +
  '"spoilers":[{"label":string}],' +
  '"summary":string,"keyMoment":string,"location":string,"locationChange":string,' +
  '"keyEvents":[{"subject":string,"action":string,"environment":string,"mood":string,"composition":string,"location":string}],' +
  '"worldStyle":string,' +
  '"datasets":[{"title":string,"unit":string,"xLabel":string,"yLabel":string,"kind":"bar"|"line"|"scatter",' +
  '"points":[{"label":string,"x":number,"y":number}],"source":string}]}. ' +
  "Include each NEW named character with an appearance description (use empty strings for " +
  "unknown appearance fields). Capture each distinct outfit a character wears as a separate " +
  "'outfits' entry (label + description). Put non-human beasts (dragons, monsters, mounts) in " +
  "'creatures', NOT 'characters'. IMPORTANT: do NOT re-output a character/creature/location " +
  "already in the 'known' lists unless this chapter adds NEW visual detail — omit it otherwise " +
  "(it is remembered). Set 'location' to where the chapter happens and 'locationChange' to " +
  "where/when it moves (empty string if it stays in one place). For 'keyEvents', produce EXACTLY " +
  "the requested number of scene prompts in reading order (each a complete scene: subject, " +
  "action, environment, mood, composition — natural language, no tags). Each keyEvent's " +
  "'location' is the ONE location name where ITS scene happens (track moves beat by beat). " +
  "Set 'worldStyle' to one concise genre + art-direction line for the whole book. " +
  "'datasets' is for NON-FICTION numeric series actually stated in the text (3+ related " +
  "values, consistent units, never invented; a point's 'x' repeats its index unless the " +
  "text gives a real numeric x) — emit [] for fiction or when there is no clean series.";

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
  private readonly onFallback: ((reason: string) => void) | undefined;
  private readonly injected: ChatComplete | undefined;
  private readonly fallback = new MockLLMProvider();

  constructor(opts: WebLLMProviderOptions = {}) {
    this.model = opts.model || DEFAULT_LOCAL_TEXT_MODEL;
    this.onProgress = opts.onProgress;
    this.onActivity = opts.onActivity;
    this.onFallback = opts.onFallback;
    this.injected = opts.complete;
  }

  /** Degrade to the mock — loudly, so a failed on-device model never looks like success. */
  private degrade(err: unknown): void {
    const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
    this.onFallback?.(
      `On-device text model unavailable${detail} — using placeholder analysis. ` +
        `Switch to a Local server (Ollama) or a cloud key in Settings → Text.`,
    );
  }

  async extractEntities(input: EntityExtractionInput): Promise<VisualBible> {
    try {
      const complete = await this.completer();
      const content = await complete(
        [
          { role: "system", content: `${extractionSystemFor(input.contentMode)}\n${EXTRACTION_JSON_INSTRUCTION}` },
          { role: "user", content: extractionUserContent(input) },
        ],
        {
          json: true,
          onToken: (tokens) => this.onActivity?.({ phase: "bible", tokens }),
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      return mergeExtraction(input.existing, parseExtraction(content), input.chapterIndex, input.unitRanges);
    } catch (err) {
      // No WebGPU / failed or stalled model load → behave like the mock so reading
      // continues, but TELL the UI (a silent junk bible looks like an app bug).
      this.degrade(err);
      return this.fallback.extractEntities(input);
    }
  }

  async buildImagePrompt(request: VisualRequest, bible: VisualBible, signal?: AbortSignal): Promise<string> {
    try {
      const complete = await this.completer();
      const text = await complete(
        [
          { role: "system", content: promptSystemFor(request.kind) },
          { role: "user", content: promptUserContent(request, bible) },
        ],
        {
          json: false,
          onToken: (tokens) => this.onActivity?.({ phase: "prompt", tokens }),
          ...(signal ? { signal } : {}),
        },
      );
      const trimmed = stripThink(text).trim();
      return trimmed.length > 0 ? trimmed : this.fallback.buildImagePrompt(request, bible);
    } catch (err) {
      this.degrade(err);
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
        // Extraction can return a long JSON object (every described character +
        // glossary); give it ample room so the JSON isn't truncated mid-object.
        const maxTokens = opts.json ? 4096 : 512;
        // Stream so callers get live token progress (proof the model is working);
        // fall back to a single-shot completion if streaming isn't available.
        try {
          const stream = await engine.chat.completions.create({
            stream: true,
            messages,
            temperature,
            max_tokens: maxTokens,
            ...(responseFormat ? { response_format: responseFormat } : {}),
          });
          let text = "";
          let tokens = 0;
          for await (const chunk of stream) {
            if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
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
            max_tokens: maxTokens,
            ...(responseFormat ? { response_format: responseFormat } : {}),
          });
          return res.choices[0]?.message?.content ?? "";
        }
      });
  }

  private engine(): Promise<MLCEngineInterface> {
    if (enginePromise && engineModel === this.model) return enginePromise;
    engineModel = this.model;
    const load = (async () => {
      const webllm = await import("@mlc-ai/web-llm");
      // Stall watchdog: the weight download / WebGPU init can hang forever in some
      // webviews (no rejection, no progress) — which froze the whole bible build with
      // no way out. Progress events keep the load alive indefinitely (a slow download
      // is never killed); only total SILENCE for ENGINE_STALL_MS fails it, so the
      // caller can degrade to the mock and say so.
      let lastProgressMs = Date.now();
      const create = webllm.CreateMLCEngine(this.model, {
        initProgressCallback: (report: InitProgressReport) => {
          lastProgressMs = Date.now();
          this.onProgress?.({ progress: report.progress, text: report.text });
        },
      });
      return await new Promise<MLCEngineInterface>((resolve, reject) => {
        const watchdog = setInterval(() => {
          if (Date.now() - lastProgressMs > ENGINE_STALL_MS) {
            clearInterval(watchdog);
            reject(
              new Error(
                "on-device model load stalled — no download/setup progress for " +
                  `${Math.round(ENGINE_STALL_MS / 1000)}s`,
              ),
            );
          }
        }, 5_000);
        create.then(
          (engine) => {
            clearInterval(watchdog);
            resolve(engine);
          },
          (err) => {
            clearInterval(watchdog);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      });
    })();
    // Cache only a SUCCESSFUL load. A cached rejection used to wedge the provider
    // into silent-mock mode forever; clearing it lets a later call retry.
    enginePromise = load;
    load.catch(() => {
      if (enginePromise === load) {
        enginePromise = undefined;
        engineModel = undefined;
      }
    });
    return load;
  }
}

/** Fail an engine load only after this long with NO progress events (ms). */
const ENGINE_STALL_MS = 60_000;

/** Tolerant parse of the model's JSON into the shared RawExtraction shape. */
export function parseExtraction(content: string): RawExtraction {
  try {
    const json = JSON.parse(stripFences(stripThink(content))) as Record<string, unknown>;
    return {
      summary: str(json.summary),
      keyMoment: str(json.keyMoment),
      location: str(json.location),
      locationChange: str(json.locationChange),
      characters: asArray(json.characters).map((c) => {
        const o = c as Record<string, unknown>;
        const a = (o.appearance ?? {}) as Record<string, unknown>;
        return {
          name: str(o.name),
          aliases: strArray(o.aliases),
          appearance: {
            hair: str(a.hair),
            eyes: str(a.eyes),
            gender: str(a.gender),
            build: str(a.build),
            height: str(a.height),
            skinTone: str(a.skinTone),
            age: str(a.age),
            distinguishingMarks: str(a.distinguishingMarks),
            notes: str(a.notes),
          },
          persistentTraits: strArray(o.persistentTraits),
          outfits: asArray(o.outfits).map((x) => {
            const ot = x as Record<string, unknown>;
            return { label: str(ot.label), description: str(ot.description) };
          }),
        };
      }),
      glossary: asArray(json.glossary).map((g) => {
        const o = g as Record<string, unknown>;
        return { term: str(o.term), definition: str(o.definition) };
      }),
      environments: asArray(json.environments).map((e) => {
        const o = e as Record<string, unknown>;
        return { name: str(o.name), description: strArray(o.description) };
      }),
      creatures: asArray(json.creatures).map((c) => {
        const o = c as Record<string, unknown>;
        return {
          name: str(o.name),
          aliases: strArray(o.aliases),
          kind: str(o.kind),
          description: strArray(o.description),
        };
      }),
      spoilers: asArray(json.spoilers).map((s) => {
        const o = s as Record<string, unknown>;
        return { label: str(o.label) };
      }),
      keyEvents: asArray(json.keyEvents).map((e) => {
        const o = e as Record<string, unknown>;
        return {
          subject: str(o.subject),
          action: str(o.action),
          environment: str(o.environment),
          mood: str(o.mood),
          composition: str(o.composition),
          location: str(o.location),
        };
      }),
      worldStyle: str(json.worldStyle),
      datasets: asArray(json.datasets).map((d) => {
        const o = d as Record<string, unknown>;
        return {
          title: str(o.title),
          unit: str(o.unit),
          xLabel: str(o.xLabel),
          yLabel: str(o.yLabel),
          kind: str(o.kind),
          points: asArray(o.points).map((p) => {
            const po = p as Record<string, unknown>;
            const x = num(po.x);
            return {
              label: str(po.label),
              y: num(po.y) ?? NaN,
              ...(x !== undefined ? { x } : {}),
            };
          }),
          source: str(o.source),
        };
      }),
    };
  } catch {
    return { characters: [], glossary: [], environments: [], spoilers: [] };
  }
}

/** Tolerant numeric coercion: a real number passes, a numeric string converts, else undefined. */
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
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
