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

  it("story 'as you go' is started by the click path (/story), not a model tool", () => {
    const r = parseBuddySlashCommand("/story A keeper finds a bottle at dawn.", []);
    expect(r).toMatchObject({ call: { tool: "start_story" } });
    // ...and start_story is never advertised to the model, while continuation appears once open.
    const idle = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(idle).not.toContain('"tool":"start_story"');
    const open = buildBuddySystemPrompt({ persona: "assistant", library: [], storyActive: true });
    expect(open).toContain('"tool":"continue_story"');
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
