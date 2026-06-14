import type { LLMProvider } from "./llm-provider.js";

/**
 * Generic chat seam for the reading-companion panel — deliberately SEPARATE from
 * `LLMProvider` (the engine's contract): chat is a UI capability the engine never
 * needs, so an optional interface means existing fakes/implementations keep
 * compiling and the worker can guard with `supportsChat` instead of every
 * provider being forced to grow a method.
 */

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  /**
   * Incremental text deltas for progressive rendering. Optional by design: the
   * returned string is always the source of truth, so buffered providers satisfy
   * the interface without faking a stream; streaming providers (WebLLM) call it.
   */
  onToken?: (delta: string) => void;
  /**
   * The model's REASONING so far while it's still inside its `<think>` block (those
   * tokens are kept out of `onToken`, since reasoning isn't the answer). The string
   * is the accumulated thinking text — hosts stream it into a dimmed "thinking" area
   * so a long reason-before-answering reads as visible progress, not a frozen hang.
   */
  onThinking?: (thinking: string) => void;
  signal?: AbortSignal;
  /** Response budget; defaults per provider (~1024). */
  maxTokens?: number;
}

export interface ChatCapable {
  /** Full final assistant text for the conversation so far. */
  chat(messages: ChatTurn[], opts?: ChatOptions): Promise<string>;
}

/** A model that can look at an image and answer in text (vision input). */
export interface VisionCapable {
  describeImage(input: {
    bytes: ArrayBuffer;
    mimeType: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<string>;
}

export function supportsChat(p: LLMProvider): p is LLMProvider & ChatCapable {
  return typeof (p as Partial<ChatCapable>).chat === "function";
}

export function supportsVision(p: LLMProvider): p is LLMProvider & VisionCapable {
  return typeof (p as Partial<VisionCapable>).describeImage === "function";
}

/** First system turn(s) joined, and the non-system turns — the split every API wants. */
export function splitSystem(messages: ChatTurn[]): {
  system: string;
  turns: { role: "user" | "assistant"; content: string }[];
} {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns = messages
    .filter((m): m is ChatTurn & { role: "user" | "assistant" } => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  return { system, turns };
}

export const DEFAULT_CHAT_MAX_TOKENS = 1024;

/**
 * The reasoning text so far from a raw, still-streaming reply that's inside a
 * `<think>` block — the content after the (possibly unclosed) `<think>` tag, with
 * any closed `</think>…` tail dropped. Used to surface live "thinking" to the host.
 */
export function reasoningSoFar(raw: string): string {
  const m = /<think>([\s\S]*)$/i.exec(raw);
  const inner = m ? m[1]! : raw;
  return inner.replace(/<\/think>[\s\S]*$/i, "").trimStart();
}
