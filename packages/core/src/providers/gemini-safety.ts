/**
 * Shared Gemini "mature mode" safety settings. Used by both the LLM provider
 * (text) and the native image provider — kept in one place so a future harm
 * category can't drift between them.
 *
 * All adjustable categories at `BLOCK_NONE`; sent only when the user has enabled
 * mature mode (see `TierConfig.allowMature`). Gemini still enforces its
 * non-configurable policies regardless.
 */
export const MATURE_SAFETY_SETTINGS: readonly { category: string; threshold: string }[] = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_NONE" }));
