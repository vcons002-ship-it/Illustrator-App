import { describe, expect, it } from "vitest";
import type { ChatTurn } from "../providers/llm/chat.js";
import {
  buildSkillProposalPrompt,
  isDuplicateSkill,
  parseSkillProposal,
  runSkillProposal,
  worthLearning,
} from "./skill-proposal.js";

describe("isDuplicateSkill", () => {
  const existing = [{ name: "compare-stocks", description: "weigh two tickers by risk-reward" }];
  it("flags same name or strong topic overlap, allows genuinely new skills", () => {
    expect(isDuplicateSkill({ name: "compare-stocks", description: "x" }, existing)).toBe(true); // same name
    expect(isDuplicateSkill({ name: "stock-comparison", description: "compare tickers on risk reward" }, existing)).toBe(true); // overlap
    expect(isDuplicateSkill({ name: "draw-flowchart", description: "make a process diagram" }, existing)).toBe(false);
    expect(isDuplicateSkill({ name: "x", description: "y" }, [])).toBe(false);
  });
});

describe("worthLearning", () => {
  it("needs at least two successful tool steps", () => {
    expect(worthLearning([])).toBe(false);
    expect(worthLearning([{ result: {} }])).toBe(false);
    expect(worthLearning([{ result: {} }, { result: { error: "x" } }])).toBe(false);
    expect(worthLearning([{ result: {} }, { result: {} }])).toBe(true);
  });
});

describe("buildSkillProposalPrompt", () => {
  it("includes the goal + transcript and asks for JSON or skip", () => {
    const transcript: ChatTurn[] = [
      { role: "assistant", content: "searched" },
      { role: "user", content: "[search_web …]" },
    ];
    const msgs = buildSkillProposalPrompt("compare two stocks", transcript);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toMatch(/skip/i);
    expect(msgs[1]!.content).toContain("compare two stocks");
    expect(msgs[1]!.content).toContain("searched");
  });
});

describe("parseSkillProposal", () => {
  it("parses a valid proposal (and strips think + fences)", () => {
    const raw = '<think>hmm</think>```json\n{"name":"Compare Stocks","description":"when asked to weigh two tickers","body":"1. quote both\\n2. compare"}\n```';
    expect(parseSkillProposal(raw)).toEqual({
      name: "Compare Stocks",
      description: "when asked to weigh two tickers",
      body: "1. quote both\n2. compare",
    });
  });

  it("returns undefined on skip, malformed, or empty", () => {
    expect(parseSkillProposal('{"skip":true}')).toBeUndefined();
    expect(parseSkillProposal("not json")).toBeUndefined();
    expect(parseSkillProposal('{"name":"x"}')).toBeUndefined();
    expect(parseSkillProposal('{"name":"","body":"steps"}')).toBeUndefined();
  });
});

describe("runSkillProposal", () => {
  it("returns the parsed candidate from the model reply", async () => {
    const llm = { chat: () => Promise.resolve('{"name":"do-x","description":"when x","body":"steps"}') };
    const candidate = await runSkillProposal(llm, { goal: "x", transcript: [] });
    expect(candidate).toMatchObject({ name: "do-x", description: "when x" });
  });

  it("returns undefined when the model declines", async () => {
    const llm = { chat: () => Promise.resolve('{"skip":true}') };
    expect(await runSkillProposal(llm, { goal: "x", transcript: [] })).toBeUndefined();
  });
});
