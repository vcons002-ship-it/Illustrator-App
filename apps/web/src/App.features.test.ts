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
    expect(APP_RAW).toContain("await writeWorkspaceFile(path, call.content, await workspaceForWrite(), call.append)");
  });

  it("ledgers and reports the SAME relative path it wrote, not the absolute one", () => {
    // The ledger is the model's durable pointer to its own work; an absolute path there is a
    // pointer it cannot follow, because read_file/edit_file resolve against the chat's folder.
    expect(APP_RAW).toMatch(/recordCreatedFile\(path, call\.content/);
    expect(APP_RAW).toContain("payload = { path, ok: true };");
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
