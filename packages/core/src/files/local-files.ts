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
] as const;

function tokenize(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

/**
 * Rank coarse filename matches against a query. Keeps only files whose name
 * contains EVERY query token (the same AND the Rust walk applies, re-checked
 * here so a custom result set is filtered too), then orders by: exact stem
 * match, then whole name as one run, then earliest match, then shorter name.
 */
export function rankLocalFiles<T extends RankableFile>(
  query: string,
  files: readonly T[],
  limit = 20,
): T[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const scored: { file: T; score: number }[] = [];
  const joined = tokens.join(" ");
  for (const file of files) {
    const lowerName = file.name.toLowerCase();
    if (!tokens.every((t) => lowerName.includes(t))) continue;
    let score = 0;
    if (stem(file.name) === joined) score += 1000; // exact "the title" match
    if (lowerName.includes(joined)) score += 200; // tokens appear together, in order
    // Earlier first-token position scores higher (title-leading match beats a
    // match buried deep in a long descriptive filename).
    score += Math.max(0, 100 - lowerName.indexOf(tokens[0]!));
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
