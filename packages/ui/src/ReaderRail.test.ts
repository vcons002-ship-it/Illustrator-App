import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chapterOutline, readingProgress } from "./ReaderRail.js";
import { NARROW_PX } from "./design/breakpoints.js";

const chapters = [
  { id: "a", index: 0, title: "The Squall" },
  { id: "b", index: 1, title: "The Lantern" },
  { id: "c", index: 2 },
];
const pages = [
  { index: 0, chapterId: "a" },
  { index: 1, chapterId: "a" },
  { index: 2, chapterId: "b" },
  { index: 3, chapterId: "c" },
];

describe("the chapter outline", () => {
  it("marks the chapter that OWNS the page being read", () => {
    expect(chapterOutline(chapters, pages, 1).find((c) => c.current)?.id).toBe("a");
    expect(chapterOutline(chapters, pages, 2).find((c) => c.current)?.id).toBe("b");
  });

  /**
   * The tempting alternative — "the last chapter whose first page is at or above here" — agrees
   * with this only while a chapter's opening page is on screen, which is almost never the case
   * while actually reading. Deriving from the page's own chapterId cannot drift.
   */
  it("marks exactly one chapter, and none when the page is unknown", () => {
    expect(chapterOutline(chapters, pages, 3).filter((c) => c.current)).toHaveLength(1);
    expect(chapterOutline(chapters, pages, 99).filter((c) => c.current)).toHaveLength(0);
  });

  it("jumps to a chapter's FIRST page, not to wherever it was last seen", () => {
    expect(chapterOutline(chapters, pages, 0).map((c) => c.firstPage)).toEqual([0, 2, 3]);
  });

  it("names an untitled chapter by its number rather than leaving a blank row", () => {
    expect(chapterOutline(chapters, pages, 0)[2]!.label).toBe("Chapter 3");
    const blank = chapterOutline([{ id: "z", index: 4, title: "   " }], [], 0);
    expect(blank[0]!.label, "a whitespace title is not a title").toBe("Chapter 5");
  });

  it("keeps an empty chapter in the list but makes it unjumpable", () => {
    // The outline should match the book's own contents; a row that scrolled nowhere would read as
    // a broken control, so the component disables it instead.
    const out = chapterOutline([{ id: "ghost", index: 0 }], [], 0);
    expect(out).toHaveLength(1);
    expect(out[0]!.firstPage).toBe(-1);
  });

  it("reports progress without dividing by zero on an empty or single-page book", () => {
    expect(readingProgress(0, 0)).toBe(0);
    expect(readingProgress(0, 1)).toBe(100);
    expect(readingProgress(0, 5)).toBe(0);
    expect(readingProgress(4, 5)).toBe(100);
    expect(readingProgress(2, 5)).toBe(50);
  });
});

/**
 * THE ONE CHANGE THAT CAN BREAK READING ITSELF.
 *
 * Four inline style objects became one grid and four modifiers. These assert the properties the
 * old objects guaranteed, because losing any of them is a reader that is subtly wrong in a way
 * only a person looking at a book would notice.
 */
describe("the reader grid keeps what the four style objects guaranteed", () => {
  const layout = readFileSync(join(__dirname, "styles", "layout.css"), "utf8");
  const grid = /\.vr-reader \{([\s\S]*?)\n\}/.exec(layout)?.[1] ?? "";

  it("never widens the prose measure, in any mode", () => {
    expect(grid, ".vr-reader not found").toBeTruthy();
    expect(grid).toMatch(/--vr-measure/);
    // The one exception is a data book, whose "prose" track is a SPREADSHEET — a sheet squeezed
    // into a 640px reading column is unusable, and the old readerData gave it 1200.
    const modes = ["--inline", "--rail", "--wide"];
    for (const m of modes) {
      const rule = new RegExp(`\\.vr-reader${m} \\{([\\s\\S]*?)\\n\\}`).exec(layout)?.[1] ?? "";
      expect(rule, `.vr-reader${m} not found`).toBeTruthy();
      expect(rule, `${m} widens the reading column`).not.toContain("--vr-measure");
    }
    expect(/\.vr-reader--data \{([\s\S]*?)\n\}/.exec(layout)?.[1] ?? "").toContain("--vr-measure");
  });

  it("collapses to one column on a phone, at the breakpoint the code believes in", () => {
    const narrow = new RegExp(`@media \\(max-width: ${NARROW_PX}px\\) \\{([\\s\\S]*?)\\n\\}\\n`).exec(layout)?.[1] ?? "";
    expect(narrow, `no @media (max-width: ${NARROW_PX}px)`).toBeTruthy();
    expect(narrow, "the phone still gets a multi-column grid").toMatch(/display:\s*block/);
    // display:block is what makes the art column flow BELOW the text it illustrates. If a mode had
    // hidden that column, a phone would lose its pictures entirely.
    expect(narrow).toMatch(/\.vr-art-col \{\s*display: block/);
  });

  it("hides the art column where its track is zero-width, rather than merely narrowing it", () => {
    // An element in a 0px track still paints its overflow across the prose beside it.
    expect(layout).toMatch(/\.vr-reader--inline \.vr-art-col,\s*\n\s*\.vr-reader--data \.vr-art-col \{\s*\n\s*display: none/);
  });

  it("only gives the rail room where there is spare width to give", () => {
    const wide = /@media \(min-width: 1440px\) \{([\s\S]*?)\n\}\n/.exec(layout)?.[1] ?? "";
    expect(wide, "no wide-screen rail rule").toBeTruthy();
    expect(wide).toContain("--vr-rail-w");
    // Below it the rail is a 0px track, so the reader is never squeezed to make room for it.
    expect(/--vr-rail-w:\s*0/.test(readFileSync(join(__dirname, "styles", "tokens.css"), "utf8"))).toBe(true);
  });
});

describe("the app wears the grid instead of describing it inline", () => {
  const app = readFileSync(join(__dirname, "..", "..", "..", "apps", "web", "src", "App.tsx"), "utf8");

  it("has no reader style objects left to disagree with the sheet", () => {
    // Inline styles beat classes, so a surviving `styles.reader` would silently win and the whole
    // change would be invisible — the cascade trap that has now bitten five times.
    for (const dead of ["styles.readerNarrow", "styles.readerWide", "styles.readerData", "styles.reader}"]) {
      expect(app, `${dead} still applied`).not.toContain(dead);
    }
  });

  it("decides the phone layout in CSS, not from innerWidth", () => {
    // useNarrow seeds from innerWidth then re-checks in an effect: a first-paint flash, and two
    // sources of truth that can disagree. It survives only for what CSS cannot do — reordering.
    expect(app).toContain("READER_CLASS[readerLayout]");
    expect(app, "the grid is still branching on `narrow`").not.toMatch(/narrow \? styles\.reader/);
    expect(app, "inlineImages must still be JS — it changes DOM order").toMatch(
      /inlineImages = \(narrow \|\| readerLayout === "inline"\)/,
    );
  });

  it("resets the layout when a different book opens", () => {
    // Without this a second book silently inherits the first one's choice, which reads as the
    // picker having stopped working.
    const effect = /const id = book\?\.id;[\s\S]*?\}, \[book\?\.id, libraryStore\]\);/.exec(app)?.[0] ?? "";
    expect(effect, "no per-book restore effect").toBeTruthy();
    expect(effect).toContain('setReaderLayout("side")');
  });
});
