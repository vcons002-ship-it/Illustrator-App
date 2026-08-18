/**
 * WHAT A WORKSPACE LOOKS LIKE ON DISK, and why it needed a shape at all.
 *
 * Every chat wrote into one flat folder — `~/VisualReader/workspace` — because that is the default
 * working directory and nothing ever suggested otherwise: the prompt's worked examples are
 * `analysis.py`, `dragon.html`, `notes.md`. Weeks of unrelated conversations therefore land in the
 * same directory listing, and neither the reader nor the assistant can tell from it which files
 * belong together, which chat made them, or what any of it was for.
 *
 * The plumbing was never the obstacle. `write_workspace_file` splits a path on `/` and creates the
 * directories, and `create_document` already writes `documents/<slug>.md`. What was missing was a
 * convention, stated once, that everything can agree on.
 *
 * TWO AXES, because the two questions a reader asks are different:
 *
 *   WHICH CHAT MADE THIS?  → a folder per conversation, named after it.
 *   WHAT KIND OF THING IS IT? → a folder per kind, inside that.
 *
 *     workspace/
 *       landing-page/
 *         README.md          ← what this workspace is and what is in it
 *         code/index.html
 *         notes/brief.md
 *       tide-report/
 *         documents/report.md
 *         data/tides.csv
 *         images/chart.png
 *
 * Everything here is PURE, so the convention is one testable thing rather than a habit spread
 * across the prompt, the host and the Rust file writer.
 */

/** The kinds a workspace sorts into. Ordered as a README lists them: what you made, then what it
 * was made from, then what it produced. */
export const WORKSPACE_KINDS = ["code", "documents", "data", "images", "notes"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

/** Extensions that decide a file's kind. Deliberately small: an unknown extension gets no folder
 * rather than a wrong one, because a file in the wrong place is harder to find than one at the top. */
const KIND_BY_EXT: Readonly<Record<string, WorkspaceKind>> = {
  // code — anything meant to be run, rendered or imported
  html: "code", htm: "code", css: "code", js: "code", mjs: "code", cjs: "code", ts: "code", tsx: "code",
  jsx: "code", py: "code", rb: "code", go: "code", rs: "code", java: "code", c: "code", h: "code",
  cpp: "code", cs: "code", sh: "code", bash: "code", ps1: "code", sql: "code", svg: "code",
  // documents — prose a person reads
  md: "documents", markdown: "documents", txt: "documents", pdf: "documents", docx: "documents",
  rtf: "documents", odt: "documents",
  // data — structured input or output
  csv: "data", tsv: "data", json: "data", yaml: "data", yml: "data", xml: "data", xlsx: "data",
  parquet: "data", db: "data", sqlite: "data",
  // images — what a render or a chart produces
  png: "images", jpg: "images", jpeg: "images", gif: "images", webp: "images", bmp: "images",
  avif: "images", mp4: "images", webm: "images",
};

/**
 * A FILE THAT NAMES ITS OWN HOME. Config and project metadata stay at the workspace root, where a
 * person and a build tool both expect them — burying `package.json` under `data/` would break the
 * thing it configures, and `README.md` under `documents/` is no longer the README.
 */
const ROOT_FILES: ReadonlySet<string> = new Set([
  "readme.md", "agents.md", "conventions.md", "requirements.md", "tasks.md", "license", "license.md",
  "package.json", "tsconfig.json", "pyproject.toml", "requirements.txt", "cargo.toml", "go.mod",
  "makefile", "dockerfile", ".gitignore", ".env", "index.html",
]);

/** Lowercased extension of a path, without the dot. Empty when there is none. */
function extensionOf(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Which folder a file belongs in, or `undefined` for the workspace root. PURE.
 *
 * `index.html` is the interesting case and it is deliberately a ROOT file: it is the entry point of
 * whatever the workspace holds, the thing a reader double-clicks. A single-page deliverable should
 * be the first thing in the folder, not one level down among its parts.
 */
export function kindForFile(path: string): WorkspaceKind | undefined {
  const base = (path.split(/[/\\]/).pop() ?? "").toLowerCase();
  if (!base) return undefined;
  if (ROOT_FILES.has(base)) return undefined;
  return KIND_BY_EXT[extensionOf(base)];
}

/**
 * The workspace-relative path a new file should be written to. PURE.
 *
 * Idempotent on a path that already names a folder — the model may well write `code/app.js` itself,
 * and re-prefixing it to `code/code/app.js` would be worse than doing nothing.
 */
export function workspacePathFor(filename: string): string {
  const parts = filename.split(/[/\\]/).filter((p) => p && p !== "." && p !== "..");
  if (parts.length === 0) return filename;
  if (parts.length > 1) return parts.join("/"); // already placed — the model said where it goes
  const kind = kindForFile(parts[0]!);
  return kind ? `${kind}/${parts[0]!}` : parts[0]!;
}

/** How long a chat's folder name may be. Long enough to stay recognisable in a directory listing,
 * short enough that the path it prefixes does not become the problem. */
const MAX_FOLDER_CHARS = 40;

/**
 * A CONVERSATION'S FOLDER NAME, from what the reader calls it. PURE.
 *
 * Named from the chat's own label so the folder means something in a file browser — the whole point
 * is that `~/VisualReader/workspace` becomes readable without opening anything. Falls back to the
 * session id when a chat has no name, because an unnamed chat's files still have to go somewhere and
 * a stable ugly name beats a pretty collision.
 */
export function chatFolderName(label: string | undefined, sessionId: string): string {
  const slug = (label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_FOLDER_CHARS)
    .replace(/-+$/, "");
  // "Chat 13" slugs to "chat-13", which is honest but says nothing; it is still better than the raw
  // id, and it changes the moment the reader renames the chat.
  if (slug) return slug;
  const fallback = sessionId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return fallback.slice(0, MAX_FOLDER_CHARS) || "chat";
}

export interface WorkspaceEntry {
  /** Workspace-relative path, e.g. `code/index.html`. */
  path: string;
  /** One line on what it is — the assistant's own description when it wrote the file. */
  note?: string;
}

/** Marks the generated section so a README the reader has edited around it survives a rewrite. */
export const README_BEGIN = "<!-- visual-reader:files -->";
export const README_END = "<!-- /visual-reader:files -->";

/**
 * THE WORKSPACE, DESCRIBED IN THE WORKSPACE. PURE.
 *
 * A folder structure says what KIND each file is and says nothing about what any of it was FOR. The
 * README is the part a person can read six weeks later, and — because it is a file on disk rather
 * than chat history — it is also the part the assistant can still read after the conversation that
 * created it has scrolled out of the context window. That second property is why this is worth
 * maintaining rather than leaving to the folder names.
 *
 * Only the marked section is generated. Anything the reader writes above or below it is theirs, and
 * `mergeWorkspaceReadme` puts it back.
 */
export function buildWorkspaceReadme(title: string, entries: readonly WorkspaceEntry[]): string {
  const byKind = new Map<string, WorkspaceEntry[]>();
  for (const e of entries) {
    const dir = e.path.includes("/") ? e.path.slice(0, e.path.indexOf("/")) : "";
    const list = byKind.get(dir) ?? [];
    list.push(e);
    byKind.set(dir, list);
  }
  const order = ["", ...WORKSPACE_KINDS];
  const sections: string[] = [];
  for (const dir of order) {
    const list = byKind.get(dir);
    if (!list?.length) continue;
    const heading = dir === "" ? "In this folder" : dir;
    const rows = list
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((e) => `- \`${e.path}\`${e.note ? ` — ${e.note}` : ""}`);
    sections.push(`### ${heading}\n${rows.join("\n")}`);
  }
  // An empty workspace says so rather than showing a bare heading: "nothing here yet" is information.
  const body = sections.length ? sections.join("\n\n") : "_Nothing saved here yet._";
  return `# ${title}\n\n${README_BEGIN}\n${body}\n${README_END}\n`;
}

/**
 * Put a regenerated file list back into an existing README, preserving whatever the reader wrote
 * around the markers. A README with no markers is treated as entirely theirs and the list is
 * appended — overwriting a person's own notes to keep an index tidy is not a trade worth making. PURE.
 */
export function mergeWorkspaceReadme(existing: string | undefined, generated: string): string {
  const prior = existing ?? "";
  if (!prior.trim()) return generated;
  const from = prior.indexOf(README_BEGIN);
  const to = prior.indexOf(README_END);
  const section = generated.slice(generated.indexOf(README_BEGIN));
  if (from === -1 || to === -1 || to < from) return `${prior.trimEnd()}\n\n${section}`;
  return `${prior.slice(0, from)}${section.trimEnd()}\n${prior.slice(to + README_END.length).replace(/^\n/, "")}`;
}

/**
 * Source language (or a bare extension) → the extension a code file should carry on disk.
 *
 * Small on purpose, same as `KIND_BY_EXT`: a language we don't know gets `.txt`, which is honest and
 * still openable, rather than a guess that makes the file look like something it isn't.
 */
const EXT_BY_LANGUAGE: Readonly<Record<string, string>> = {
  html: "html", htm: "html", svg: "svg", xml: "xml", css: "css",
  js: "js", javascript: "js", jsx: "jsx", ts: "ts", typescript: "ts", tsx: "tsx",
  py: "py", python: "py", rb: "rb", ruby: "rb", go: "go", golang: "go", rs: "rs", rust: "rs",
  java: "java", c: "c", "c++": "cpp", cpp: "cpp", cs: "cs", csharp: "cs", php: "php", swift: "swift",
  kt: "kt", kotlin: "kt", sh: "sh", bash: "sh", shell: "sh", zsh: "sh", ps1: "ps1", powershell: "ps1",
  sql: "sql", json: "json", yaml: "yaml", yml: "yaml", toml: "toml", md: "md", markdown: "md",
  txt: "txt", text: "txt",
};

/**
 * THE FILENAME A CODE WINDOW'S SOURCE IS SAVED UNDER. PURE.
 *
 * The old rule was the book's title with every non-word character turned into `_` and NOTHING ELSE —
 * so "Solar System Page" became `Solar_System_Page`, a file with no extension. Nothing downstream
 * could work with that: the kind-sorter had no extension to read, `run_command` had no interpreter to
 * infer, the browser had no type to render, and the reader saw a file their computer refused to open.
 *
 * A title that already ends in an extension is left alone — the model naming its own file
 * (`particles.js`) is a decision, not an accident.
 */
export function codeFileNameFor(title: string, language?: string): string {
  const safe =
    (title || "code")
      .trim()
      .toLowerCase()
      .replace(/[^\w.-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 80)
      .replace(/[-.]+$/, "") || "code";
  if (/\.[a-z0-9]{1,8}$/.test(safe)) return safe;
  return `${safe}.${EXT_BY_LANGUAGE[(language ?? "").trim().toLowerCase()] ?? "txt"}`;
}
