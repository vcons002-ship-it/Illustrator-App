/**
 * A tiny, dependency-free Markdown → block model. Shared so the document EXPORTERS (PDF/Word, in
 * @visual-reader/epub) and the document VIEWERS (the reader + the inline chat renderer, in the UI)
 * render the SAME structure. Scope is a text document: headings, paragraphs with bold/italic/code
 * runs, bullet + numbered lists, fenced code blocks, and rules — not arbitrary CSS layout. PURE.
 */

/** One styled span of text within a block. */
export interface DocInline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Inline `code` — monospaced. */
  code?: boolean;
}

export type DocBlock =
  | { type: "heading"; level: 1 | 2 | 3; runs: DocInline[] }
  | { type: "paragraph"; runs: DocInline[] }
  | { type: "list"; ordered: boolean; items: DocInline[][] }
  | { type: "code"; text: string }
  | { type: "rule" };

/** Split a line of Markdown into styled runs (**bold**, __bold__, *italic*, _italic_, `code`). */
export function parseInline(text: string): DocInline[] {
  const runs: DocInline[] = [];
  // Bold (** or __) is tried before italic (* or _) so `**x**` doesn't match as italic; `` `code` ``
  // last. Unmatched markers fall through as literal text.
  const re = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[2] !== undefined) runs.push({ text: m[2], bold: true });
    else if (m[4] !== undefined) runs.push({ text: m[4], italic: true });
    else if (m[5] !== undefined) runs.push({ text: m[5], code: true });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text }];
}

/**
 * Parse a Markdown string into the block model. Deliberately small + forgiving: headings (#/##/###),
 * fenced ``` code blocks, bullet (-,*,+) and numbered (1.) lists, `---` rules, and blank-line-separated
 * paragraphs (soft-wrapped lines joined with a space). Anything it doesn't recognise becomes prose.
 */
export function markdownToBlocks(md: string): DocBlock[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: DocBlock[] = [];
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length) {
      blocks.push({ type: "paragraph", runs: parseInline(para.join(" ").trim()) });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trimEnd();
    const trimmed = line.trim();

    // Fenced code block: collect verbatim until the closing fence.
    const fence = /^```/.test(trimmed);
    if (fence) {
      flushPara();
      const body: string[] = [];
      i++;
      for (; i < lines.length; i++) {
        if (/^```/.test((lines[i] ?? "").trim())) break;
        body.push(lines[i] ?? "");
      }
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    if (trimmed === "") {
      flushPara();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      const level = Math.min(3, heading[1]!.length) as 1 | 2 | 3;
      blocks.push({ type: "heading", level, runs: parseInline(heading[2]!.trim()) });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara();
      blocks.push({ type: "rule" });
      continue;
    }

    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listItem) {
      flushPara();
      const ordered = /\d/.test(listItem[2]!);
      const items: DocInline[][] = [parseInline(listItem[3]!.trim())];
      // Absorb following list lines of the same ordered/unordered kind.
      while (i + 1 < lines.length) {
        const next = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec((lines[i + 1] ?? "").trimEnd());
        if (!next || /\d/.test(next[2]!) !== ordered) break;
        items.push(parseInline(next[3]!.trim()));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    para.push(trimmed);
  }
  flushPara();
  return blocks;
}
