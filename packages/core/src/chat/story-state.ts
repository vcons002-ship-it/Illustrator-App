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
