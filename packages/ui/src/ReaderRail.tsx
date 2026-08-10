import { cx } from "./design/classes.js";
import { t } from "./design/tokens.js";

export interface RailChapter {
  id: string;
  title?: string;
  index: number;
}
export interface RailPage {
  index: number;
  chapterId: string;
}

export interface OutlineEntry {
  id: string;
  label: string;
  /** The page to scroll to. -1 when the chapter has no pages, so the caller can skip it. */
  firstPage: number;
  current: boolean;
}

/**
 * THE CHAPTER LIST, AND WHICH ONE YOU ARE IN.
 *
 * "Current" is the chapter owning the page being read, NOT the nearest heading above it — those
 * differ whenever a chapter's first page is off screen, which is most of the time while reading.
 * Derived from `page.chapterId` rather than from position, so it cannot drift out of step with
 * however the reader happens to be scrolled.
 *
 * A chapter with no pages keeps its row (the outline should match the book's own contents) but
 * reports firstPage -1, because scrolling to a page that is not there would do nothing and look
 * like a broken control.
 */
export function chapterOutline(
  chapters: readonly RailChapter[],
  pages: readonly RailPage[],
  activePage: number,
): OutlineEntry[] {
  const firstPageOf = new Map<string, number>();
  for (const p of pages) {
    if (!firstPageOf.has(p.chapterId)) firstPageOf.set(p.chapterId, p.index);
  }
  const currentId = pages.find((p) => p.index === activePage)?.chapterId;
  return chapters.map((c) => ({
    id: c.id,
    label: c.title?.trim() || `Chapter ${c.index + 1}`,
    firstPage: firstPageOf.get(c.id) ?? -1,
    current: c.id === currentId,
  }));
}

/** How far through the book, 0–100. */
export function readingProgress(activePage: number, totalPages: number): number {
  if (totalPages <= 1) return totalPages === 1 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((activePage / (totalPages - 1)) * 100)));
}

/**
 * THE RAIL — what the ~1,100px of `margin: 0 auto` was doing instead.
 *
 * On a 2560px monitor the reader was a 1400px column centred in the window, so roughly eleven
 * hundred pixels of screen were margin. Widening the prose was never the answer: 640px is the right
 * measure and stretching it makes the app worse to read. So the reclaimed width goes to the art and
 * to this — where you are, and where you can go.
 *
 * Rendered whenever there is a book, and HIDDEN BY CSS below 1440px rather than by a condition
 * here. That is deliberate: a layout decision made in JS from `innerWidth` has to seed a state and
 * then correct itself in an effect, which is a visible flash on first paint and a whole class of
 * bug where the two disagree. CSS simply knows.
 */
export function ReaderRail({
  chapters,
  pages,
  activePage,
  onJump,
}: {
  chapters: readonly RailChapter[];
  pages: readonly RailPage[];
  activePage: number;
  onJump: (page: number) => void;
}) {
  const outline = chapterOutline(chapters, pages, activePage);
  const pct = readingProgress(activePage, pages.length);

  return (
    <nav className={cx.rail} aria-label="Chapters">
      <div style={headStyle}>Progress</div>
      <div className={cx.queueBar} style={{ marginBottom: 14 }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${pct}%` }} />
      </div>
      {outline.length > 0 ? (
        <>
          <div style={headStyle}>Chapters</div>
          <ol style={listStyle}>
            {outline.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`${cx.railItem}${c.current ? ` ${cx.railItemCurrent}` : ""}`}
                  style={itemStyle}
                  onClick={() => c.firstPage >= 0 && onJump(c.firstPage)}
                  disabled={c.firstPage < 0}
                  {...(c.current ? { "aria-current": "true" as const } : {})}
                >
                  {c.label}
                </button>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </nav>
  );
}

const headStyle = {
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  opacity: 0.5,
  marginBottom: 6,
} as const;

const listStyle = { listStyle: "none", margin: 0, padding: 0 } as const;

const itemStyle = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "none",
  border: "none",
  color: t.text.dim,
  font: "inherit",
  fontSize: 12,
  lineHeight: 1.45,
  padding: "3px 6px",
  borderRadius: 5,
  cursor: "pointer",
} as const;
