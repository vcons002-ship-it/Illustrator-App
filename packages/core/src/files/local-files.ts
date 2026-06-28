/**
 * Ranking for local-file search results (desktop). The Rust side walks the disk
 * and returns coarse filename matches; this pure pass ranks them so the best
 * candidates surface first — host-agnostic and unit-testable, no `fs` needed.
 *
 * File-system access is offered ONLY through explicit user commands (the `/find`
 * and `/open` slash commands), never as an LLM-invokable tool: a web page or
 * book text must never be able to talk the model into reading the user's disk.
 */

export interface RankableFile {
  /** Absolute path on disk. */
  path: string;
  /** File name (basename). */
  name: string;
}

/** A file found by the desktop search (the Rust `search_files` result shape). */
export interface LocalFile extends RankableFile {
  /** Lower-cased extension without the dot. */
  ext: string;
  /** Size in bytes (0 when unknown). */
  size: number;
}

/** File extensions the importer understands (mirrors the web importer's accept). */
export const SEARCHABLE_FILE_EXTS = [
  "epub", "pdf", "txt", "md", "markdown", "html", "htm",
  "docx", "rtf", "csv", "tsv", "json", "xlsx",
  "png", "jpg", "jpeg", "webp", "gif", // images → the photo-transform path
] as const;

/**
 * Filler words people say when phrasing a search ("find my notes file", "any md files") that aren't
 * part of a filename. Dropped before matching — otherwise a token like "files" is required in the name
 * and matches nothing, so "find my md files" returns zero hits. "doc"/"document" count as filler too
 * (too generic to filter on); a real type hint ("md", "pdf", "image") is handled by FILE_TYPE_EXTS.
 */
const FIND_STOP_WORDS = new Set([
  "find", "search", "look", "locate", "get", "open", "show", "give", "fetch", "grab",
  "me", "my", "the", "a", "an", "any", "some", "all", "please", "and", "that", "this",
  "for", "of", "on", "in", "about", "with", "named", "called", "titled", "named",
  "file", "files", "doc", "docs", "document", "documents",
]);

/**
 * Type words → the extensions they mean, so "md files" filters to .md, "a photo of …" to images, etc.
 * A token matches a file when its NAME contains the token OR (the token is a type word and) the file's
 * EXTENSION is one of its types — so type words act as a filter without having to appear in the name.
 */
const FILE_TYPE_EXTS: Record<string, readonly string[]> = {
  md: ["md", "markdown"], markdown: ["md", "markdown"],
  pdf: ["pdf"], pdfs: ["pdf"],
  txt: ["txt"], text: ["txt"],
  docx: ["docx"], word: ["doc", "docx"],
  rtf: ["rtf"], epub: ["epub"], ebook: ["epub"], ebooks: ["epub"],
  csv: ["csv"], tsv: ["tsv"], json: ["json"],
  xlsx: ["xlsx", "xls"], xls: ["xlsx", "xls"], excel: ["xlsx", "xls"],
  spreadsheet: ["xlsx", "xls", "csv", "ods"], spreadsheets: ["xlsx", "xls", "csv", "ods"], sheet: ["xlsx", "xls", "csv"],
  html: ["html", "htm"], htm: ["html", "htm"], webpage: ["html", "htm"],
  png: ["png"], jpg: ["jpg", "jpeg"], jpeg: ["jpg", "jpeg"], webp: ["webp"], gif: ["gif"],
  image: ["png", "jpg", "jpeg", "webp", "gif"], images: ["png", "jpg", "jpeg", "webp", "gif"],
  photo: ["png", "jpg", "jpeg", "webp", "gif"], photos: ["png", "jpg", "jpeg", "webp", "gif"],
  picture: ["png", "jpg", "jpeg", "webp", "gif"], pictures: ["png", "jpg", "jpeg", "webp", "gif"], pic: ["png", "jpg", "jpeg", "webp", "gif"],
};

function tokenize(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

/** Query tokens with filler words removed (what actually has to match a filename). */
function queryTokens(q: string): string[] {
  return tokenize(q).filter((t) => !FIND_STOP_WORDS.has(t));
}

function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

/** Lower-cased extension (no dot) for a filename ("" when none). */
function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** A token is satisfied when it appears in the name OR it's a type word matching the file's extension. */
function tokenMatches(lowerName: string, ext: string, token: string): boolean {
  if (lowerName.includes(token)) return true;
  const types = FILE_TYPE_EXTS[token];
  return types ? types.includes(ext) : false;
}

/**
 * Rank coarse filename matches against a query. After dropping filler words, keeps files where EVERY
 * remaining token is satisfied — present in the name, OR a type word ("md", "pdf", "photo") matching
 * the extension — so "md files" finds every .md even though "md" isn't spelled in the name. Orders by:
 * exact stem match, then the content tokens appearing together, then earliest name match, shorter name.
 */
export function rankLocalFiles<T extends RankableFile>(
  query: string,
  files: readonly T[],
  limit = 20,
): T[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const scored: { file: T; score: number }[] = [];
  // Tokens that aren't pure type words are the "content" the name should contain (for the joined bonus).
  const contentTokens = tokens.filter((t) => !FILE_TYPE_EXTS[t]);
  const joined = contentTokens.join(" ");
  for (const file of files) {
    const lowerName = file.name.toLowerCase();
    const ext = extOf(file.name);
    if (!tokens.every((t) => tokenMatches(lowerName, ext, t))) continue;
    let score = 0;
    if (joined && stem(file.name) === joined) score += 1000; // exact "the title" match
    if (joined && lowerName.includes(joined)) score += 200; // content tokens appear together, in order
    // Earlier first-name-token position scores higher (title-leading match beats one buried deep in a
    // long descriptive filename). Falls back to any matched token when the first is only an ext match.
    const firstInName = tokens.find((t) => lowerName.includes(t));
    if (firstInName) score += Math.max(0, 100 - lowerName.indexOf(firstInName));
    score -= Math.min(80, file.name.length); // prefer the tersest matching name
    scored.push({ file, score });
  }
  scored.sort((a, b) => b.score - a.score || a.file.name.localeCompare(b.file.name));
  return scored.slice(0, limit).map((s) => s.file);
}

/** A human "1.2 MB" / "340 KB" size, for the file list. 0/uknown → "". */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
