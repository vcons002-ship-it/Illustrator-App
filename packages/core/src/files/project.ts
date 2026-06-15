import { zipSync, strToU8 } from "fflate";

/**
 * Bundle the multiple files an assistant emits (a linked HTML/CSS/JS site, a small
 * script project) into ONE downloadable .zip, so a multi-file answer stays together
 * with its relative links intact instead of being saved file-by-file. Pure + fflate,
 * so it's unit-tested in core; the chat UI collects the named code blocks and the host
 * saves the bytes (desktop → ~/VisualReader/exports, web → a download).
 */

export interface ProjectFile {
  /** Relative path within the project, e.g. "index.html" or "src/app.js". */
  name: string;
  content: string;
}

export const PROJECT_ZIP_MIME = "application/zip";
export const MAX_PROJECT_FILES = 50;
const MAX_PATH_CHARS = 120;

/** Strip control chars and the characters illegal in a path segment on common
 * filesystems. */
function cleanSegment(seg: string): string {
  let out = "";
  for (const ch of seg) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20) continue; // control chars
    if ('<>:"|?*'.includes(ch)) continue; // illegal on Windows etc.
    out += ch;
  }
  return out.trim();
}

/**
 * A safe RELATIVE path for an archive entry: forward slashes, no leading slash (never
 * absolute), no "." / ".." segments (no traversal/escape), illegal/control chars
 * stripped, length-bounded. Returns "" when nothing usable remains.
 */
export function sanitizeProjectPath(name: string): string {
  return name
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map(cleanSegment)
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/")
    .slice(0, MAX_PATH_CHARS);
}

/** Cap the set and force unique, safe paths — collisions get "-2"/"-3" before the
 * extension, unnamed entries become "file-N". */
export function dedupeProjectFiles(files: ProjectFile[]): ProjectFile[] {
  const out: ProjectFile[] = [];
  const seen = new Set<string>();
  let untitled = 0;
  for (const f of files.slice(0, MAX_PROJECT_FILES)) {
    let path = sanitizeProjectPath(f.name) || `file-${++untitled}.txt`;
    if (seen.has(path.toLowerCase())) {
      const slash = path.lastIndexOf("/");
      const dot = path.lastIndexOf(".");
      const stem = dot > slash ? path.slice(0, dot) : path;
      const ext = dot > slash ? path.slice(dot) : "";
      let n = 2;
      while (seen.has(`${stem}-${n}${ext}`.toLowerCase())) n++;
      path = `${stem}-${n}${ext}`;
    }
    seen.add(path.toLowerCase());
    out.push({ name: path, content: f.content });
  }
  return out;
}

/** Zip a set of text files (sanitised + deduped) into a project archive. */
export function zipProject(files: ProjectFile[]): Uint8Array {
  const record: Record<string, Uint8Array> = {};
  for (const f of dedupeProjectFiles(files)) record[f.name] = strToU8(f.content);
  return zipSync(record);
}
