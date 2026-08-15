import { describe, expect, it } from "vitest";
import { ROUTING_CASES, regressionCases, scoreRoutingCase } from "./routing-eval.js";
import { BUDDY_TOOL_NAMES, SERIES_SPLIT, buildBuddySystemPrompt, parseBuddyToolCalls, stripToolCallJson } from "./buddy-tools.js";
import { TOOLSET_IDS } from "./toolsets.js";

/**
 * The toolsets the fixture's cases need documented before they can be called.
 *
 * A deferred tool is invisible to a lean prompt, so a case expecting `find_files` against
 * `loadedToolsets: []` measures only whether the model called `load_toolset` first — which is a
 * different decision from the one the case is about. Loading these puts the run in the mid-session
 * state where the confusable pairs are actually distinguishable.
 */
const EVAL_TOOLSETS = ["files"] as const;
// `markets` is deliberately NOT loaded: the `deferred-toolset` case exists to check that the model
// loads before it guesses, and pre-loading it would delete the only case testing that path.

/**
 * THE FIXTURE'S OWN TESTS — these run everywhere, with no model.
 *
 * The scorer is the part that has to be right: a lenient scorer turns the whole eval into a rubber
 * stamp, which is worse than not having one, because it looks like evidence.
 */
describe("scoring a routing case", () => {
  const c = (expectation: Parameters<typeof scoreRoutingCase>[0]["expect"]) => ({
    id: "x", ask: "", because: "", expect: expectation,
  });
  const reply = (over: Partial<{ firstTool: string; tools: string[]; text: string }> = {}) => ({
    tools: [] as string[], text: "", ...over,
  });

  it("passes only the exact tool it asked for", () => {
    expect(scoreRoutingCase(c({ tool: "search_web" }), reply({ firstTool: "search_web", tools: ["search_web"] }), SERIES_SPLIT).pass).toBe(true);
    expect(scoreRoutingCase(c({ tool: "search_web" }), reply({ firstTool: "search_images", tools: ["search_images"] }), SERIES_SPLIT).pass).toBe(false);
  });

  it("treats a tool of null as 'answer in prose', which is a real expectation", () => {
    // Half the conduct rules are "do NOT reach for a tool here". Without this the fixture could only
    // ever test the positive half.
    expect(scoreRoutingCase(c({ tool: null }), reply({ text: "Paris." }), SERIES_SPLIT).pass).toBe(true);
    expect(scoreRoutingCase(c({ tool: null }), reply({ firstTool: "search_web", tools: ["search_web"] }), SERIES_SPLIT).pass).toBe(false);
  });

  it("checks a plan ANYWHERE in the reply, not just first", () => {
    // A model may narrate before planning. The decision under test is "was a checklist made", not
    // "was set_plan the very first token".
    expect(scoreRoutingCase(c({ plan: true }), reply({ firstTool: "search_web", tools: ["search_web", "set_plan"] }), SERIES_SPLIT).pass).toBe(true);
    expect(scoreRoutingCase(c({ plan: false }), reply({ tools: ["set_plan"] }), SERIES_SPLIT).pass).toBe(false);
  });

  it("detects the series marker case-insensitively, as the splitter does", () => {
    expect(scoreRoutingCase(c({ marker: true }), reply({ text: `A\n[[NEXT]]\nB` }), SERIES_SPLIT).pass).toBe(true);
    expect(scoreRoutingCase(c({ marker: false }), reply({ text: `A\n${SERIES_SPLIT}\nB` }), SERIES_SPLIT).pass).toBe(false);
  });

  it("reports WHY, because a bare pass rate cannot be acted on", () => {
    expect(scoreRoutingCase(c({ tool: "calculate" }), reply({ firstTool: "search_web", tools: ["search_web"] }), SERIES_SPLIT).detail)
      .toBe("expected calculate, got search_web");
  });
});

describe("the fixture itself", () => {
  it("covers the decisions rather than one corner of them", () => {
    expect(ROUTING_CASES.length).toBeGreaterThanOrEqual(28);
    // Every case must assert SOMETHING, or it is a case that can never fail.
    for (const c of ROUTING_CASES) {
      const e = c.expect;
      expect(e.tool !== undefined || e.plan !== undefined || e.marker !== undefined, `${c.id} asserts nothing`).toBe(true);
      expect(c.because.length, `${c.id} does not say why it exists`).toBeGreaterThan(20);
    }
  });

  it("has unique ids, so a report can be diffed run to run", () => {
    expect(new Set(ROUTING_CASES.map((c) => c.id)).size).toBe(ROUTING_CASES.length);
  });

  it("keeps the cases that actually broke in production", () => {
    // These are the reason the fixture is worth running: a plausible-looking prompt edit has already
    // been observed to break each one.
    const ids = regressionCases().map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["three-images", "alphabet", "alphabet-backwards", "reader-asks-for-plan", "count-range"]));
  });

  it("asserts both directions on the tools that get confused for each other", () => {
    // A fixture that only tests "draw → generate_image" passes a prompt that ALWAYS says
    // generate_image. The pair is the test, not the case.
    const byId = new Map(ROUTING_CASES.map((c) => [c.id, c]));
    expect(byId.get("show-vs-draw-show")?.expect.tool).toBe("search_images");
    expect(byId.get("show-vs-draw-draw")?.expect.tool).toBe("generate_image");
    expect(byId.get("search-verb-web")?.expect.tool).toBe("search_web");
    expect(byId.get("find-verb-files")?.expect.tool).toBe("find_files");
  });

  it("only ever expects a tool that really exists", () => {
    // Guards against the fixture drifting: a case naming a deleted tool tests nothing and passes
    // forever. Checked against the runtime roster rather than the prompt text, because a tool in a
    // DEFERRED toolset is legitimately absent from a lean prompt — which the first draft of this
    // test got wrong, and which is itself worth knowing: with nothing loaded, `find_files` cannot be
    // called at all until `load_toolset` runs.
    for (const c of ROUTING_CASES) {
      if (typeof c.expect.tool === "string") {
        expect(BUDDY_TOOL_NAMES.has(c.expect.tool as never), `${c.id} expects ${c.expect.tool}, which is not a tool`).toBe(true);
      }
    }
  });

  it("names the toolsets its cases need, so the live run is not testing an unloadable tool", () => {
    // The live runner loads these. Without them half the confusable-pair cases would only ever
    // measure whether the model remembered to call load_toolset first.
    for (const id of EVAL_TOOLSETS) expect(TOOLSET_IDS).toContain(id);
  });
});

/**
 * THE LIVE RUN — skipped unless an endpoint is configured, so this sits in CI without a GPU.
 *
 *   VR_EVAL_URL=http://localhost:11434/v1 VR_EVAL_MODEL=qwen3.6:35b-a3b npx vitest run routing-eval
 *
 * Reports per-case, not just an aggregate: the failures this fixture exists for are precedence
 * failures, and an aggregate hides exactly those. Runs each case once by default (VR_EVAL_N to raise
 * it) because the point is a signal to act on, not a publishable number.
 */
const URL = process.env.VR_EVAL_URL;
const MODEL = process.env.VR_EVAL_MODEL;
const N = Number(process.env.VR_EVAL_N ?? 1);

describe.skipIf(!URL || !MODEL)("routing eval (live)", () => {
  it(
    "reports which decisions the prompt actually gets right",
    async () => {
      const system = buildBuddySystemPrompt({
        persona: "assistant", library: [], canSearchFiles: true, canRunCommands: true, canWolfram: true,
        loadedToolsets: [...EVAL_TOOLSETS],
      } as never);
      const rows: { id: string; passes: number; runs: number; details: string[]; regressed: boolean }[] = [];
      for (const c of ROUTING_CASES) {
        const details: string[] = [];
        let passes = 0;
        for (let i = 0; i < N; i++) {
          const res = await fetch(`${URL}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: MODEL, stream: false,
              messages: [{ role: "system", content: system }, { role: "user", content: c.ask }],
            }),
          });
          const raw = (await res.json()) as { choices?: { message?: { content?: string } }[] };
          const text = raw.choices?.[0]?.message?.content ?? "";
          const calls = parseBuddyToolCalls(text);
          const scored = scoreRoutingCase(
            c,
            { ...(calls[0] ? { firstTool: calls[0].tool } : {}), tools: calls.map((x) => x.tool), text: stripToolCallJson(text) },
            SERIES_SPLIT,
          );
          if (scored.pass) passes++;
          else details.push(scored.detail);
        }
        rows.push({ id: c.id, passes, runs: N, details: [...new Set(details)], regressed: !!c.regressed });
      }
      const failed = rows.filter((r) => r.passes < r.runs);
      console.log(
        `\nROUTING EVAL — ${MODEL}\n` +
          rows.map((r) => `${r.passes === r.runs ? "  ok" : "FAIL"} ${r.regressed ? "!" : " "} ${r.id.padEnd(26)} ${r.passes}/${r.runs} ${r.details.join("; ")}`).join("\n") +
          `\n\n${rows.length - failed.length}/${rows.length} cases pass. ` +
          `Regression set: ${rows.filter((r) => r.regressed && r.passes === r.runs).length}/${rows.filter((r) => r.regressed).length}\n`,
      );
      // Deliberately does NOT assert a pass rate. This is an instrument, not a gate — a threshold
      // here would either be met by loosening it or would block unrelated work. Read the report.
      expect(rows.length).toBe(ROUTING_CASES.length);
    },
    10 * 60 * 1000,
  );
});
