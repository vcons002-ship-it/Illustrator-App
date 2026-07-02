import { describe, expect, it } from "vitest";
import { routePendingTool, type ToolAutoFlags } from "./tool-approval.js";

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
