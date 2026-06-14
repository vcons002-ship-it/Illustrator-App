import { describe, expect, it } from "vitest";
import {
  POLISH_PRESETS,
  POLISH_CHAT_GUIDANCE,
  MAX_POLISH_INPUT_CHARS,
  buildPolishInstruction,
  buildUnderstandPrompt,
  buildProducePrompt,
  parseUnderstanding,
} from "./document-polish.js";

describe("POLISH_PRESETS", () => {
  it("has four presets with unique ids and non-empty directives", () => {
    expect(POLISH_PRESETS).toHaveLength(4);
    const ids = POLISH_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(4);
    for (const p of POLISH_PRESETS) {
      expect(p.label.trim()).not.toBe("");
      expect(p.directive.trim().length).toBeGreaterThan(10);
    }
  });
});

describe("buildPolishInstruction", () => {
  it("uses the preset directive alone when there's no free-text", () => {
    const out = buildPolishInstruction({ mode: "summarize", freeText: "" });
    expect(out).toContain("SUMMARY");
    expect(out).not.toContain("Additional instructions");
  });

  it("layers free-text on as subordinate to the faithfulness rules", () => {
    const out = buildPolishInstruction({ mode: "proofread", freeText: "keep British spelling" });
    expect(out).toContain("PROOFREAD");
    expect(out).toContain("Additional instructions");
    expect(out).toContain("keep British spelling");
    expect(out).toMatch(/NEVER at the cost/i);
  });

  it("works with free-text only (no preset)", () => {
    const out = buildPolishInstruction({ freeText: "turn this into FAQ form" });
    expect(out).toContain("turn this into FAQ form");
  });
});

describe("buildUnderstandPrompt / buildProducePrompt", () => {
  const source = "The trial ran for 12 weeks with 48 participants.";

  it("understand returns [system,user] with faithfulness markers and a JSON contract", () => {
    const msgs = buildUnderstandPrompt({ mode: "summarize", freeText: "", source });
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
    expect(msgs[0]!.content).toMatch(/ONLY information/i);
    expect(msgs[0]!.content).toMatch(/MUST NOT add/i);
    expect(msgs[0]!.content).toContain('"plan"');
    expect(msgs[0]!.content).toContain('"question"');
    expect(msgs[1]!.content).toContain(source);
  });

  it("produce carries the confirmed plan and says output only the text", () => {
    const msgs = buildProducePrompt({ mode: "condense", freeText: "", source, confirmedPlan: "Half-length summary" });
    expect(msgs[0]!.content).toMatch(/ONLY the reworked document text/i);
    expect(msgs[1]!.content).toContain("Half-length summary");
    expect(msgs[1]!.content).toContain(source);
  });

  it("bounds the source to the model budget, keeping the START of the document", () => {
    const big = "START_MARKER " + "x".repeat(MAX_POLISH_INPUT_CHARS) + " END_MARKER";
    const user = buildProducePrompt({ freeText: "", source: big, confirmedPlan: "" })[1]!.content;
    expect(user).toContain("START_MARKER");
    expect(user).not.toContain("END_MARKER");
    // The whole user message stays near the cap (instruction + capped source).
    expect(user.length).toBeLessThan(MAX_POLISH_INPUT_CHARS + 2000);
  });
});

describe("parseUnderstanding", () => {
  it("parses a clean JSON object", () => {
    expect(parseUnderstanding('{"plan":"One-paragraph summary","question":""}')).toEqual({
      plan: "One-paragraph summary",
      question: "",
    });
  });

  it("strips a <think> preamble before parsing", () => {
    const raw = '<think>let me plan</think>{"plan":"Tighten it","question":"Formal or casual?"}';
    expect(parseUnderstanding(raw)).toEqual({ plan: "Tighten it", question: "Formal or casual?" });
  });

  it("unwraps a fenced JSON block", () => {
    expect(parseUnderstanding('```json\n{"plan":"P","question":""}\n```').plan).toBe("P");
  });

  it("falls back to treating non-JSON prose as the plan", () => {
    expect(parseUnderstanding("I'll write a short faithful summary.")).toEqual({
      plan: "I'll write a short faithful summary.",
      question: "",
    });
  });
});

describe("POLISH_CHAT_GUIDANCE", () => {
  it("carries the faithfulness wording and the saveable-fence instruction (shared with the panel)", () => {
    expect(POLISH_CHAT_GUIDANCE).toMatch(/faithfully/i);
    expect(POLISH_CHAT_GUIDANCE).toMatch(/never add facts/i);
    expect(POLISH_CHAT_GUIDANCE).toMatch(/```md/);
  });
});
