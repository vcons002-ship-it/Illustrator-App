import { describe, expect, it } from "vitest";
import { allowedInCreativeIdle, routePendingTool, type ToolAutoFlags } from "./tool-approval.js";

const OFF: ToolAutoFlags = {
  fileAccessGranted: false,
  screenCaptureGranted: false,
  autonomousFileSearch: false,
  fullAutonomy: false,
  allowCommands: false,
  autonomousWorkspace: false,
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
    expect(routePendingTool("generate_image", { ...OFF, autonomousWorkspace: true, allowCommands: true })).toBe("ask");
  });

  it("run_command needs commands enabled AND the autonomous workspace — full autonomy alone never reaches it", () => {
    expect(routePendingTool("run_command", { ...OFF, allowCommands: true, autonomousWorkspace: true })).toBe("host");
    expect(routePendingTool("run_command", { ...OFF, allowCommands: true })).toBe("ask");
    expect(routePendingTool("run_command", { ...OFF, autonomousWorkspace: true })).toBe("ask");
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
        autonomousWorkspace: true,
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
