import { describe, it, expect } from "vitest";
import { createEmptyBible, resolvePageEntities } from "./bible.js";
import { shouldRevealImage } from "./spoiler.js";
import type { VisualBible } from "../types/bible.js";
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
