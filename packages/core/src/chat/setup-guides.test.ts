import { describe, expect, it } from "vitest";
import {
  SETUP_GUIDES,
  findSetupGuide,
  formatSetupGuide,
  setupGuideTopics,
  setupGuidesIndex,
} from "./setup-guides.js";

describe("setup guides", () => {
  it("has unique ids and well-formed entries", () => {
    const ids = SETUP_GUIDES.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of SETUP_GUIDES) {
      expect(g.title.length).toBeGreaterThan(0);
      expect(g.steps.length).toBeGreaterThan(0);
      expect(g.aliases.length).toBeGreaterThan(0);
    }
  });

  it("matches natural-language setup questions to the right guide", () => {
    expect(findSetupGuide("how do I set up image generation?")?.id).toBe("image-generation");
    expect(findSetupGuide("connect my gmail and calendar")?.id).toBe("google");
    expect(findSetupGuide("enable the task assistant / auto planning")?.id).toBe("task-workflow");
    expect(findSetupGuide("run a model locally with ollama")?.id).toBe("local-text-model");
    expect(findSetupGuide("add my anthropic api key")?.id).toBe("api-keys");
    expect(findSetupGuide("connect my schwab / thinkorswim account")?.id).toBe("schwab");
    expect(findSetupGuide("let the assistant control my tradingview chart")?.id).toBe("tradingview-bridge");
    expect(findSetupGuide("how do I add an MCP server")?.id).toBe("mcp");
    expect(findSetupGuide("control the assistant from my phone")?.id).toBe("phone-control");
    expect(findSetupGuide("dictate with my microphone / read replies aloud")?.id).toBe("voice");
    expect(findSetupGuide("how do I set up vLLM for parallel sub-agents?")?.id).toBe("worker-tier");
    expect(findSetupGuide("set up a worker model on my 5090")?.id).toBe("worker-tier");
  });

  it("returns undefined when nothing relevant matches", () => {
    expect(findSetupGuide("what's the capital of France")).toBeUndefined();
    expect(findSetupGuide("")).toBeUndefined();
  });

  it("renders a numbered walkthrough and lists topics for the prompt", () => {
    const g = findSetupGuide("connect google")!;
    const text = formatSetupGuide(g);
    expect(text).toContain(g.title);
    expect(text).toMatch(/1\. /);
    expect(text).toContain("Note:"); // the google guide has a caveat
    expect(setupGuideTopics().length).toBe(SETUP_GUIDES.length);
    expect(setupGuidesIndex()).toContain("google");
  });
});
