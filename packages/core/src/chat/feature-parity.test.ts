import { describe, expect, it } from "vitest";
import { TOOL_INVENTORY, keptTools, consolidatedTools, capabilityAreas } from "./tool-inventory.js";
import { buildBuddySystemPrompt, parseBuddyToolCall } from "./buddy-tools.js";
import { parseBuddySlashCommand } from "./slash-commands.js";

/**
 * FEATURE-PARITY GUARDRAIL. The simplification shrank the tool surface but must lose NO capability.
 * These tests fail if a capability is dropped-without-replacement: the inventory must stay complete,
 * consolidated tools must still resolve, and the high-value capabilities must still parse end to end.
 */
describe("tool inventory is complete and consistent", () => {
  it("lists every chat tool exactly once (the surface only shrank, nothing was deleted)", () => {
    const names = TOOL_INVENTORY.map((e) => e.tool);
    expect(new Set(names).size).toBe(names.length); // no duplicates
    // A frozen lower bound: removing a tool entry (a capability) without recording its disposition fails.
    expect(names.length).toBeGreaterThanOrEqual(71);
  });

  it("every consolidated/relocated tool points at a surviving path", () => {
    const kept = new Set(keptTools());
    for (const { tool, via } of consolidatedTools()) {
      expect(tool).toBeTruthy();
      // A merge target is itself a kept tool; a click target names where it now lives.
      expect(kept.has(via) || /Story|Open Book|click|\//.test(via)).toBe(true);
    }
  });

  it("the four merged reader-open tools all route through open_content", () => {
    expect(consolidatedTools().filter((c) => c.via === "open_content").map((c) => c.tool).sort()).toEqual([
      "open_code",
      "open_library_book",
      "open_pasted_text",
      "open_web_text",
    ]);
    expect(keptTools()).toContain("open_content");
  });

  it("the four reader/ingest tools all route through read", () => {
    expect(consolidatedTools().filter((c) => c.via === "read").map((c) => c.tool).sort()).toEqual([
      "read_attachment",
      "read_email",
      "read_file",
      "read_url",
    ]);
    expect(keptTools()).toContain("read");
  });

  it("read normalizes every source to its internal reader shape", () => {
    expect(parseBuddyToolCall('{"tool":"read","source":"url","ref":"https://example.com"}')).toMatchObject({
      tool: "read_url",
      url: "https://example.com",
    });
    expect(parseBuddyToolCall('{"tool":"read","source":"file","ref":"/tmp/a.txt"}')).toMatchObject({
      tool: "read_file",
      path: "/tmp/a.txt",
    });
    expect(parseBuddyToolCall('{"tool":"read","source":"email","ref":"msg-1"}')).toMatchObject({
      tool: "read_email",
      id: "msg-1",
    });
    expect(
      parseBuddyToolCall('{"tool":"read","source":"attachment","ref":"msg-1","attachmentId":"att-1"}'),
    ).toMatchObject({ tool: "read_attachment", messageId: "msg-1", attachmentId: "att-1" });
  });
});

describe("every high-value capability still works end to end", () => {
  // One concrete, valid call per critical capability — each must parse (the protocol still accepts it).
  const fixtures: Record<string, string> = {
    "exact math": '{"tool":"calculate","expression":"2+2"}',
    "web research": '{"tool":"search_web","query":"photonics"}',
    "read a page": '{"tool":"read_url","url":"https://example.com"}',
    "open (library)": '{"tool":"open_content","source":"library","id":"text-1"}',
    "open (web)": '{"tool":"open_content","source":"web","url":"https://example.com/a"}',
    "open (pasted)": '{"tool":"open_content","source":"pasted","text":"Once upon a time"}',
    "open (code)": '{"tool":"open_content","source":"code","text":"const x=1"}',
    "build a spreadsheet": '{"tool":"create_spreadsheet","title":"Budget","columns":[{"name":"Item"}]}',
    "write a document": '{"tool":"create_document","title":"Brief","content":"# Brief\\n\\nHello"}',
    "generate an image": '{"tool":"generate_image","prompt":"an apple"}',
    "create a file (run tool)": '{"tool":"write_file","path":"a.py","content":"print(1)"}',
    "run & test code": '{"tool":"run_command","command":"python a.py"}',
    "story continuation": '{"tool":"continue_story","text":"They pressed on into the dark."}',
    "long-term memory": '{"tool":"remember","note":"prefers watercolor"}',
    "task planning": '{"tool":"plan_task","request":"renew my registration"}',
    "scheduled tasks": '{"tool":"schedule_task","title":"Recap","prompt":"summarise email","rule":"daily","time":"08:00"}',
    "in-chat checklist (chaining)": '{"tool":"set_plan","steps":["write code","run it"]}',
  };

  for (const [capability, json] of Object.entries(fixtures)) {
    it(`${capability} still parses to a valid tool call`, () => {
      expect(parseBuddyToolCall(json)).toBeTruthy();
    });
  }

  it("the context-trimmed tool groups are GATED, not dropped — each reappears under its flag", () => {
    // The simplification gates these behind capability flags to save context in a plain chat; they
    // must still be advertised (capability intact) when the flag is on.
    const plain = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    for (const t of ['"tool":"plan_task"', '"tool":"schedule_task"', '"tool":"spawn_agents"', '"tool":"delegate"', '"tool":"stock_quote"', '"tool":"market_analysis"']) {
      expect(plain).not.toContain(t);
    }
    const task = buildBuddySystemPrompt({ persona: "assistant", library: [], canTaskTools: true });
    expect(task).toContain('"tool":"plan_task"');
    expect(task).toContain('"tool":"schedule_task"');
    const agents = buildBuddySystemPrompt({ persona: "assistant", library: [], canSubAgents: true });
    expect(agents).toContain('"tool":"spawn_agents"');
    expect(agents).toContain('"tool":"delegate"');
    const markets = buildBuddySystemPrompt({ persona: "assistant", library: [], canMarkets: true });
    expect(markets).toContain('"tool":"stock_quote"');
    expect(markets).toContain('"tool":"market_analysis"');
  });

  it("story 'as you go' is started by the click path (/story), and continued by plain prose (no model tools)", () => {
    const r = parseBuddySlashCommand("/story A keeper finds a bottle at dawn.", []);
    expect(r).toMatchObject({ call: { tool: "start_story" } });
    // No story tool is advertised: start is a click, and continuation is a plain prose reply the
    // worker turns into the next beat. Capability is preserved without the model juggling tools.
    const idle = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(idle).not.toContain('"tool":"start_story"');
    const open = buildBuddySystemPrompt({ persona: "assistant", library: [], storyActive: true, storyMode: "direct" });
    expect(open).not.toContain('"tool":"continue_story"');
    expect(open).not.toContain('"tool":"set_story_cadence"');
    expect(open).toMatch(/STORY MODE/);
  });
});

describe("no FEATURES.md capability area was dropped", () => {
  it("covers every advertised capability area", () => {
    // The plain-language capability areas from FEATURES.md — each must still map to a tool/click.
    const required = [
      "web research",
      "find real figures",
      "open to read/illustrate",
      "build a spreadsheet",
      "co-write an illustrated story",
      "generate an image",
      "technical analysis",
      "Schwab account",
      "task planning",
      "scheduled tasks",
      "Gmail",
      "Calendar",
      "find files on the PC",
      "run & test code",
      "MCP servers",
      "long-term memory",
      "reusable skills",
    ];
    const areas = new Set(capabilityAreas());
    for (const area of required) expect(areas.has(area)).toBe(true);
  });
});
