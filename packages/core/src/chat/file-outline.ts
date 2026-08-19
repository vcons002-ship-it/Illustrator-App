/**
 * A MAP OF A FILE, so a change to line 698 does not require reading 711 lines to find it.
 *
 * This is the smallest useful version of what Aider calls a repo map. There the problem is fitting a
 * whole codebase into a window; here it is one file, and the window is a local model's 27k characters
 * of input — a single page of generated HTML can be most of that, which is how a chat ends up with no
 * room left for the conversation that was asking for the change.
 *
 * read_file already takes a line RANGE. What was missing is any way to know which range to ask for:
 * the only route to line 698 was to read from line 1 and count. The outline answers that, and the
 * model then reads a few dozen lines instead of seven hundred.
 *
 * A HEURISTIC INDEX, NOT A PARSE, and it is worth being plain about the difference. There is no
 * tree-sitter here and nothing is compiled; these are line patterns, they will miss an unusual
 * declaration and occasionally name something that is not a definition. That is an acceptable trade
 * for a signpost — a wrong entry costs one wasted range read, while no outline costs the whole file.
 */

/** One thing worth knowing the position of. */
export interface OutlineEntry {
  /** 1-based. */
  line: number;
  /** What it is, as it reads in the file — deliberately the source text rather than a normalised name. */
  label: string;
}

/** Words that begin a STATEMENT, not a definition — `if (x) {` looks exactly like a method otherwise,
 * and an outline made mostly of `if` is worse than none. */
const NOT_A_NAME = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "else", "do", "try", "with",
  "constructor", "typeof", "new", "delete", "void", "in", "of", "case", "default",
]);

const PATTERNS: readonly { re: RegExp; pick: (m: RegExpMatchArray) => string | undefined }[] = [
  // Markdown / prose structure.
  { re: /^(#{1,6})\s+(.+?)\s*$/, pick: (m) => `${m[1]} ${m[2]}` },
  // function foo(…) — JS/TS, with or without export/async.
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/, pick: (m) => `function ${m[1]}()` },
  // class Foo / Python class.
  { re: /^\s*(?:export\s+)?(?:default\s+)?class\s+([\w$]+)/, pick: (m) => `class ${m[1]}` },
  // const foo = (…) => / = function
  {
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function\b|\(|[\w$]+\s*=>)/,
    pick: (m) => `${m[1]}()`,
  },
  // Python def.
  { re: /^\s*(?:async\s+)?def\s+([\w]+)/, pick: (m) => `def ${m[1]}()` },
  // A method or bare call-shaped definition: `tick() {`. Guarded by NOT_A_NAME.
  { re: /^\s{0,8}([\w$]+)\s*\([^)]*\)\s*\{\s*$/, pick: (m) => (NOT_A_NAME.has(m[1]!) ? undefined : `${m[1]}()`) },
  // HTML landmarks: a script/style block, or any element carrying an id.
  { re: /^\s*<(script|style)\b[^>]*>/i, pick: (m) => `<${m[1]!.toLowerCase()}>` },
  { re: /^\s*<(\w+)\b[^>]*\bid=["']([\w-]+)["']/i, pick: (m) => `<${m[1]} id="${m[2]}">` },
  // A top-level CSS rule.
  { re: /^([.#@][\w-][^{;]{0,60})\{\s*$/, pick: (m) => m[1]!.trim() },
];

/** Below this a file is quicker to read than to index, and an outline is just noise in the reply. */
export const OUTLINE_MIN_LINES = 120;

export function fileOutline(text: string, maxEntries = 60): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    for (const { re, pick } of PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      const label = pick(m);
      if (label) out.push({ line: i + 1, label });
      break; // one entry per line — the first pattern that fits is the most specific one that did
    }
  }
  // Keep the ENDS when there are too many: the top of a file says what it is and the bottom is where
  // a generated page puts its wiring, which is exactly where the reported bug was.
  if (out.length <= maxEntries) return out;
  const head = Math.ceil(maxEntries * 0.6);
  return [...out.slice(0, head), ...out.slice(out.length - (maxEntries - head))];
}

/** The outline as it rides in a read_file result, or "" when there is nothing worth showing. */
export function outlineBlock(path: string, text: string): string {
  const total = text.split("\n").length;
  if (total < OUTLINE_MIN_LINES) return "";
  const entries = fileOutline(text);
  if (entries.length < 3) return ""; // nothing structural found — say nothing rather than guess
  const rows = entries.map((e) => `${String(e.line).padStart(5)}  ${e.label}`).join("\n");
  return (
    `[outline of ${path} — ${total} lines. Read a RANGE around what you need ` +
    `({"tool":"read","source":"file","ref":"${path}","from":N,"to":M}) rather than the whole file.]\n${rows}\n`
  );
}
