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
  signal?: AbortSignal;
  /** Response budget; defaults per provider (~1024). */
  maxTokens?: number;
}

export interface ChatCapable {
  /** Full final assistant text for the conversation so far. */
  chat(messages: ChatTurn[], opts?: ChatOptions): Promise<string>;
}

export function supportsChat(p: LLMProvider): p is LLMProvider & ChatCapable {
  return typeof (p as Partial<ChatCapable>).chat === "function";
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
