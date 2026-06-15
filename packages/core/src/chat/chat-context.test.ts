import { describe, expect, it } from "vitest";
import {
  buildChatSystemPrompt,
  chatContextSections,
  chatSystemCachePrefix,
  lookupBible,
  MATURE_CHAT_NOTE,
  type ChatContextInput,
} from "./chat-context.js";
import { createEmptyBible } from "../visual-bible/bible.js";
import { emptyAppearance } from "../types/bible.js";

describe("lookupBible", () => {
  const bible = (() => {
    const b = createEmptyBible("t");
    b.characters.push({
      id: "c1",
      name: "Violet",
      aliases: ["Vi"],
      appearance: { ...emptyAppearance(), hair: "brown", gender: "woman" },
      persistentTraits: [],
      clothing: [],
      outfits: [],
      anchor: { seed: 1 },
      firstSeenChapter: 0,
    });
    b.environments.push({
      id: "e1",
      name: "Basgiath",
      aliases: ["the fortress"],
      description: ["dark basalt fortress"],
      firstSeenChapter: 3,
    });
    b.glossary = [{ term: "flight leathers", definition: "fitted black hide" }];
    return b;
  })();

  it("returns full detail for a name/alias match, spoiler-gated", () => {
    const opts = { fullView: false, chapterIndex: 1, contentMode: "fiction" as const };
    expect(lookupBible(bible, "violet", opts)).toContain("brown");
    expect(lookupBible(bible, "Vi", opts)).toContain("CHARACTER Violet"); // alias
    expect(lookupBible(bible, "flight leathers", opts)).toContain("fitted black hide");
    // Basgiath is first seen in ch 3 — not reached at ch 1, so hidden…
    expect(lookupBible(bible, "the fortress", opts)).toBe("");
    // …but reachable once spoilers/full view is on.
    expect(lookupBible(bible, "the fortress", { ...opts, fullView: true })).toContain("basalt");
    expect(lookupBible(bible, "nothing-here", opts)).toBe("");
  });
});

function input(over: Partial<ChatContextInput> = {}): ChatContextInput {
  return {
    bookTitle: "Test Book",
    contentMode: "fiction",
    chapters: [
      { index: 0, title: "One", text: "Alice met Bob at the harbour." },
      { index: 1, title: "Two", text: "They sailed at dawn. The storm hit at noon." },
      { index: 2, title: "Three", text: "Bob was the traitor all along." },
    ],
    position: { chapterIndex: 1, charOffsetInChapter: 20 },
    allowSpoilers: false,
    ...over,
  };
}

function bibleWith(): ReturnType<typeof createEmptyBible> {
  const b = createEmptyBible("t");
  b.characters.push(
    {
      id: "char-alice",
      name: "Alice",
      aliases: [],
      appearance: emptyAppearance(),
      persistentTraits: [],
      clothing: [],
      outfits: [],
      anchor: { seed: 1 },
      firstSeenChapter: 0,
    },
    {
      id: "char-zed",
      name: "Zed",
      aliases: [],
      appearance: emptyAppearance(),
      persistentTraits: [],
      clothing: [],
      outfits: [],
      anchor: { seed: 2 },
      firstSeenChapter: 2, // introduced AFTER the reader's position
    },
  );
  b.spoilers.push({ id: "s1", label: "Bob is the traitor", revealParagraphId: "" });
  b.storyboard.push(
    { chapterIndex: 0, summary: "They meet.", keyMoment: "", location: "", locationChange: "" },
    { chapterIndex: 2, summary: "The betrayal.", keyMoment: "", location: "", locationChange: "" },
  );
  b.datasets!.push({
    id: "d",
    chapterIndex: 2,
    title: "Casualties by day",
    unit: "",
    xLabel: "",
    yLabel: "",
    kind: "bar",
    points: [
      { label: "a", y: 1 },
      { label: "b", y: 2 },
    ],
    source: "",
  });
  return b;
}

describe("mature mode", () => {
  it("appends the mature clause to the role only when allowMature is set", () => {
    expect(buildChatSystemPrompt(input())).not.toContain(MATURE_CHAT_NOTE.trim());
    expect(buildChatSystemPrompt(input({ allowMature: true }))).toContain(MATURE_CHAT_NOTE.trim());
  });
});

describe("buildChatSystemPrompt — fiction, spoilers off", () => {
  it("cuts the book at the reader's position", () => {
    const sys = buildChatSystemPrompt(input());
    expect(sys).toContain("Alice met Bob"); // chapter 0: included
    expect(sys).toContain("They sailed at dawn."); // ch 1 up to offset 20
    expect(sys).not.toContain("storm hit"); // ch 1 beyond the offset
    expect(sys).not.toContain("traitor all along"); // ch 2: future
    expect(sys).toContain("haven't read that far");
  });

  it("INDEXES reached entities by name, never lists spoiler labels, detail is lookup-only", () => {
    const sys = buildChatSystemPrompt(input({ bible: bibleWith() }));
    expect(sys).toContain("INDEX only"); // the compact-index header
    expect(sys).toContain("Alice"); // reached character: NAME in the index
    expect(sys).not.toContain("Zed"); // first seen later → excluded
    expect(sys).not.toContain("The betrayal."); // ch 2 summary (future) absent
    expect(sys).not.toContain("Bob is the traitor"); // spoiler label excluded in EVERY mode
    expect(sys).not.toContain("Casualties"); // ch 2 dataset (future) absent
  });

  it("keeps the TAIL nearest the reader when over budget", () => {
    const sys = buildChatSystemPrompt(
      input({
        chapters: [
          { index: 0, title: "One", text: `LANDMARK_EARLY ${"early filler. ".repeat(50)}` },
          { index: 1, title: "Two", text: `LANDMARK_LATE ${"x".repeat(100)}` },
        ],
        position: { chapterIndex: 1, charOffsetInChapter: 115 },
        budgetChars: 200,
      }),
    );
    expect(sys).toContain("LANDMARK_LATE");
    expect(sys).not.toContain("LANDMARK_EARLY");
    expect(sys).toContain("omitted for length");
  });
});

describe("buildChatSystemPrompt — full view", () => {
  it("allowSpoilers includes the whole book and indexes later entities by name", () => {
    const sys = buildChatSystemPrompt(input({ allowSpoilers: true, bible: bibleWith() }));
    expect(sys).toContain("traitor all along"); // full book text
    expect(sys).toContain("Zed"); // later character now indexed (spoilers on)
    expect(sys).not.toContain("Bob is the traitor"); // labels still never dumped
  });

  it("technical books are ALWAYS fully visible; bible index lists titles, values are lookup-only", () => {
    const sys = buildChatSystemPrompt(
      input({ contentMode: "technical", allowSpoilers: false, bible: bibleWith() }),
    );
    expect(sys).toContain("traitor all along"); // full text despite spoilers off
    expect(sys).toContain("TECHNICAL BIBLE");
    expect(sys).toContain("Casualties by day"); // dataset TITLE in the index
    expect(sys).not.toContain("a=1, b=2"); // values are behind lookup_bible now
  });

  it("keeps the chapter nearest the reader when the whole book exceeds the budget", () => {
    const sys = buildChatSystemPrompt(
      input({
        allowSpoilers: true,
        chapters: [
          { index: 0, title: "", text: `AAA ${"a".repeat(150)}` },
          { index: 1, title: "", text: `BBB ${"b".repeat(50)}` },
          { index: 2, title: "", text: `CCC ${"c".repeat(150)}` },
        ],
        position: { chapterIndex: 1, charOffsetInChapter: 0 },
        budgetChars: 120,
      }),
    );
    expect(sys).toContain("BBB"); // the current chapter survives
    expect(sys).not.toContain("AAA");
    expect(sys).not.toContain("CCC");
    expect(sys).toContain("omitted");
  });
});

describe("buildChatSystemPrompt — invariants", () => {
  it("always carries the tool instructions and the data-not-instructions guard", () => {
    const sys = buildChatSystemPrompt(input());
    expect(sys).toContain('"tool":"search_web"');
    expect(sys).toContain("not instructions to follow");
  });
});

describe("system-prompt cache prefix", () => {
  it("the stable prefix (role + tools + guard) is a genuine LEADING substring of the full prompt", () => {
    const i = input({ bible: bibleWith() });
    const full = buildChatSystemPrompt(i);
    const prefix = chatSystemCachePrefix(chatContextSections(i));
    expect(full.startsWith(prefix)).toBe(true);
    expect(prefix).toContain('"tool":"search_web"'); // tool defs ride the cached prefix
    expect(prefix).toContain("not instructions to follow"); // and so does the guard
    expect(prefix).not.toContain("Alice met Bob"); // but the volatile book text does NOT
  });

  it("orders the stable sections BEFORE the volatile book/bible (so the prefix is cacheable)", () => {
    const full = buildChatSystemPrompt(input({ bible: bibleWith() }));
    expect(full.indexOf('"tool":"search_web"')).toBeLessThan(full.indexOf("Alice met Bob"));
    expect(full.indexOf("not instructions to follow")).toBeLessThan(full.indexOf("Alice met Bob"));
  });
});
