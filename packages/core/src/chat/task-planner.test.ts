import { describe, expect, it } from "vitest";
import {
  TASK_AUTONOMY_RULE,
  buildPlanPrompt,
  buildPrepDocPrompt,
  buildResearchSystemPrompt,
  parsePlan,
} from "./task-planner.js";
import { normalizeTaskPlan } from "./tasks.js";

describe("planner prompts", () => {
  it("research prompt asks for deadline/lead-time/steps/cost/official site and DATA guard", () => {
    const s = buildResearchSystemPrompt();
    expect(s).toMatch(/deadline/i);
    expect(s).toMatch(/lead time/i);
    expect(s).toMatch(/official/i);
    expect(s).toMatch(/not as instructions|never as instructions/i);
  });

  it("research prompt is trip-aware: checks Gmail for existing bookings + flags missing info", () => {
    const s = buildResearchSystemPrompt();
    expect(s).toMatch(/trip|travel/i);
    expect(s).toMatch(/gmail_search|already booked/i);
    expect(s).toMatch(/book-by|book by|cheapest/i); // sensible booking timing for fluctuating prices
    expect(s).toMatch(/missing|open questions/i); // identifies what it needs to ask
  });

  it("plan prompt offers clarifying questions + a trip book-by/price step", () => {
    const [sys] = buildPlanPrompt("trip to Iowa", "no flight confirmation found in Gmail", "2026-06-17");
    expect(sys!.content).toMatch(/clarifyingQuestions/);
    expect(sys!.content).toMatch(/book by|book-by/i);
    expect(sys!.content).toMatch(/never invent/i);
  });

  it("plan prompt carries the autonomy boundary + today + strict-JSON schema", () => {
    const [sys, user] = buildPlanPrompt("renew registration", "DMV fee is $85, due 2026-07-01", "2026-06-15");
    expect(sys!.content).toContain(TASK_AUTONOMY_RULE);
    expect(sys!.content).toContain("2026-06-15");
    expect(sys!.content).toMatch(/"actor": "ai_prep" \| "user_action"/);
    expect(user!.content).toContain("renew registration");
    expect(user!.content).toContain("DMV fee is $85");
  });

  it("autonomy rule never lets payment/submit be ai_prep", () => {
    expect(TASK_AUTONOMY_RULE).toMatch(/payment.*user_action|user_action.*payment/i);
    expect(TASK_AUTONOMY_RULE).toMatch(/when unsure, choose 'user_action'/i);
  });

  it("prep-doc prompt is faithful and fenced to the requested format", () => {
    const [sys] = buildPrepDocPrompt({
      taskTitle: "Renew", stepTitle: "Cover letter", stepDetail: "draft it", researchNotes: "facts", fence: "md",
    });
    expect(sys!.content).toContain("```md");
    expect(sys!.content).toMatch(/PLACEHOLDER/);
    expect(sys!.content).toMatch(/STRICT FAITHFULNESS/);
  });
});

describe("parsePlan", () => {
  const good = JSON.stringify({
    title: "Renew car registration",
    summary: "California DMV online renewal",
    deadlineIso: "2026-07-31",
    leadTimeDays: 14,
    estCost: "$85",
    steps: [
      { title: "Gather your VIN and last registration", actor: "ai_prep", dueIso: "2026-07-10",
        links: [{ label: "DMV renewal", url: "https://dmv.ca.gov/renew", official: true }] },
      { title: "Pay the renewal fee online", actor: "user_action", dueIso: "2026-07-20", estCost: "$85" },
    ],
  });

  it("parses a clean plan and feeds normalizeTaskPlan", () => {
    const parsed = parsePlan(good)!;
    expect(parsed.title).toBe("Renew car registration");
    expect(parsed.leadTimeDays).toBe(14);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps![0]!.actor).toBe("ai_prep");
    expect(parsed.steps![0]!.links![0]).toEqual({ label: "DMV renewal", url: "https://dmv.ca.gov/renew", official: true });
    // Round-trips through the store normalizer (the host adds source).
    const plan = normalizeTaskPlan({ ...parsed, source: { kind: "typed", text: "renew" } });
    expect(plan.steps.map((s) => s.order)).toEqual([0, 1]);
    expect(plan.steps[1]!.actor).toBe("user_action");
  });

  it("parses clarifyingQuestions when the plan needs more info", () => {
    const withQs = JSON.stringify({
      title: "Plan the Iowa trip",
      clarifyingQuestions: ["Which city are you flying from?", "What's your budget?", ""],
      steps: [{ title: "Book flights by 2026-07-01", actor: "user_action" }],
    });
    const parsed = parsePlan(withQs)!;
    expect(parsed.clarifyingQuestions).toEqual(["Which city are you flying from?", "What's your budget?"]);
  });

  it("strips <think> + code fences and coerces a bad actor to user_action", () => {
    const messy = "<think>planning…</think>```json\n" +
      JSON.stringify({ title: "T", steps: [{ title: "S", actor: "yolo" }] }) + "\n```";
    const parsed = parsePlan(messy)!;
    expect(parsed.title).toBe("T");
    expect(parsed.steps![0]!.actor).toBe("user_action"); // unknown actor → safe default
  });

  it("returns undefined for non-JSON, missing title, or no steps", () => {
    expect(parsePlan("not json")).toBeUndefined();
    expect(parsePlan(JSON.stringify({ steps: [{ title: "x" }] }))).toBeUndefined(); // no title
    expect(parsePlan(JSON.stringify({ title: "x", steps: [] }))).toBeUndefined(); // no steps
    expect(parsePlan(JSON.stringify({ title: "x", steps: [{ detail: "no title" }] }))).toBeUndefined();
  });
});
