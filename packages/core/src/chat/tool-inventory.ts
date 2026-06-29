/**
 * BEFORE/AFTER TOOL INVENTORY — the audit trail for the chat-simplification work.
 *
 * The simplification SHRANK the tool surface (fewer look-alike tools for the model to pick among)
 * without dropping any CAPABILITY. This module is the typed record of that: every chat tool that ever
 * existed is listed with its disposition —
 *   • "kept"            — still a tool the model can call directly.
 *   • { mergedInto }    — no longer advertised on its own; the model now reaches it through ONE
 *                         consolidated tool (the open_* reader tools → open_content; the read_url /
 *                         read_file / read_email / read_attachment ingest tools → read). The shape
 *                         stays in the protocol, so the capability is unchanged.
 *   • { movedToClick }  — taken off the model surface and surfaced as a UI click instead (start_story →
 *                         the Open Book "Story as you go" button / the /story command).
 *
 * `feature-parity.test.ts` reads this so a capability that's removed-without-replacement fails CI.
 */

export type Disposition = "kept" | { mergedInto: string } | { movedToClick: string };

export interface ToolEntry {
  tool: string;
  /** The user-facing capability this tool serves (a FEATURES.md area). */
  capability: string;
  disposition: Disposition;
}

export const TOOL_INVENTORY: ToolEntry[] = [
  // Research & web
  { tool: "search_web", capability: "web research", disposition: "kept" },
  { tool: "search_books", capability: "book discovery", disposition: "kept" },
  { tool: "random_books", capability: "book discovery", disposition: "kept" },
  { tool: "search_images", capability: "find real figures", disposition: "kept" },
  // The four reader/ingest tools collapsed into ONE read tool with a `source` discriminator
  // (url | file | email | attachment) — same move as open_content. The shapes stay in the
  // protocol, so every capability is unchanged; only the model-facing surface shrank.
  { tool: "read", capability: "read a page/repo", disposition: "kept" },
  { tool: "read_url", capability: "read a page/repo", disposition: { mergedInto: "read" } },
  { tool: "wolfram", capability: "real-world data", disposition: "kept" },
  { tool: "calculate", capability: "exact math", disposition: "kept" },

  // Opening content — the five reader-open tools collapsed into open_content (open_image stays its
  // own DISPLAY tool: it shows a picture inline, not a reader, so merging it would add confusion).
  { tool: "open_content", capability: "open to read/illustrate", disposition: "kept" },
  { tool: "open_library_book", capability: "open to read/illustrate", disposition: { mergedInto: "open_content" } },
  { tool: "open_web_text", capability: "open to read/illustrate", disposition: { mergedInto: "open_content" } },
  { tool: "open_pasted_text", capability: "open to read/illustrate", disposition: { mergedInto: "open_content" } },
  { tool: "open_code", capability: "open code as a code book", disposition: { mergedInto: "open_content" } },
  { tool: "open_image", capability: "show an image inline", disposition: "kept" },
  { tool: "remove_library_book", capability: "manage the library", disposition: "kept" },

  // Spreadsheets & data
  { tool: "create_spreadsheet", capability: "build a spreadsheet", disposition: "kept" },
  { tool: "create_document", capability: "write a document", disposition: "kept" },

  // Story "as you go" — start moves to a click; continuing an OPEN story stays a tool.
  { tool: "start_story", capability: "co-write an illustrated story", disposition: { movedToClick: "Open Book → Story as you go (/story)" } },
  // The three continuation tools left the model surface — they confused the model. Continuing is now a
  // plain prose reply the worker turns into the next beat; cadence + redraw are Story-header controls.
  // The executors are kept and retriggered from the worker/UI, so no capability is lost.
  { tool: "continue_story", capability: "co-write an illustrated story", disposition: { movedToClick: "Story mode — the prose reply IS the next beat" } },
  { tool: "render_scene", capability: "co-write an illustrated story", disposition: { movedToClick: "Story header → Illustrate / redraw control" } },
  { tool: "set_story_cadence", capability: "co-write an illustrated story", disposition: { movedToClick: "Story header → cadence control" } },

  // Image generation & settings
  { tool: "generate_image", capability: "generate an image", disposition: "kept" },
  { tool: "set_visual_style", capability: "art style & cadence", disposition: "kept" },
  { tool: "update_setting", capability: "change a setting", disposition: "kept" },
  { tool: "setup_help", capability: "guided setup", disposition: "kept" },

  // Markets & finance
  { tool: "stock_quote", capability: "stock quotes", disposition: "kept" },
  { tool: "market_analysis", capability: "technical analysis", disposition: "kept" },
  { tool: "set_price_alert", capability: "price alerts", disposition: "kept" },
  { tool: "list_alerts", capability: "price alerts", disposition: "kept" },
  { tool: "cancel_alert", capability: "price alerts", disposition: "kept" },
  { tool: "trading_script", capability: "Pine/thinkScript", disposition: "kept" },
  { tool: "schwab_quote", capability: "Schwab account", disposition: "kept" },
  { tool: "schwab_options", capability: "Schwab account", disposition: "kept" },
  { tool: "schwab_positions", capability: "Schwab account", disposition: "kept" },
  { tool: "schwab_watchlists", capability: "Schwab account", disposition: "kept" },
  { tool: "prep_order", capability: "review-and-place orders", disposition: "kept" },
  { tool: "tv_chart", capability: "TradingView bridge", disposition: "kept" },

  // Task orchestration & scheduling
  { tool: "plan_task", capability: "task planning", disposition: "kept" },
  { tool: "list_task_plans", capability: "task planning", disposition: "kept" },
  { tool: "get_task_plan", capability: "task planning", disposition: "kept" },
  { tool: "add_task_steps", capability: "task planning", disposition: "kept" },
  { tool: "update_task_step", capability: "task planning", disposition: "kept" },
  { tool: "mark_step_done", capability: "task planning", disposition: "kept" },
  { tool: "schedule_task", capability: "scheduled tasks", disposition: "kept" },
  { tool: "list_scheduled", capability: "scheduled tasks", disposition: "kept" },
  { tool: "cancel_scheduled", capability: "scheduled tasks", disposition: "kept" },
  { tool: "set_plan", capability: "in-chat checklist", disposition: "kept" },
  { tool: "complete_step", capability: "in-chat checklist", disposition: "kept" },

  // Google
  { tool: "gmail_search", capability: "Gmail", disposition: "kept" },
  { tool: "read_email", capability: "Gmail", disposition: { mergedInto: "read" } },
  { tool: "read_attachment", capability: "Gmail attachments", disposition: { mergedInto: "read" } },
  { tool: "draft_email", capability: "Gmail", disposition: "kept" },
  { tool: "send_email", capability: "Gmail", disposition: "kept" },
  { tool: "list_events", capability: "Calendar", disposition: "kept" },
  { tool: "create_event", capability: "Calendar", disposition: "kept" },
  { tool: "list_tasks", capability: "Google Tasks", disposition: "kept" },
  { tool: "create_task", capability: "Google Tasks", disposition: "kept" },
  { tool: "add_task_group", capability: "Google Tasks", disposition: "kept" },

  // Desktop PC tools
  { tool: "find_files", capability: "find files on the PC", disposition: "kept" },
  { tool: "read_file", capability: "read any local file", disposition: { mergedInto: "read" } },
  { tool: "write_file", capability: "write to the workspace", disposition: "kept" },
  { tool: "run_command", capability: "run & test code", disposition: "kept" },
  { tool: "screenshot", capability: "see the screen", disposition: "kept" },
  { tool: "spawn_agents", capability: "parallel sub-agents", disposition: "kept" },
  { tool: "spawn_coding_agents", capability: "parallel coding agents", disposition: "kept" },
  { tool: "delegate", capability: "sub-agent delegation", disposition: "kept" },

  // MCP
  { tool: "mcp_tools", capability: "MCP servers", disposition: "kept" },
  { tool: "mcp_call", capability: "MCP servers", disposition: "kept" },

  // Memory & skills
  { tool: "remember", capability: "long-term memory", disposition: "kept" },
  { tool: "forget", capability: "long-term memory", disposition: "kept" },
  { tool: "read_skill", capability: "reusable skills", disposition: "kept" },
  { tool: "save_skill", capability: "reusable skills", disposition: "kept" },
  { tool: "forget_skill", capability: "reusable skills", disposition: "kept" },
];

/** Tools the model still calls directly (advertised on their own). */
export function keptTools(): string[] {
  return TOOL_INVENTORY.filter((e) => e.disposition === "kept").map((e) => e.tool);
}

/** Tools no longer advertised on their own but reachable through a consolidated tool or a click —
 * paired with what now provides the capability. */
export function consolidatedTools(): { tool: string; via: string }[] {
  return TOOL_INVENTORY.flatMap((e) =>
    e.disposition === "kept"
      ? []
      : [{ tool: e.tool, via: "mergedInto" in e.disposition ? e.disposition.mergedInto : e.disposition.movedToClick }],
  );
}

/** The distinct user-facing capability areas covered by the inventory (every one must survive). */
export function capabilityAreas(): string[] {
  return [...new Set(TOOL_INVENTORY.map((e) => e.capability))];
}
