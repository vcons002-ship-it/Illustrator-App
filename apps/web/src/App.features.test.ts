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

/**
 * STOP HAS TO REACH A PENDING APPROVAL.
 *
 * `buddyCancel` aborts the turn in flight and nothing else, so a run suspended on an approval
 * survived Stop: the card stayed pending, and a pending tool is one of the guards the scheduled-task
 * and idle-turn executors check before they will start anything — so everything after it quietly
 * declined to run too. Reported from a phone, where the card is easiest to miss in the first place
 * and Stop is the control the reader reaches for.
 *
 * Both entry points — the panel's own button and the phone's `vrcmd:chatCancel` relay — have to go
 * through the same clearing. Wiring one and not the other is the shape this regressed in.
 */
describe("Stop clears a pending approval", () => {
  it("routes both the button and the phone's relay through stopBuddyRun", () => {
    expect(APP).toContain("const stopBuddyRun = useCallback(");
    // The relay handler. If this goes back to bare buddyCancel(), a phone's Stop leaves the card up.
    expect(APP).toMatch(/case "vrcmd:chatCancel":\s*\n\s*stopBuddyRun\(\);/);
    // The button, via onBuddyCancel — which relays on a phone and clears here on the desktop.
    expect(APP).toMatch(/if \(isRemoteClient\) sendAppSync\(\{ type: "vrcmd:chatCancel" \}\);\s*\n\s*else stopBuddyRun\(\);/);
  });

  it("clears exactly what Deny clears", () => {
    const body = APP.slice(APP.indexOf("const stopBuddyRun = useCallback("));
    const fn = body.slice(0, body.indexOf("}, [buddyCancel]);"));
    for (const line of ["buddyCancel();", "setBuddyPendingTool(undefined);", "pendingBuddyTranscript.current = [];", "pendingBuddyHistory.current = [];"]) {
      expect(fn, line).toContain(line);
    }
  });
});

/**
 * A TOOL THAT REACHES THE READER'S COMPUTER NAMES WHAT IT IS REACHING FOR.
 *
 * The trace row and the activity line are the entire view of that reach on a linked phone, and
 * "Proposing a command…" was the same row whether the assistant wanted `ls` or `rm -rf` — nothing to
 * judge before approving, nothing recognisable in the trace after.
 */
describe("the live activity line", () => {
  it("describes desktop-runtime proposals by their payload", () => {
    expect(APP).toContain("describeToolProposal");
    expect(APP).toMatch(/isDesktopRuntimeTool\(c\) \|\| c\.tool === "browser_eval" \? describeToolProposal\(c\)/);
  });

  it("no longer carries the generic strings those tools fell to", () => {
    expect(APP).not.toContain("Proposing a command…");
    expect(APP).not.toContain("Searching your files…");
    expect(APP).not.toContain("Asking to see your screen…");
  });
});

/**
 * THE IN-TURN CHECKLIST TICK CARRIES THE HOST'S GUARDS, NOT JUST ITS SHAPE.
 *
 * Steps used to be one per TURN, judged by the host's executor in App.tsx. When they moved inside
 * the round loop, the worker grew its own tick — and copied the free nudge without either of the two
 * things that make a free nudge safe. It had no MAX_STEP_REMINDERS bound, so a model that kept
 * narrating was asked the same thing until the round budget ran out and the step never parked; and
 * it dropped `needsTool`, which is the only text that says a file step is satisfied by an actual
 * write_file call rather than by a description of one — precisely the confusion the nudge answers.
 */
describe("the worker's in-turn tick", () => {
  const WORKER = readFileSync(join(__dirname, "engine.worker.ts"), "utf8");

  it("bounds its free nudges per step, so a stuck step can still park", () => {
    expect(WORKER).toContain("MAX_STEP_REMINDERS");
    expect(WORKER).toMatch(/tickNudges\s*=\s*\{\s*stepId:\s*step\.id,\s*count:\s*used\s*\+\s*1\s*\}/);
    // A real attempt or an advance restores the budget — otherwise a long, healthy run exhausts it.
    expect(WORKER).toMatch(/tickNudges\s*=\s*\{\s*stepId:\s*"",\s*count:\s*0\s*\}/);
  });

  it("names the tool the step needs, the same as the host's nudge does", () => {
    expect(WORKER).toMatch(/stepDirective\(wf!, step, "nudge", need \? \{ needsTool: need \} : \{\}\)/);
  });

  it("shares one bound with the host rather than keeping a second copy", () => {
    // Two copies of a limit drift; the host's used to be the only one, in App.tsx.
    expect(APP_RAW).not.toMatch(/const MAX_STEP_REMINDERS\s*=/);
    expect(APP_RAW).toContain("MAX_STEP_REMINDERS");
  });
});

/**
 * THE TWO NUMBERS THAT DECIDED WHETHER A LONG FILE COULD EXIST AT ALL.
 *
 * Reasoning tokens and reply tokens come out of the same `num_predict` on Ollama. At 30% of a
 * conservative 8,192-token window that was 2,457 for both, and a qwen3-class model spends 800–3,000
 * of them thinking before it writes a character — so the generation ended inside the thinking block
 * every round, and the round loop bought nothing, because round 20 faced the identical wall as round
 * 0. A fraction of the window was the wrong rule: the input is bounded separately, so the only real
 * constraint is that the two fit together.
 */
describe("the local reply budget", () => {
  const WORKER = readFileSync(join(__dirname, "engine.worker.ts"), "utf8");

  it("has a floor a thinking model can actually answer inside", () => {
    expect(WORKER).toMatch(/const MIN_LOCAL_REPLY_TOKENS = 4096/);
    expect(WORKER).toMatch(/Math\.max\(MIN_LOCAL_REPLY_TOKENS, Math\.floor\(usable \* LOCAL_REPLY_FRACTION\)\)/);
  });

  it("never lets the floor eat the context on a small window", () => {
    // Half the window to each side is what makes a floor safe at 8,192 tokens.
    expect(WORKER).toMatch(/Math\.floor\(usable \/ 2\)/);
  });
});

/**
 * THE CHECKLIST KEEPS ITS PLACE ACROSS TURNS.
 *
 * `compileWorkflow` hardcodes every step to `pending` and activates step 1 — it is for a checklist
 * that has just been written. The worker called it on every turn, so the in-turn tick believed step
 * 1 was current on turn four and pushed step 1's instruction into the turn. The host's own copy is
 * protected, so the card kept showing the real position while the model rewrote a finished file:
 * it reads as a stall and is actually a rewind.
 */
describe("the worker's checklist", () => {
  const WORKER = readFileSync(join(__dirname, "engine.worker.ts"), "utf8");

  it("adopts the progress the host sent instead of resetting to step 1", () => {
    expect(WORKER).toMatch(/adoptPlanProgress\(compileWorkflow\(msg\.plan!\), msg\.plan!\)/);
  });

  it("does not compile a running checklist from scratch", () => {
    expect(WORKER, "a bare compileWorkflow(msg.plan) resets every step to pending").not.toMatch(
      /\?\s*compileWorkflow\(msg\.plan!\)\s*:/,
    );
  });
});

/**
 * A STEP IS NOT A ROUND.
 *
 * Every round that did not satisfy a step's contract was read as a failed attempt: `advanceWorkflow`
 * with `done:false` spends one of the step's few attempts, and after `maxAttempts` the step parks at
 * "⏸ Stuck". That is right for a step whose work is one act — render this image, run this command —
 * and wrong for one whose deliverable does not fit a single reply. "Write index.html" is several
 * rounds of appending on a local model whose budget cannot hold the file, and under the old reading
 * each of those rounds was a failure rather than progress.
 */
describe("a checklist step that takes more than one round", () => {
  const WORKER = readFileSync(join(__dirname, "engine.worker.ts"), "utf8");

  it("continues a step that is visibly progressing instead of failing it", () => {
    expect(WORKER).toMatch(/stepDirective\(wf!, step, "continue"/);
    // Progress is MEASURED from the app's own observation of the round, never claimed by the model —
    // the same standard the collar holds everywhere else.
    expect(WORKER).toMatch(/evidence\.toolResults\.length > tickProgress\.tools/);
    expect(WORKER).toMatch(/evidence\.text\.length > tickProgress\.chars/);
  });

  it("bounds it, so a trickle still reaches the retry and park path", () => {
    expect(WORKER).toContain("MAX_STEP_ROUNDS");
    expect(WORKER).toMatch(/progressRounds < MAX_STEP_ROUNDS/);
  });

  it("starts the next step's allowance fresh", () => {
    // Carried over, a long step would spend the next step's rounds before it began.
    expect(WORKER).toMatch(/tickProgress = \{ stepId: "", tools: -1, chars: -1, rounds: 0 \}/);
  });
});

/**
 * THE CUT IS A LAST RESORT, NOT A LEASH. Half the reply budget fired on a model that was legitimately
 * planning, handed back a half-formed plan and demanded output from it. The honest bound is the point
 * past which there was never going to be an answer anyway: reasoning and reply share one
 * `num_predict`, so a deliberation at three quarters of the whole allowance has already spent what
 * the answer needed.
 */
describe("the thinking bound", () => {
  const WORKER = readFileSync(join(__dirname, "engine.worker.ts"), "utf8");

  it("is generous, and local-only", () => {
    expect(WORKER).toMatch(/thinkingBudgetChars: Math\.floor\(budgets\.reply \* 1\.5\)/);
  });
});

/**
 * A CANCELLATION IS AN OUTCOME, NOT A FAULT.
 *
 * Pressing Stop aborts the fetch, and the rejection is a DOMException whose message is whatever the
 * browser felt like saying — "BodyStreamBuffer was aborted". Four handlers posted `err.message`
 * unclassified, so that string became the reader's error. Worse, `interruptedRunNote` writes the same
 * reason into a DURABLE model-facing turn that is replayed as history on every later turn of the
 * chat, so a small local model spends the rest of the session being told its last attempt died of a
 * Blink internal.
 */
describe("pressing Stop", () => {
  const WORKER = readFileSync(join(__dirname, "engine.worker.ts"), "utf8");

  it("is reported as a stop, not as the browser's internal error text", () => {
    expect(WORKER).toMatch(/const stopOrError = \(ac: AbortController, err: unknown\): string =>/);
    expect(WORKER).toMatch(/err instanceof Error && err\.name === "AbortError"/);
    expect(WORKER).toContain('"Stopped."');
  });

  it("covers every handler whose error the reader reads as a chat message", () => {
    // The four registered in `chatAborts` — the only ones a Stop can reach. Every other post in this
    // file is for an operation that has no Stop, so a raw message there is the right thing.
    for (const kind of ["buddyError", "chatError", "planned", "polished"]) {
      // The multi-line `post({ type: "x", … })` shape a catch uses — `planned` and `polished` also
      // have single-line SUCCESS posts earlier in the file, which are not what this is about.
      expect(
        new RegExp(`type: "${kind}",[\\s\\S]{0,160}?stopOrError\\(ac, err\\)`).test(WORKER),
        `${kind} still posts the browser's raw error text on a Stop`,
      ).toBe(true);
    }
  });
});

/**
 * ONE CONVERSATION'S STATE MUST NOT APPEAR IN ANOTHER'S.
 *
 * The worker held per-conversation state as module globals, and "global" was never a decision — the
 * buddyChat message carried no session id, so there was nothing to key on. What it cost: an
 * unattended ✨ Creative run wrote an essay, `create_document` put it in the single `activeDocument`
 * slot, and every later turn in the reader's OWN chat opened with "the active document — a long
 * essay…". The excerpt is pinned system text budgeted at 40% of the history allowance, so on a 30k
 * window it was ~7,800 characters of someone else's work evicting the conversation it sat beside.
 */
describe("per-conversation state in the worker", () => {
  const WORKER = readFileSync(join(__dirname, "engine.worker.ts"), "utf8");
  const PROTOCOL = readFileSync(join(__dirname, "worker-protocol.ts"), "utf8");

  it("carries a session id on the turn, which is what makes keying possible at all", () => {
    expect(PROTOCOL).toMatch(/sessionId\?: string;/);
    expect(readFileSync(join(__dirname, "App.tsx"), "utf8")).toContain(
      "activeScheduledTaskId(), carriedThinking, activeBuddyIdRef.current)",
    );
    expect(WORKER).toMatch(/const sessionKey = msg\.sessionId \?\? NO_SESSION;/);
  });

  it("keys the document and the draft by conversation, with no global left behind", () => {
    expect(WORKER).toContain("activeDocumentBySession");
    expect(WORKER).toContain("lastDraftBySession");
    // A bare `activeDocument =` / `lastDraft =` assignment is the shape that leaked.
    expect(WORKER, "a global document assignment came back").not.toMatch(/^\s*let activeDocument\b/m);
    expect(WORKER, "a global draft assignment came back").not.toMatch(/^\s*let lastDraft\b/m);
  });

  it("stops keying the loaded toolsets on a string literal shared by every chat", () => {
    // `load_toolset` is the first tool an unattended creative run is allowed, and its documentation
    // rides inside the cache prefix — welded onto every other conversation's setup for the page's life.
    expect(WORKER).not.toMatch(/const sessionKey = "buddy"/);
  });
});

/**
 * THE PROMPT'S LIVE BLOCKS ARE PART OF THE PROMPT. The history was sized against `setup` alone,
 * measured before those blocks existed — so the conversation was budgeted generously against a
 * prompt that then grew, the total overshot at send time, and `trimTurnMessages` clawed the
 * difference back by dropping the oldest turns behind the reader. The readout said "53% of window"
 * while the real prompt was larger, because it metered the same three sections and not the blocks.
 */
describe("the context budget and its readout", () => {
  const WORKER = readFileSync(join(__dirname, "engine.worker.ts"), "utf8");

  it("charges the live blocks to the history budget", () => {
    expect(WORKER).toMatch(/historyBudget\(budgets\.input, setup\.length \+ volatile\.length\)/);
  });

  it("shows them in the readout, so the same thing cannot hide again", () => {
    expect(WORKER).toMatch(/key: "live", label: "Documents & working state", text: volatile/);
  });

  it("assembles them BEFORE the trim, or the budget is sized for a prompt that is not sent", () => {
    const built = WORKER.indexOf("const volatile = [storyStateBlock");
    expect(built, "the buddy turn's volatile assembly is gone").toBeGreaterThan(-1);
    // Searched FROM the assembly: the reader-side chat path has its own trim earlier in the file,
    // and matching that one would pass no matter which order the buddy path used.
    const trimmed = WORKER.indexOf("const history = trimChatHistory(", built);
    expect(trimmed, "the buddy turn trims history before the blocks it must be sized against exist").toBeGreaterThan(built);
  });
});

/**
 * THE WORKSPACE HAS A SHAPE NOW.
 *
 * Every conversation wrote into one flat `workspace/` directory, so weeks of unrelated work piled
 * into a single listing with no way — for the reader OR the model — to tell which file belonged to
 * which chat or what any of it was for. The convention is a folder per conversation, kind folders
 * inside it, and a README that keeps saying what's in there.
 *
 * The gate that matters most here is SYMMETRY: a path the model can write is a path the model can
 * read back. Sorting writes into subfolders while reads still resolve somewhere else would turn a
 * tidier directory into a file the model can never open again.
 */
describe("the per-chat workspace layout", () => {
  const WORKER = readFileSync(join(__dirname, "engine.worker.ts"), "utf8");
  const HOOK = readFileSync(join(__dirname, "useEngineWorker.ts"), "utf8");

  it("gives each chat its own folder, created lazily by the first file it writes", () => {
    expect(APP_RAW).toContain("const ensureChatWorkspace = useCallback");
    // The README is the bootstrap: writing it through the ordinary workspace writer creates the
    // directory and hands back its absolute path — no new Rust command, no new approval.
    expect(APP_RAW).toMatch(/writeWorkspaceFile\(`\$\{folder\}\/README\.md`, readme\)/);
    // A folder the reader chose themselves is never overridden.
    expect(APP_RAW).toContain("buddyWorkingDirRef.current || (await ensureChatWorkspace())");
  });

  it("sorts a written file into its kind folder", () => {
    expect(APP_RAW).toContain("const path = workspacePathFor(call.path);");
    // `content` rather than `call.content`: an append now has a duplicated join trimmed off it first.
    expect(APP_RAW).toContain("await writeWorkspaceFile(path, content, await workspaceForWrite(), call.append)");
  });

  it("ledgers and reports the SAME relative path it wrote, not the absolute one", () => {
    // The ledger is the model's durable pointer to its own work; an absolute path there is a
    // pointer it cannot follow, because read_file/edit_file resolve against the chat's folder.
    expect(APP_RAW).toMatch(/recordCreatedFile\(path, call\.content/);
    // The payload gained the append anchor (line count + tail), so it is an object literal now; the
    // claim being pinned is still that the RELATIVE path is what goes back to the model.
    expect(APP_RAW).toContain("payload = {\n        path,\n        ok: true,");
  });

  it("resolves a workspace-relative read through the same door that wrote it", () => {
    expect(WORKER).toContain("let hostWorkingDir: string | undefined;");
    expect(WORKER).toMatch(/hostFile\(\{ op: "read", path, \.\.\.\(hostWorkingDir \? \{ cwd: hostWorkingDir \} : \{\}\) \}\)/);
    expect(HOOK).toContain("if (!ABSOLUTE_PATH.test(path)) {");
    expect(HOOK).toContain("const r = await readWorkspaceFile(path, msg.cwd);");
  });

  it("reads and edits in the chat's folder too, not just writes", () => {
    expect(APP_RAW).toContain("const dir = await workspaceForWrite();\n      const file = await readWorkspaceFile(call.path, dir);");
    expect(APP_RAW).toContain('let g = await readWorkspaceFile("AGENTS.md", guideDir);');
    expect(APP_RAW).toContain("const r = await readWorkspaceFile(p, workspaceDirNow());");
  });

  it("keeps a README describing the folder, merged so a reader's own notes survive", () => {
    expect(APP_RAW).toContain("const refreshWorkspaceReadme = useCallback");
    expect(APP_RAW).toMatch(/mergeWorkspaceReadme\(existing\.exists \? existing\.text : undefined, generated\)/);
    // Never into a folder the reader chose — their project is theirs.
    expect(APP_RAW).toContain("if (!dir || buddyWorkingDirRef.current) return;");
  });

  it("sends the chat's folder as the turn's working folder, so the worker resolves reads there", () => {
    expect(APP_RAW).toContain("}, workspaceDirNow(), activeTaskPlanId(),");
    expect(WORKER).toContain("hostWorkingDir = msg.workingDir;");
  });

  it("names the folder what the reader sees, not the session id", () => {
    // A chat only carries a stored `label` when something named it, so an ordinary conversation had
    // none and the folder fell all the way back to the session id — `buddy-msxr09vq`, which tells a
    // person looking at their own workspace nothing at all. The picker's positional fallback
    // ("Chat 13") now lives in one place that both the picker and the folder read.
    expect(APP_RAW).toContain("const displayLabel = useCallback((id: string): string =>");
    expect(APP_RAW).toContain("const label = displayLabel(id);");
    expect(APP_RAW).not.toMatch(/const label = buddySessionsRef\.current\.find\(\(x\) => x\.id === id\)\?\.label;/);
  });

  it("will not let a second chat move into the first one's folder", () => {
    // "Chat 13" is a POSITION, so deleting an earlier chat makes the name come round again.
    expect(APP_RAW).toContain("const owner = held2?.exists ? readmeChatId(held2.text) : undefined;");
    expect(APP_RAW).toContain("if (owner && owner !== id) folder =");
    // The owner is recorded when the folder is created.
    expect(APP_RAW).toContain("buildWorkspaceReadme(label.trim() || folder, [], id)");
  });

  it("names the folder actually in use in the bar, instead of claiming the default", () => {
    const PANEL = readFileSync(join(__dirname, "../../../packages/ui/src/ChatBuddyPanel.tsx"), "utf8");
    // The bar said "Default workspace" while the chat was writing, searching and running commands in
    // its own folder — telling the reader their files were somewhere they were not.
    // The NAME, not the whole absolute path: on a linked phone the bar is showing the desktop's path,
    // which is both correct and far wider than the screen. The full path stays on the title.
    expect(PANEL).toContain("folderName ? `This chat's folder (${folderName})`");
    expect(PANEL).toContain("title={chatFolder && !workingDir ? chatFolder : label}");
    expect(APP_RAW).toContain("...(chatFolder ? { chatFolder } : {}),");
    // The ref alone cannot drive a render, which is why there is state beside it.
    expect(APP_RAW).toContain("if (id === activeBuddyIdRef.current) setChatFolder(dir);");
  });

  it("finds a folder the chat ALREADY has, on a fresh page load", () => {
    // The chat→folder map is rebuilt per page load and only a WRITE ever filled it, so after a
    // reload a chat with a folder full of its work looked like a chat with none: the bar said
    // "Default workspace" and — worse — commands and reads went to the shared root while the chat's
    // files sat elsewhere. The folder was on disk the whole time; nothing was looking for it.
    expect(APP_RAW).toContain("const adoptChatWorkspace = useCallback");
    expect(APP_RAW).toContain("void adoptChatWorkspaceRef.current(activeBuddyId);");
    // Sessions arrive from storage after the first render, and the folder's name comes from the
    // chat's — probing before they land would look for the wrong name.
    expect(APP_RAW).toContain("}, [activeBuddyId, buddySessions]);");
  });

  it("adopts read-only, so a chat that only talks still never grows a folder", () => {
    const at = APP_RAW.indexOf("const adoptChatWorkspace = useCallback");
    const body = APP_RAW.slice(at, APP_RAW.indexOf("[isRemoteClient, displayLabel, rememberChatDir],", at));
    expect(body).toContain("await readWorkspaceFile(");
    expect(body, "the probe must never create a folder").not.toContain("writeWorkspaceFile");
    // It checks the suffixed name a collision would have produced, the name an OLDER build would have
    // given the same chat, and refuses someone else's folder.
    expect(body).toContain("for (const folder of [...new Set([base, suffixed, legacy])])");
    expect(body).toContain("if (owner && owner !== id) continue;");
  });

  /**
   * "IT STILL JUST SAYS /WORKSPACE", ON THE PHONE — reported after the folder was already being
   * resolved, created and used correctly on the desktop.
   *
   * Both functions that resolve a folder begin `if (!isDesktop || isRemoteClient) return`, which is
   * right — the phone has no filesystem and its turns run on the desktop — and left the phone with
   * nothing to name. So the bar said "Default workspace" on the one device the reader was holding,
   * while commands ran in the chat's folder at the other end of the link. The desktop's answer now
   * rides the chat mirror.
   */
  it("tells a linked phone which folder the desktop is using", () => {
    const SYNC = readFileSync(join(__dirname, "remote-sync.ts"), "utf8");
    expect(SYNC).toContain("chatDir?: string;");
    expect(APP_RAW).toContain("...(s.chatDir ? { chatDir: s.chatDir } : {}),");
    // And the phone keeps it when it adopts the mirrored session list — dropping it here would put
    // the bar straight back to "Default workspace".
    expect(APP_RAW.slice(APP_RAW.indexOf("const applyChat = useCallback"))).toContain(
      "...(s.chatDir ? { chatDir: s.chatDir } : {}),",
    );
  });

  it("counts Chat N once, so the switcher and the folder cannot disagree", () => {
    // The switcher counted over the FILTERED list and displayLabel over the raw one, so a chat shown
    // as "Chat 13" named its folder `chat-21` — and then went looking for `chat-13`, found nothing,
    // and reported the default workspace. Reported exactly that way.
    expect(APP_RAW).toContain("const i = list.filter((x) => !x.hidden).findIndex((x) => x.id === id);");
    expect(APP_RAW).toContain("label: displayLabel(s.id),");
    // No other place may count for itself.
    expect(APP_RAW.match(/`Chat \$\{i \+ 1\}`/g) ?? []).toHaveLength(1);
  });

  /**
   * A NAME THAT MOVES CANNOT BE USED TO FIND A FOLDER TWICE.
   *
   * "Chat 13" is a position and the reader can rename a chat at will, so rebuilding the name on every
   * page load meant the folder was found only as long as nothing changed. Resolve once, remember the
   * answer; the derived name is then only ever used to CHOOSE a folder, never to find it again.
   */
  it("remembers the folder on the session instead of re-deriving its name", () => {
    expect(APP_RAW).toContain("chatDir?: string;");
    expect(APP_RAW).toContain("const rememberChatDir = useCallback");
    // Written to all three places that have to agree: the synchronous map a turn reads, the bar, and
    // the persisted session.
    const at = APP_RAW.indexOf("const rememberChatDir = useCallback");
    const body = APP_RAW.slice(at, APP_RAW.indexOf("[isRemoteClient, libraryStore],", at));
    expect(body).toContain("chatWorkspaceRef.current.set(id, dir);");
    expect(body).toContain("if (id === activeBuddyIdRef.current) setChatFolder(dir);");
    expect(body).toContain('putMemo?.("buddy-sessions"');
    // The stored answer is preferred over any probe, and the probe stores what it finds.
    expect(APP_RAW).toContain("const stored = list.find((s) => s.id === id)?.chatDir;");
    expect(APP_RAW).toContain("if (stored) chatWorkspaceRef.current.set(activeBuddyId, stored);");
  });

  /**
   * THE UPLOAD WAS GONE THE MOMENT THE TURN ENDED.
   *
   * Reported as two things that are one thing: "the uploaded file was immediately lost after the turn
   * ended, it was never saved to a workspace", and then "it didn't know where to find the code to give
   * me a fully fixed version." An attachment was folded into a single prompt and nowhere else — its
   * chip in the transcript is display-only (`turns: []`, deliberately, so a 30k-char paste doesn't sit
   * in history forever), which left the content existing only inside a request that had already been
   * sent.
   */
  it("saves an attached file into the chat's workspace and tells the model where", () => {
    expect(APP_RAW).toContain("const saveAttachmentToWorkspace = useCallback");
    expect(APP_RAW).toContain("const saved = await saveAttachmentToWorkspace(att);");
    // Sorted by kind and put in the LEDGER — the pointer that survives history being trimmed.
    const at = APP_RAW.indexOf("const saveAttachmentToWorkspace = useCallback");
    const body = APP_RAW.slice(at, APP_RAW.indexOf("[isRemoteClient, execHostTool, recordCreatedFile, refreshWorkspaceReadme],", at));
    // Saved under the name it had on the reader's DISK. A document import names the chip after the
    // parsed title — "Flow3" for an HTML page — and a file with no extension is one Windows has no
    // association for: `start Flow3` opened nothing and a double-click did not work either.
    expect(body).toContain("const path = workspacePathFor(att.fileName ?? att.name);");
    expect(body).toContain("recordCreatedFile(path, body.split");
    // A BOUNDED copy must never be written over the reader's own file.
    expect(body).toContain("att.full ?? (att.text && att.text.length < ATTACH_DOC_MAX_CHARS ? att.text : undefined)");
    // And the model is told the path rather than left to guess it.
    expect(APP_RAW).toContain("SAVED IN THE WORKSPACE as ${saved}");
  });

  it("carries the whole file to the desktop, not just the model's bounded share", () => {
    const SYNC = readFileSync(join(__dirname, "remote-sync.ts"), "utf8");
    expect(SYNC).toContain("full?: string;");
    expect(APP_RAW).toContain("...(text.length > bounded.length ? { full: text } : {})");
    // Shed before the send itself is refused — a document saved short beats one never sent.
    expect(APP_RAW).toContain("relayAtts = relayAtts.map(({ full: _full, ...a }) => a);");
  });

  /**
   * "HOW COULD THE CHAT LOSE THE TEXT IT JUST WROTE AND GO LOOK FOR A FILE?"
   *
   * A reply spent all eight continuations pasting a page into the chat, stopped mid-identifier, and
   * then ran find_files for a file that had never been written. Nothing was trimmed — the context was
   * at 44%. The model went to disk because it is told to ("never rewrite a big file from memory") and
   * because the prompt is emphatic that a big file belongs in write_file. It was right on both counts
   * and had not done it, and the continuation directive forbids tool calls, so it could not.
   */
  it("saves the file a reply ran out of room writing", () => {
    expect(APP_RAW).toContain("const rescueUnfinishedFile = useCallback");
    expect(APP_RAW).toContain("const rescued = await rescueUnfinishedFile(res.text);");
    const at = APP_RAW.indexOf("const rescueUnfinishedFile = useCallback");
    const body = APP_RAW.slice(at, APP_RAW.indexOf("[isRemoteClient, displayLabel, execHostTool", at));
    // An unclosed fence is the whole signal.
    expect(body).toContain("const block = openBlockOf(text);");
    // What is rescued is incomplete, so it never goes near a file that already exists — not even
    // under a different name. A half-written duplicate beside a working file is worse than nothing:
    // the next turn gets two candidates and the ledger advertises the wrong one.
    expect(body).toContain("if (held?.exists) return undefined;");
    // Comments stripped: the note explaining WHY the -part2 scheme was wrong obviously mentions it.
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code, "a rescue must never write a second copy of an existing file").not.toContain("-part");
    // And it goes in the ledger, which is what the next turn actually reads.
    expect(body).toContain("recordCreatedFile(path, block.body.split");
    // The follow-up turn is TOLD the path — this note is model-facing on purpose, unlike most.
    expect(APP_RAW).toContain('To finish it: read_file "${rescued}"');
    expect(APP_RAW).toContain('"append":true');
  });

  /**
   * "IT JUST GOT STUCK DOING THIS" — `start Flow3`, indefinitely, with no output, no error and no
   * timeout. A launcher returns at once but the program it starts inherits our pipes, and the host
   * reads them to EOF, which never comes. The deadline cannot save it: it kills the launcher while
   * the reader thread is still blocked on a pipe the launched program holds.
   */
  it("never waits on a command that hands a file to another program", () => {
    expect(APP_RAW).toContain("call.detach || launchesAnApp(call.command),");
    // A coding agent hits the same trap with nobody watching to notice.
    expect(APP_RAW).toContain("launchesAnApp(call.command),\n      );");
  });

  /**
   * "STILL CAN'T DOWNLOAD" — on the card for the edit that had just been made.
   *
   * write_file's card carries what it wrote; edit_file's carried only a path. On a linked phone that
   * path is on another machine, so 💾 Download went to a disk it cannot reach and failed, while the
   * file's content — which after an edit is the WHOLE file — was right there in the host that built
   * the card. The two cards had no reason to differ.
   */
  it("puts the edited file on its own card, so a phone can save it", () => {
    const at = APP_RAW.indexOf("const runEditFile");
    const body = APP_RAW.slice(at, APP_RAW.indexOf("const feedback = formatBuddyToolResult(call, { editFile: payload });", at));
    expect(body).toContain("content: r.content,");
    expect(body).toContain("kind: createdFileKind(call.path)");
  });

  it("opens from what the card holds when the disk is on another machine", () => {
    // The path is still preferred on the DESKTOP — it opens the real file with its real handling,
    // not a copy rebuilt from the card.
    expect(APP_RAW).toContain(
      "if (ref.path && !(isRemoteClient && (ref.bytes || ref.content !== undefined))) void onOpenLocalFile(ref.path);",
    );
    expect(APP_RAW).toContain(
      "if (ref.path && !(isRemoteClient && (ref.bytes || ref.content !== undefined))) void readLocalFile(ref.path).then((f) => onUpload(f, as));",
    );
  });

  /**
   * "CAN YOU ADD A WAY TO ASK IT TO OPEN THE FILECARD IN CHAT?"
   *
   * A card is how a file becomes usable from a phone — Download, Open in app, Read here — and cards
   * only ever appeared as a side effect of the assistant WRITING something. A file written earlier,
   * or one whose card had scrolled away, could not be got back at all: the reader could see it named
   * in the file ledger and had no way to ask for it.
   */
  it("can put a file card back in the chat on demand", () => {
    const SLASH = readFileSync(join(__dirname, "../../../packages/core/src/chat/slash-commands.ts"), "utf8");
    expect(SLASH).toContain("export const SHOW_FILE_COMMAND");
    expect(SLASH).toContain("[FIND_FILES_COMMAND, SHOW_FILE_COMMAND]");
    // MAIN-THREAD, like /find and /code — the file is on disk and the reader has named it, so the
    // model's cooperation is not a dependency.
    expect(APP_RAW).toMatch(/const show = \/\^\\\/show/);
    expect(APP_RAW).toContain("const found = await readWorkspaceFile(rel, workspaceDirNow());");
    // The card CARRIES the file, because the device asking is the one whose disk this is not.
    const at = APP_RAW.indexOf("const show = /^\\/show");
    const body = APP_RAW.slice(at, APP_RAW.indexOf("// `/find` is a MAIN-THREAD command", at));
    expect(body).toContain("content: found.text,");
    expect(body).toContain("No file called");
  });

  /**
   * "IT JUST TRIES TO WRITE IT ALL IN ONE GO." The reader's own diagnosis, and the fix they chose:
   * the app refuses, rather than the prompt asking again.
   */
  it("refuses to replace an existing code file wholesale, before writing anything", () => {
    expect(APP_RAW).toContain("const refusal =");
    expect(APP_RAW).toContain("wholeFileRewriteRefusal({");
    // Checked BEFORE the write — a refusal must leave the file on disk exactly as it was.
    const at = APP_RAW.indexOf("const runWriteFile");
    const body = APP_RAW.slice(at, APP_RAW.indexOf("let payload: {", at));
    expect(body).toContain("const held = await readWorkspaceFile(path, dirNow)");
    expect(body.indexOf("wholeFileRewriteRefusal")).toBeGreaterThan(-1);
    expect(body, "the guard must sit ahead of writeWorkspaceFile").not.toContain("await writeWorkspaceFile(");
    // The model is handed the reason, not just a wall.
    expect(APP_RAW).toContain("turns: [...pre, { role: \"user\", content: refusal }],");
  });

  /**
   * "IS IT GOOD AT KNOWING WHERE THE PREVIOUS CHUNK STOPPED?" It had nothing to go on.
   *
   * Appending was a byte concatenation and the feedback said only "APPENDED this chunk" — no line
   * count, no tail, no check on the join. So a model writing a file in pieces continued from its own
   * memory of what it had emitted, which is what is unreliable after a reply ran out mid-file and may
   * not be in context at all once history has been trimmed.
   */
  it("stitches an appended chunk and says where the file now ends", () => {
    expect(APP_RAW).toContain("const join = call.append && held?.exists ? joinAppendedChunk(held.text, call.content) : undefined;");
    expect(APP_RAW).toContain("const content = join ? join.chunk : call.content;");
    // The anchor is read BACK off disk, so an append that partly failed is not reported as whole.
    expect(APP_RAW).toContain("const after = call.append ? await readWorkspaceFile(path, dirNow)");
    expect(APP_RAW).toContain("tail: fileTail(after.text)");
    const TOOLS = readFileSync(join(__dirname, "../../../packages/core/src/chat/buddy-tools.ts"), "utf8");
    expect(TOOLS).toContain("It currently ENDS with:");
    expect(TOOLS).toContain("Continue from exactly there");
    // A silent trim would be a worse bug than the one it fixes.
    expect(TOOLS).toContain("were ALREADY on disk and were dropped");
  });

  /**
   * "IF WE CAN'T GET IT TO RELIABLY USE CODEX WE NEED TO AT LEAST GIVE IT DECENT CODING MANAGEMENT."
   *
   * Every real harness verifies after it edits — Aider lints and hands the errors straight back. One
   * run in the wild did it by hand here, extracting a page's <script> and putting it through Node's
   * parser, and found the split literal that had killed the entire page. That was the model on a good
   * day. Without it, a file broken by an edit is not discovered until the reader opens it.
   */
  it("checks that the file still parses after it writes or edits one", () => {
    expect(APP_RAW).toContain("const verifySource = useCallback");
    expect(APP_RAW).toContain('formatBuddyToolResult(call, { writeFile: payload }) + verified');
    expect(APP_RAW).toContain('formatBuddyToolResult(call, { editFile: payload }) + verified');
    // An APPEND is exempt: a chunk in the middle of a file is expected not to parse, and crying
    // breakage every time would train the model to ignore the one message that matters.
    expect(APP_RAW).toContain("payload.ok && !call.append ? await verifySource(path, call.content)");
    // The edit path checks what is actually on disk after the edit, not the pre-edit text.
    expect(APP_RAW).toContain("await verifySource(call.path, editedText)");
  });

  it("never runs the file it is checking", () => {
    const SC = readFileSync(join(__dirname, "../../../packages/core/src/chat/syntax-check.ts"), "utf8");
    // --check parses, ast.parse builds a tree, new Function compiles a body without calling it. A
    // check that ran the file would be a far worse idea than no check.
    expect(SC).toContain("--check");
    expect(SC).toContain("ast.parse");
    expect(SC).not.toContain("eval(");
  });

  it("does not grow a folder for a chat that only ever talks", () => {
    // The per-turn reads (project guide, plan file check) use the NON-creating lookup.
    expect(APP_RAW).toContain("const workspaceDirNow = useCallback");
    expect(APP_RAW).not.toMatch(/const guideDir = await workspaceForWrite\(\)/);
  });
});

/**
 * WHAT IT MAKES, IT SAVES.
 *
 * The assistant wrote an HTML page, the reader worked on it and improved it — and nothing was ever
 * on disk. `open_code` and a pasted HTML page opened a code window and persisted to the library, and
 * that was the whole of it. The source existed only inside the browser's own database, so once the
 * conversation scrolled past the code block the work was gone from every place either of them could
 * look: not in the chat, not in the file ledger, not in the workspace, not readable by read_file.
 *
 * Three separate holes led to the same place, and all three are gated here.
 */
describe("everything created lands in the workspace", () => {
  const IMPORT = readFileSync(join(__dirname, "import-file.ts"), "utf8");

  it("saves a code book to disk the moment it opens, however it was made", () => {
    expect(APP_RAW).toContain("const saveCodeToWorkspace = useCallback");
    // open_code / a pasted HTML page arriving from the worker.
    expect(APP_RAW).toContain('if (e.book.contentMode === "code") void saveCodeToWorkspace(e.book, codeSourceOf(e.book), { onlyIfMissing: true });');
    // The reader's own paste, through the paste modal.
    expect(APP_RAW).toContain('if (created.contentMode === "code") void saveCodeToWorkspace(created, text, { onlyIfMissing: true });');
    // An uploaded source file.
    expect(APP_RAW).toContain('saveCodeToWorkspaceRef.current(imported.book, imported.book.code ?? "");');
  });

  it("never lets OPENING a book overwrite a newer file on disk", () => {
    // The library copy goes stale as soon as the assistant edits the file with the code window shut;
    // re-opening the book would then push that stale copy back over the newer source.
    expect(APP_RAW).toContain("if (opts?.onlyIfMissing && isDesktop && !isRemoteClient) {");
    expect(APP_RAW).toContain("if (held?.exists && held.text.trim()) {");
  });

  it("stops gating the code window's disk write on command access", () => {
    // Saving a file into the app's OWN workspace folder is not "running a command"; gating it there
    // meant a reader with commands off edited code that never existed outside the browser.
    expect(APP_RAW).not.toMatch(/isRemoteClient\) && settings\.allowCommands\) \{\s*void execHostTool\(\{ tool: "write_file"/);
    expect(APP_RAW).toContain("void saveCodeToWorkspace(b, text);");
  });

  it("gives the saved file a real name, so it can be sorted, run and opened", () => {
    // "Solar System Page" used to become `Solar_System_Page` — no extension at all.
    expect(APP_RAW).toContain("workspacePathFor(codeFileNameFor(b.title, b.language))");
    expect(APP_RAW).not.toMatch(/replace\(\/\[\^\\w\.-\]\+\/g, "_"\)/);
  });

  it("keeps the SOURCE of an uploaded code file instead of stripping it to prose", () => {
    // `.html` routed to the reader, which runs htmlToText — so handing back a page the assistant had
    // just written showed it the rendered text with every tag gone.
    expect(IMPORT).toContain("if (CODE_EXTS.has(e)) return \"code\";");
    expect(IMPORT).toMatch(/const CODE_EXTS: ReadonlySet<string> = new Set\(\[\s*"html",/);
    expect(IMPORT).toContain('return { kind: "book", book: bookFromCode(title, await file.text(), ext) };');
    // The reader can still import a saved article as prose deliberately.
    expect(IMPORT).toContain('{ id: "code", label: "⟨⟩ Code / source file" }');
    // …but `auto` must no longer send html down the reader route.
    expect(IMPORT).not.toMatch(/e === "rtf" \|\| e === "html"/);
  });

  it("relays a phone's write into the same folder, sorted the same way", () => {
    expect(APP_RAW).toContain("const dir = cwdOverride || workspaceDirNow();");
    expect(APP_RAW).toContain("await writeWorkspaceFile(workspacePathFor(call.path), call.content, dir, call.append)");
  });
});

/**
 * TWO FAILURES A LINKED PHONE HITS AND A DESKTOP NEVER DOES.
 */
describe("file cards on a linked phone", () => {
  it("saves the text the card is holding instead of going to the desktop's disk for it", () => {
    // Every file the assistant writes produces a card carrying BOTH the text and the path it was
    // saved to. The path was tried first, so Download went to disk for text already in hand — and on
    // a phone that disk is on another machine, so it failed with "Desktop bridge unavailable" while
    // the content sat right there in the card.
    const order = APP_RAW.indexOf("const data: Uint8Array | string = ref.bytes");
    expect(order, "the download handler's source order changed shape").toBeGreaterThan(-1);
    const block = APP_RAW.slice(order, order + 400);
    expect(block.indexOf("ref.content !== undefined")).toBeLessThan(block.indexOf("ref.path"));
    // An APPENDED file deliberately carries no content, and a found PC file only a path, so the disk
    // read has to survive as the fallback.
    expect(block).toContain("readLocalFile(ref.path)");
  });

  it("says where a file it cannot reach actually is", () => {
    expect(APP_RAW).toContain("isRemoteClient && ref.path");
    expect(APP_RAW).toContain("lives on the desktop");
  });
});

/**
 * A menu that opens BEHIND the message below it.
 */
describe("the file card's More menu escapes its bubble", () => {
  const CSS = readFileSync(join(__dirname, "../../../packages/ui/src/styles/components.css"), "utf8");

  /**
   * RAISING THE BUBBLE WAS NOT ENOUGH, and it was reported again after it shipped.
   *
   * Every bubble sets backdrop-filter, which creates a stacking context, so an absolutely-positioned
   * panel can only ever compete inside its own bubble. `:has(details[open])` lifted the whole bubble
   * and still lost — which is the point at which the answer stops being a z-index. The menu is now
   * PORTALLED to document.body, where there is no ancestor context left to be trapped by. The CSS
   * rule stays for the other disclosures that live inside a bubble.
   */
  it("portals the menu out of the bubble entirely", () => {
    const PANEL = readFileSync(join(__dirname, "../../../packages/ui/src/ChatPanel.tsx"), "utf8");
    expect(PANEL).toContain("<AnchoredMenu label=\"⋯ More\"");
    // The old absolute panel must be gone, or it is still the thing being rendered.
    expect(PANEL, "the file menu must not position itself inside the bubble").not.toContain("const fileMenuStyle");
    const MENU = readFileSync(join(__dirname, "../../../packages/ui/src/AnchoredMenu.tsx"), "utf8");
    expect(MENU).toContain("createPortal");
  });

  it("still raises the bubble for the disclosures that remain inside one", () => {
    expect(CSS).toContain(".vr-msg:has(details[open])");
    expect(CSS).toMatch(/\.vr-msg:has\(details\[open\]\)\s*\{[^}]*z-index:\s*30/);
  });

  it("raises it ONLY while the menu is open", () => {
    // A bubble permanently lifted above its neighbours would win every other overlap too.
    expect(CSS).not.toMatch(/^\.vr-msg\s*\{[^}]*z-index:/m);
  });
});

/**
 * `/code` runs the agent with NO model turn in front of it.
 */
describe("forcing a job through the external coding agent", () => {
  it("intercepts on the main thread and calls the runner directly", () => {
    expect(APP_RAW).toMatch(/const code = \/\^\\\/code/);
    expect(APP_RAW).toContain('await runDelegateCodingTask({ tool: "delegate_coding_task", task: code[1]!.trim() });');
  });

  it("is intercepted BEFORE anything that would start a model turn", () => {
    // If the worker saw it first, the model would be back in the loop — the thing being removed.
    const codeAt = APP_RAW.indexOf("const code = /^\\/code");
    const findAt = APP_RAW.indexOf("const find = /^\\/find");
    expect(codeAt).toBeGreaterThan(-1);
    expect(codeAt).toBeLessThan(findAt);
  });

  it("offers the command only where the agent can run", () => {
    expect(APP_RAW).toContain("...(isDesktop && settings.delegateCoding ? { canDelegateCoding: true } : {}),");
  });
});
