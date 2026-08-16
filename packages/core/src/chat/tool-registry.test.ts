import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUDDY_TOOL_NAMES, describeToolProposal, ollamaToolSchemas } from "./buddy-tools.js";
import { CREATIVE_IDLE_TOOLS } from "./tool-approval.js";
import { TOOLSETS } from "./toolsets.js";

/**
 * THE TOOL REGISTRY AUDIT — one spine, and everything that describes a tool checked against it.
 *
 * Every recent tool bug has had the same shape, and it is not a logic error: the same fact about a
 * tool is stated in several places, and the places disagree. Nothing fails loudly when they do,
 * because each place is individually correct.
 *
 *   · `control_ui` could route to "ask" with no approval card written → the turn suspended behind a
 *     card that was never rendered. Two statements of "what needs a click".
 *   · `load_toolset` was allowed by the executor and forbidden by the creative prompt's closed list.
 *     Two statements of "what this run may call".
 *   · A tool documented in the prose catalog but missing from `ollamaToolSchemas` was uncallable for
 *     any model driving through native tool-calling — which sees ONLY that list. (Recorded in
 *     buddy-tools.ts; it is why the loader is first and ungated there.)
 *   · App.tsx kept its own activity-label ladder beside `describeBuddyToolActivity`, and the two
 *     described the same call differently.
 *
 * `BUDDY_TOOL_NAMES` is the spine: it is what the parser will accept, so a name absent from it does
 * not exist no matter how well documented it is. Everything below asks one question — does this
 * other list agree with the spine, and where it deliberately doesn't, is that written down?
 */

const SRC = join(import.meta.dirname);
const buddyTools = readFileSync(join(SRC, "buddy-tools.ts"), "utf8");

/** Every tool name the native schemas offer. */
const schemaNames = new Set(
  ollamaToolSchemas({ canSearchFiles: true, canRunCommands: true, canWolfram: true, canMarkets: true }).map(
    (s) => s.function.name,
  ),
);

describe("the toolsets agree with the spine", () => {
  it("lists only tools that exist", () => {
    for (const set of TOOLSETS) {
      for (const tool of set.tools) {
        expect(BUDDY_TOOL_NAMES.has(tool as never), `${set.id} lists "${tool}", which the parser will reject`).toBe(true);
      }
    }
  });

  it("files each tool in exactly one set", () => {
    // Two homes means `toolsetForTool` picks one arbitrarily, and the tool becomes reachable through
    // a set the reader never loaded — or unreachable through the one they did.
    const seen = new Map<string, string>();
    for (const set of TOOLSETS) {
      for (const tool of set.tools) {
        const prior = seen.get(tool);
        expect(prior, `"${tool}" is in both ${prior} and ${set.id}`).toBeUndefined();
        seen.set(tool, set.id);
      }
    }
  });
});

describe("the native schemas agree with the spine", () => {
  it("offers only tools that exist", () => {
    for (const name of schemaNames) {
      expect(BUDDY_TOOL_NAMES.has(name as never), `ollamaToolSchemas offers "${name}", which the parser will reject`).toBe(
        true,
      );
    }
  });

  it("offers the loader, whose absence is the one unrecoverable one", () => {
    // Without it the on-demand sets cannot be reached AT ALL: the index names groups the model has no
    // way to ask for. Asserted separately from the rest because it is the load-bearing one.
    expect(schemaNames.has("load_toolset")).toBe(true);
  });

  /**
   * A TOOLSET'S NATIVE COVERAGE IS ALL-OR-NOTHING, and a partial one is free breakage.
   *
   * The schema list is filtered by the SAME loaded set as the prompt, so the tokens are already
   * being paid the moment the reader loads `coding`. Offering five of that set's eight tools
   * therefore saves nothing at all — it just makes the other three unreachable for a model driving
   * through native tool-calling, which is the exact failure recorded on `keep_going` in
   * buddy-tools.ts: "it knew it needed to, said so in its reasoning, and had no way to."
   *
   * A set with NO schemas is a different and coherent choice — that set is text-protocol only.
   * The three below are the ones caught mid-way, pinned by name so the gap cannot grow silently
   * while it is open. Closing one means deleting it from here in the same commit.
   */
  const KNOWN_PARTIAL: Readonly<Record<string, readonly string[]>> = {
    // The one that bites hardest: live control is look → act → look, and `control_ui` (act) has a
    // schema while `screenshot` (look) does not — so a native-calling model can act and not look.
    coding: ["browser_eval", "screenshot", "spawn_coding_agents"],
    books: ["random_books", "open_library_book", "remove_library_book", "set_visual_style"],
    markets: [
      "set_price_alert", "list_alerts", "cancel_alert", "trading_script", "tv_chart", "prep_order",
      "schwab_quote", "schwab_options", "schwab_positions", "schwab_watchlists",
    ],
  };

  it("covers a toolset entirely or not at all, apart from the gaps on record", () => {
    for (const set of TOOLSETS) {
      const missing = set.tools.filter((t) => !schemaNames.has(t));
      if (missing.length === set.tools.length) continue; // text-protocol only — a whole choice
      expect(missing, `${set.id} is partly native: fix it, or record the gap here deliberately`).toEqual(
        KNOWN_PARTIAL[set.id] ?? [],
      );
    }
  });
});

/**
 * WHAT REACHES THE READER'S MACHINE SAYS WHAT IT IS REACHING FOR.
 *
 * Not every host tool needs this — a render is a render, and "Generating…" tells the reader as much
 * as they need. The ones that matter are the ones that touch their computer, because there the label
 * IS the disclosure: it is what they read before approving, and the row the trace keeps afterwards.
 * On a phone it is the entire view of that reach, which is how "Proposing a command…" — the same row
 * whether the assistant wanted `ls` or `rm -rf` — was the whole story.
 */
describe("a reach into the reader's machine is named", () => {
  const MACHINE_TOOLS = [
    { tool: "run_command", command: "npm test" },
    { tool: "write_file", path: "a.ts", content: "x" },
    { tool: "edit_file", path: "a.ts", edits: [] },
    { tool: "find_files", query: "tax return" },
    { tool: "screenshot" },
    { tool: "browser_eval", expression: "1" },
    { tool: "delegate_coding_task", task: "add a retry" },
  ] as const;

  it("carries its payload rather than its category", () => {
    for (const call of MACHINE_TOOLS) {
      const line = describeToolProposal(call as never);
      expect(line, `${call.tool} has no proposal line`).toBeTruthy();
      expect(line, `${call.tool} falls through to the generic activity line`).not.toBe("Working on it…");
    }
  });

  it("covers every desktop-runtime tool the host can relay", () => {
    // The list App.tsx routes through the relay. If a tool is added there and not here, it goes back
    // to being described by category — which is the state the mobile report was made in.
    const named = new Set(MACHINE_TOOLS.map((c) => c.tool));
    for (const tool of ["run_command", "write_file", "edit_file", "find_files", "screenshot", "control_ui", "delegate_coding_task"]) {
      expect(named.has(tool as never) || tool === "control_ui", `${tool} is relayed to the desktop but unnamed`).toBe(true);
    }
  });
});

describe("the creative-idle allowlist agrees with the spine", () => {
  it("allows only tools that exist", () => {
    for (const tool of CREATIVE_IDLE_TOOLS) {
      expect(BUDDY_TOOL_NAMES.has(tool as never), `the creative allowlist permits "${tool}", which does not exist`).toBe(
        true,
      );
    }
  });

  /**
   * The executor allowlist and the prompt's closed list are two statements of the same fact, and the
   * prompt is the one the model reads first. Saying "you can ONLY search, read, write a document and
   * keep your own notes" while the toolset index tells it to load `documents` first is a
   * contradiction the model has to resolve by guessing — which it did, on every run.
   */
  it("is not contradicted by the prompt that describes it", () => {
    const closedList = /In this mode you can ONLY[\s\S]{0,600}?Work within it\./.exec(buddyTools)?.[0] ?? "";
    expect(closedList, "the creative-idle closed list moved — re-point this check").toBeTruthy();
    expect(closedList, "the closed list omits the loader the toolset index tells it to use").toContain("load_toolset");
  });
});
