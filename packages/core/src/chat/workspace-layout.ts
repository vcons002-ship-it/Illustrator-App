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
 *         index.html         ← code stays at the top, where run_command runs
 *         app.js
 *         notes/brief.md
 *       tide-report/
 *         tides.py
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
  // NO `code` ENTRIES, AND THAT IS THE RULE: sort what is only ever READ, and leave what is RUN
  // where it runs. Source files used to sort into `code/`, which quietly broke every project of more
  // than one file — a shell command runs in the workspace ROOT, so a model that wrote `main.py` with
  // write_file (sorted into `code/`) and `test_main.py` with a shell redirect (left at the root) got
  // two files in two directories and a test that could not import the module it was testing. Nothing
  // in the run looked wrong; the checklist went green.
  //
  // The app cannot sort what the shell writes, so the only way for the two to agree is for neither
  // to move anything. Prose, data, pictures and notes are never `cd`-ed into, imported, or passed to
  // an interpreter, so filing those costs nothing and is most of the readability anyway.
  //
  // `code/` stays a KIND, so a path the model places there itself is honoured and the README still
  // groups it — this only stops the app from putting files there behind the shell's back.
  //
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
 * SOURCE FILES ALWAYS RETURN UNDEFINED — see KIND_BY_EXT for why: anything that runs has to sit
 * where commands run, and commands run in the workspace root.
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

/**
 * STITCHING A CHUNKED FILE, WHICH NOTHING WAS DOING.
 *
 * A big file is written in pieces: the first with write_file, the rest with `append:true`. That is
 * the protocol the prompt asks for, and the whole of what the app did with it was concatenate bytes.
 * The model was told only "APPENDED this chunk" — not how much is on disk, not what the file now
 * ends with, not whether the join is sound. So it continued from its own memory of what it had
 * emitted, which is precisely the thing that is unreliable after a reply ran out mid-file, and which
 * may not even be in its context any more once history has been trimmed.
 *
 * A re-sent line at a join duplicates silently. A skipped one leaves a hole. Both produce a file that
 * often still parses, which is the worst outcome available.
 *
 * So the join is checked: the longest suffix of what is on disk that the incoming chunk repeats is
 * removed before writing.
 *
 * THREE CONDITIONS, and each one is doing work. Two line breaks, so this is a repeated PASSAGE. A
 * character floor, because `}\n}\n` is four characters spanning two breaks and is perfectly ordinary
 * at the end of nested code — deleting it would corrupt exactly the file this exists to protect. And
 * at least one substantial line, because an overlap made only of punctuation and indentation is a
 * coincidence however long it is, while one containing a real line of code is not.
 *
 * This is a heuristic and it is worth being honest that it is: it can only ever be wrong in the
 * direction of dropping something, so it is built to need real evidence before it does.
 */
const MIN_OVERLAP_CHARS = 24;
const SUBSTANTIAL_LINE = /[^\s]{8}/;

export interface AppendJoin {
  /** What should actually be written. */
  chunk: string;
  /** Characters of duplicate removed from the front of the incoming chunk (0 when the join was clean). */
  trimmed: number;
}

export function joinAppendedChunk(existing: string, chunk: string): AppendJoin {
  const max = Math.min(existing.length, chunk.length);
  for (let n = max; n >= MIN_OVERLAP_CHARS; n--) {
    const tail = existing.slice(existing.length - n);
    if (!chunk.startsWith(tail)) continue;
    if ((tail.match(/\n/g) ?? []).length < 2) continue;
    if (!tail.split("\n").some((l) => SUBSTANTIAL_LINE.test(l))) continue;
    return { chunk: chunk.slice(n), trimmed: n };
  }
  return { chunk, trimmed: 0 };
}

/** The last `lines` lines of a file — the anchor a continuation needs, and the one thing the model
 * was never told. Bounded so a single enormous line can't flood the reply it rides in. */
export function fileTail(text: string, lines = 3, maxChars = 400): string {
  // A file almost always ends with a newline, which splits to a trailing empty string — counting that
  // as one of the anchor lines would spend a third of the anchor on nothing.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const tail = body.split("\n").slice(-lines).join("\n");
  return tail.length > maxChars ? `…${tail.slice(tail.length - maxChars)}` : tail;
}

/**
 * WHOLE-FILE REWRITES OF EXISTING CODE, AND WHY THE APP REFUSES THEM.
 *
 * The prompt has told the model for a long time not to rewrite a big file from memory: the file
 * ledger says it every turn, and the write_file guidance says a big file will not fit in one reply.
 * It does it anyway, because a model asked to "fix this" reaches for the whole file — and the result
 * is the failure the reader watched twice: the reply runs out mid-file, or the model re-types a
 * verified file from memory in three chunks purely to make a card appear, with a working page one
 * transcription slip from being destroyed.
 *
 * Persuasion has had its turn. This is the same decision the reader already made, so the app makes
 * it: an existing source file of any size worth caring about cannot be replaced wholesale. It can be
 * CHANGED in place (edit_file, which is a diff and cannot truncate), handed to the external coding
 * agent (which edits files directly), appended to, or written under a NEW name. Nothing legitimate is
 * lost — a fresh file, a small file and an append are all untouched.
 *
 * The floor exists so this never fires on a stub. Rewriting eight lines is not the failure mode; it
 * is quick, it fits in a reply, and refusing it would only teach the model that write_file is
 * unreliable.
 */
export const REWRITE_GUARD_MIN_LINES = 40;

/** Extensions the guard covers: things that are RUN or compiled, where a truncated file is a broken
 * one. Prose and data are deliberately absent — a half-written note is obvious to its reader, and
 * regenerating a .md or .csv from a template is ordinary work. */
const GUARDED_CODE_EXTS: ReadonlySet<string> = new Set([
  "html", "htm", "css", "js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash",
  "ps1", "sql", "lua", "r", "pl",
]);

/**
 * The refusal a whole-file rewrite of an existing source file earns, or undefined when the write is
 * fine. Model-facing: it names every route that still works, because a refusal that does not say
 * what to do instead is just a wall.
 */
export function wholeFileRewriteRefusal(input: {
  path: string;
  append?: boolean;
  exists: boolean;
  existingLines: number;
}): string | undefined {
  if (input.append || !input.exists) return undefined;
  if (input.existingLines < REWRITE_GUARD_MIN_LINES) return undefined;
  const ext = (input.path.split(/[/\\]/).pop() ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (!GUARDED_CODE_EXTS.has(ext)) return undefined;
  return (
    `[write_file REFUSED — ${input.path} already exists and is ${input.existingLines} lines, and this ` +
    `call would replace the whole of it from memory. That is how the work gets lost: the reply runs ` +
    `out part way and what lands on disk is half a file. Nothing has been written; the file on disk ` +
    `is untouched.\n` +
    `Do it one of these ways instead:\n` +
    `- CHANGE it in place: read_file it, then edit_file with search/replace. This is almost always ` +
    `what you want, it cannot truncate, and it is far cheaper than re-typing the file.\n` +
    `- Hand the job to the coding agent: delegate_coding_task, which edits the files itself and ` +
    `reports a diff. Right for a change touching several places or several files.\n` +
    `- ADD to the end: the same call with "append":true.\n` +
    `- Genuinely need a fresh file? Write it under a NEW name.\n` +
    `If you only wanted the reader to SEE the file, it is already on disk — say so and tell them to ` +
    `type /show ${input.path}, which puts its card in the chat. Do not re-save a file to make a card.]`
  );
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
 * WHICH CHAT OWNS THIS FOLDER, written into its README.
 *
 * Folders are named after the conversation, and two conversations can easily want the same name —
 * "Chat 13" is a POSITION in the list, so deleting an earlier chat makes the number come round
 * again. Without a way to tell whose folder a directory is, the second one would quietly move into
 * the first one's files. The id is in the README rather than a dotfile because the README already
 * has to exist, already gets written on creation, and a marker in a file the reader can see is
 * easier to reason about than one hidden from them.
 */
export function chatIdMarker(sessionId: string): string {
  return `<!-- visual-reader:chat ${sessionId} -->`;
}

/** The chat id recorded in a README, or undefined if it carries none (a folder made by hand, or by
 * a version of the app older than the marker). */
export function readmeChatId(text: string | undefined): string | undefined {
  return /<!--\s*visual-reader:chat\s+(\S+?)\s*-->/.exec(text ?? "")?.[1];
}

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
export function buildWorkspaceReadme(title: string, entries: readonly WorkspaceEntry[], sessionId?: string): string {
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
  // The owner marker sits INSIDE the generated block, so mergeWorkspaceReadme carries it forward with
  // the rest of it and a reader editing around the block can't accidentally strip the folder's identity.
  const owner = sessionId ? `${chatIdMarker(sessionId)}\n` : "";
  return `# ${title}\n\n${README_BEGIN}\n${owner}${body}\n${README_END}\n`;
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
