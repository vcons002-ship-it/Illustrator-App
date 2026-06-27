/**
 * In-place file editing — search/replace blocks (the reliable format leading coding agents use),
 * applied to a file's text so the model edits an EXISTING file without re-emitting the whole thing
 * (which truncates on big files and is token-expensive). Each `search` must match EXACTLY ONCE so an
 * edit is never applied to the wrong place; zero or ambiguous matches are reported, not guessed. PURE —
 * the host reads the file, calls this, writes the result back. See the `edit_file` tool.
 */

/** One search/replace edit: find `search` (verbatim) and swap it for `replace`. */
export interface FileEdit {
  search: string;
  replace: string;
}

/** Why a single edit couldn't be applied. */
export interface FileEditFailure {
  index: number;
  search: string;
  reason: "not_found" | "ambiguous";
}

export interface FileEditResult {
  /** The edited text (edits that failed are skipped — partial application is reported via failures). */
  content: string;
  /** How many edits applied cleanly. */
  applied: number;
  /** Edits that matched zero (not_found) or 2+ (ambiguous) times. */
  failures: FileEditFailure[];
}

/** Count non-overlapping occurrences of `needle` in `hay` (verbatim). */
function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Apply search/replace edits to `content`, in order. Each `search` must match EXACTLY ONCE in the
 * CURRENT text (after any prior edits) — 0 matches → `not_found`, 2+ → `ambiguous` — so an edit can
 * never land in the wrong spot. Failed edits are skipped and reported so the caller can tell the model
 * to retry with a more specific anchor (more surrounding context). PURE.
 */
export function applyFileEdits(content: string, edits: FileEdit[]): FileEditResult {
  let out = content;
  let applied = 0;
  const failures: FileEditFailure[] = [];
  edits.forEach((edit, index) => {
    const { search, replace } = edit;
    const matches = countOccurrences(out, search);
    if (matches === 1) {
      out = out.replace(search, replace);
      applied++;
    } else {
      failures.push({ index, search, reason: matches > 1 ? "ambiguous" : "not_found" });
    }
  });
  return { content: out, applied, failures };
}

/** A one-line, model-facing summary of an edit result (for the tool feedback). */
export function summarizeFileEdits(path: string, r: FileEditResult): string {
  if (r.failures.length === 0) return `[edit_file applied ${r.applied} edit(s) to ${path}.]`;
  const why = r.failures
    .map((f) => `#${f.index + 1} ${f.reason === "ambiguous" ? "matched 2+ places (add more surrounding context)" : "no exact match (re-read the file; copy the text verbatim)"}`)
    .join("; ");
  return `[edit_file: ${r.applied} applied, ${r.failures.length} FAILED on ${path} — ${why}. The file is unchanged for the failed edits.]`;
}
