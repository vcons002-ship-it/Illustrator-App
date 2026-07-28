import { describe, it, expect } from "vitest";
import { createEmptyBible, resolvePageEntities } from "./bible.js";
import { shouldRevealImage } from "./spoiler.js";
import { emptyAppearance, type VisualBible } from "../types/bible.js";
import type { Page } from "../types/book.js";

function page(text: string): Page {
  return {
    id: "p1",
    index: 0,
    chapterId: "c1",
    paragraphs: text.split("\n").map((t, i) => ({ id: `p1-${i}`, index: i, text: t })),
  };
}

function bibleWith(): VisualBible {
  const b = createEmptyBible("book-1");
  b.characters.push({
    id: "char-aria",
    name: "Aria",
    aliases: ["the captain"],
    appearance: emptyAppearance(),
    persistentTraits: ["tall", "silver hair"],
    clothing: ["red coat"],
    anchor: { seed: 1 },
    firstSeenChapter: 0,
  });
  b.environments.push({
    id: "env-bridge",
    name: "the bridge",
    description: ["cramped", "blinking consoles"],
    firstSeenChapter: 0,
  });
  b.spoilers.push({ id: "spoiler-knife", label: "hidden knife", revealParagraphId: "p1-3" });
  return b;
}

describe("resolvePageEntities", () => {
  it("matches characters by name and alias, environments by name, spoilers by label", () => {
    const b = bibleWith();
    const result = resolvePageEntities(b, page("Aria stepped onto the bridge.\nA hidden knife glinted."));
    expect(result.characterIds).toContain("char-aria");
    expect(result.environmentIds).toContain("env-bridge");
    expect(result.spoilerIds).toContain("spoiler-knife");
  });

  it("matches a character via an alias", () => {
    const b = bibleWith();
    const result = resolvePageEntities(b, page("The captain gave the order."));
    expect(result.characterIds).toContain("char-aria");
  });

  it("returns no matches when entities are absent", () => {
    const b = bibleWith();
    const result = resolvePageEntities(b, page("The empty corridor stretched on."));
    expect(result.characterIds).toEqual([]);
    expect(result.environmentIds).toEqual([]);
    expect(result.spoilerIds).toEqual([]);
  });

  /**
   * A place named after someone: the page is set in "Aria's Rest", so Aria's NAME is in the text
   * without Aria being in the scene. She used to resolve as present, and her look then went into the
   * illustration — a character drawn into a room she isn't in. Each occurrence belongs to the longest
   * bible name covering it.
   */
  it("a place named after a character isn't a mention of the character", () => {
    const b = bibleWith();
    b.environments.push({ id: "env-rest", name: "aria's rest", description: ["a low tavern"], firstSeenChapter: 0 });
    const result = resolvePageEntities(b, page("The captain waited in Aria's Rest."));
    expect(result.environmentIds).toContain("env-rest");
    // "the captain" is her alias, so she IS here — via the alias, not via the place's name.
    expect(result.characterIds).toContain("char-aria");

    const without = resolvePageEntities(b, page("A stranger waited in Aria's Rest."));
    expect(without.environmentIds).toContain("env-rest");
    expect(without.characterIds).toEqual([]);
  });
});

describe("shouldRevealImage", () => {
  const spoilers = [{ id: "s1", label: "knife", revealParagraphId: "p1-3" }];

  it("reveals immediately when there are no spoilers", () => {
    expect(shouldRevealImage([], spoilers, new Set())).toBe(true);
  });

  it("stays hidden until the reader passes the reveal paragraph", () => {
    expect(shouldRevealImage(["s1"], spoilers, new Set(["p1-1", "p1-2"]))).toBe(false);
    expect(shouldRevealImage(["s1"], spoilers, new Set(["p1-1", "p1-2", "p1-3"]))).toBe(true);
  });

  it("fails safe (hidden) for an unknown spoiler id", () => {
    expect(shouldRevealImage(["unknown"], spoilers, new Set(["p1-3"]))).toBe(false);
  });
});
