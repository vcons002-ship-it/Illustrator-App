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
