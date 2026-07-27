/**
 * Tool-approval POLICY — the one place that decides what happens when the assistant asks to use a
 * tool: run it immediately (and through which executor), or stop and show the approval card. The
 * host's turn-completion handler used to encode this as a long if/else chain mixing policy with
 * execution; the policy now lives here as a pure, unit-tested table, and the host switches on the
 * returned route to invoke its executors. Deny/dismiss is not a route — it's always the user
 * declining the shown card.
 */

/** The capability grants + settings toggles the policy reads. All plain booleans so this stays
 * host-agnostic (the web host derives them from session grants + ReaderSettings). */
export interface ToolAutoFlags {
  /** "Allow always" was clicked for file search this session. */
  fileAccessGranted: boolean;
  /** "Allow always" was clicked for screen capture this session. */
  screenCaptureGranted: boolean;
  /** Settings: auto-approve desktop file search. */
  autonomousFileSearch: boolean;
  /** Settings: full autonomy — renders and capability tools run without a click. */
  fullAutonomy: boolean;
  /** Settings: shell commands are enabled at all. */
  allowCommands: boolean;
  /** Settings: autonomous workspace — approved-folder commands run without a click. */
  autonomousWorkspace: boolean;
}

/** Where an incoming tool call routes. `ask` = suspend the turn and show the approval card. */
export type ToolAutoRoute =
  | "host" // desktop host-tool dispatch (find_files / screenshot / write_file / run_command), no click
  | "image" // render immediately (full autonomy)
  | "video"
  | "long-video"
  | "plan" // safe host-run planner — never needs a click
  | "order-review" // ALWAYS opens the review-and-place gate; never auto-submits
  | "tv-chart" // drives the reader's own TradingView chart (chart-only CDP bridge)
  | "delegate" // isolated read-only sub-agent
  | "stitch" // join existing clips with ffmpeg — local, non-destructive, no new rendering
  | "ask";

/**
 * Decide a pending tool's route. Mirrors the launch-chat gate exactly:
 * - find_files runs when file access was granted this session OR a setting auto-approves it;
 * - screenshot runs when screen capture was granted OR full autonomy is on;
 * - renders (image/video/long video) auto-run ONLY under full autonomy;
 * - plan_task / tv_chart / delegate always run (safe, host-side, read-only or reviewable);
 * - prep_order always routes to the order-review gate (the gate itself is the approval);
 * - write_file / edit_file always run — writing into the sandboxed workspace folder is harmless (the
 *   dangerous step, run_command, keeps its own gate);
 * - run_command runs only when commands are enabled AND the autonomous workspace is on —
 *   full autonomy alone NEVER reaches it (the hard danger floor);
 * - everything else asks.
 */
export function routePendingTool(tool: string, f: ToolAutoFlags): ToolAutoRoute {
  switch (tool) {
    case "find_files":
      return f.fileAccessGranted || f.autonomousFileSearch || f.fullAutonomy ? "host" : "ask";
    case "screenshot":
      return f.screenCaptureGranted || f.fullAutonomy ? "host" : "ask";
    case "generate_image":
      return f.fullAutonomy ? "image" : "ask";
    case "generate_video":
      return f.fullAutonomy ? "video" : "ask";
    case "generate_long_video":
      return f.fullAutonomy ? "long-video" : "ask";
    case "plan_task":
      return "plan";
    case "prep_order":
      return "order-review";
    case "tv_chart":
      return "tv-chart";
    case "delegate":
      return "delegate";
    case "write_file":
    case "edit_file":
      // edit_file is the same sandboxed workspace write as write_file (search/replace in place vs full
      // rewrite) — it must route identically, or it would default to "ask" while write_file runs freely.
      return "host";
    case "set_cell":
    case "add_formula_column":
    case "read_data":
      // The reader's OWN open spreadsheet, in the app's own data view — no filesystem, no network, and
      // undoable by typing over the cell. Gating these behind a click would make a sheet the assistant
      // just built un-editable without one approval per cell.
      return "host";
    case "stitch_videos":
      // Joining clips the reader already has is a local, non-destructive file operation (no new
      // rendering, nothing leaves the machine) — no click needed.
      return "stitch";
    case "run_command":
      return f.allowCommands && f.autonomousWorkspace ? "host" : "ask";
    default:
      return "ask";
  }
}
