import { describe, expect, it } from "vitest";
import { buildDelegatePrompt } from "./subagent.js";

describe("buildDelegatePrompt", () => {
  it("embeds the task and constrains the sub-agent to read-only tools", () => {
    const p = buildDelegatePrompt("  find the 3 biggest EU photonics firms  ");
    expect(p).toContain("SUBTASK: find the 3 biggest EU photonics firms");
    expect(p).toMatch(/read-only/i);
    expect(p).toMatch(/do not change settings/i);
  });
});
