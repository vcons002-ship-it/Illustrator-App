/**
 * Turn an email attachment's raw bytes into text the agent can USE as prep — for the
 * text-like types we can decode without a heavy parser (plain text, CSV, JSON, XML, and
 * HTML, which we strip to text). Binary formats (PDF, images, Office) return undefined;
 * the caller handles those (e.g. PDF text extraction via pdfjs in the worker). Pure +
 * unit-tested, so "what counts as readable" lives in one place.
 */

const TEXT_LIKE = /^(text\/|application\/(json|xml|.*\+xml|x-yaml|yaml|csv|x-ndjson|javascript|x-sh)|message\/rfc822)/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|log|html?|ics|eml|rtf)$/i;

/** Whether an attachment is text we can decode inline (by MIME, falling back to extension). */
export function isTextLikeMime(mimeType: string, filename?: string): boolean {
  if (TEXT_LIKE.test(mimeType.trim())) return true;
  return !!filename && TEXT_EXT.test(filename.trim());
}

/** Extracted text for a text-like attachment, or undefined when it's binary (let the
 * caller try a format-specific parser). HTML is stripped to its visible text. */
export function extractAttachmentText(bytes: Uint8Array, mimeType: string, filename?: string): string | undefined {
  if (!isTextLikeMime(mimeType, filename)) return undefined;
  let text = new TextDecoder().decode(bytes);
  const isHtml = /html/i.test(mimeType) || /\.html?$/i.test(filename ?? "");
  if (isHtml) {
    text = text
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">");
  }
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
