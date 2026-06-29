import { zipSync, strToU8 } from "fflate";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { markdownToBlocks, parseInline, type DocBlock, type DocInline } from "@visual-reader/core";

/**
 * Turn a Markdown document (what the chat buddy authors) into REAL `.docx` and `.pdf` files.
 *
 * Same dependency-light spirit as `data-export.ts`: `.docx` is hand-built OOXML zipped with the
 * `fflate` the rest of the app already uses (no `docx`/`officegen`), so it's pure + unit-tested by
 * reading the bytes back. `.pdf` uses `pdf-lib` (pure-JS) for correct font metrics + word-wrap —
 * the one thing a hand-rolled writer gets wrong. Scope is a TEXT document (headings, paragraphs with
 * bold / italic / code runs, bullet + numbered lists, code blocks, rules) — not arbitrary CSS
 * layout. Both render from the shared {@link DocBlock} model (core) so exporters + viewers match.
 */

// The block model + Markdown parser live in @visual-reader/core (so the UI can render the same
// structure inline without pulling pdf-lib). Re-export for existing importers of this module.
export { markdownToBlocks, parseInline };
export type { DocBlock, DocInline };

// ----------------------------------------------------------------- DOCX (hand-built OOXML)

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_OFFICE_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Half-point font size for a heading level (Word `w:sz` is in half-points). */
function docxHeadingSize(level: 1 | 2 | 3): number {
  return level === 1 ? 56 : level === 2 ? 44 : 32; // 28 / 22 / 16 pt
}

/** One `<w:r>` run with bold/italic/mono run-properties. */
function runXml(run: DocInline, opts: { bold?: boolean; sizeHalfPt?: number } = {}): string {
  const bold = run.bold || opts.bold;
  const props =
    (bold ? "<w:b/>" : "") +
    (run.italic ? "<w:i/>" : "") +
    (run.code ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>' : "") +
    (opts.sizeHalfPt ? `<w:sz w:val="${opts.sizeHalfPt}"/><w:szCs w:val="${opts.sizeHalfPt}"/>` : "");
  const rPr = props ? `<w:rPr>${props}</w:rPr>` : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`;
}

function paragraphXml(runs: DocInline[], opts: { bold?: boolean; sizeHalfPt?: number; pPr?: string } = {}): string {
  const body = runs.map((r) => runXml(r, opts)).join("");
  return `<w:p>${opts.pPr ?? ""}${body}</w:p>`;
}

function blockToDocxParagraphs(block: DocBlock): string {
  switch (block.type) {
    case "heading":
      return paragraphXml(block.runs, {
        bold: true,
        sizeHalfPt: docxHeadingSize(block.level),
        pPr: '<w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>',
      });
    case "paragraph":
      return paragraphXml(block.runs, { pPr: '<w:pPr><w:spacing w:after="160"/></w:pPr>' });
    case "list":
      return block.items
        .map((item, i) => {
          const marker: DocInline = { text: block.ordered ? `${i + 1}. ` : "• " };
          return paragraphXml([marker, ...item], {
            pPr: '<w:pPr><w:spacing w:after="60"/><w:ind w:left="360" w:hanging="360"/></w:pPr>',
          });
        })
        .join("");
    case "code":
      return block.text
        .split("\n")
        .map((line) =>
          paragraphXml([{ text: line || " ", code: true }], {
            pPr: '<w:pPr><w:spacing w:after="0"/></w:pPr>',
          }),
        )
        .join("");
    case "rule":
      return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr></w:p>';
  }
}

/**
 * Build a real Word `.docx` (Open XML, zipped) from the block model. Direct run formatting (no
 * styles.xml) keeps the package minimal; Word, LibreOffice, and Google Docs all open it.
 */
export function blocksToDocx(title: string, blocks: DocBlock[]): Uint8Array {
  const titlePara = title.trim()
    ? paragraphXml([{ text: title.trim(), bold: true }], {
        bold: true,
        sizeHalfPt: 64,
        pPr: '<w:pPr><w:spacing w:after="200"/></w:pPr>',
      })
    : "";
  const body = titlePara + blocks.map(blockToDocxParagraphs).join("");
  const sectPr =
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="${W}"><w:body>${body}${sectPr}</w:body></w:document>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="${NS_CT}">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="${NS_REL}">` +
        `<Relationship Id="rId1" Type="${NS_OFFICE_DOC}" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(documentXml),
    "word/_rels/document.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS_REL}"/>`,
    ),
  };
  return zipSync(files);
}

// ----------------------------------------------------------------- PDF (pdf-lib)

interface PdfFonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  mono: PDFFont;
}

/** A word carrying its font + measured width, for greedy line-fill. */
interface LaidWord {
  text: string;
  font: PDFFont;
  width: number;
}

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 72; // 1 inch
const BODY_SIZE = 11;

function pdfFontFor(run: DocInline, fonts: PdfFonts): PDFFont {
  if (run.code) return fonts.mono;
  if (run.bold && run.italic) return fonts.boldItalic;
  if (run.bold) return fonts.bold;
  if (run.italic) return fonts.italic;
  return fonts.regular;
}

/**
 * Render the block model to a real PDF (selectable text) with word-wrap + pagination. Async because
 * pdf-lib's font embed + save are async.
 */
export async function blocksToPdf(title: string, blocks: DocBlock[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (title.trim()) doc.setTitle(title.trim());
  doc.setProducer("Visual Reader");
  const fonts: PdfFonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
  };

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const newPage = (): void => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };
  const need = (h: number): void => {
    if (y - h < MARGIN) newPage();
  };

  /** Flow styled runs as wrapped lines from `indent`, drawing each line; advances `y`. */
  const flowRuns = (
    runs: DocInline[],
    size: number,
    base: { bold?: boolean },
    opts: { indent?: number; marker?: { text: string; font: PDFFont } } = {},
  ): void => {
    const indent = opts.indent ?? 0;
    const lineHeight = size * 1.32;
    const sanitize = (s: string): string => s.replace(/\t/g, "    ");
    // Flatten runs → words, each remembering its font.
    const words: LaidWord[] = [];
    for (const run of runs) {
      const font = pdfFontFor({ ...run, bold: !!(run.bold || base.bold) }, fonts);
      for (const w of sanitize(run.text).split(/(\s+)/)) {
        if (w === "" ) continue;
        if (/^\s+$/.test(w)) continue; // spacing handled between words
        words.push({ text: w, font, width: font.widthOfTextAtSize(w, size) });
      }
    }
    const spaceWidth = fonts.regular.widthOfTextAtSize(" ", size);
    const maxWidth = PAGE_W - MARGIN - (MARGIN + indent);
    const marker = opts.marker;

    let line: LaidWord[] = [];
    let lineWidth = 0;
    const drawLine = (isFirst: boolean): void => {
      need(lineHeight);
      let x = MARGIN + indent;
      if (isFirst && marker) {
        page.drawText(marker.text, { x: MARGIN, y: y - size, size, font: marker.font, color: rgb(0.1, 0.1, 0.1) });
      }
      for (let i = 0; i < line.length; i++) {
        const wd = line[i]!;
        page.drawText(wd.text, { x, y: y - size, size, font: wd.font, color: rgb(0.1, 0.1, 0.1) });
        x += wd.width + spaceWidth;
      }
      y -= lineHeight;
    };

    let drewAny = false;
    let firstLine = true;
    for (const wd of words) {
      const add = (line.length ? spaceWidth : 0) + wd.width;
      if (line.length && lineWidth + add > maxWidth) {
        drawLine(firstLine);
        drewAny = true;
        firstLine = false;
        line = [];
        lineWidth = 0;
      }
      line.push(wd);
      lineWidth += (line.length > 1 ? spaceWidth : 0) + wd.width;
    }
    if (line.length || !drewAny) drawLine(firstLine); // always emit at least one line (markers, empties)
  };

  // Title as a big heading.
  if (title.trim()) {
    flowRuns([{ text: title.trim(), bold: true }], 22, { bold: true });
    y -= 6;
  }

  for (const block of blocks) {
    switch (block.type) {
      case "heading": {
        const size = block.level === 1 ? 18 : block.level === 2 ? 15 : 13;
        y -= 6;
        need(size * 1.4);
        flowRuns(block.runs, size, { bold: true });
        y -= 4;
        break;
      }
      case "paragraph":
        flowRuns(block.runs, BODY_SIZE, {});
        y -= 6;
        break;
      case "list":
        block.items.forEach((item, i) => {
          flowRuns(item, BODY_SIZE, {}, {
            indent: 22,
            marker: { text: block.ordered ? `${i + 1}.` : "•", font: fonts.regular },
          });
          y -= 2;
        });
        y -= 4;
        break;
      case "code": {
        const size = 9.5;
        const lh = size * 1.3;
        for (const lineText of block.text.split("\n")) {
          need(lh);
          page.drawText(lineText.replace(/\t/g, "    ") || " ", {
            x: MARGIN + 6,
            y: y - size,
            size,
            font: fonts.mono,
            color: rgb(0.2, 0.2, 0.25),
          });
          y -= lh;
        }
        y -= 6;
        break;
      }
      case "rule":
        need(12);
        y -= 4;
        page.drawLine({
          start: { x: MARGIN, y },
          end: { x: PAGE_W - MARGIN, y },
          thickness: 0.75,
          color: rgb(0.6, 0.6, 0.6),
        });
        y -= 10;
        break;
    }
  }

  return doc.save();
}

/** Convenience: Markdown straight to a `.docx`. */
export function markdownToDocx(title: string, md: string): Uint8Array {
  return blocksToDocx(title, markdownToBlocks(md));
}

/** Convenience: Markdown straight to a `.pdf`. */
export function markdownToPdf(title: string, md: string): Promise<Uint8Array> {
  return blocksToPdf(title, markdownToBlocks(md));
}

/** MIME types for the document formats this module produces. */
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const PDF_MIME = "application/pdf";
