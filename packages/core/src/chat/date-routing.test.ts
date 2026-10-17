import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChatCapable, ChatTurn } from "../providers/llm/chat.js";
import { dateMath, parseDateMathInput, parseDateToken, type DateMathInput } from "./date-math.js";
import { evaluateExpression } from "./calculator.js";
import { evaluateMath } from "./math-engine.js";
import { buildBuddySystemPrompt, buildToolCallFormat, ollamaToolSchemas, parseBuddyToolCall, type BuddyToolCall } from "./buddy-tools.js";
import { CHAT_TOOLS_SYSTEM, parseToolCall } from "./chat-tools.js";
import { runBuddyTurn, runBuddyTool, type BuddyDeps } from "./buddy-session.js";
import { runChatTurn } from "./chat-session.js";
import { allowedInCreativeIdle } from "./tool-approval.js";
import { activeStep, compileWorkflow, evaluateStep, inferDoneWhen, recompileWorkflow, slimStepEvidence, workflowToPlan } from "./workflow.js";

const NOW = new Date(2026, 9, 17, 23, 58);
const CALL = { tool: "date_math", op: "day_number", from: "2026-06-30", to: "tomorrow", startDay: 1 } as const;
const EXPRESSION = "(2026-10-18) - (2026-06-30) + 1";

function replay(replies: string[]): ChatCapable & { calls: ChatTurn[][] } {
  const calls: ChatTurn[][] = [];
  return { calls, async chat(messages) { calls.push([...messages]); return replies[calls.length - 1] ?? "Day 111."; } };
}

describe("calendar regression from the reported Day 111 task", () => {
  it("returns 110 elapsed days and Day 111, not 9 or Day 112", () => {
    expect(dateMath(CALL, NOW)).toMatchObject({ ok: true, from: "2026-06-30", to: "2026-10-18", days: 110, dayNumber: 111 });
    expect(dateMath({ ...CALL, to: "2026-06-30" }, NOW).dayNumber).toBe(1);
    expect(dateMath({ ...CALL, to: "2026-06-29" }, NOW).dayNumber).toBe(0);
    expect(dateMath({ ...CALL, from: "2026-07-28", to: "2026-08-05", startDay: 28 }, NOW).dayNumber).toBe(36);
  });

  it("blocks date subtraction in both math engines without breaking numeric math", async () => {
    expect(() => evaluateExpression(EXPRESSION)).toThrow(/date_math/);
    await expect(evaluateMath(EXPRESSION)).rejects.toThrow(/date_math/);
    expect(evaluateExpression("2026 - 10 - 18")).toBe(1998);
    expect(evaluateExpression("12*(3+4)")).toBe(84);
    expect(await evaluateMath("12*(3+4)")).toBe("84");
  });

  it.each([
    { op: "nonsense", from: "2026-06-30" }, { op: "diff" }, { op: "diff", from: "" },
    { op: "add" }, { op: "add", days: 1.7 }, { op: "add", days: "1" },
    { op: "day_number", from: "2026-06-30" }, { ...CALL, startDay: 1.5 },
  ])("rejects malformed arguments consistently in both chats: %j", (args) => {
    expect(parseDateMathInput(args)).toBeUndefined();
    const json = JSON.stringify({ ...args, tool: "date_math" });
    expect(parseBuddyToolCall(json)).toBeUndefined();
    expect(parseToolCall(json)).toBeUndefined();
  });

  it.each(["2026-10-170", "2026-10-17 garbage", "Junk 28, 2026", "2026-02-29", "2026-07-28T99:99:00Z", "0000-01-01", ""])("rejects malformed date %s", (token) => {
    expect(parseDateToken(token, NOW)).toBeUndefined();
    expect(dateMath({ op: "diff", from: token }, NOW).ok).toBe(false);
  });

  it("validates direct callers too and returns structured failures instead of throwing", () => {
    for (const input of [{ op: "add" }, { op: "add", days: 1.7 }, { op: "add", days: Number.MAX_SAFE_INTEGER },
      { op: "weekday", date: "2026-10-170" }, { op: "nonsense" }, { op: "diff" },
      { op: "day_number", from: "2026-06-30" }, { op: "add", date: "9999-12-31", days: 1 }]) {
      expect(dateMath(input as DateMathInput, NOW).ok).toBe(false);
    }
    expect(dateMath({ op: "weekday", date: "0099-01-01" }, NOW).date).toBe("0099-01-01");
    expect(dateMath({ op: "diff", from: "2024-02-28", to: "2024-03-01" }, NOW).days).toBe(2);
    expect(dateMath({ op: "diff", from: "2026-03-07", to: "2026-03-09" }, NOW).days).toBe(2);
    expect(dateMath({ op: "diff", from: "2026-10-31", to: "2026-11-02" }, NOW).days).toBe(2);
    expect(dateMath({ op: "add", days: 1 }, NOW).date).toBe("2026-10-18");
    expect(dateMath({ op: "weekday", date: "28th July 2026" }, NOW).date).toBe("2026-07-28");
  });

  it("always offers the native schema and grammar, even with no toolsets loaded", () => {
    const schema = ollamaToolSchemas({ loadedToolsets: [] }).find((s) => s.function.name === "date_math");
    expect(schema?.function.parameters.properties.op?.enum).toContain("day_number");
    expect(buildToolCallFormat(["date_math"])).toBeDefined();
    expect(parseBuddyToolCall(JSON.stringify(CALL))).toEqual(CALL);
    expect(parseToolCall(JSON.stringify(CALL))).toEqual(CALL);
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [] })).toContain('"startDay":1');
    expect(CHAT_TOOLS_SYSTEM).toContain('"tool":"date_math"');
  });

  it.each([false, true])("main chat/Creative executes and feeds the exact result back (creative=%s)", async (creativeIdle) => {
    const llm = replay([JSON.stringify(CALL), "The target is Day 111."]);
    const out = await runBuddyTurn({ llm, now: NOW, system: "Use date_math.", history: [{ role: "user", content: "Calculate tomorrow's day number; June 30 is Day 1." }], deps: {} as BuddyDeps, creativeIdle });
    expect(allowedInCreativeIdle(CALL)).toBe(true);
    expect(out.toolResults[0]?.result.dateMath).toMatchObject({ ok: true, days: 110, dayNumber: 111 });
    expect(llm.calls[1]?.some((turn) => turn.content.includes("Day 111"))).toBe(true);
    expect(out.pendingTool).toBeUndefined();
  });

  it("calculator rejection can recover to date_math within the same main-chat turn", async () => {
    const llm = replay([JSON.stringify({ tool: "calculate", expression: EXPRESSION }), JSON.stringify(CALL), "Day 111."]);
    const out = await runBuddyTurn({ llm, now: NOW, system: "Use calendar tools.", history: [{ role: "user", content: "Calculate tomorrow's day number." }], deps: {} as BuddyDeps });
    expect(out.toolResults[0]?.result.error).toMatch(/date_math/);
    expect(out.toolResults[0]?.result.calc).toBeUndefined();
    expect(out.toolResults[1]?.result.dateMath?.dayNumber).toBe(111);
  });

  it("book chat executes the same operation offline with the same local clock", async () => {
    const llm = replay([JSON.stringify(CALL), "Day 111."]);
    const out = await runChatTurn({ llm, now: NOW, system: CHAT_TOOLS_SYSTEM, history: [{ role: "user", content: "Calculate tomorrow's day number." }], tools: {} });
    expect(out.toolResults[0]?.result.dateMath).toMatchObject({ ok: true, dayNumber: 111 });
    expect(llm.calls[0]?.[0]?.content).toContain("Current local calendar date: 2026-10-17");
    expect(llm.calls[1]?.some((turn) => turn.content.includes("Day 111"))).toBe(true);
  });

  it("never ticks the calculation step from prose, ordinary math, missing data, or a failed date tool", async () => {
    const instruction = "Calculate tomorrow's pregnancy day number (relative to June 30, 2026 being Day 1).";
    const plan = { steps: [{ text: instruction, status: "pending" as const, needs: "calculate" }] };
    const wf = compileWorkflow(plan);
    const step = activeStep(wf)!;
    expect(step.doneWhen).toEqual({ kind: "tool_ok", tool: "date_math" });
    expect(inferDoneWhen(instruction)).toEqual(step.doneWhen);
    expect(workflowToPlan(wf).steps[0]?.needs).toBe("date_math");
    expect(activeStep(recompileWorkflow(wf, plan))?.doneWhen).toEqual(step.doneWhen);
    for (const toolResults of [[], [{ call: { tool: "calculate", expression: "1+1" } as BuddyToolCall, result: { calc: { expression: "1+1", result: "2" } } }],
      [{ call: CALL, result: {} }], [{ call: CALL, result: { dateMath: { ok: false, error: "bad date" } } }]]) {
      expect(evaluateStep(step, { toolResults, text: "Day 111, done!" }).done).toBe(false);
    }
    const result = await runBuddyTool(CALL, {} as BuddyDeps, NOW);
    expect(evaluateStep(step, { toolResults: slimStepEvidence([{ call: CALL, result }]), text: "" }).done).toBe(true);
    expect(inferDoneWhen("Create a Google Calendar event for tomorrow")).not.toEqual(step.doneWhen);
    expect(inferDoneWhen("Read documents/reference.md for that day")).not.toEqual(step.doneWhen);
    expect(inferDoneWhen("Calculate the average sales per day")).not.toEqual(step.doneWhen);
    expect(inferDoneWhen("Calculate days from 48 hours")).not.toEqual(step.doneWhen);
  });

  it("retains date results across the worker, linked client, display, and completion evidence", () => {
    const source = (file: string) => readFileSync(`apps/web/src/${file}`, "utf8");
    expect(source("worker-protocol.ts").match(/dateMath\?: BuddyToolResultPayload\["dateMath"\]/g)).toHaveLength(2);
    expect(source("useEngineWorker.ts").match(/dateMath: msg.dateMath/g)).toHaveLength(2);
    expect(source("engine.worker.ts").match(/dateMath: e.result.dateMath/g)).toHaveLength(2);
    expect(source("App.tsx").match(/Date calculation failed:/g)).toHaveLength(2);
    expect(source("App.tsx")).toContain("e.dateMath ? { dateMath: e.dateMath } : {}");
  });
});
