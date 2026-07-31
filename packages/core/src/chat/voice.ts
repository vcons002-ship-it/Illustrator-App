/**
 * VOICE — pure helpers for the optional voice mode (dictate with the mic, hear replies).
 * The Web Speech APIs (SpeechRecognition / speechSynthesis) live in the UI; everything decidable
 * without a browser lives here: what to say, which replies are new, how to cut it into utterances
 * the browser will actually finish, and which installed voice to say it in.
 */

/** Max characters to speak (a long reply read aloud in full is rarely wanted). */
export const MAX_SPEAK_CHARS = 1200;

/** Turn an assistant reply (markdown) into clean, speakable prose. */
export function speakableText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code block) ") // don't read code aloud
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/https?:\/\/\S+/g, " (link) ")
    .replace(/[*_#>~|]/g, "") // markdown emphasis / headings / quotes / tables
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SPEAK_CHARS);
}

/** A chat message, as much of it as speaking needs to know. */
export interface VoiceMessageLike {
  role: string;
  text?: string;
  /** Creation timestamp — the only stable identity a message has here. */
  at?: number;
}

/**
 * The replies that arrived since we last looked, ready to speak.
 *
 * Speaking used to track an INDEX into the message list, which is only meaningful while the list
 * grows. It doesn't always grow: starting a new chat empties it, switching sessions replaces it, and
 * clearing history truncates it. After any of those the stored index pointed past the end of a
 * shorter conversation, so every later reply landed BELOW the mark and was silently skipped — voice
 * mode stayed switched on, looked on, and never spoke again. Switching to a LONGER history had the
 * opposite fault: it read the whole backlog out loud.
 *
 * So the question isn't "how many have I seen" but "is this the same conversation, continued". If
 * `next` doesn't extend `prev` it's a different (or reset) conversation and there is nothing NEW in
 * it to announce — adopt it silently.
 *
 * `since` is the moment the reader asked to be read to, and it settles the case the extension test
 * can't: an EMPTY list is a prefix of everything, so a history ARRIVING into an empty panel looks
 * exactly like forty replies landing at once. That is the normal state of a linked phone, which owns
 * no conversation and is sent the desktop's on connect, and of any session being switched into. A
 * message written before you asked to be read to is not something to read out. PURE.
 */
export function repliesToSpeak(
  prev: readonly VoiceMessageLike[],
  next: readonly VoiceMessageLike[],
  since = 0,
): string[] {
  const extended =
    next.length >= prev.length &&
    // role+at, never text: a message can be rewritten in place (inline images restored on a phone,
    // a redacted body re-hydrated) without becoming a different message.
    prev.every((m, i) => next[i]?.role === m.role && next[i]?.at === m.at);
  if (!extended) return [];
  return next
    .slice(prev.length)
    .filter((m) => m.role === "assistant" && m.text && (m.at === undefined || m.at > since))
    .map((m) => speakableText(m.text ?? ""))
    .filter((t) => t.length > 0);
}

/**
 * Longest single utterance to hand the browser.
 *
 * Chrome's speech synthesis stops mid-sentence on a long utterance (a well-known ~15-second limit
 * with no error and no `onend`), which reads exactly like the feature being broken. Short utterances
 * queued back-to-back play as one continuous read.
 */
export const MAX_UTTERANCE_CHARS = 180;

/**
 * Cut speakable text into utterances at sentence ends, falling back to clause and word boundaries.
 *
 * Never mid-word: the seam between two utterances is audible, so it has to fall where a speaker
 * would breathe anyway. PURE.
 */
export function speechChunks(text: string, max: number = MAX_UTTERANCE_CHARS): string[] {
  const clean = text.trim();
  if (!clean) return [];
  // Sentence-ish pieces, keeping their terminator.
  const pieces = clean.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [clean];
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = "";
  };
  for (const piece of pieces) {
    for (const part of piece.length <= max ? [piece] : splitLong(piece, max)) {
      if (buf && buf.length + part.length > max) flush();
      buf += part;
    }
  }
  flush();
  return out;
}

/** Break an over-long sentence at a comma/clause, then at whitespace — never inside a word. PURE. */
function splitLong(sentence: string, max: number): string[] {
  const words = sentence.split(/(\s+)/);
  const out: string[] = [];
  let buf = "";
  for (const w of words) {
    if (buf && buf.length + w.length > max) {
      out.push(buf);
      buf = w.trimStart();
    } else buf += w;
  }
  if (buf) out.push(buf);
  return out;
}

/** Which voice the reader wants replies read in. */
export type VoiceGender = "feminine" | "masculine";

/** The parts of a `SpeechSynthesisVoice` that choosing one depends on. */
export interface VoiceLike {
  name: string;
  lang: string;
  /** True for a voice bundled with the OS; false for a network voice (usually the better ones). */
  localService?: boolean;
  default?: boolean;
}

/**
 * Voices whose gender is known by name, because the Web Speech API doesn't expose it.
 *
 * There is no gender field on SpeechSynthesisVoice, so a name table is the only thing available.
 * These are the stock voices shipped by macOS/iOS, Windows, Android and Chrome — checked as whole
 * words so "Alexander" never matches "Alex".
 */
const FEMININE_VOICES = [
  "samantha", "victoria", "allison", "ava", "susan", "vicki", "karen", "moira", "tessa", "fiona",
  "serena", "kate", "stephanie", "zira", "hazel", "aria", "jenny", "michelle", "sonia", "libby",
  "clara", "emily", "joanna", "kendra", "kimberly", "salli", "ivy", "nicole", "olivia", "amy",
  "zoe", "zoë", "nora", "sarah", "eva", "anna", "katja", "marlene", "amelie", "amélie", "alice",
  "paulina", "luciana", "milena", "alva", "ellen", "yuna", "kyoko", "sinji", "tingting", "female",
  "woman",
];
const MASCULINE_VOICES = [
  "alex", "daniel", "fred", "tom", "oliver", "rishi", "aaron", "arthur", "gordon", "nathan",
  "bruce", "ralph", "david", "mark", "guy", "ryan", "brandon", "christopher", "eric", "roger",
  "steffan", "matthew", "joey", "justin", "brian", "russell", "geraint", "hans", "yannick",
  "thomas", "xander", "carlos", "diego", "jorge", "enrique", "maged", "otoya", "reed", "rocko",
  "lee", "male", "man",
];

/** The gender a voice's NAME indicates, or undefined when nothing in it says. PURE. */
export function voiceGenderOf(name: string): VoiceGender | undefined {
  const words = name.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  // "male" is a substring of "female", so an explicit marker has to be matched as a whole word and
  // feminine has to be asked first.
  if (words.some((w) => FEMININE_VOICES.includes(w))) return "feminine";
  if (words.some((w) => MASCULINE_VOICES.includes(w))) return "masculine";
  return undefined;
}

/**
 * One of the natural (Kokoro) voices, as the model itself describes it.
 *
 * Read from the loaded model at runtime rather than copied here, so the list can't drift from what
 * is actually installed — and unlike the browser's voices these carry a stated gender and a quality
 * grade, which is what turns the reader's choice from an inference into a fact.
 */
export interface NaturalVoiceLike {
  name: string;
  language: string;
  gender: string;
  /** The model's own quality grade for this voice: "A", "B-", "C+", "F"… */
  overallGrade?: string;
}

/** A letter grade as a number, so the best-sounding voice can be preferred. PURE. */
function gradeScore(grade: string | undefined): number {
  const letter = grade?.trim().toUpperCase();
  if (!letter) return 0;
  const base = { A: 12, B: 9, C: 6, D: 3, F: 0 }[letter[0] ?? ""];
  if (base === undefined) return 0;
  return base + (letter.includes("+") ? 1 : letter.includes("-") ? -1 : 0);
}

/**
 * The best natural voice for the reader's choice: right language, requested gender, best grade.
 *
 * Same ordering as {@link pickVoice} and for the same reason — a voice reading English in the wrong
 * accent is a worse answer than one reading it properly. The difference is that gender is no longer
 * guessed from a name here; the model states it. Returns the voice's id. PURE.
 */
export function pickNaturalVoice(
  voices: Readonly<Record<string, NaturalVoiceLike>>,
  opts: { gender?: VoiceGender; lang?: string } = {},
): string | undefined {
  const want = opts.lang || "en-US";
  const wantGender = opts.gender === "feminine" ? "female" : opts.gender === "masculine" ? "male" : undefined;
  let best: string | undefined;
  let bestScore = -Infinity;
  for (const [id, v] of Object.entries(voices)) {
    const stated = v.gender?.toLowerCase();
    const score =
      langScore(v.language, want) * 1_000 +
      (wantGender ? (stated === wantGender ? 200 : 0) : 100) +
      gradeScore(v.overallGrade);
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/** Names that mark a voice as one of the modern, natural-sounding ones. */
const NATURAL_MARKERS = ["natural", "neural", "premium", "enhanced", "siri"];
/** Names that mark the old robotic fallbacks — worse than any real voice. */
const ROBOTIC_MARKERS = ["compact", "espeak", "pico", "eloquence", "novelty", "bells", "bubbles",
  "cellos", "organ", "trinoids", "whisper", "wobble", "zarvox", "albert", "bad news", "good news",
  "jester", "superstar", "boing", "bahh", "deranged", "hysterical"];

const has = (name: string, markers: string[]) => {
  const low = name.toLowerCase();
  return markers.some((m) => low.includes(m));
};

/** How well a voice's language matches: 2 exact, 1 same language, 0 different. PURE. */
function langScore(voiceLang: string, want: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/_/g, "-");
  const [v, w] = [norm(voiceLang), norm(want)];
  if (v === w) return 2;
  return v.split("-")[0] === w.split("-")[0] ? 1 : 0;
}

/**
 * The best installed voice for the reader's choice: right language first, then the requested gender,
 * then the most natural-sounding of what's left.
 *
 * Language outranks gender deliberately. A feminine voice reading English in a German accent is a
 * worse answer to "read this to me" than a masculine one reading it properly — and gender here is
 * inferred from a NAME, so it is the softer of the two claims.
 *
 * Returns undefined only when there are no voices at all; a reader who asked for a voice gets the
 * closest real one rather than silence. PURE.
 */
export function pickVoice(
  voices: readonly VoiceLike[],
  opts: { gender?: VoiceGender; lang?: string } = {},
): VoiceLike | undefined {
  const want = opts.lang || "en-US";
  let best: VoiceLike | undefined;
  let bestScore = -Infinity;
  for (const v of voices) {
    const gender = voiceGenderOf(v.name);
    const score =
      langScore(v.lang, want) * 1_000 +
      (opts.gender ? (gender === opts.gender ? 200 : gender ? 0 : 100) : 100) +
      (has(v.name, NATURAL_MARKERS) ? 30 : 0) +
      (has(v.name, ROBOTIC_MARKERS) ? -60 : 0) +
      (v.localService === false ? 10 : 0) +
      (v.default ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}
