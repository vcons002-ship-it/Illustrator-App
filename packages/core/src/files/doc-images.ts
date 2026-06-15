/**
 * Designed documents with AI-generated images. The assistant writes a complete HTML
 * document (an invitation, flyer, poster, card) and marks each image it wants the app
 * to create with `<img data-generate="a rich description" …>`. The host generates each
 * one through the normal render path and embeds it as a self-contained data: URI, so
 * the finished document previews and saves as a single standalone .html file.
 *
 * Pure string transforms (no DOM — this runs in the worker/node too), regex over the
 * bounded HTML the model writes. Deliberately minimal: a placeholder is just an <img>
 * whose `data-generate` attribute we swap for a real `src`, leaving every other
 * attribute (alt, width, height, style, class) untouched.
 */

export interface DocImagePlaceholder {
  /** Position-based id (0,1,2…) — embed reuses the same ordering. */
  id: string;
  /** The image description to render. */
  prompt: string;
  alt: string;
  width?: number;
  height?: number;
}

export const MAX_DOC_IMAGES = 8;
export const MAX_DOC_IMAGE_PROMPT_CHARS = 600;

const IMG_TAG = /<img\b[^>]*>/gi;

function getAttr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[1] ?? m[2]) : undefined;
}

function toDim(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function stripGenerate(tag: string): string {
  return tag.replace(/\sdata-generate\s*=\s*(?:"[^"]*"|'[^']*')/i, "");
}

/** True when the HTML has at least one `<img data-generate="…">` to fill in. */
export function hasDocImages(html: string): boolean {
  return /<img\b[^>]*\bdata-generate\s*=/i.test(html);
}

/** The images a document asks the app to generate, in document order (capped). */
export function parseDocImages(html: string): DocImagePlaceholder[] {
  const out: DocImagePlaceholder[] = [];
  for (const m of html.matchAll(IMG_TAG)) {
    const prompt = getAttr(m[0], "data-generate")?.trim();
    if (!prompt) continue;
    if (out.length >= MAX_DOC_IMAGES) break;
    const width = toDim(getAttr(m[0], "width"));
    const height = toDim(getAttr(m[0], "height"));
    out.push({
      id: String(out.length),
      prompt: prompt.slice(0, MAX_DOC_IMAGE_PROMPT_CHARS),
      alt: getAttr(m[0], "alt") ?? "",
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    });
  }
  return out;
}

/**
 * Swap each `data-generate` placeholder for the generated image: the `data-generate`
 * attribute is replaced by a `src` (the data: URI for that placeholder's id). A
 * placeholder with no provided src (generation failed/skipped) just loses its
 * `data-generate` attribute, so the browser shows its `alt` instead of a broken icon.
 */
export function embedDocImages(html: string, srcById: ReadonlyMap<string, string>): string {
  let i = 0;
  return html.replace(IMG_TAG, (tag) => {
    const prompt = getAttr(tag, "data-generate")?.trim();
    if (!prompt) return tag;
    const id = String(i++);
    const stripped = stripGenerate(tag);
    const src = srcById.get(id);
    return src ? stripped.replace(/<img\b/i, `<img src="${src}"`) : stripped;
  });
}
