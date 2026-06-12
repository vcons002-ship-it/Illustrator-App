import { describe, expect, it } from "vitest";
import { approxTokens, measureContextUsage } from "./context-usage.js";

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
