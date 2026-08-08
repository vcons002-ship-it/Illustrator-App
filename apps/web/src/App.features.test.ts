import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE "NO FEATURES LOST" GATE.
 *
 * A redesign that touches nearly every file produces a diff too large to review line by line.
 * This is the proof instead: an inventory captured from the tree BEFORE the sweep, asserted on
 * every run afterwards.
 *
 * It reads App.tsx as text rather than rendering it. That cannot prove a control still WORKS —
 * only that it was not deleted — but deletion during a 600-site mechanical edit is the actual
 * failure mode, and it is the one a green test suite would otherwise hide completely.
 *
 * When a feature is deliberately removed or renamed, change the list in the same commit. The
 * list moving is fine; the list moving SILENTLY is what this prevents.
 */

const APP_RAW = readFileSync(join(__dirname, "App.tsx"), "utf8");

/**
 * App.tsx WITH ITS COMMENTARY REMOVED.
 *
 * The inventory below is a substring search, and this file is heavily commented — including with
 * comments ABOUT the controls, naming them. So a control could be deleted from the UI and the gate
 * would still pass on the comment explaining why it went. That is not hypothetical: it happened on
 * the toolbar regrouping, where "Tools" survived the check purely because two comments mention it.
 *
 * Block and full-line comments only. A trailing `// …` cannot be stripped safely without parsing
 * strings, and it is not where this file explains itself.
 */
const APP = APP_RAW.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");
const UI_SRC = join(__dirname, "..", "..", "..", "packages", "ui", "src");

/** Every button/control label reachable from the header and book toolbars. */
const CONTROLS = [
  "Exit book",
  // The five groups that replaced the flat "Tools" row. "Tools" itself is deliberately gone from
  // this list: that caret no longer exists. Kept as a reminder of why the list is edited in the
  // same commit as the UI rather than trusted to stay true on its own — and note that a bare
  // "Tools" would still have PASSED, matching the identifier `bookToolsOpen`, which is the limit
  // of substring matching on source and the reason these entries carry their emoji.
  "📖 This book",
  "📚 Library",
  "🧠 Assistant",
  "🔌 Connections",
  "Book tools",
  "Read view",
  "Edit code",
  "Original layout",
  "Clean text",
  "Library",
  "Creations",
  "Open book",
  "Story",
  "Paste text",
  "Polish doc",
  "Skills",
  "Memory",
  "Soul",
  "You",
  "Tasks",
  "Calendar",
  "Markets",
  "Browse",
  "Link phone",
  "Scheduled",
  "Load sample",
  "Test image",
  "Photo",
  "Settings",
  "Start illustrating",
  "Complete book",
  "Resume all",
  "Reading",
  "Painting",
  "Redo",
  "Technical",
  "Characters",
  "Places",
  "Creatures",
  "Export",
  "Import bible",
];

/** Panels and modals the app can open. Each must still be referenced from App.tsx. */
const SURFACES = [
  "FirstRunWizard",
  "WorldBible",
  "CharacterBible",
  "DataModal",
  "ImportBibleModal",
  "TestImageModal",
  "PhotoTransformModal",
  "ChatPanel",
  "PasteTextModal",
  "DocumentPolishPanel",
  "LibraryPanel",
  "CreationsPanel",
  "SkillsPanel",
  "MemoriesPanel",
  "SoulPanel",
  "StorySetupModal",
  "TasksPanel",
  "CalendarPanel",
  "ActionHistoryPanel",
  "RenameExportModal",
  "StockChartPanel",
  "BrowserPanel",
  "OrderReviewModal",
  "ScheduledTasksPanel",
  "SettingsPanel",
  "ChatBuddyPanel",
  "WorkflowBar",
  "ProviderBadges",
  "ActivityCenter",
  "ToastHost",
  "DownloadStatus",
];

/** The five ways a book can be shown. Losing one silently would strand a whole content type. */
const VIEWS = ["story", "document", "text", "data", "code"];

describe("every user-facing control still exists", () => {
  it.each(CONTROLS)("offers %s", (label) => {
    expect(APP).toContain(label);
  });
});

describe("every panel and overlay is still reachable", () => {
  it.each(SURFACES)("renders %s", (name) => {
    expect(APP).toContain(name);
  });
});

describe("every reader view survives", () => {
  it.each(VIEWS)("handles viewAs %s", (view) => {
    expect(APP).toContain(`"${view}"`);
  });

  it("keeps the per-unit inline image path, which only exists on narrow screens", () => {
    // The one layout branch React must own rather than CSS: it changes DOM ORDER.
    expect(APP).toContain("InlineUnitImage");
    expect(APP).toContain("inlineImages");
  });
});

describe("the component library is intact", () => {
  /** Deliberately internal: shared building blocks consumed by relative path inside
   * packages/ui and never part of its public surface. Allowlisted here, and the next test
   * proves they still have consumers — so the allowlist can't quietly hide a real orphan. */
  const INTERNAL = ["ModalShell", "RemovedBibleEntries"];

  const componentFiles = readdirSync(UI_SRC)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => f.replace(/\.tsx$/, ""));

  it("exports every module that has a file", () => {
    // Catches a component orphaned by a sweep — still on disk, no longer exported, invisible.
    const index = readFileSync(join(UI_SRC, "index.ts"), "utf8");
    const missing = componentFiles.filter((c) => !INTERNAL.includes(c) && !index.includes(`./${c}.js`));
    expect(missing, `on disk but not exported: ${missing.join(", ")}`).toEqual([]);
  });

  it("the internal components are used by someone", () => {
    for (const name of INTERNAL) {
      const consumers = componentFiles.filter(
        (f) => f !== name && readFileSync(join(UI_SRC, `${f}.tsx`), "utf8").includes(name),
      );
      expect(consumers.length, `${name} is exported by nobody and imported by nobody`).toBeGreaterThan(0);
    }
  });
});

describe("the reader's own affordances", () => {
  it("still measures the content box instead of guessing at viewport maths", () => {
    // Five hand-written height constants each counted a different set of chrome; this is the
    // one that measures. Losing it brings back the double scrollbar it was added to fix.
    expect(APP).toContain("--vr-view-h");
    expect(APP).toContain("ResizeObserver");
  });

  it("keeps the per-character reference capture in the reader", () => {
    expect(APP).toContain("Lock this look");
  });
});

/**
 * WHICH FACE GOES WHERE.
 *
 * `styles.shell` used to declare the READING font — `Georgia, 'Iowan Old Style', serif` — and it
 * sits on the app's root element, so every button, pill, menu, status chip and chat message
 * inherited a book face. A serif UI is what "the new colour scheme doesn't seem right" actually
 * turned out to be: the palette was landing correctly and the typography was wrong.
 *
 * It also silently disabled base.css. `.vr-app { font-family: var(--vr-font-ui) }` can never win
 * against an inline style on the same element, so the stylesheet's own font rule was inert — the
 * exact cascade fact this whole migration is built on, working against us for once.
 *
 * The split is now explicit in both directions, and both directions are asserted: the shell takes
 * the UI font, and prose asks for the reading font by name. Either half regressing alone is a bug
 * — a serif UI, or a sans-serif book — so neither is left to inheritance.
 */
describe("typography: a sans UI around a serif book", () => {
  /** Pull one style object out of the `styles` record by key, WITHOUT its comments — these blocks
   * are commented in prose that names the very fonts being asserted about, and a gate that reads
   * commentary is a gate that fires on a sentence rather than on the code. */
  const styleBlock = (key: string): string => {
    const at = APP.indexOf(`\n  ${key}: {`);
    expect(at, `styles.${key} not found`).toBeGreaterThan(-1);
    return APP.slice(at, APP.indexOf("\n  },", at)).replace(/\/\/.*$/gm, "");
  };

  it("does not put the reading serif on the app shell, where everything inherits it", () => {
    expect(styleBlock("shell")).not.toMatch(/Georgia|serif/);
  });

  it("gives the shell the UI font, so chrome is sans by default", () => {
    expect(styleBlock("shell")).toContain("t.font.ui");
  });

  it("keeps the book itself in the reading face", () => {
    // These inherited their serif from the shell. With the shell switched they must state it, or
    // the reader silently becomes sans — a regression nothing else in the suite would notice.
    for (const key of ["paragraph", "chapterHeading", "readerDocInner"]) {
      expect(styleBlock(key), `styles.${key} lost the reading font`).toContain("t.font.read");
    }
  });

  it("keeps imported articles in the reading face too", () => {
    const article = readFileSync(join(UI_SRC, "styles", "article.css"), "utf8");
    expect(article).toMatch(/\.vr-article-html\s*\{[^}]*--vr-font-read/);
  });

  it("leaves code and plain text on the monospace face", () => {
    expect(styleBlock("readerPlainText")).toMatch(/ui-monospace|t\.font\.mono/);
  });

  /**
   * THE SHELL WAS NOT THE ONLY PLACE THAT SAID GEORGIA.
   *
   * A portalled surface renders on a bare <body>, outside the app tree, so it inherits nothing and
   * has to restate its own font. SettingsPanel restated the READING font — copied from the shell
   * back when it did inherit — so after the shell moved to sans, the entire Settings panel stayed
   * serif. On screen that is indistinguishable from the stylesheet failing to load, which is
   * exactly how it was reported.
   *
   * Checking one file was the mistake. Anything that carries its own copy of a value carries its
   * own copy of a mistake, so every portalled surface is checked, by finding them rather than by
   * listing them — a new portal added later is caught without anyone remembering to add it here.
   */
  it("no portalled surface reintroduces the reading font as its UI font", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(UI_SRC).filter((n) => n.endsWith(".tsx"))) {
      const src = readFileSync(join(UI_SRC, f), "utf8");
      if (!src.includes("createPortal")) continue;
      src.split("\n").forEach((line, i) => {
        if (/fontFamily:\s*["'`][^"'`]*(Georgia|Iowan|serif)/.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `portalled surfaces declaring the book face for their chrome: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});

/**
 * EVERY FULL-SCREEN PANEL GOES THROUGH ModalShell.
 *
 * Ten of them were hand-rolled `position: fixed` overlays. An audit found the same three zeros in
 * every one: no Escape handling, no `role="dialog"`, no `aria-modal`. Structurally they were divs.
 * That meant Tab walked out of the panel into the page behind it — still there, still interactive,
 * now invisible — focus never entered or returned, and a screen reader announced nothing at all.
 *
 * ModalShell already solved this for the modals that used it. The fix was to stop having two kinds
 * of modal, and this keeps it that way: a new panel that hand-rolls an overlay fails here, with a
 * pointer to the component it should be using instead.
 */
describe("every overlay panel is a real dialog", () => {
  const UI_FILES = readdirSync(UI_SRC).filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"));

  /** Not modals: a menu dismisses on outside-tap and must NOT trap focus or claim the page is
   * inert, and the particle field is a decorative canvas. Both are listed rather than pattern-
   * matched, so adding a third exemption is a deliberate act. */
  const NOT_MODALS = new Set(["AnchoredMenu.tsx", "ParticleField.tsx", "ModalShell.tsx"]);

  it("no panel hand-rolls a full-screen overlay", () => {
    const offenders = UI_FILES.filter((f) => {
      if (NOT_MODALS.has(f)) return false;
      const src = readFileSync(join(UI_SRC, f), "utf8");
      const fullScreen = /position:\s*"fixed"/.test(src) && /inset:\s*0/.test(src);
      return fullScreen && !src.includes("ModalShell");
    });
    expect(
      offenders,
      `hand-rolled overlays — use ModalShell so they get Escape, a focus trap and aria-modal: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the panels that were converted on it", () => {
    // Named individually: a regex could go green because ModalShell appears in a comment.
    for (const f of [
      "TasksPanel",
      "SkillsPanel",
      "CalendarPanel",
      "ActionHistoryPanel",
      "StockChartPanel",
      "BrowserPanel",
      "ScheduledTasksPanel",
      "WorldBible",
      "CharacterBible",
      "DocumentPolishPanel",
    ]) {
      const src = readFileSync(join(UI_SRC, `${f}.tsx`), "utf8");
      expect(src, `${f} no longer renders through ModalShell`).toMatch(/<ModalShell\b/);
    }
  });

  it("does not make a form dismissable that deliberately was not", () => {
    // DocumentPolishPanel never had a backdrop onClick — a stray tap must not throw away a
    // half-written document. Converting it without this would have quietly changed that.
    const src = readFileSync(join(UI_SRC, "DocumentPolishPanel.tsx"), "utf8");
    expect(src).toContain("disableBackdropClose");
  });
});
