/**
 * VOICE — small pure helper for the optional voice mode (dictate with the mic, hear replies).
 * The Web Speech APIs (SpeechRecognition / speechSynthesis) live in the UI; this is just the
 * text-cleanup so spoken replies don't read out markdown punctuation, code blocks, or URLs.
 */

/** Max characters to speak (a long reply read aloud in full is rarely wanted). */
export const MAX_SPEAK_CHARS = 1200;

/** Turn an assistant reply (markdown) into clean, speakable prose. */
export function speakableText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code block) ") // don't read code aloud
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/https?:\/\/\S+/g, " (link) ")
    .replace(/[*_#>~|]/g, "") // markdown emphasis / headings / quotes / tables
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SPEAK_CHARS);
}
