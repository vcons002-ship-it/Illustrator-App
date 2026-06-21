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
  /**
   * Called once when the reply finishes, reporting whether the model was CUT OFF at the token
   * budget (`truncated: true` ⇒ finish_reason "length"). The chat/buddy loop uses this to AUTO-
   * CONTINUE a long answer in further passes and stitch them together, so a big document isn't
   * capped at one reply. Optional — providers that can't tell simply never call it (no continuation).
   */
  onComplete?: (meta: { truncated: boolean }) => void;
  /**
   * Reasoning effort for THINKING models served locally (OpenAI `reasoning_effort`): "none" turns
   * the hidden reasoning pass off, "low"/"medium"/"high" scale it. Sent only when set; servers/models
   * that don't support it ignore the field (and a strict server that rejects it is retried without).
   * Cloud providers map their own reasoning controls separately, so this is a no-op there.
   */
  reasoningEffort?: "none" | "low" | "medium" | "high";
  /**
   * The byte-stable LEADING portion of the system prompt (role + tool definitions +
   * guard) — must be a genuine prefix of the joined system text. Providers with an
   * explicit prompt cache (Claude) mark a cache breakpoint after it so multi-turn
   * conversations re-read it instead of re-prefilling it; providers that auto-cache
   * prefixes server-side (Gemini/OpenAI) and local servers (llama.cpp KV reuse) get
   * the same win for free from the stable-prefix ORDERING and ignore this field.
   */
  cachePrefix?: string;
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
 * Below this, a cache breakpoint isn't worth a two-block split — Anthropic enforces
 * its own per-model token floor (~1024 tokens, ~2048 for Haiku) and silently ignores
 * `cache_control` under it, so this only avoids splitting a trivially short prefix
 * for no benefit. ~4 chars/token.
 */
export const MIN_CACHE_PREFIX_CHARS = 2_000;

/** One block of a structured system prompt; `cache` marks an ephemeral cache
 * breakpoint after it (Anthropic prompt caching). */
export interface SystemBlock {
  text: string;
  cache?: boolean;
}

/**
 * Split a system prompt into cache blocks for a provider with EXPLICIT prompt caching
 * (Claude). `cachePrefix` must be the stable, byte-identical-across-turns leading part
 * AND a real prefix of `system`; the volatile remainder (book text, bible) trails it
 * uncached. Returns a single uncached block when there's no usable prefix, so the
 * caller can map blindly. The empty-`system` case is handled by the caller (no system).
 */
export function systemCacheBlocks(system: string, cachePrefix?: string): SystemBlock[] {
  if (cachePrefix && cachePrefix.length >= MIN_CACHE_PREFIX_CHARS && system.startsWith(cachePrefix)) {
    const rest = system.slice(cachePrefix.length);
    return rest.trim() ? [{ text: cachePrefix, cache: true }, { text: rest }] : [{ text: cachePrefix, cache: true }];
  }
  return [{ text: system }];
}

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
