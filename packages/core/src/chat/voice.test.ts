import { describe, expect, it } from "vitest";
import {
  MAX_SPEAK_CHARS,
  MAX_UTTERANCE_CHARS,
  pickNaturalVoice,
  pickVoice,
  repliesToSpeak,
  speakableText,
  speechChunks,
  voiceGenderOf,
} from "./voice.js";

describe("speakableText", () => {
  it("strips markdown, code, and links into clean prose", () => {
    expect(speakableText("**Hi** there, see `x=1` and [the docs](https://e.com).")).toBe(
      "Hi there, see x=1 and the docs.",
    );
    expect(speakableText("Run this:\n```js\nconsole.log(1)\n```\ndone")).toContain("(code block)");
    expect(speakableText("Visit https://example.com/page now")).toContain("(link)");
  });
  it("caps very long replies", () => {
    expect(speakableText("a ".repeat(2000)).length).toBeLessThanOrEqual(MAX_SPEAK_CHARS);
  });
});

describe("repliesToSpeak", () => {
  const m = (role: string, text: string, at: number) => ({ role, text, at });

  it("speaks only what arrived since last time", () => {
    const prev = [m("user", "hi", 1), m("assistant", "hello", 2)];
    const next = [...prev, m("user", "more", 3), m("assistant", "sure thing", 4)];
    expect(repliesToSpeak(prev, next)).toEqual(["sure thing"]);
  });

  it("says nothing when nothing is new", () => {
    const same = [m("user", "hi", 1), m("assistant", "hello", 2)];
    expect(repliesToSpeak(same, same)).toEqual([]);
  });

  it("goes quiet — not deaf — when the conversation is REPLACED", () => {
    // The reported failure: voice mode stayed on, looked on, and never spoke again. An index into
    // the old, longer list pointed past the end of the new one, so every later reply landed below
    // the mark. A new chat must simply start clean.
    const prev = [m("user", "a", 1), m("assistant", "b", 2), m("user", "c", 3), m("assistant", "d", 4)];
    const cleared: ReturnType<typeof m>[] = [];
    expect(repliesToSpeak(prev, cleared)).toEqual([]);
    // and the very next reply in the fresh chat IS spoken
    const fresh = [m("user", "new question", 5), m("assistant", "new answer", 6)];
    expect(repliesToSpeak(cleared, fresh)).toEqual(["new answer"]);
  });

  it("does not read a whole loaded history out loud", () => {
    // Switching to a longer session is not four new replies arriving.
    const prev = [m("user", "a", 1)];
    const other = [m("user", "x", 10), m("assistant", "1", 11), m("user", "y", 12), m("assistant", "2", 13)];
    expect(repliesToSpeak(prev, other)).toEqual([]);
  });

  it("survives a message being rewritten in place", () => {
    // Inline images get re-hydrated on a phone, which rewrites an existing message's text. That is
    // the same message, still, and must not look like a different conversation.
    const prev = [m("assistant", "see image", 1)];
    const next = [{ role: "assistant", text: "see image ![x](data:…)", at: 1 }, m("assistant", "and here", 2)];
    expect(repliesToSpeak(prev, next)).toEqual(["and here"]);
  });

  it("does not read a conversation that ARRIVES into an empty panel", () => {
    // An empty list is a prefix of everything, so a history landing at once passes the extension
    // test. That is the normal state of a linked phone: it owns no conversation and is sent the
    // desktop's whole chat on connect — which would otherwise be read out from the top.
    const snapshot = [m("user", "a", 10), m("assistant", "b", 11), m("user", "c", 12), m("assistant", "d", 13)];
    expect(repliesToSpeak([], snapshot, 100)).toEqual([]);
    // and the first reply written AFTER the reader asked to be read to is spoken
    expect(repliesToSpeak(snapshot, [...snapshot, m("assistant", "live", 101)], 100)).toEqual(["live"]);
  });

  it("speaks everything new when no start time is given", () => {
    expect(repliesToSpeak([], [m("assistant", "hi", 5)])).toEqual(["hi"]);
  });

  it("skips empty and non-assistant messages", () => {
    const prev: never[] = [];
    const next = [m("user", "hi", 1), m("tool", "ran something", 2), m("assistant", "", 3)];
    expect(repliesToSpeak(prev, next)).toEqual([]);
  });
});

describe("speechChunks", () => {
  it("keeps every utterance short enough for the browser to finish", () => {
    // Chrome silently stops a long utterance partway with no error and no onend, which is
    // indistinguishable from the feature being broken.
    const long = "This is a sentence about geology. ".repeat(20);
    const chunks = speechChunks(speakableText(long));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_UTTERANCE_CHARS);
  });

  it("breaks at sentence ends, and never inside a word", () => {
    const chunks = speechChunks("First one. Second one! Third one?", 20);
    expect(chunks).toEqual(["First one.", "Second one!", "Third one?"]);
    for (const c of speechChunks("supercalifragilistic ".repeat(30), 40))
      expect(c).not.toMatch(/supercalifragilisti$/);
  });

  it("loses no words", () => {
    const text = "Alpha beta gamma. Delta epsilon zeta! Eta theta iota?";
    expect(speechChunks(text, 25).join(" ").split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it("returns nothing for nothing", () => {
    expect(speechChunks("   ")).toEqual([]);
  });
});

describe("voiceGenderOf", () => {
  it("reads the stock voice names", () => {
    expect(voiceGenderOf("Samantha")).toBe("feminine");
    expect(voiceGenderOf("Microsoft Zira - English (United States)")).toBe("feminine");
    expect(voiceGenderOf("Google UK English Male")).toBe("masculine");
    expect(voiceGenderOf("Daniel (Enhanced)")).toBe("masculine");
  });

  it("does not read 'male' out of 'female'", () => {
    expect(voiceGenderOf("Google UK English Female")).toBe("feminine");
  });

  it("does not match a name that merely starts the same", () => {
    expect(voiceGenderOf("Alexandra")).toBeUndefined();
  });

  it("admits when a name says nothing", () => {
    expect(voiceGenderOf("Google US English")).toBeUndefined();
  });
});

describe("pickNaturalVoice", () => {
  // A faithful slice of the table kokoro-js reports at runtime (it exports no VOICES constant, so
  // this is a copy for the test only — the app reads the real one off the loaded model).
  const VOICES = {
    af_heart: { name: "Heart", language: "en-us", gender: "Female", overallGrade: "A" },
    af_bella: { name: "Bella", language: "en-us", gender: "Female", overallGrade: "A-" },
    af_jessica: { name: "Jessica", language: "en-us", gender: "Female", overallGrade: "D" },
    am_michael: { name: "Michael", language: "en-us", gender: "Male", overallGrade: "C+" },
    am_adam: { name: "Adam", language: "en-us", gender: "Male", overallGrade: "F+" },
    bf_emma: { name: "Emma", language: "en-gb", gender: "Female", overallGrade: "B-" },
    bm_george: { name: "George", language: "en-gb", gender: "Male", overallGrade: "C" },
  };

  it("takes the reader's choice as stated, not inferred", () => {
    // The whole point of the natural voices: they declare a gender, so this is no longer a guess
    // from a name — which is what left the Android voice list unmatchable.
    expect(pickNaturalVoice(VOICES, { gender: "feminine", lang: "en-US" })).toBe("af_heart");
    expect(pickNaturalVoice(VOICES, { gender: "masculine", lang: "en-US" })).toBe("am_michael");
  });

  it("prefers the better-graded voice of the requested gender", () => {
    expect(pickNaturalVoice(VOICES, { gender: "feminine", lang: "en-US" })).not.toBe("af_jessica");
    expect(pickNaturalVoice(VOICES, { gender: "masculine", lang: "en-US" })).not.toBe("am_adam");
  });

  it("matches the reader's accent when it can", () => {
    expect(pickNaturalVoice(VOICES, { gender: "feminine", lang: "en-GB" })).toBe("bf_emma");
    expect(pickNaturalVoice(VOICES, { gender: "masculine", lang: "en-GB" })).toBe("bm_george");
  });

  it("puts language ahead of gender, like the system picker", () => {
    const onlyGb = { bf_emma: VOICES.bf_emma, am_michael: { ...VOICES.am_michael, language: "de-de" } };
    expect(pickNaturalVoice(onlyGb, { gender: "masculine", lang: "en-GB" })).toBe("bf_emma");
  });

  it("still returns a voice when no gender was asked for", () => {
    expect(pickNaturalVoice(VOICES, { lang: "en-US" })).toBe("af_heart");
  });

  it("has nothing to offer for an empty model", () => {
    expect(pickNaturalVoice({}, { gender: "feminine" })).toBeUndefined();
  });
});

describe("pickVoice", () => {
  const v = (name: string, lang = "en-US", extra: Record<string, unknown> = {}) => ({ name, lang, ...extra });

  it("honours the requested gender", () => {
    const voices = [v("Daniel"), v("Samantha")];
    expect(pickVoice(voices, { gender: "feminine" })?.name).toBe("Samantha");
    expect(pickVoice(voices, { gender: "masculine" })?.name).toBe("Daniel");
  });

  it("prefers a natural voice over a robotic one of the same gender", () => {
    const voices = [v("Samantha (Compact)"), v("Microsoft Aria Online (Natural)")];
    expect(pickVoice(voices, { gender: "feminine" })?.name).toContain("Aria");
  });

  it("puts the right language ahead of the requested gender", () => {
    // A feminine voice reading English with a German accent is a worse answer to "read this to me"
    // than a masculine one reading it properly — and the gender is inferred from a NAME, so it is
    // the softer of the two claims.
    const voices = [v("Katja", "de-DE"), v("Daniel", "en-GB")];
    expect(pickVoice(voices, { gender: "feminine", lang: "en-US" })?.name).toBe("Daniel");
  });

  it("prefers the exact locale over the same language", () => {
    const voices = [v("Karen", "en-AU"), v("Samantha", "en-US")];
    expect(pickVoice(voices, { gender: "feminine", lang: "en-US" })?.name).toBe("Samantha");
  });

  it("takes an unknown-gender voice over one of the wrong gender", () => {
    // A name that says nothing might still be right; a name that says "Daniel" is known to be wrong.
    const voices = [v("Daniel"), v("Google US English")];
    expect(pickVoice(voices, { gender: "feminine" })?.name).toBe("Google US English");
  });

  it("gives the closest real voice rather than silence", () => {
    expect(pickVoice([v("Hans", "de-DE")], { gender: "feminine", lang: "en-US" })?.name).toBe("Hans");
    expect(pickVoice([], { gender: "feminine" })).toBeUndefined();
  });

  it("ignores gender when none was asked for", () => {
    const voices = [v("Zarvox"), v("Microsoft Guy Online (Natural)")];
    expect(pickVoice(voices)?.name).toContain("Guy");
  });
});
