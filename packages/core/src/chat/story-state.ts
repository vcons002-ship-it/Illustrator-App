/**
 * STORY STATE — the live context fed to the WRITING model each beat of a "story as you go".
 *
 * Without it, the writer sees only the rolling chat history (trimmed oldest-first), so a long story
 * silently loses its earlier plot, cast, and setting. This block re-grounds every beat from state we
 * already track — the present cast + location, the last few beats verbatim, and a rolling synopsis —
 * so continuity survives chat trimming. It's injected AFTER the cached system prefix (it changes each
 * beat), and bounded so prompt cost stays flat.
 */

export interface StoryStateInput {
  mode: "direct" | "roleplay";
  /** Roleplay: the played character names (me = reader, you = assistant). */
  play?: { me?: string; you?: string };
  /** Characters on stage right now, with a one-line identity note where known. */
  presentCast: { name: string; note?: string }[];
  /** The current location name, if resolved. */
  location?: string;
  /** The last few beats, verbatim (most recent last). */
  recentBeats: string[];
  /** The rolling "story so far" synopsis (plot, relationships, unresolved threads). */
  synopsis?: string;
}

export const STORY_STATE_MAX_CHARS = 4000;
const MAX_BEAT_CHARS = 700;

/** Build the STORY STATE prompt block ("" when there's nothing to say). */
export function storyStatePromptBlock(input: StoryStateInput): string {
  const lines: string[] = [];
  if (input.synopsis?.trim()) lines.push(`Story so far: ${input.synopsis.trim()}`);
  const cast = input.presentCast
    .filter((c) => c.name)
    .map((c) => (c.note ? `${c.name} (${c.note})` : c.name))
    .join("; ");
  if (cast) lines.push(`On stage now: ${cast}`);
  if (input.location?.trim()) lines.push(`Location: ${input.location.trim()}`);
  if (input.mode === "roleplay" && (input.play?.me || input.play?.you)) {
    lines.push(
      `Roleplay: the reader plays ${input.play?.me ?? "their character"}; you voice ${
        input.play?.you ?? "your character"
      } and everyone else.`,
    );
  }
  const beats = input.recentBeats.filter((b) => b?.trim());
  if (beats.length) {
    lines.push("Most recent beats (continue seamlessly from the last one — do not repeat it):");
    beats.forEach((b) => {
      const t = b.trim();
      lines.push(`• ${t.length > MAX_BEAT_CHARS ? `…${t.slice(-MAX_BEAT_CHARS)}` : t}`);
    });
  }
  if (lines.length === 0) return "";
  let block = `STORY STATE (the live state of the open story — keep continuity with ALL of this):\n${lines.join("\n")}`;
  if (block.length > STORY_STATE_MAX_CHARS) block = `${block.slice(0, STORY_STATE_MAX_CHARS)}…`;
  return block;
}

/** Refresh the synopsis every N beats (the only part of STORY STATE that costs an LLM call). */
export const SYNOPSIS_REFRESH_EVERY = 6;
export const MAX_SYNOPSIS_CHARS = 900;

/**
 * The system + user messages for generating a story's TITLE + OPENING BEAT from the reader's premise.
 * "Story as you go" treats the reader's setup text as an idea/seed — the model writes the actual
 * opening scene and proposes a title — instead of using the typed text verbatim as beat one.
 */
export function storyOpeningRequest(
  premise: string,
  opts: {
    characters?: { name: string; description?: string }[];
    mode?: "direct" | "roleplay";
    play?: { me?: string; you?: string };
    /** The conversation this story has ALREADY been growing in (see {@link storySoFarFromChat}).
     * Present when the reader chose to carry the chat in — the opening then CONTINUES what's there
     * rather than starting over, which is the whole point of offering it. */
    soFar?: string;
  } = {},
): { system: string; user: string } {
  const cast = (opts.characters ?? []).filter((c) => c.name.trim());
  const roleplay = opts.mode === "roleplay";
  const soFar = opts.soFar?.trim();
  const system =
    (soFar
      ? "You are turning a story the reader has ALREADY been telling you in conversation into a proper " +
        "illustrated story. Write the next BEAT: vivid, full-scene narrative PROSE (about 2 short " +
        "paragraphs) that CONTINUES from where the conversation left off — same characters, same place, " +
        "same situation, carrying on rather than starting over. Do not recap, re-introduce anyone, or " +
        "rewind to the beginning; pick it up as if no break had happened, and end on a hook that invites " +
        "the reader's next move. Refer to characters by the names already used. "
      : "You are opening a collaborative, illustrated story from the reader's idea. Write the OPENING " +
        "BEAT: vivid, full-scene narrative PROSE (about 2 short paragraphs) that establishes the setting, " +
        "mood, and the characters present, and ends on a hook that invites the reader's first move. Refer " +
        "to characters by their established names. ") +
    (roleplay
      ? "This is ROLEPLAY — set the scene and bring the cast on stage, but do NOT act, speak, or decide " +
        "for the reader's own character; leave them room to respond. "
      : "") +
    "Also propose a SHORT, evocative book TITLE (2–5 words, no quotes). " +
    'Reply with ONLY a JSON object: {"title": "…", "opening": "…"} — no preamble, no code fence, no commentary.';
  const castLine = cast.length
    ? `Characters: ${cast.map((c) => (c.description?.trim() ? `${c.name} (${c.description.trim()})` : c.name)).join("; ")}.\n`
    : "";
  const playLine =
    roleplay && opts.play
      ? `The reader plays ${opts.play.me || "their character"}; you voice ${opts.play.you || "the other character(s)"}.\n`
      : "";
  const soFarBlock = soFar ? `THE STORY SO FAR (from the chat — continue from the END of this):\n${soFar}\n\n` : "";
  const premiseLine = premise.trim()
    ? `${soFar ? "The reader also says" : "Reader's idea for the story"}:\n${premise.trim()}\n\n`
    : "";
  const user =
    `${soFarBlock}${premiseLine}${castLine}${playLine}` +
    (soFar
      ? "Write the title and the NEXT beat now — continuing the story above, not restarting it."
      : "Write the title and opening beat now.");
  return { system, user };
}

/**
 * Render a chat as "the story so far" for {@link storyOpeningRequest}.
 *
 * A story often starts as ordinary conversation and only becomes a Story-as-you-go once it's already
 * running. Starting one used to throw that away — a deliberately EMPTY writer context, which is what
 * makes the model reliably answer in beat prose, but also what made it open on a scene nobody had
 * been in. Carrying the text (rather than the turns) keeps both: the writer's own context stays
 * clean, and what was already told comes with it.
 *
 * The user-facing carry option promises the whole conversation, so the default is deliberately
 * unbounded. A caller may still provide a budget for a constrained surface; when it does, oldest
 * turns are dropped first. Tool/system chatter is left out — it's the story that matters, not the
 * app's own notes. Returns "" when there's nothing worth carrying. PURE.
 */
export function storySoFarFromChat(
  messages: readonly { role: string; text?: string }[],
  budget = Number.POSITIVE_INFINITY,
): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user" && m.role !== "assistant") continue; // tool notes/cards aren't the story
    const text = (m.text ?? "").trim();
    if (!text) continue;
    const line = `${m.role === "user" ? "Reader" : "Assistant"}: ${text}`;
    if (used + line.length + 1 > budget && lines.length > 0) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * Build the initial stored beats for a story started from chat.
 *
 * The carried transcript must be a real part of the book, not merely hidden context for the model
 * that writes the next beat. Each assistant story response becomes an internal beat/chapter, paired
 * with the reader message(s) that led to it. Explicit chapter headings inside one response split it
 * further. Story rendering is one image per beat, so collapsing a seven-response story into one beat
 * made analysis write one prompt and left six requested images with no render unit to attach to.
 *
 * The speaker labels and every character of message text remain in the book; only the internal
 * extraction boundaries change. A generated continuation is appended after the carried beats.
 */
export function storyStartBeats(opening: string, soFar?: string): string[] {
  const carried = soFar?.trim() ?? "";
  const next = opening.trim();
  if (carried) return [...carriedStoryBeats(carried), ...(next ? [next] : [])];
  return next ? [next] : [];
}

type CarriedTurn = { role: "Reader" | "Assistant"; text: string };

/** Parse the exact text format emitted by {@link storySoFarFromChat}. */
function carriedTurns(transcript: string): CarriedTurn[] {
  const marker = /^(Reader|Assistant):[ \t]*/gm;
  const matches = [...transcript.matchAll(marker)];
  if (matches.length === 0 || matches[0]!.index !== 0) return [];
  return matches.map((m, i) => {
    const start = m.index! + m[0].length;
    const end = matches[i + 1]?.index ?? transcript.length;
    return {
      role: m[1] as CarriedTurn["role"],
      text: transcript.slice(start, end).replace(/\n$/, "").trimEnd(),
    };
  });
}

const CARRIED_CHAPTER_HEADING =
  /^(?:#{1,3}\s+\S.*|(?:chapter|part|book)\s+(?:[0-9]+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten)\b.{0,80})$/i;

/** One assistant response may itself contain several explicitly headed chapters. */
function assistantSections(text: string): string[] {
  const lines = text.split("\n");
  const headings = lines
    .map((line, i) => (CARRIED_CHAPTER_HEADING.test(line.trim()) ? i : -1))
    .filter((i) => i >= 0);
  if (headings.length === 0) return [text];

  const sections: string[] = [];
  const prefix = lines.slice(0, headings[0]!).join("\n").trim();
  for (let i = 0; i < headings.length; i++) {
    const body = lines.slice(headings[i]!, headings[i + 1] ?? lines.length).join("\n").trim();
    if (!body) continue;
    sections.push(i === 0 && prefix ? `${prefix}\n${body}` : body);
  }
  return sections.length ? sections : [text];
}

function carriedStoryBeats(transcript: string): string[] {
  const turns = carriedTurns(transcript);
  if (turns.length === 0) return [transcript]; // legacy/unlabelled payload: preserve it byte-for-byte

  const beats: string[] = [];
  let readerTurns: string[] = [];
  for (const turn of turns) {
    if (turn.role === "Reader") {
      readerTurns.push(`Reader: ${turn.text}`);
      continue;
    }
    const sections = assistantSections(turn.text);
    sections.forEach((section, i) => {
      const lead = i === 0 ? readerTurns : [];
      beats.push([...lead, `Assistant: ${section}`].join("\n"));
    });
    readerTurns = [];
  }
  // A final reader turn still belongs to the imported story even if the assistant had not answered.
  if (readerTurns.length) beats.push(readerTurns.join("\n"));
  return beats.length ? beats : [transcript];
}

/** Parse the model's reply to {@link storyOpeningRequest}: tolerant of code fences / stray prose. */
export function parseStoryOpening(text: string): { title?: string; opening?: string } {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const obj = JSON.parse(raw.slice(start, end + 1)) as { title?: unknown; opening?: unknown };
      const title = typeof obj.title === "string" ? obj.title.trim() : undefined;
      const opening = typeof obj.opening === "string" ? obj.opening.trim() : undefined;
      return { ...(title ? { title } : {}), ...(opening ? { opening } : {}) };
    }
  } catch {
    // fall through to the empty result — the caller falls back to the premise verbatim
  }
  return {};
}

/** The system + user messages for a one-shot synopsis refresh (kept here so it's testable). */
export function synopsisRequest(beats: readonly string[], prevSynopsis?: string): { system: string; user: string } {
  const system =
    "You maintain a running synopsis of a collaborative story. Given the story so far, write a SINGLE " +
    "compact paragraph (<= 120 words) capturing what matters for continuity: the main plot threads, " +
    "where things stand, key relationships and emotional beats, and any unresolved hooks. Plain prose, " +
    "no preamble, no list — just the synopsis.";
  const story = beats.join("\n\n");
  const user =
    (prevSynopsis ? `Previous synopsis:\n${prevSynopsis}\n\n` : "") +
    `Story so far (beats in order):\n${story}\n\nWrite the updated synopsis.`;
  return { system, user };
}
