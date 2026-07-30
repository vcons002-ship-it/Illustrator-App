import { repairTruncatedJson } from "../providers/llm/extraction.js";

/**
 * Pull structured findings out of a document larger than any context window.
 *
 * THE DIVISION OF LABOUR WITH `read_file`. They are not competing ways to look at a file; they answer
 * different questions and cost completely different amounts.
 *
 *  - `read_file` puts text IN FRONT OF the model. The words enter the conversation and stay there.
 *    It is the right tool for a small file, for one known section, and — critically — before any
 *    edit, because `edit_file` matches verbatim and can only change text the model has actually seen.
 *  - This runs a loop the model never sees. The document is read in chunks by CODE, each chunk is put
 *    to the model on its own with a bounded record of what has already been found, and only the
 *    FINDINGS come back. A three-hundred-page document costs one result-sized message instead of
 *    three hundred pages, and the model cannot lose its place because it was never keeping it.
 *
 * They compose in one direction: extract to find out WHERE something is, then `read_file` with the
 * returned line anchors to look at it exactly. That is why every finding carries a line number — a
 * result you cannot navigate back to is a claim you have to take on faith.
 *
 * The methodology is the book pipeline's, which is the same problem solved for novels: iterate in
 * code, carry a compact summary rather than the text, merge into an accumulator, remember what is
 * done so a stop can resume, and treat one bad chunk as one bad chunk. Deliberately NOT sharing that
 * implementation — the Visual Bible path is the highest-traffic code in the app and has just been
 * through several rounds of fixes; the ~60 lines of loop duplicated here are cheaper than the risk of
 * destabilising it. Worth unifying once this has proven its shape.
 */

/** One slice of a document, with the line range it came from so a finding can be navigated back to. */
export interface DocumentChunk {
  index: number;
  /** 1-based inclusive line range in the source document. */
  fromLine: number;
  toLine: number;
  text: string;
}

/** One thing the extraction was asked to find. */
export interface DocumentFinding {
  /** What was found, in the document's own words where possible. */
  text: string;
  /** 1-based line it was found at — the anchor for a follow-up `read_file`. */
  line: number;
  /** Optional context the model thought worth keeping. */
  note?: string;
}

export interface DocumentExtraction {
  findings: DocumentFinding[];
  /** Chunk indices already processed — so a stopped run resumes instead of restarting. */
  done: number[];
  /** One line per chunk that failed, with the reason. A partial answer that SAYS it is partial. */
  notes: string[];
}

/** Findings past this are dropped: a result that doesn't fit its own reply is not a result. */
export const MAX_FINDINGS = 200;
/** Prior findings echoed into a chunk's prompt, so it doesn't re-report what is already known. */
const MAX_CARRIED_FINDINGS = 30;
/** Each carried finding is truncated to this — the model needs to recognise it, not re-read it. */
const MAX_CARRIED_CHARS = 120;
/**
 * Lines repeated at the start of each chunk after the first.
 *
 * A finding that straddles a chunk boundary is invisible to both halves — the sentence naming a date
 * ends in one chunk and the date itself starts the next. A small overlap means every boundary is seen
 * whole by at least one chunk; the duplicate findings that produces are collapsed on merge, which is
 * the cheaper direction to be wrong in.
 */
const OVERLAP_LINES = 6;

/** Empty state for a fresh run. */
export function emptyExtraction(): DocumentExtraction {
  return { findings: [], done: [], notes: [] };
}

/**
 * Split a document into chunks on LINE boundaries, never mid-line.
 *
 * Line boundaries because the anchors have to stay usable: a chunk that starts mid-line produces
 * findings whose line numbers don't survive a round trip through `read_file`. A single line longer
 * than the budget is kept whole rather than split — it is one unit of text, and cutting it would put
 * a finding at a position that doesn't exist.
 */
export function chunkDocument(text: string, chunkChars: number): DocumentChunk[] {
  const lines = text.split("\n");
  if (lines.length === 0 || !(chunkChars > 0)) return [];
  const chunks: DocumentChunk[] = [];
  let start = 0; // 0-based index of the first line of this chunk
  while (start < lines.length) {
    let end = start; // exclusive
    let used = 0;
    while (end < lines.length) {
      const len = lines[end]!.length + 1;
      if (used > 0 && used + len > chunkChars) break;
      used += len;
      end++;
    }
    chunks.push({
      index: chunks.length,
      fromLine: start + 1,
      toLine: end,
      text: lines.slice(start, end).join("\n"),
    });
    if (end >= lines.length) break;
    // Step back a few lines so a finding spanning the boundary is whole in the next chunk.
    start = Math.max(end - OVERLAP_LINES, start + 1);
  }
  return chunks;
}

/**
 * Fold a chunk's findings into the accumulated state.
 *
 * Deduped on the finding's own words, case- and whitespace-insensitively, keeping the EARLIEST
 * occurrence — the overlap between chunks means the same thing is genuinely seen twice, and the first
 * sighting has the anchor a reader would want. PURE.
 */
export function mergeFindings(
  state: DocumentExtraction,
  chunkIndex: number,
  found: readonly DocumentFinding[],
): DocumentExtraction {
  const seen = new Set(state.findings.map((f) => normalizeFinding(f.text)));
  const findings = [...state.findings];
  for (const f of found) {
    const text = f.text.trim();
    if (!text || findings.length >= MAX_FINDINGS) continue;
    const key = normalizeFinding(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const note = (f.note ?? "").trim();
    findings.push({ text, line: Math.max(1, Math.floor(f.line) || 1), ...(note ? { note } : {}) });
  }
  return {
    ...state,
    findings,
    done: state.done.includes(chunkIndex) ? state.done : [...state.done, chunkIndex],
  };
}

function normalizeFinding(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Record why one chunk produced nothing, so a partial answer says which part is missing. */
export function noteChunkFailure(
  state: DocumentExtraction,
  chunk: DocumentChunk,
  reason: string,
): DocumentExtraction {
  const why = reason.trim().replace(/\s+/g, " ").slice(0, 160);
  return {
    ...state,
    notes: [...state.notes, `lines ${chunk.fromLine}–${chunk.toLine} could not be read${why ? `: ${why}` : ""}`],
    done: state.done.includes(chunk.index) ? state.done : [...state.done, chunk.index],
  };
}

/**
 * The prompt for one chunk: the question, what is already known (bounded), and the text.
 *
 * The already-known block is the book pipeline's "known characters" idea and exists for the same
 * reason: without it every chunk re-reports the same recurring item and the result is a list of
 * duplicates. Bounded because it rides along with EVERY chunk — an unbounded record of findings would
 * grow until it, rather than the document, was what overflowed the window. PURE.
 */
export function chunkExtractionPrompt(
  question: string,
  chunk: DocumentChunk,
  known: readonly DocumentFinding[],
): string {
  const carried = known
    .slice(-MAX_CARRIED_FINDINGS)
    .map((f) => `- ${f.text.slice(0, MAX_CARRIED_CHARS)}`)
    .join("\n");
  const alreadyFound = carried
    ? `Already found earlier in this document — do NOT repeat these, only add what is new:\n${carried}\n\n`
    : "";
  return (
    `Find, in the text below, everything matching this request:\n${question}\n\n` +
    `${alreadyFound}` +
    `The text is lines ${chunk.fromLine}–${chunk.toLine} of a longer document. Line numbers below are ` +
    `absolute — report the line a finding appears on so it can be looked up.\n\n` +
    `Reply with JSON only: {"findings":[{"text":"…","line":123,"note":"…"}]}. ` +
    `Quote the document's own words in "text". Use "note" only when the finding needs context to make ` +
    `sense on its own. If nothing here matches, reply {"findings":[]} — an empty answer is a real ` +
    `answer and is better than a guess.\n\n` +
    `--- TEXT (lines ${chunk.fromLine}–${chunk.toLine}) ---\n${numberLines(chunk)}`
  );
}

/** The chunk with absolute line numbers prefixed, so a reported line means something. */
function numberLines(chunk: DocumentChunk): string {
  return chunk.text
    .split("\n")
    .map((line, i) => `${chunk.fromLine + i}| ${line}`)
    .join("\n");
}

/** Parse one chunk's reply, repairing a truncation the way chapter analysis does. */
export function parseChunkFindings(reply: string): DocumentFinding[] {
  const body = reply.replace(/```(?:json)?\s*([\s\S]*?)```/i, "$1").trim();
  const json = tryParse(body) ?? tryParse(repairTruncatedJson(body));
  if (!json || typeof json !== "object") return [];
  const raw = (json as { findings?: unknown }).findings;
  if (!Array.isArray(raw)) return [];
  const out: DocumentFinding[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as { text?: unknown; line?: unknown; note?: unknown };
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (!text) continue;
    const line = typeof o.line === "number" && Number.isFinite(o.line) ? Math.max(1, Math.floor(o.line)) : 1;
    const note = typeof o.note === "string" ? o.note.trim() : "";
    out.push({ text, line, ...(note ? { note } : {}) });
  }
  return out;
}

function tryParse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Minimal model surface this loop needs — the same shape the chat providers already satisfy. */
export interface ExtractionModel {
  chat(messages: { role: "system" | "user" | "assistant"; content: string }[], opts?: { maxTokens?: number; signal?: AbortSignal }): Promise<string>;
}

/** How small a document has to be before chunking it is pure overhead. */
export const MIN_CHUNKED_DOCUMENT_CHARS = 8_000;

/**
 * Run the extraction over a whole document.
 *
 * The loop is the point, and every property of it was learned the hard way in the book pipeline:
 * CODE decides what is read next, so the model cannot lose its place; each chunk is a fresh, bounded
 * call, so cost is flat in document size; a chunk that fails is retried once and then RECORDED rather
 * than either abandoning the run or silently vanishing; an abort is not a failure; and `done` means a
 * stopped run resumes instead of starting over.
 */
export async function extractFromDocument(opts: {
  text: string;
  question: string;
  model: ExtractionModel;
  chunkChars: number;
  /** Response ceiling per chunk. */
  maxTokens?: number;
  state?: DocumentExtraction;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<DocumentExtraction> {
  const chunks = chunkDocument(opts.text, opts.chunkChars);
  let state = opts.state ?? emptyExtraction();
  opts.onProgress?.(state.done.length, chunks.length);
  for (const chunk of chunks) {
    if (opts.signal?.aborted) return state; // stopped, not failed — `done` keeps the progress
    if (state.done.includes(chunk.index)) continue;
    let reply: string | undefined;
    let lastError = "";
    for (let attempt = 0; attempt < 2 && reply === undefined; attempt++) {
      try {
        reply = await opts.model.chat(
          [
            {
              role: "system",
              content:
                "You extract exactly what you are asked for from one section of a document, and nothing else. " +
                "You answer with JSON only. You never invent a finding that is not in the text in front of you.",
            },
            { role: "user", content: chunkExtractionPrompt(opts.question, chunk, state.findings) },
          ],
          { ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}), ...(opts.signal ? { signal: opts.signal } : {}) },
        );
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (opts.signal?.aborted) return state;
      }
    }
    state = reply === undefined
      ? noteChunkFailure(state, chunk, lastError)
      : mergeFindings(state, chunk.index, parseChunkFindings(reply));
    opts.onProgress?.(state.done.length, chunks.length);
  }
  return state;
}

/**
 * The result as the model sees it: the findings, and — when a chunk failed — the fact that they are
 * incomplete and which lines are missing.
 *
 * The gap notice is not decoration. An extraction that quietly returns 9 of 10 sections reads exactly
 * like a document that only had 9, and the difference matters when someone acts on it.
 */
export function formatExtraction(question: string, state: DocumentExtraction, chunks: number): string {
  const head = `[extract_from_document — "${question}", ${state.findings.length} finding${state.findings.length === 1 ? "" : "s"} across ${chunks} section${chunks === 1 ? "" : "s"}]`;
  const body = state.findings.length
    ? state.findings.map((f) => `- line ${f.line}: ${f.text}${f.note ? ` (${f.note})` : ""}`).join("\n")
    : "Nothing in the document matched.";
  const gaps = state.notes.length
    ? `\n\n[INCOMPLETE — ${state.notes.length} section${state.notes.length === 1 ? "" : "s"} could not be read: ${state.notes.join("; ")}. ` +
      `Say so if you rely on this being exhaustive.]`
    : "";
  const howToRead =
    state.findings.length > 0
      ? `\n\nLine numbers are absolute — read any of them with {"tool":"read","source":"file","ref":"<path>","from":<line>} to see the text around it before quoting or editing.`
      : "";
  return `${head}\n${body}${gaps}${howToRead}`;
}
