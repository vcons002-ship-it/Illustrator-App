import { describe, expect, it } from "vitest";
import { CREATIVE_IDLE_TOOLS, allowedInCreativeIdle, isLiveControlTool, routePendingTool, type ToolAutoFlags } from "./tool-approval.js";
import { toolsetForTool } from "./toolsets.js";

const OFF: ToolAutoFlags = {
  fileAccessGranted: false,
  screenCaptureGranted: false,
  autonomousFileSearch: false,
  fullAutonomy: false,
  allowCommands: false,
  autonomousWorkspace: false, liveControl: false,
};

describe("routePendingTool", () => {
  it("asks for everything gated when no grants/toggles are on", () => {
    for (const tool of ["find_files", "screenshot", "generate_image", "generate_video", "generate_long_video", "run_command", "send_email", "spawn_coding_agents", "made_up_tool"]) {
      expect(routePendingTool(tool, OFF)).toBe("ask");
    }
  });

  it("find_files runs under the session grant, the setting, or full autonomy", () => {
    expect(routePendingTool("find_files", { ...OFF, fileAccessGranted: true })).toBe("host");
    expect(routePendingTool("find_files", { ...OFF, autonomousFileSearch: true })).toBe("host");
    expect(routePendingTool("find_files", { ...OFF, fullAutonomy: true })).toBe("host");
  });

  it("screenshot runs under the session grant or full autonomy — not the file-search setting", () => {
    expect(routePendingTool("screenshot", { ...OFF, screenCaptureGranted: true })).toBe("host");
    expect(routePendingTool("screenshot", { ...OFF, fullAutonomy: true })).toBe("host");
    expect(routePendingTool("screenshot", { ...OFF, autonomousFileSearch: true })).toBe("ask");
  });

  it("renders auto-run only under full autonomy", () => {
    expect(routePendingTool("generate_image", { ...OFF, fullAutonomy: true })).toBe("image");
    expect(routePendingTool("generate_video", { ...OFF, fullAutonomy: true })).toBe("video");
    expect(routePendingTool("generate_long_video", { ...OFF, fullAutonomy: true })).toBe("long-video");
    expect(routePendingTool("generate_image", { ...OFF, autonomousWorkspace: true, liveControl: false, allowCommands: true })).toBe("ask");
  });

  it("run_command needs commands enabled AND the autonomous workspace — full autonomy alone never reaches it", () => {
    expect(routePendingTool("run_command", { ...OFF, allowCommands: true, autonomousWorkspace: true, liveControl: false })).toBe("host");
    expect(routePendingTool("run_command", { ...OFF, allowCommands: true })).toBe("ask");
    expect(routePendingTool("run_command", { ...OFF, autonomousWorkspace: true, liveControl: false })).toBe("ask");
    // The hard danger floor: fullAutonomy must NOT unlock shell commands.
    expect(routePendingTool("run_command", { ...OFF, fullAutonomy: true })).toBe("ask");
  });

  it("always-auto tools route to their handlers regardless of flags", () => {
    expect(routePendingTool("plan_task", OFF)).toBe("plan");
    expect(routePendingTool("tv_chart", OFF)).toBe("tv-chart");
    expect(routePendingTool("delegate", OFF)).toBe("delegate");
    expect(routePendingTool("write_file", OFF)).toBe("host");
    // edit_file is the same sandboxed workspace write as write_file — it routes identically (not "ask").
    expect(routePendingTool("edit_file", OFF)).toBe("host");
    // Joining existing clips is local + non-destructive — never needs a click.
    expect(routePendingTool("stitch_videos", OFF)).toBe("stitch");
  });

  it("prep_order ALWAYS opens the review gate — even under full autonomy", () => {
    expect(routePendingTool("prep_order", OFF)).toBe("order-review");
    expect(
      routePendingTool("prep_order", {
        fileAccessGranted: true,
        screenCaptureGranted: true,
        autonomousFileSearch: true,
        fullAutonomy: true,
        allowCommands: true,
        autonomousWorkspace: true, liveControl: false,
      }),
    ).toBe("order-review");
  });
});

describe("creative idle: what an unattended run may touch", () => {
  it("allows only look-things-up-and-write-them-up", () => {
    for (const t of ["search_web", "read_url", "read", "create_document", "edit_document", "remember", "calculate"]) {
      expect(allowedInCreativeIdle({ tool: t })).toBe(true);
    }
  });

  /**
   * The loader returns instructions, not power — every tool inside the set it loads is checked
   * against this same list on the next round. Blocking it took the manual away from tools this list
   * ALLOWS: create_document, edit_document and read_document are the `documents` toolset, and the
   * index in the prompt tells the model to load it before using them. The run was refused the page
   * for a tool it was being told to use in the same sentence, and had to guess its way around it.
   */
  it("allows the toolset loader, whose absence took the manual from tools it permits", () => {
    expect(allowedInCreativeIdle({ tool: "load_toolset" })).toBe(true);
    for (const t of ["create_document", "edit_document", "read_document"]) {
      expect(allowedInCreativeIdle({ tool: t }), t).toBe(true);
    }
  });

  /**
   * The invariant that would have caught this without anyone noticing it in a screenshot: if the
   * list permits a tool that lives behind a toolset, it has to permit the loader too. Otherwise the
   * run is allowed to call something whose instructions it cannot fetch — which is not a smaller
   * capability, it is the same capability with the documentation removed.
   */
  it("permits the loader for every allowed tool that lives behind a toolset", () => {
    const gated = [...CREATIVE_IDLE_TOOLS].filter((t) => toolsetForTool(t));
    expect(gated.length, "no allowed tool is toolset-gated — this test has stopped testing anything").toBeGreaterThan(0);
    expect(allowedInCreativeIdle({ tool: "load_toolset" }), `${gated.join(", ")} need their manual`).toBe(true);
  });

  it("still refuses what a loaded set would contain — loading is not permission", () => {
    // The whole reason the loader is safe: `load_toolset coding` hands over a page of instructions
    // and changes nothing about what the next round is allowed to do.
    for (const t of ["run_command", "write_file", "edit_file"]) {
      expect(allowedInCreativeIdle({ tool: t }), t).toBe(false);
    }
  });

  it("refuses everything that touches the machine, sends, or spends — this is the whole safety story", () => {
    // Named individually rather than asserting a count: the point is that ADDING a tool to the app
    // must not quietly widen what runs while nobody is watching, and a test that just counts would.
    const forbidden = [
      "run_command",
      "write_file",
      "edit_file",
      "delegate_coding_task",
      "spawn_coding_agents",
      "spawn_agents",
      "delegate",
      "find_files",
      "read_file",
      "screenshot",
      "open_image",
      "send_email",
      "draft_email",
      "edit_draft",
      "create_event",
      "update_event",
      "create_task",
      "schedule_task",
      "prep_order",
      "trading_script",
      "generate_image",
      "generate_video",
      "generate_long_video",
      "mcp_call",
      "update_setting",
      "set_cell",
      "create_spreadsheet",
    ];
    for (const t of forbidden) expect(allowedInCreativeIdle({ tool: t })).toBe(false);
  });

  it("is an allowlist, so a tool added later is refused until someone opts it in", () => {
    expect(allowedInCreativeIdle({ tool: "some_tool_invented_next_year" })).toBe(false);
    expect(allowedInCreativeIdle({ tool: "" })).toBe(false);
  });
});

describe("creative idle: the memory tools are judged per CALL, not per name", () => {
  it("lets it shape its own identity from what it explored", () => {
    expect(allowedInCreativeIdle({ tool: "remember", about: "self" })).toBe(true);
    expect(allowedInCreativeIdle({ tool: "forget", match: "x", about: "self" } as { tool: string; about?: string })).toBe(true);
  });

  it("never lets an unattended run touch the READER's memories", () => {
    // `forget` defaults to the reader's memories, so a name-only allowlist would have let a run with
    // nobody watching delete what the reader asked it to remember.
    expect(allowedInCreativeIdle({ tool: "forget" })).toBe(false);
    expect(allowedInCreativeIdle({ tool: "forget", about: "reader" })).toBe(false);
    expect(allowedInCreativeIdle({ tool: "forget", about: "user" })).toBe(false);
  });

  it("won't revise its picture of the reader with nobody there to inform it", () => {
    expect(allowedInCreativeIdle({ tool: "remember", about: "user" })).toBe(false);
    // Noting what it explored (reader-memory, additive) stays fine.
    expect(allowedInCreativeIdle({ tool: "remember" })).toBe(true);
    expect(allowedInCreativeIdle({ tool: "remember", about: "reader" })).toBe(true);
  });
});

describe("live control", () => {
  const LIVE: ToolAutoFlags = { ...OFF, liveControl: true };

  it("runs the loop's own tools without a click — an approval card per look makes a loop impossible", () => {
    expect(routePendingTool("control_ui", LIVE)).toBe("host");
    expect(routePendingTool("screenshot", LIVE)).toBe("host");
  });

  it("does NOT open the shell — clicking buttons is not consent to run commands", () => {
    // The whole reason control_ui is safe to auto-run is that the app writes the script; run_command
    // is the model writing it, and it keeps its own gate.
    expect(routePendingTool("run_command", LIVE)).toBe("ask");
    expect(routePendingTool("browser_eval", LIVE)).toBe("ask");
    expect(routePendingTool("send_email", LIVE)).toBe("ask");
    expect(routePendingTool("generate_image", LIVE)).toBe("ask");
  });

  it("control_ui still asks when live control is off, even under full autonomy", () => {
    expect(routePendingTool("control_ui", OFF)).toBe("ask");
    expect(routePendingTool("control_ui", { ...OFF, fullAutonomy: true })).toBe("ask");
    // ...but the shell's own gate reaches it, since that is the same reach into the machine.
    expect(routePendingTool("control_ui", { ...OFF, allowCommands: true, autonomousWorkspace: true })).toBe("host");
  });
});

describe("isLiveControlTool", () => {
  it("counts the loop's tools and nothing else", () => {
    expect(isLiveControlTool({ tool: "control_ui" })).toBe(true);
    expect(isLiveControlTool({ tool: "screenshot" })).toBe(true);
    // A run that happened to search the web once must not look closer to its limit than it is.
    expect(isLiveControlTool({ tool: "search_web" })).toBe(false);
    expect(isLiveControlTool({ tool: "run_command" })).toBe(false);
  });
});
