import { describe, expect, it } from "vitest";
import { approxTokens, measureContextUsage, shouldAutoCompact, type ContextUsage } from "./context-usage.js";

const usageWith = (approx: number, max: number | undefined): ContextUsage => ({
  segments: [],
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
      segments: [],
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
      segments: [],
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
