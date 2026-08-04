import { describe, expect, it } from "vitest";
import {
  ALWAYS_ON_TOOLS,
  TOOLSETS,
  TOOLSET_IDS,
  isToolAvailable,
  toolsetForTool,
  toolsetIndexBlock,
} from "./toolsets.js";
import { BUDDY_TOOL_NAMES, buildBuddySystemPrompt, formatBuddyToolResult, ollamaToolSchemas, parseBuddyToolCall, toolsetDoc } from "./buddy-tools.js";

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

describe("the registry describes the prompt it actually gates", () => {
  // Everything a fully-equipped desktop permits, so every toolset SHOULD have something to hand back.
  // canSchwab and canTvBridge were missing here, and their absence is why the guard below passed
  // while the broker tools and the whole TradingView bridge sat in every prompt: the fixture never
  // switched them on, so the blocks they gate were never rendered for it to check.
  const EQUIPPED = {
    ...FULL, canGoogle: true, canMarkets: true, canTaskTools: true, canSubAgents: true,
    canSchwab: true, canTvBridge: true,
    loadedToolsets: [],
  } as unknown as Parameters<typeof toolsetDoc>[1];

  it("hands back a real document for every toolset the environment permits", () => {
    // `create_document` lived inside the `canSpreadsheets` branch, so `canDocuments` switched nothing.
    // load_toolset diffed two identical prompts, got "" back, and the dispatcher reported the only
    // thing an empty document can mean: "the documents tools aren't available on this device" — about
    // tools that were sitting in the prompt the whole time. An empty doc must mean UNAVAILABLE and
    // nothing else, or the loader tells the reader a capability was removed when it was mis-wired.
    for (const set of TOOLSETS) {
      expect(toolsetDoc(set.id, EQUIPPED), `${set.id} loads nothing — its flag gates no prompt text`)
        .not.toBe("");
    }
  });

  it("does not gate a tool whose documentation is unconditional", () => {
    // The other half of the same bug: prompt text showing a call the gate then refuses. The model can
    // only call what it can see, so anything visible must be callable — advertise-then-refuse reads
    // to the reader as a capability that vanished mid-session.
    const lean = build({ ...EQUIPPED, loadedToolsets: [] });
    for (const set of TOOLSETS) {
      for (const tool of set.tools) {
        expect(lean, `${tool} is shown while "${set.id}" is unloaded, but calling it is refused`)
          .not.toContain(`"tool":"${tool}"`);
      }
    }
  });

  it("only names tools that exist", () => {
    // `price_alert` was listed under markets; the real tool is `set_price_alert`. A name no tool has
    // matches nothing, so the gate silently stopped applying to the tool it was meant to cover.
    for (const set of TOOLSETS) {
      for (const tool of set.tools) {
        expect(BUDDY_TOOL_NAMES.has(tool as never), `"${tool}" (in ${set.id}) is not a real tool`).toBe(true);
      }
    }
  });

  it("leaves no tool deferred with no group to load it from", () => {
    // The hole the two bugs above fell through, stated over the REAL roster rather than a hand list:
    // a tool whose documentation disappears when nothing is loaded, but which belongs to no toolset,
    // is invisible AND unloadable. `set_price_alert` and `read_skill` were both in that state — the
    // model could neither see them nor ask for them, and nothing in the prompt admitted they existed.
    const equipped = { ...EQUIPPED, canSchwab: true, canTvBridge: true } as Record<string, unknown>;
    const loadedAll = build({ ...equipped, loadedToolsets: TOOLSET_IDS });
    const loadedNone = build({ ...equipped, loadedToolsets: [] });
    const homed = new Set([...TOOLSETS.flatMap((s) => s.tools), ...ALWAYS_ON_TOOLS]);
    for (const tool of BUDDY_TOOL_NAMES) {
      const deferred = loadedAll.includes(`"tool":"${tool}"`) && !loadedNone.includes(`"tool":"${tool}"`);
      if (deferred) expect(homed.has(tool), `${tool}'s docs are deferred but no toolset loads them`).toBe(true);
    }
  });

  it("keeps a story's own instructions out of an unrelated toolset", () => {
    // storyBlock sat inside the spreadsheets branch, so an open story lost its instructions unless
    // something irrelevant happened to be loaded.
    const story = { storyActive: true, storyMode: "direct" };
    expect(build({ ...story, loadedToolsets: [] })).toContain("STORY MODE (a story is open)");
    expect(build({ ...story, loadedToolsets: ["spreadsheets"] })).toContain("STORY MODE (a story is open)");
    // and the how-to-start note when no story is open
    expect(build({ loadedToolsets: [] })).toContain("CO-WRITING AN ILLUSTRATED STORY");
  });
});

describe("deferring documentation never changes a fact", () => {
  // The reported failure: the assistant was CERTAIN Google wasn't connected. It was connected — the
  // host sets canGoogle from real credentials — but the gate switched the flag off because the set
  // wasn't loaded, and the "off" branch was a statement about the READER'S ACCOUNT, not about which
  // manual was in front of the model. So the prompt said, in capitals, that a linked account was not
  // linked. A capability may be deferred; a fact may not.
  const connected = { ...FULL, canGoogle: true, loadedToolsets: [] };

  it("does not tell the model Google is disconnected while it is connected", () => {
    const lean = build(connected);
    expect(lean).not.toMatch(/GOOGLE IS NOT CONNECTED/);
    expect(lean).toMatch(/GOOGLE IS CONNECTED/);
  });

  it("still says so plainly when Google really is not connected", () => {
    const lean = build({ loadedToolsets: [] }); // FULL has no canGoogle
    expect(lean).toMatch(/GOOGLE IS NOT CONNECTED/);
    expect(lean).not.toMatch(/GOOGLE IS CONNECTED/);
  });

  it("does not offer to load a toolset the reader never connected", () => {
    // The mirror image of the same bug: an absent flag read as "no opinion" put google in the index
    // of things it could do, so the model could equally have promised mail it had no way to reach.
    expect(build({ loadedToolsets: [] })).not.toContain("- google —");
    expect(build(connected)).toContain("- google —");
  });

  it("does not tell the model it cannot run code when the reader allowed it", () => {
    const lean = build({ loadedToolsets: [] }); // FULL has canRunCommands
    expect(lean).not.toMatch(/YOU CANNOT SAVE FILES OR RUN CODE/);
    expect(lean).toMatch(/YOU CAN SAVE FILES AND RUN CODE/);
  });

  it("still says so when commands genuinely aren't allowed", () => {
    const phone = buildBuddySystemPrompt({
      persona: "default", library: [], canRunCommands: false, loadedToolsets: [],
    } as unknown as Parameters<typeof buildBuddySystemPrompt>[0]);
    expect(phone).toMatch(/YOU CANNOT SAVE FILES OR RUN CODE/);
  });

  it("gives a fully-equipped machine a different prompt from a bare one", () => {
    // The blunt version of all of the above: before the fix these were byte-identical, so nothing in
    // the prompt distinguished a desktop with everything connected from a phone with nothing.
    const equipped = build({ ...connected, canMarkets: true, canTaskTools: true, canSubAgents: true });
    const bare = buildBuddySystemPrompt({
      persona: "default", library: [], loadedToolsets: [],
    } as unknown as Parameters<typeof buildBuddySystemPrompt>[0]);
    expect(equipped).not.toBe(bare);
  });

  it("changes nothing about the facts for a caller that hasn't opted in", () => {
    expect(build({ canGoogle: true })).not.toMatch(/GOOGLE IS NOT CONNECTED/);
    expect(build()).toMatch(/GOOGLE IS NOT CONNECTED/);
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

describe("a tool the prompt names is a tool the model can call", () => {
  // How a task-bound scheduled action ended up doing nothing visible. The prompt said, in the task
  // block: "Get the ids from list_task_plans / get_task_plan first if you don't have them — never
  // guess an id." Neither tool was documented as a call anywhere. Told to fetch ids from a tool whose
  // shape it had never been shown, and forbidden from guessing, the model had nothing left to do.
  // save_task_context was worse: the prompt a bound scheduled action FIRES with tells it to record
  // what it found there, and the tool appeared nowhere in the prompt at all.
  //
  // The other half were names that are not callable at all: open_library_book, open_web_text and
  // read_file are shapes the PARSER produces from open_content / read, so a model following the prose
  // literally emitted a call no parser accepts.
  const EQUIPPED = {
    ...FULL, canGoogle: true, canMarkets: true, canTaskTools: true, canSubAgents: true,
    canSchwab: true, canAutomateTasks: true,
    activePlan: { goal: "g", steps: [{ text: "s", status: "pending" }] },
    library: [{ id: "b1", title: "T" }],
  } as unknown as Parameters<typeof buildBuddySystemPrompt>[0];

  /** Named in the prompt on purpose while NOT being callable — each needs a reason. */
  const DELIBERATE = new Set([
    "complete_step", // app-managed mode withdraws it and tells the model so, by name
    "set_plan", // named in the multi-step guidance before any checklist exists
  ]);

  it("documents every tool it tells the model to use", () => {
    const prompt = buildBuddySystemPrompt({ ...EQUIPPED, loadedToolsets: TOOLSET_IDS });
    const unusable = [...BUDDY_TOOL_NAMES].filter(
      (t) => !DELIBERATE.has(t) && prompt.includes(t) && !prompt.includes(`"tool":"${t}"`),
    );
    expect(unusable, `named but never shown as a call: ${unusable.join(", ")}`).toEqual([]);
  });

  it("on the lean prompt, a named tool is at least LOADABLE", () => {
    // Different rule, deliberately. The routing guide names deferred tools on purpose ("a downloadable
    // DOCUMENT → create_document") and calling one un-loaded returns its instructions rather than an
    // error — that is the whole on-demand design. What must never happen is a name with no
    // documentation AND no group to fetch it from: nothing the model does can reach that.
    const lean = buildBuddySystemPrompt({ ...EQUIPPED, loadedToolsets: [] });
    const homed = new Set([...TOOLSETS.flatMap((set) => set.tools), ...ALWAYS_ON_TOOLS]);
    const unreachable = [...BUDDY_TOOL_NAMES].filter(
      (t) => !DELIBERATE.has(t) && lean.includes(t) && !lean.includes(`"tool":"${t}"`) && !homed.has(t),
    );
    expect(unreachable, `named, undocumented, and in no toolset: ${unreachable.join(", ")}`).toEqual([]);
  });

  it("can read a task back, which is what a bound scheduled action needs", () => {
    const prompt = buildBuddySystemPrompt({ ...EQUIPPED, loadedToolsets: ["tasks"] });
    for (const t of ["list_task_plans", "get_task_plan", "save_task_context"])
      expect(prompt, t).toContain(`"tool":"${t}"`);
  });
});

describe("every call the prompt shows is a call the parser accepts", () => {
  // Naming a tool is not enough — the SHAPE has to be right too, and getting that wrong is worse than
  // saying nothing: the model follows the documented example, the parser rejects the key it never
  // heard of, and the call is dropped silently. Three of the five task tools documented in the
  // previous change were wrong this way — get_task_plan takes `id` (not `planId`), add_task_steps
  // takes step OBJECTS (not strings), update_task_step takes `notes`/`status` (not `text`) — which is
  // exactly the failure that documenting them was meant to fix. So the prompt's own examples are
  // parsed here, and anything the runtime would reject fails the build.
  const EQUIPPED = {
    ...FULL, canGoogle: true, canMarkets: true, canTaskTools: true, canSubAgents: true,
    canSchwab: true, canAutomateTasks: true,
    activePlan: { goal: "g", steps: [{ text: "s", status: "pending" }] },
    library: [{ id: "b1", title: "T" }],
  } as unknown as Parameters<typeof buildBuddySystemPrompt>[0];

  /** Every `{"tool":…}` object the prompt shows, extracted by balancing braces. */
  function examples(prompt: string): string[] {
    const out: string[] = [];
    for (let i = prompt.indexOf('{"tool":'); i >= 0; i = prompt.indexOf('{"tool":', i + 1)) {
      let depth = 0;
      for (let j = i; j < prompt.length; j++) {
        if (prompt[j] === "{") depth++;
        else if (prompt[j] === "}" && --depth === 0) {
          out.push(prompt.slice(i, j + 1));
          break;
        }
      }
    }
    return out;
  }

  it("finds the examples at all", () => {
    // Guard against the extractor silently matching nothing and the real assertion passing vacuously.
    const found = examples(buildBuddySystemPrompt({ ...EQUIPPED, loadedToolsets: TOOLSET_IDS }));
    expect(found.length).toBeGreaterThan(30);
  });

  /**
   * Shapes the prompt deliberately SKETCHES rather than shows — alternatives separated by `|`, a bare
   * `…` standing in for "and the rest". They aren't valid JSON, so a model can't copy them verbatim
   * anyway; the surrounding prose is what teaches those two. Listed explicitly so a NEW unparseable
   * example has to be justified here rather than quietly joining them.
   */
  const SKETCHES = [
    '{"tool":"generate_long_video","subject":"…","clips":["shot 1 …","shot 2 …",…],"source":{"kind":"…"}}',
    '{"tool":"open_content","source":"library|web|pasted|code", …}',
    '{"tool":"update_setting","field":"…","value":…}',
  ];

  it("parses every one of them", () => {
    const prompt = buildBuddySystemPrompt({ ...EQUIPPED, loadedToolsets: TOOLSET_IDS });
    // The prompt writes placeholders as "…"; a parser requiring a non-empty string would reject those
    // for the wrong reason, so fill them first. What is under test is the KEYS.
    const fill = (ex: string) => ex.replace(/"…"/g, '"x"').replace(/…/g, "");
    const all = examples(prompt);
    const sketches = all.filter((ex) => {
      try {
        JSON.parse(fill(ex));
        return false;
      } catch {
        return true; // not even JSON — a sketch, not an example
      }
    });
    expect(sketches, "a new example isn't valid JSON — make it real or list it as a sketch").toEqual(SKETCHES);
    const rejected = all.filter((ex) => !sketches.includes(ex) && parseBuddyToolCall(fill(ex)) === undefined);
    expect(rejected, `the prompt shows calls the parser rejects:\n${rejected.join("\n")}`).toEqual([]);
  });

  it("would have caught the wrong argument name", () => {
    // The specific mistake, pinned: `planId` is not how you fetch a task.
    expect(parseBuddyToolCall('{"tool":"get_task_plan","planId":"p1"}')).toBeUndefined();
    expect(parseBuddyToolCall('{"tool":"get_task_plan","id":"p1"}')).toEqual({ tool: "get_task_plan", id: "p1" });
  });
});

describe("the assistant can always reach its own record", () => {
  // Reported: "can the AI not check what the activity log shows or which scheduled tasks it has done
  // that day? I asked and it didn't look." It couldn't. recent_actions sat inside the `tasks` toolset,
  // so a plain chat had no documentation for it at all, and a chat that DID have task tools was told
  // about it only under the index line "plan, schedule and track multi-step work across sessions" —
  // nothing a model would load in order to answer "what have you done today?".
  //
  // It fails the always-on test in the most literal way there is: asked what it did, a model does not
  // think to fetch the task-management manual first. Self-knowledge cannot sit behind a load, for the
  // same reason remembering your name cannot.
  const chat = (extra: Record<string, unknown> = {}) =>
    buildBuddySystemPrompt({ persona: "default", library: [], ...extra } as unknown as Parameters<typeof buildBuddySystemPrompt>[0]);

  it("is documented in a plain chat with nothing loaded and no task tools", () => {
    expect(chat({ loadedToolsets: [] })).toContain('"tool":"recent_actions"');
  });

  it("does not depend on the task tools being permitted", () => {
    // canTaskTools is only on when task automation is enabled, a plan is active, or the persona is
    // planning. "What did you do this morning?" asks for none of those.
    expect(chat({ canTaskTools: false, loadedToolsets: [] })).toContain('"tool":"recent_actions"');
  });

  it("is never deferred", () => {
    expect(toolsetForTool("recent_actions")).toBeUndefined();
    expect(isToolAvailable("recent_actions", [])).toBe(true);
  });

  it("tells the model to READ it rather than answer from memory", () => {
    // The failure was not only reachability — a model that can reach a record still has to be told
    // that answering "what did you do today" from recollection is guessing.
    expect(chat({ loadedToolsets: [] })).toMatch(/never answer from memory/);
  });

  it("the tasks index line says the group covers scheduled actions", () => {
    // So "which scheduled tasks ran today?" has something to match on when list_scheduled is wanted.
    expect(toolsetIndexBlock(["tasks"], [])).toContain("scheduled actions");
  });
});

describe("tools added since the deferral scheme was built", () => {
  const build = (extra: Record<string, unknown> = {}): string =>
    buildBuddySystemPrompt({ persona: "default", library: [], ...extra } as unknown as Parameters<typeof buildBuddySystemPrompt>[0]);

  // A tool documented outside any toolset's flags rides in EVERY prompt — which is what the whole
  // scheme exists to prevent, and what silently happened to the broker + TradingView blocks. Each
  // entry: the tool, the toolset that owns it, and the flags its documentation needs.
  const RECENT: { tool: string; set: string; on: Record<string, unknown> }[] = [
    { tool: "update_task", set: "tasks", on: { canTaskTools: true } },
    { tool: "update_task_doc", set: "tasks", on: { canTaskTools: true } },
    { tool: "tv_chart", set: "markets", on: { canMarkets: true, canTvBridge: true } },
    { tool: "schwab_quote", set: "markets", on: { canSchwab: true } },
    { tool: "prep_order", set: "markets", on: { canSchwab: true } },
  ];

  it("are absent with nothing loaded, and arrive when their toolset is", () => {
    for (const { tool, set, on } of RECENT) {
      expect(build({ ...on, loadedToolsets: [] }), `${tool} is documented before anything is loaded`)
        .not.toContain(`"tool":"${tool}"`);
      expect(build({ ...on, loadedToolsets: [set] }), `${tool} is missing after loading "${set}"`)
        .toContain(`"tool":"${tool}"`);
    }
  });

  it("are each answerable by a real toolset, so a call before loading isn't a dead end", () => {
    for (const { tool, set } of RECENT) {
      expect(toolsetForTool(tool)?.id, `${tool} belongs to no toolset`).toBe(set);
      expect(isToolAvailable(tool, [set])).toBe(true);
      expect(isToolAvailable(tool, [])).toBe(false);
    }
  });

  it("loading a toolset never claims hardware or an account the reader hasn't got", () => {
    // canSchwab/canTvBridge describe what the reader actually connected. On-demand loading may only
    // turn them off — a `markets` load must not advertise a broker they never linked.
    const lean = build({ canMarkets: true, canSchwab: false, canTvBridge: false, loadedToolsets: ["markets"] });
    expect(lean).not.toContain('"tool":"schwab_quote"');
    expect(lean).not.toContain('"tool":"tv_chart"');
    expect(lean).toContain('"tool":"stock_quote"'); // the keyless half still loads
  });
});

describe("the markets index line is the only thing standing between a price question and a guess", () => {
  it("names the words a reader actually uses, and forbids answering from memory", () => {
    // With the docs deferred, `stock_quote` and `market_analysis` are invisible until `markets` is
    // loaded — so this one line has to be what makes the model reach for them instead of reciting a
    // price it half-remembers.
    const markets = TOOLSETS.find((t) => t.id === "markets")!;
    for (const word of ["stock", "ticker", "price", "chart", "trade"]) {
      expect(markets.trigger.toLowerCase(), `the markets trigger never says "${word}"`).toContain(word);
    }
    expect(markets.trigger).toMatch(/never from memory/i);
    // And it has to actually reach the prompt.
    const block = toolsetIndexBlock(["markets"], []);
    expect(block).toContain(markets.trigger);
  });
});

describe("a price question must not be answered by a web search", () => {
  const build = (extra: Record<string, unknown> = {}): string =>
    buildBuddySystemPrompt({ persona: "default", library: [], ...extra } as unknown as Parameters<typeof buildBuddySystemPrompt>[0]);

  it("puts the redirect beside search_web, where the model is actually tempted", () => {
    // Deferring the market docs left a fully-documented web search in front of the model and a
    // one-line index entry off to the side. It searched. The rule has to sit next to the tool it
    // is overriding, not only inside the group that hasn't been opened.
    const lean = build({ canMarkets: true, loadedToolsets: [] });
    expect(lean).toContain('"tool":"search_web"');
    expect(lean).toContain("MARKET DATA IS NOT A WEB SEARCH");
    expect(lean).toContain('{"tool":"load_toolset","name":"markets"}');
    // It still says what search_web IS good for here, or the model just stops searching for news.
    expect(lean).toMatch(/market NEWS/);
  });

  it("stays out of the way for a reader with no markets tools at all", () => {
    expect(build({ loadedToolsets: [] })).not.toContain("MARKET DATA IS NOT A WEB SEARCH");
  });

  it("survives the group being loaded — the rule outlives the reminder", () => {
    expect(build({ canMarkets: true, loadedToolsets: ["markets"] })).toContain("MARKET DATA IS NOT A WEB SEARCH");
  });
});

describe("the native tool schemas say the same thing as the prompt", () => {
  const desc = (opts: Record<string, unknown>): string =>
    ollamaToolSchemas(opts as Parameters<typeof ollamaToolSchemas>[0]).find((s) => s.function.name === "search_web")!.function.description;

  it("carves market data out of search_web for a reader who has the markets tools", () => {
    // A native-tool-calling model sees ONLY this list — and search_web used to advertise itself for
    // "current facts", which is exactly what a price is. Fixing the prompt alone would leave the two
    // channels contradicting each other.
    const d = desc({ canMarkets: true, loadedToolsets: [] });
    expect(d).toMatch(/NOT for market data/i);
    expect(d).toMatch(/markets/);
    expect(d).toMatch(/never from search results/i);
  });

  it("says nothing about markets to a reader who hasn't got them", () => {
    expect(desc({ loadedToolsets: [] })).not.toMatch(/market data/i);
  });

  it("withholds the market schemas themselves until the group is loaded", () => {
    const names = (loaded: string[]): string[] =>
      ollamaToolSchemas({ canMarkets: true, loadedToolsets: loaded } as Parameters<typeof ollamaToolSchemas>[0]).map((s) => s.function.name);
    expect(names([])).not.toContain("stock_quote");
    expect(names(["markets"])).toContain("stock_quote");
    expect(names([])).toContain("load_toolset"); // the way back in is never withheld
  });
});

describe("a failed price feed is a fact to report, not a licence to guess", () => {
  it("no longer tells the model to web-search for the price instead", () => {
    // The old text ended "Use search_web for current prices instead, and proceed." — the exact thing
    // the rest of the prompt forbids, arriving at the one moment the model is looking for permission.
    const out = formatBuddyToolResult({ tool: "stock_quote", symbol: "MSFT" }, {});
    expect(out).not.toMatch(/use search_web for current prices/i);
    expect(out).toMatch(/TELL THE READER/);
    expect(out).toMatch(/unverified/i);
    expect(out).toMatch(/Never present it as a live price/i);
  });

  it("won't let indicators be estimated when the bars didn't arrive", () => {
    const out = formatBuddyToolResult({ tool: "market_analysis", symbol: "MSFT" }, {});
    expect(out).toMatch(/cannot be estimated/i);
    expect(out).toMatch(/VWAP, RSI/);
  });
});

describe("numbers arrive with their source attached", () => {
  it("puts a Source line on the quote the model is handed", () => {
    const out = formatBuddyToolResult({ tool: "stock_quote", symbol: "MSFT" }, { quote: { symbol: "MSFT", close: 512.3 } });
    expect(out).toContain("Source: Yahoo");
    expect(out).toMatch(/STATE THE SOURCE/);
  });

  it("marks a Schwab quote as NOT the keyless feed", () => {
    const out = formatBuddyToolResult({ tool: "schwab_quote", symbol: "MSFT" }, { schwabQuote: { symbol: "MSFT", last: 512.3 } });
    expect(out).toContain("Source: your Schwab account");
    expect(out).toMatch(/NOT the keyless feed/);
  });

  it("tells the model to repeat the source, and to decline a figure it has no source for", () => {
    const p = buildBuddySystemPrompt({ persona: "default", library: [], canMarkets: true, loadedToolsets: [] } as never);
    expect(p).toContain("ALWAYS SAY WHERE A NUMBER CAME FROM");
    expect(p).toMatch(/If you have no source for a figure, you do not have the figure/);
  });
});
