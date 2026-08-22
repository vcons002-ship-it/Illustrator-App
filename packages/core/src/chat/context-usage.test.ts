import { describe, expect, it } from "vitest";
import { approxTokens, compactionBudget, measureContextUsage, shouldAutoCompact, type ContextUsage } from "./context-usage.js";

/**
 * A usage where ALL of the weight is chat history — the case where compacting can obviously help.
 *
 * `segments: []` used to be shorthand for "don't care": only the totals mattered, because
 * `shouldAutoCompact` only read the totals. It reads the segments now, and it has to: compaction can
 * shrink the history and nothing else, so a request that is over budget on its BOOK is a request
 * compaction cannot rescue, and firing it there is the loop the guard exists to break. The fixture
 * has to say which it is.
 */
const usageWith = (approx: number, max: number | undefined): ContextUsage => ({
  segments: [{ key: "history", label: "Chat history", chars: approx * 4 }],
  totalChars: approx * 4,
  approxTokens: approx,
  ...(max ? { maxTokens: max } : {}),
  budgetChars: 0,
});

describe("measureContextUsage", () => {
  it("drops empties, sorts largest-first, and totals + estimates tokens", () => {
    const usage = measureContextUsage(
      [
        { key: "book", label: "Book text", text: "x".repeat(400) },
        { key: "bible", label: "Visual bible", text: "y".repeat(100) },
        { key: "history", label: "Chat history", text: "" }, // dropped
        { key: "message", label: "Your message", text: "z".repeat(40) },
      ],
      { budgetChars: 24_000, maxTokens: 8192 },
    );
    expect(usage.segments.map((s) => s.key)).toEqual(["book", "bible", "message"]);
    expect(usage.totalChars).toBe(540);
    expect(usage.approxTokens).toBe(approxTokens(540)); // ceil(540/4) = 135
    expect(usage.maxTokens).toBe(8192);
    expect(usage.budgetChars).toBe(24_000);
  });

  it("omits maxTokens when the window is unknown", () => {
    const usage = measureContextUsage([{ key: "a", label: "A", text: "hello" }], {
      budgetChars: 1000,
    });
    expect(usage.maxTokens).toBeUndefined();
    expect(usage.segments).toHaveLength(1);
  });
});

describe("shouldAutoCompact", () => {
  it("fires when usage crosses the fraction with enough messages", () => {
    expect(shouldAutoCompact(usageWith(6600, 8192), 12)).toBe(true);
  });

  it("holds while usage is below the fraction", () => {
    expect(shouldAutoCompact(usageWith(4000, 8192), 12)).toBe(false);
  });

  it("holds while the conversation is still short, even when near the limit", () => {
    expect(shouldAutoCompact(usageWith(8000, 8192), 4)).toBe(false);
  });

  it("never fires without a known window", () => {
    expect(shouldAutoCompact(usageWith(9999, undefined), 50)).toBe(false);
    expect(shouldAutoCompact(undefined, 50)).toBe(false);
  });

  it("respects custom fraction + minMessages overrides", () => {
    expect(shouldAutoCompact(usageWith(5000, 8192), 5, { fraction: 0.5, minMessages: 4 })).toBe(true);
    expect(shouldAutoCompact(usageWith(5000, 8192), 3, { fraction: 0.5, minMessages: 4 })).toBe(false);
  });
});

describe("compaction fires when conversation is actually being lost", () => {
  /**
   * "WHY ARE WE EVEN TRIMMING CHAT HISTORY?" — a fair question, and the honest answer is that we
   * should not have been, this often. Auto-compaction exists precisely to summarise a conversation
   * BEFORE trimming destroys it, and it was gated on `approxTokens`, measured on the history that
   * SURVIVED trimming. Trimming holds that figure at or under budget by construction, so it never
   * reached 0.8 of the window and compaction never ran: the donut sat at 44% while earlier turns
   * were being thrown away every single turn.
   */
  it("triggers on REAL loss, not on a trimmed sentence", async () => {
    const { shouldAutoCompact } = await import("./context-usage.js");
    const trimmedLooksFine = {
      segments: [{ key: "history", label: "Chat history", chars: 4_000 }],
      totalChars: 4_000,
      approxTokens: 1_000, // ~3% of the window — nowhere near the 0.8 fraction
      maxTokens: 30_000,
      budgetChars: 12_000,
      inputTokens: 27_000,
      droppedChars: 30_000, // an exchange's worth of a 108,000-character capacity
    };
    expect(shouldAutoCompact(trimmedLooksFine, 12)).toBe(true);
    // Nothing dropped and well under the fraction: still nothing to do.
    const { droppedChars: _drop, ...nothingLost } = trimmedLooksFine;
    expect(shouldAutoCompact(nothingLost, 12)).toBe(false);
    /**
     * A NICK IS NOT A LOSS, and reading it as one is what broke souls and reference photos.
     *
     * Auto-compaction replaces the whole history with a summary. Firing it on the first dropped
     * character meant a chat that had never been compacted was suddenly summarised most turns — and
     * a summary is exactly where two similar characters blur together and a list of physical
     * specifics goes missing. Reported as souls mixing and references losing their subject.
     */
    expect(shouldAutoCompact({ ...trimmedLooksFine, droppedChars: 400 }, 12)).toBe(false);
  });

  it("still needs a real conversation and a known window", async () => {
    const { shouldAutoCompact } = await import("./context-usage.js");
    const lost = { segments: [], totalChars: 1, approxTokens: 1, maxTokens: 30_000, budgetChars: 10, droppedChars: 5_000 };
    // A two-message chat is not worth summarising, however tight the window.
    expect(shouldAutoCompact(lost, 3)).toBe(false);
    // No known window means no basis for any of this.
    const { maxTokens: _max, ...noWindow } = lost;
    expect(shouldAutoCompact(noWindow, 12)).toBe(false);
  });

  it("records what did not fit, and omits the field when everything did", async () => {
    const { measureContextUsage } = await import("./context-usage.js");
    const parts = [{ key: "history", label: "Chat history", text: "abc" }];
    expect(measureContextUsage(parts, { budgetChars: 100, droppedChars: 42 }).droppedChars).toBe(42);
    expect(measureContextUsage(parts, { budgetChars: 100 }).droppedChars).toBeUndefined();
    expect(measureContextUsage(parts, { budgetChars: 100, droppedChars: 0 }).droppedChars).toBeUndefined();
  });
});

describe("how full is 'full'", () => {
  /**
   * "WHY WOULD IT COMPACT HERE AT 54% CONTEXT?" Because 54% was full.
   *
   * The reply's reservation is 40% of a local window, so the request can never reach the window at
   * all: on a 50k-token window the input ceiling is 27k, which displays as 54%. That number is the
   * ceiling, not a halfway point — the chat was completely full and being trimmed every turn to stay
   * there. The same denominator made the 0.8 fraction test unreachable, so on a local model it had
   * never once fired.
   */
  it("measures fullness against what the request can occupy, not the window", async () => {
    const { shouldAutoCompact } = await import("./context-usage.js");
    const atCeiling = {
      // Split the way a real reading session is: a book that compaction cannot touch, and the
      // history that it can.
      segments: [
        { key: "book", label: "Book text", chars: 60_000 },
        { key: "history", label: "Chat history", chars: 48_000 },
      ],
      totalChars: 108_000,
      approxTokens: 27_000, // exactly the input ceiling …
      maxTokens: 50_000, // … which is 54% of the window
      inputTokens: 27_000,
      budgetChars: 75_600,
    };
    expect(shouldAutoCompact(atCeiling, 12)).toBe(true);
    // Against the WINDOW this is 54% — under 0.8, so the old test said "plenty of room" at the
    // exact moment there was none.
    const { inputTokens: _ceiling, ...oldView } = atCeiling;
    expect(shouldAutoCompact(oldView, 12)).toBe(false);
  });

  it("does not fire on a chat that is genuinely half full", async () => {
    const { shouldAutoCompact } = await import("./context-usage.js");
    expect(
      shouldAutoCompact(
        { segments: [], totalChars: 54_000, approxTokens: 13_500, maxTokens: 50_000, inputTokens: 27_000, budgetChars: 75_600 },
        12,
      ),
    ).toBe(false);
  });

  it("carries the ceiling through the measurement", async () => {
    const { measureContextUsage } = await import("./context-usage.js");
    const parts = [{ key: "history", label: "Chat history", text: "abc" }];
    expect(measureContextUsage(parts, { budgetChars: 100, inputTokens: 27_000 }).inputTokens).toBe(27_000);
    expect(measureContextUsage(parts, { budgetChars: 100 }).inputTokens).toBeUndefined();
  });
});

describe("what a compaction may spend and read", () => {
  /**
   * Reported as a chat "compacting with no end". Three faults in one call: a flat 1024-token budget
   * shared with reasoning on a thinking model (so the summary can come back EMPTY), a budget that
   * ignored how much was being compressed, and an input cut with slice(-120_000) — which keeps the
   * tail, and the tail is the part still in the conversation.
   */
  it("leaves room to think on top of the summary, not inside it", async () => {
    const { compactionBudget } = await import("./context-usage.js");
    const b = compactionBudget(80_000, 27_000);
    expect(b.thinkingBudgetChars).toBeGreaterThan(0);
    // The generation has to cover BOTH, or the thinking bound starves the summary instead of
    // protecting it.
    expect(b.maxTokens).toBeGreaterThan(b.thinkingBudgetChars / 4);
  });

  it("scales the summary with what is being compressed, within bounds", async () => {
    const { compactionBudget } = await import("./context-usage.js");
    const small = compactionBudget(8_000, 27_000);
    const large = compactionBudget(400_000, 27_000);
    expect(large.maxTokens).toBeGreaterThan(small.maxTokens);
    // Never so terse it cannot carry decisions and open questions …
    expect(small.maxTokens).toBeGreaterThan(400);
    // … and never so long it becomes a permanent tax on every later prompt, since the brief is
    // injected into all of them.
    expect(large.maxTokens).toBeLessThan(2_100);
  });

  it("reads as much as the model can hold, not a fixed 120k", async () => {
    const { compactionBudget } = await import("./context-usage.js");
    // A big window should read more than a small one.
    expect(compactionBudget(500_000, 100_000).inputCap).toBeGreaterThan(compactionBudget(500_000, 20_000).inputCap);
    // With no known ceiling the old fixed cap stands rather than guessing.
    expect(compactionBudget(500_000).inputCap).toBe(120_000);
  });

  it("cuts the MIDDLE, because the head is the only copy of what was decided", async () => {
    const { boundTranscript } = await import("./context-usage.js");
    const text = `OPENING DECISION${"x".repeat(5_000)}THE LAST THING SAID`;
    const out = boundTranscript(text, 1_000);
    expect(out.length).toBeLessThanOrEqual(1_000);
    expect(out.startsWith("OPENING DECISION"), "the head is what compaction exists to rescue").toBe(true);
    expect(out.endsWith("THE LAST THING SAID"), "the tail is what the reader just said").toBe(true);
    // Announced, so the model does not read the join as continuous.
    expect(out).toContain("not shown");
  });

  it("leaves a transcript that already fits completely alone", async () => {
    const { boundTranscript } = await import("./context-usage.js");
    expect(boundTranscript("short enough", 1_000)).toBe("short enough");
  });
});

/**
 * "THE CURRENT COMPACTING IS STUCK RUNNING WITH NO END."
 *
 * Both of `shouldAutoCompact`'s conditions measure the WHOLE request — book, visual bible,
 * instructions, live documents, history — while compaction can only shrink the history. So a long
 * book with a big bible can hold the request over the line on its own, and then the trigger is true
 * regardless of what compaction does: summarise the entire conversation to nothing and it is still
 * true on the next render. The app destroys the history, re-measures, finds itself over budget, and
 * destroys it again — for as long as the chat is open, at up to two minutes of local generation a
 * round.
 *
 * A trigger its own remedy cannot clear is not a trigger. These are the cases that separate the two.
 */
describe("compaction only fires when compacting would actually help", () => {
  const over = (segments: { key: string; label: string; chars: number }[]): ContextUsage => {
    const totalChars = segments.reduce((n, s) => n + s.chars, 0);
    return { segments, totalChars, approxTokens: approxTokens(totalChars), inputTokens: 27_000, budgetChars: 0 };
  };

  it("holds when the non-chat segments alone are over the line", () => {
    // 100k chars of book = 25k tokens against a 27k ceiling. Compacting the 8k-char history to a
    // brief leaves the request at ~25k tokens: still over 0.8, so this would fire again immediately.
    const bookIsTooBig = over([
      { key: "book", label: "Book text", chars: 100_000 },
      { key: "history", label: "Chat history", chars: 8_000 },
    ]);
    expect(bookIsTooBig.approxTokens).toBeGreaterThan(27_000 * 0.8); // the trigger's condition IS met
    expect(shouldAutoCompact(bookIsTooBig, 20)).toBe(false); // …and compaction still cannot help
  });

  it("fires when the history is the thing that is too big", () => {
    const historyIsTooBig = over([
      { key: "book", label: "Book text", chars: 20_000 },
      { key: "history", label: "Chat history", chars: 80_000 },
    ]);
    expect(shouldAutoCompact(historyIsTooBig, 20)).toBe(true);
  });

  it("holds when there is no history to compact at all", () => {
    expect(shouldAutoCompact(over([{ key: "book", label: "Book text", chars: 110_000 }]), 20)).toBe(false);
  });

  it("holds when real loss is happening but compaction is not the remedy", () => {
    // The loss backstop fires on dropped conversation — but if the drop is happening because the
    // book fills the window, replacing the history with a brief changes nothing about that.
    const losing = { ...over([{ key: "book", label: "Book text", chars: 100_000 }, { key: "history", label: "Chat history", chars: 4_000 }]), droppedChars: 30_000 };
    expect(shouldAutoCompact(losing, 20)).toBe(false);
  });

  it("refuses a compaction that would make the request bigger", () => {
    // A short history compresses to a brief with a 400-token floor — 1,600 characters, which is more
    // than the 600 it replaces. Compaction that grows the request is not compaction.
    const barelyAnyHistory = over([
      { key: "book", label: "Book text", chars: 90_000 },
      { key: "history", label: "Chat history", chars: 600 },
    ]);
    expect(shouldAutoCompact(barelyAnyHistory, 20)).toBe(false);
  });
});

/**
 * The brief is injected into EVERY later prompt, and the transcript it reads has to fit the same
 * window that is already too small. Both bounds were absolutes with no reference to the model.
 */
describe("compactionBudget scales to the model, not just the transcript", () => {
  it("never asks to read more than the model can hold", () => {
    // The old `Math.max(20_000, …)` floor: a floor above a ceiling is not a floor. On an 8k-token
    // window it sent 20,000 characters — 5,000 tokens of transcript plus the brief plus the
    // reasoning — into a call made BECAUSE the conversation was already too big.
    const tiny = compactionBudget(400_000, 8_000);
    expect(approxTokens(tiny.inputCap) + tiny.maxTokens).toBeLessThanOrEqual(8_000);
  });

  it("shrinks the brief before it shrinks the transcript on a small window", () => {
    const tiny = compactionBudget(400_000, 8_000);
    const roomy = compactionBudget(400_000, 100_000);
    expect(tiny.summaryTokens).toBeLessThan(roomy.summaryTokens);
    // …and it stays large enough to carry decisions, names and open questions.
    expect(tiny.summaryTokens).toBeGreaterThanOrEqual(150);
  });

  it("keeps the brief to a share of the window, so it cannot out-cost what it evicted", () => {
    for (const ceiling of [4_000, 8_000, 27_000, 120_000]) {
      const b = compactionBudget(400_000, ceiling);
      expect(b.summaryTokens).toBeLessThanOrEqual(Math.max(150, ceiling * 0.15));
    }
  });

  it("still reports a reasoning bound, since the summary call is where it was silently dropped", () => {
    expect(compactionBudget(50_000, 27_000).thinkingBudgetChars).toBeGreaterThan(0);
    // The generation has to cover the reasoning AS WELL AS the brief, or the bound starves the
    // summary rather than protecting it.
    const b = compactionBudget(50_000, 27_000);
    expect(b.maxTokens).toBeGreaterThan(b.summaryTokens);
  });
});
