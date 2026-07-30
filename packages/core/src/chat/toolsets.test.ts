import { describe, expect, it } from "vitest";
import {
  ALWAYS_ON_TOOLS,
  TOOLSETS,
  TOOLSET_IDS,
  isToolAvailable,
  toolsetForTool,
  toolsetIndexBlock,
} from "./toolsets.js";
import { buildBuddySystemPrompt, ollamaToolSchemas, toolsetDoc } from "./buddy-tools.js";

/** Everything a fully-equipped desktop can do. */
const FULL = {
  persona: "default" as const,
  library: [],
  now: "Sunday, June 15, 2026, 4:58 PM",
  canSearchFiles: true,
  canRunCommands: true,
  canAutonomousWorkspace: true,
  canGenerateVideo: true,
  canWolfram: true,
  canGithub: true,
  canDelegateCoding: true,
  canDocuments: true,
  canSpreadsheets: true,
  canAppSettings: true,
  canBooks: true,
};
const build = (extra: Record<string, unknown> = {}) =>
  buildBuddySystemPrompt({ ...FULL, ...extra } as unknown as Parameters<typeof buildBuddySystemPrompt>[0]);
const tok = (s: string) => Math.round(s.length / 4);

describe("the registry", () => {
  it("gives every tool at most one home", () => {
    const seen = new Map<string, string>();
    for (const set of TOOLSETS) {
      for (const tool of set.tools) {
        expect(seen.get(tool), `${tool} is in two toolsets`).toBeUndefined();
        seen.set(tool, set.id);
      }
    }
  });

  it("never defers a tool that is meant to be always available", () => {
    // An always-on tool inside a toolset would be withheld until loaded, which defeats the point of
    // it being always-on — the model would have to fetch a manual before it could remember your name.
    for (const tool of ALWAYS_ON_TOOLS) expect(toolsetForTool(tool)).toBeUndefined();
  });

  it("has unique ids", () => {
    expect(new Set(TOOLSET_IDS).size).toBe(TOOLSET_IDS.length);
  });
});

describe("isToolAvailable", () => {
  it("lets an always-on tool through with nothing loaded", () => {
    expect(isToolAvailable("remember", [])).toBe(true);
    expect(isToolAvailable("read", [])).toBe(true);
  });

  it("withholds a deferred tool until its set is loaded", () => {
    expect(isToolAvailable("run_command", [])).toBe(false);
    expect(isToolAvailable("run_command", ["coding"])).toBe(true);
  });

  it("lets an UNKNOWN tool through rather than blocking it", () => {
    // A tool the registry has never heard of (an MCP tool, something new) must not be silently
    // un-callable because it wasn't listed — failing open is right when the list is the thing at risk
    // of being out of date.
    expect(isToolAvailable("some_mcp_tool", [])).toBe(true);
  });
});

describe("the index", () => {
  it("offers only what the environment can actually do", () => {
    const block = toolsetIndexBlock(["coding", "files"], []);
    expect(block).toContain("- coding —");
    expect(block).toContain("- files —");
    expect(block).not.toContain("- video —");
  });

  it("marks what is already loaded, so it isn't fetched twice", () => {
    expect(toolsetIndexBlock(["coding"], ["coding"])).toContain("- coding (loaded) —");
  });

  it("says that guessing is safe", () => {
    // The model must know a forgotten load costs a round-trip, not an error — otherwise it hedges.
    expect(toolsetIndexBlock(["coding"], [])).toMatch(/instructions back rather than an error/);
  });

  it("is empty when there is nothing to offer", () => {
    expect(toolsetIndexBlock([], [])).toBe("");
  });
});

describe("the prompt shrinks", () => {
  it("drops the deferred documentation and adds the index", () => {
    const legacy = build();
    const lean = build({ loadedToolsets: [] });
    expect(tok(lean)).toBeLessThan(tok(legacy) / 2);
    expect(lean).toContain("YOU CAN DO MORE THAN THE TOOLS BELOW");
    expect(lean).not.toContain('"tool":"run_command"');
    expect(lean).not.toContain('"tool":"generate_video"');
  });

  it("keeps the always-on tools and the core policy", () => {
    const lean = build({ loadedToolsets: [] });
    expect(lean).toContain('"tool":"calculate"');
    expect(lean).toContain('"tool":"search_web"');
    expect(lean).toContain("GROUNDED IN TRUTH");
  });

  it("brings a set back when it is loaded", () => {
    const coding = build({ loadedToolsets: ["coding"] });
    expect(coding).toContain('"tool":"run_command"');
    expect(coding).not.toContain('"tool":"generate_video"'); // and only that set
  });

  it("changes NOTHING for a caller that hasn't opted in", () => {
    // The blocks that had no capability flag before must not vanish for existing callers.
    const legacy = build();
    expect(legacy).toContain('"tool":"run_command"');
    expect(legacy).toContain('"tool":"create_spreadsheet"');
    expect(legacy).toContain('"tool":"update_setting"');
    expect(legacy).toContain('"tool":"search_books"');
    expect(legacy).not.toContain("YOU CAN DO MORE THAN THE TOOLS BELOW");
  });

  it("never advertises what the machine cannot do", () => {
    // Loading a set is not permission: a phone has no shell, so "coding" must stay off even when
    // asked for. On-demand loading may only ever REMOVE a capability, never grant one.
    const phone = buildBuddySystemPrompt({
      persona: "default",
      library: [],
      canRunCommands: false,
      loadedToolsets: ["coding"],
    } as unknown as Parameters<typeof buildBuddySystemPrompt>[0]);
    expect(phone).not.toContain('"tool":"run_command"');
  });
});

describe("the loader is reachable", () => {
  // The bug this whole scheme died on: the index told the model to call `load_toolset`, and
  // `load_toolset` was in neither the native schema list nor the text catalogue. A model driving
  // through native tool-calling sees ONLY that list, so the on-demand sets could not be reached at
  // all. An instruction to call something uncallable is worse than no instruction.
  it("is in the native schemas, always, whatever is loaded", () => {
    for (const loaded of [[], ["coding"], ["coding", "video"]]) {
      const names = ollamaToolSchemas({ canSearchFiles: true, loadedToolsets: loaded }).map((t) => t.function.name);
      expect(names, `missing with ${JSON.stringify(loaded)}`).toContain("load_toolset");
    }
  });

  it("names the groups in its own description, so a native call knows what to pass", () => {
    const schema = ollamaToolSchemas({ loadedToolsets: [] }).find((t) => t.function.name === "load_toolset")!;
    for (const id of TOOLSET_IDS) expect(schema.function.description).toContain(id);
    expect(schema.function.parameters.required).toEqual(["name"]);
  });

  it("is a peer of the other tools in the text catalogue, not just prose", () => {
    expect(build({ loadedToolsets: [] })).toContain('- {"tool":"load_toolset","name":"…"}');
  });

  it("tells the model not to claim it can't do something in the list", () => {
    // The observed failure mode: it read the index as a description of what it lacked.
    expect(build({ loadedToolsets: [] })).toMatch(/NEVER tell the reader you are unable/);
  });

  it("is absent for a caller that hasn't opted in — there is nothing to load", () => {
    expect(build()).not.toContain('"tool":"load_toolset"');
    expect(ollamaToolSchemas({ canSearchFiles: true }).map((t) => t.function.name)).toContain("load_toolset");
  });
});

describe("toolsetDoc", () => {
  it("is exactly the text the prompt would have carried", () => {
    // Derived by diffing two real builds, so it cannot drift from the prompt.
    const doc = toolsetDoc("video", { ...FULL, loadedToolsets: [] } as unknown as Parameters<typeof toolsetDoc>[1]);
    expect(doc).toContain('"tool":"generate_video"');
    expect(doc).toContain('"tool":"stitch_videos"');
    expect(doc).not.toContain('"tool":"run_command"');
    for (const line of doc.split("\n").slice(1)) {
      if (line.trim()) expect(build({ loadedToolsets: ["video"] })).toContain(line);
    }
  });

  it("says which set it is, so the model knows what it just gained", () => {
    expect(toolsetDoc("coding", { ...FULL, loadedToolsets: [] } as unknown as Parameters<typeof toolsetDoc>[1]))
      .toMatch(/^TOOLSET "coding" — loaded/);
  });

  it("is empty for a set the environment can't offer", () => {
    const doc = toolsetDoc("coding", {
      persona: "default", library: [], canRunCommands: false, loadedToolsets: [],
    } as unknown as Parameters<typeof toolsetDoc>[1]);
    expect(doc).toBe("");
  });
});

describe("native schemas follow the same gate", () => {
  it("withholds schemas for unloaded sets", () => {
    // They ride ALONGSIDE the prompt, so leaving them ungated hands back most of the saving.
    const all = ollamaToolSchemas({ canSearchFiles: true, canRunCommands: true, canWolfram: true });
    const lean = ollamaToolSchemas({
      canSearchFiles: true, canRunCommands: true, canWolfram: true, loadedToolsets: [],
    });
    expect(lean.length).toBeLessThan(all.length);
    expect(lean.map((t) => t.function.name)).not.toContain("run_command");
    expect(lean.map((t) => t.function.name)).toContain("search_web"); // always-on survives
  });

  it("restores them when the set is loaded", () => {
    const coding = ollamaToolSchemas({
      canSearchFiles: true, canRunCommands: true, canWolfram: true, loadedToolsets: ["coding"],
    });
    expect(coding.map((t) => t.function.name)).toContain("run_command");
  });

  it("is ungated for a caller that hasn't opted in", () => {
    expect(ollamaToolSchemas({ canRunCommands: true }).map((t) => t.function.name)).toContain("run_command");
  });
});
