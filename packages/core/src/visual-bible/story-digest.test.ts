import { describe, expect, it } from "vitest";
import { storyDigest, recentArcLine } from "./story-digest.js";
import { createEmptyBible } from "./bible.js";
import type { ChapterScene, VisualBible } from "../types/bible.js";

function scene(over: Partial<ChapterScene> & { chapterIndex: number }): ChapterScene {
  return { summary: "", keyMoment: "", location: "", locationChange: "", ...over };
}
function bibleWith(storyboard: ChapterScene[]): VisualBible {
  return { ...createEmptyBible("b"), storyboard };
}

describe("storyDigest", () => {
  it("rolls chapter summaries into a labelled, chapter-by-chapter block", () => {
    const b = bibleWith([
      scene({ chapterIndex: 0, summary: "Mara leaves home." }),
      scene({ chapterIndex: 1, summary: "She reaches the city and meets Toll." }),
    ]);
    const d = storyDigest(b);
    expect(d).toContain("THE STORY SO FAR");
    expect(d).toContain("Ch 1: Mara leaves home.");
    expect(d).toContain("Ch 2: She reaches the city and meets Toll.");
  });

  it("spoiler-gates by upToChapter", () => {
    const b = bibleWith([
      scene({ chapterIndex: 0, summary: "Setup." }),
      scene({ chapterIndex: 1, summary: "Midpoint." }),
      scene({ chapterIndex: 2, summary: "The twist nobody should see yet." }),
    ]);
    const d = storyDigest(b, { upToChapter: 1 });
    expect(d).toContain("Midpoint.");
    expect(d).not.toContain("twist");
  });

  it("keeps recent summaries full but compresses older chapters to their keyMoment", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      scene({ chapterIndex: i, summary: `Chapter ${i} summary detail `.repeat(20), keyMoment: `key moment ${i}` }),
    );
    const d = storyDigest(bibleWith(many), { budgetChars: 100_000, recentFull: 3 });
    // Recent chapter (Ch 40 = index 39) shows its full summary…
    expect(d).toContain("Ch 40: Chapter 39 summary detail");
    // …an older chapter is compressed to its one-line keyMoment, NOT its repeated summary.
    expect(d).toContain("Ch 1: key moment 0");
    expect(d).not.toContain("Ch 1: Chapter 0 summary detail Chapter 0 summary detail");
  });

  it("trims oldest-first to fit a tight budget (recent detail survives)", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      scene({ chapterIndex: i, summary: `Chapter ${i} summary `.repeat(40), keyMoment: `km${i}` }),
    );
    const d = storyDigest(bibleWith(many), { budgetChars: 2000, recentFull: 3 });
    expect(d.length).toBeLessThanOrEqual(2000 + 80); // body cap + header
    expect(d).toContain("Ch 40:"); // newest kept
    expect(d).not.toContain("Ch 1:"); // oldest trimmed
  });

  it("returns empty for no storyboard", () => {
    expect(storyDigest(createEmptyBible("b"))).toBe("");
    expect(storyDigest(undefined)).toBe("");
  });
});

describe("recentArcLine", () => {
  it("gives a terse prior-arc line (chapters before the current), capped", () => {
    const b = bibleWith([
      scene({ chapterIndex: 0, keyMoment: "the ship sinks" }),
      scene({ chapterIndex: 1, keyMoment: "they wash ashore" }),
      scene({ chapterIndex: 2, keyMoment: "now lost in the jungle" }),
    ]);
    const line = recentArcLine(b);
    expect(line).toContain("the ship sinks");
    expect(line).toContain("they wash ashore");
  });

  it("is empty on the first chapter (nothing prior)", () => {
    expect(recentArcLine(bibleWith([scene({ chapterIndex: 0, keyMoment: "it begins" })]))).toBe("");
  });
});
