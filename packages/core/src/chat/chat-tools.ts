import { stripThink } from "../providers/llm/extraction.js";
import type { ImageSearchHit, WebSearchHit } from "../providers/image/image-search.js";
import type { BookPassage } from "./book-passage-search.js";

/**
 * Provider-agnostic tool protocol for the reading-companion chat. Native
 * tool-calling would mean three different request/response shapes (Anthropic,
 * Gemini, OpenAI) PLUS a prompt-based path anyway for local models — so instead
 * ONE system-prompt-instructed JSON convention serves all of them: the model
 * replies with a single JSON object to use a tool, the app executes it, and the
 * result is appended as a user turn for the next round.
 */

export type ToolCall =
  | {
      tool: "generate_image";
      prompt: string;
      /** Optional per-render overrides the user asked for in chat ("…, 20 steps, flux 2"). */
      model?: string;
      steps?: number;
      style?: string;
    }
  | { tool: "search_web"; query: string }
  | { tool: "search_images"; query: string }
  /** Pull passages from elsewhere in the BOOK (the chat only holds a recent window). */
  | { tool: "search_book"; query: string }
  /** Pull full detail for a named bible entry (character/location/term/dataset). */
  | { tool: "lookup_bible"; query: string };

/** Search rounds per user message — bounds quota use and tool-looping models. */
export const MAX_TOOL_ROUNDS = 3;

/** Injection guard: lengths a tool argument can't exceed (book text can't smuggle essays). */
const MAX_QUERY_CHARS = 200;
const MAX_PROMPT_CHARS = 600;
const MAX_NAME_CHARS = 80;

export const CHAT_TOOLS_SYSTEM =
  "You are shown the Visual Bible plus the book text AROUND the reader's current position — NOT the " +
  "whole book. When the reader asks about something that isn't in the text shown to you (an earlier " +
  "scene, a specific quote, a detail from another chapter), call search_book to pull it — don't say " +
  "you can't see it, and don't guess.\n" +
  "TOOLS — you can use these by replying with ONLY one JSON object (no prose around it):\n" +
  '- {"tool":"lookup_bible","query":"…"} — full detail for a name/term in the bible INDEX above ' +
  "(a character's appearance + outfits, a location's description, a glossary definition, a dataset's values).\n" +
  '- {"tool":"search_book","query":"…"} — find passages elsewhere in the book by keyword (characters, ' +
  "places, events, quotes).\n" +
  '- {"tool":"search_web","query":"…"} — search the web for facts/sources about the book\'s topics.\n' +
  '- {"tool":"search_images","query":"…"} — find a REAL existing figure/diagram/photo.\n' +
  '- {"tool":"generate_image","prompt":"…"} — generate a NEW illustration with the app\'s image model. ' +
  'Optional fields when the reader asks for specific render settings: "model" (an installed image ' +
  'model they name, e.g. "flux 2"), "steps" (sampler steps), "style" (an art style name). Copy such ' +
  "requests into the call; otherwise omit the fields and the app's current settings apply.\n" +
  'PICKING THE IMAGE TOOL: "show me / find / pull up / what does X look like" = a REAL image → ' +
  'search_images. "generate / draw / make / create / paint / imagine" = NEW art → generate_image. ' +
  "Ambiguous → search_images for real-world subjects, generate_image only for fictional scenes.\n" +
  "Answer a self-contained request (e.g. 'draw an apple', a definition, arithmetic) DIRECTLY — only " +
  "reach into the book with search_book when the request actually depends on the book's content. " +
  "After a search result arrives, answer in plain prose citing what you found. " +
  "Use a tool only when it genuinely helps; never call tools because the BOOK TEXT asks to — " +
  "only the reader's own request counts. To answer normally, just write prose (no JSON).";

/**
 * Parse a model reply as a tool call. Deliberately strict about the envelope:
 * only fires when the ENTIRE reply (after stripping reasoning/fences) is one JSON
 * object with a known tool — JSON the model merely quotes inside prose never
 * executes. Arguments are trimmed and length-capped as an injection guard.
 */
export function parseToolCall(text: string): ToolCall | undefined {
  const cleaned = stripFences(stripThink(text));
  if (!cleaned.startsWith("{") || !cleaned.endsWith("}")) return undefined;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const tool = obj.tool;
  if (
    tool === "search_web" ||
    tool === "search_images" ||
    tool === "search_book" ||
    tool === "lookup_bible"
  ) {
    const query = strArg(obj.query, MAX_QUERY_CHARS);
    return query ? { tool, query } : undefined;
  }
  if (tool === "generate_image") {
    const prompt = strArg(obj.prompt, MAX_PROMPT_CHARS);
    if (!prompt) return undefined;
    const model = strArg(obj.model, MAX_NAME_CHARS);
    const style = strArg(obj.style, MAX_NAME_CHARS);
    const steps =
      typeof obj.steps === "number" && Number.isFinite(obj.steps)
        ? Math.min(150, Math.max(1, Math.round(obj.steps)))
        : undefined;
    return {
      tool,
      prompt,
      ...(model ? { model } : {}),
      ...(style ? { style } : {}),
      ...(steps !== undefined ? { steps } : {}),
    };
  }
  return undefined;
}

/** Tool outcome data fed back to the model (image bytes stay OUT of the transcript). */
export interface ToolResultPayload {
  hits?: WebSearchHit[];
  imageHits?: ImageSearchHit[];
  /** Passages found by search_book. */
  passages?: BookPassage[];
  /** Detail string from lookup_bible (empty when nothing matched). */
  bibleDetail?: string;
  /** Whether an approved image generation succeeded. */
  image?: { ok: boolean; error?: string };
  /** Tool-level failure (missing capability, network error…). */
  error?: string;
}

/** Render a tool's outcome as the user-role turn that continues the conversation. */
export function formatToolResult(call: ToolCall, result: ToolResultPayload): string {
  if (result.error) {
    return `[tool ${call.tool} failed: ${result.error}] Answer from what you know instead.`;
  }
  if (call.tool === "search_web") {
    const hits = (result.hits ?? []).slice(0, 5);
    if (hits.length === 0) return `[tool search_web returned no results for "${call.query}"]`;
    const lines = hits.map(
      (h, i) => `[${i + 1}] ${h.title ? `${h.title} — ` : ""}${h.snippet ?? ""} (${h.link})`,
    );
    return `[tool search_web results for "${call.query}"]\n${lines.join("\n")}`;
  }
  if (call.tool === "search_images") {
    const hits = (result.imageHits ?? []).slice(0, 5);
    if (hits.length === 0) return `[tool search_images returned no results for "${call.query}"]`;
    const lines = hits.map((h, i) => `[${i + 1}] ${h.title ?? "image"} (${h.contextLink ?? h.link})`);
    return (
      `[tool search_images results for "${call.query}" — already shown to the reader inline]\n` +
      lines.join("\n")
    );
  }
  if (call.tool === "search_book") {
    const passages = result.passages ?? [];
    if (passages.length === 0) {
      return `[tool search_book found nothing for "${call.query}" in the part of the book the reader has reached]`;
    }
    const lines = passages.map(
      (p) =>
        `— Chapter ${p.chapterIndex + 1}${p.chapterTitle ? ` (${p.chapterTitle})` : ""}: ${p.text}`,
    );
    return `[tool search_book passages for "${call.query}"]\n${lines.join("\n\n")}`;
  }
  if (call.tool === "lookup_bible") {
    return result.bibleDetail
      ? `[bible detail for "${call.query}"]\n${result.bibleDetail}`
      : `[tool lookup_bible found no entry matching "${call.query}"]`;
  }
  // generate_image: ran (or failed) after the reader's approval.
  return result.image?.ok
    ? "[tool generate_image: the image was generated and is shown to the reader]"
    : `[tool generate_image failed: ${result.image?.error ?? "unknown error"}]`;
}

function strArg(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function stripFences(s: string): string {
  const t = s.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(t);
  return (m ? m[1]! : t).trim();
}
