/**
 * Tool documentation the model loads WHEN IT NEEDS IT, instead of carrying on every turn.
 *
 * The system prompt had grown to ~10,700 tokens before a word of conversation, and two-thirds of that
 * was capability documentation for things a given conversation never touches: how to run commands,
 * how to animate a video, how to build a spreadsheet, how to change a setting. All of it correct, all
 * of it present, none of it relevant — and on a local model it left barely room for the last exchange.
 *
 * So the prompt keeps what is needed to make the FIRST decision — who the assistant is, the policy
 * that shapes every reply, the handful of tools it uses without being asked, and a one-line index of
 * everything else — and the rest is fetched on demand.
 *
 * TWO PROPERTIES MAKE THIS SAFE, and both matter more than the saving:
 *
 *  1. A toolset's document is DERIVED, never written twice. `toolsetDoc` builds the real prompt with
 *     and without the toolset and returns the difference, so the documentation the model loads is by
 *     construction the exact text the prompt would have carried. There is no second copy to drift.
 *  2. Forgetting to load is not a failure. A call to a tool from an unloaded set is answered with the
 *     document itself — see {@link toolsetForTool} and the dispatcher — so the model gets what it
 *     needed and re-issues the call. It never has to remember to look something up first, which is
 *     the assumption most progressive-disclosure schemes quietly depend on and small models break.
 */

/** The capability flags a toolset switches on in `buildBuddySystemPrompt`. */
export type ToolsetFlag =
  | "canSearchFiles"
  | "canRunCommands"
  | "canAutonomousWorkspace"
  | "canDelegateCoding"
  | "canGithub"
  | "canGenerateVideo"
  | "canWolfram"
  | "canGoogle"
  | "canMarkets"
  | "canTaskTools"
  | "canSubAgents"
  | "canDocuments"
  | "canSpreadsheets"
  | "canAppSettings"
  | "canBooks";

export interface Toolset {
  id: string;
  /**
   * Flags this toolset introduced, which had no flag before it existed — the blocks that used to be
   * unconditional. They must default ON when a caller hasn't opted into on-demand loading, or the
   * legacy prompt silently loses documentation it always carried.
   */
  newFlags?: ToolsetFlag[];
  /** One line for the index: what this is FOR, phrased as the trigger to reach for it. */
  trigger: string;
  /** Prompt flags this toolset turns on. */
  flags: ToolsetFlag[];
  /** Tool names it documents — used to answer a call to something not yet loaded. */
  tools: string[];
}

/**
 * Tools the assistant uses WITHOUT being asked, so their documentation can never be deferred.
 *
 * The test is not "how often" but "would it occur to the model to go and look this up first". Reading
 * is the loader itself. Remembering happens because the reader said something worth keeping, not
 * because they asked for it. A checklist gets ticked as work completes. Searching and picturing are
 * reached for mid-sentence. A model that has to fetch a manual before it can remember your name will
 * simply not remember your name.
 */
export const ALWAYS_ON_TOOLS = [
  "read",
  "remember",
  "forget",
  "set_plan",
  "complete_step",
  "generate_image",
  "search_web",
  "search_images",
  "calculate",
  "load_toolset",
  // The assistant's memory of its OWN unattended work. It failed the always-on test in the most
  // literal way: asked "what have you done today?", a model does not think "I should fetch the
  // task-management manual" — it answers from nothing. Self-knowledge cannot sit behind a load, for
  // the same reason remembering your name cannot.
  "recent_actions",
  // Opening a URL, pasted text or code as something readable is documented UNCONDITIONALLY, so it
  // must be callable unconditionally too. Listing it under `books` meant the prompt showed the call
  // and the gate then rejected it — advertise-then-refuse, the same shape as create_document.
  "open_content",
] as const;

export const TOOLSETS: readonly Toolset[] = [
  {
    id: "files",
    trigger: "find, open and read files on the reader's own computer",
    flags: ["canSearchFiles"],
    tools: ["find_files", "open_image", "read_file", "extract_from_document"],
  },
  {
    id: "coding",
    trigger: "write, edit and RUN code; shell commands; screenshots; GitHub; hand work to a coding agent",
    flags: ["canRunCommands", "canAutonomousWorkspace", "canDelegateCoding", "canGithub"],
    tools: ["run_command", "write_file", "edit_file", "screenshot", "delegate_coding_task", "spawn_coding_agents"],
  },
  {
    id: "documents",
    trigger: "make or revise a real document — PDF or Word, with headings, images and layout",
    flags: ["canDocuments"],
    newFlags: ["canDocuments"],
    tools: ["create_document", "edit_document", "read_document"],
  },
  {
    id: "spreadsheets",
    trigger: "build or work with a spreadsheet, table or dataset",
    flags: ["canSpreadsheets"],
    newFlags: ["canSpreadsheets"],
    tools: ["create_spreadsheet", "set_cell", "add_formula_column", "read_data"],
  },
  {
    id: "video",
    trigger: "make a video, animate an existing image, or join clips together",
    flags: ["canGenerateVideo"],
    tools: ["generate_video", "generate_long_video", "stitch_videos"],
  },
  {
    id: "books",
    trigger: "find, open, illustrate or manage books and the reader's library",
    flags: ["canBooks"],
    newFlags: ["canBooks"],
    tools: ["search_books", "random_books", "open_library_book", "remove_library_book", "set_visual_style"],
  },
  {
    id: "settings",
    trigger: "change one of the app's own settings, or explain how to set something up",
    flags: ["canAppSettings"],
    newFlags: ["canAppSettings"],
    tools: ["update_setting", "setup_help"],
  },
  {
    id: "google",
    trigger: "the reader's email, calendar and Google tasks",
    flags: ["canGoogle"],
    tools: [
      "gmail_search", "read_email", "read_attachment", "draft_email", "list_drafts", "edit_draft",
      "send_email", "list_events", "create_event", "update_event", "list_tasks", "create_task",
      "add_task_group",
    ],
  },
  {
    id: "tasks",
    trigger: "plan, schedule and track multi-step work across sessions; the reader's to-dos and scheduled actions",
    flags: ["canTaskTools"],
    tools: [
      "plan_task", "schedule_task", "list_scheduled", "cancel_scheduled", "mark_step_done",
      "complete_task", "save_task_context", "update_task_step", "update_task", "update_task_doc",
      "add_task_steps", "list_task_plans",
      "get_task_plan",
    ],
  },
  {
    id: "markets",
    trigger: "stock quotes, market analysis, price alerts and trading scripts",
    flags: ["canMarkets"],
    // set_price_alert, not price_alert — a name no tool has matched nothing, so the real tool sat in
    // no toolset at all: its documentation deferred with the rest of markets, but with no group to
    // load and nothing to gate it. Invisible and unloadable. The roster test below now forbids it.
    tools: ["stock_quote", "market_analysis", "set_price_alert", "list_alerts", "cancel_alert", "trading_script", "tv_chart", "prep_order"],
  },
  {
    id: "agents",
    trigger: "split a big job across parallel sub-agents",
    flags: ["canSubAgents"],
    tools: ["delegate", "spawn_agents"],
  },
  {
    id: "wolfram",
    trigger: "authoritative real-world data and computation (Wolfram|Alpha)",
    flags: ["canWolfram"],
    tools: ["wolfram"],
  },
];

/**
 * Whether the ENVIRONMENT can offer this toolset at all — a fact about the reader's machine and
 * accounts, decided before anything is loaded.
 *
 * `undefined` is the case that matters. For a flag that predates on-demand loading, the host adds it
 * only when the capability is real — `canGoogle` appears when Google is actually connected — so an
 * absent flag means absent, and listing it would offer to read mail from an account nobody linked.
 * For a flag this scheme INVENTED (`newFlags`), the block it gates used to be unconditional, so an
 * absent flag means it was always on. Same word, opposite meaning; the registry knows which is which.
 * PURE.
 */
export function toolsetAvailable(set: Toolset, flags: Readonly<Record<string, unknown>>): boolean {
  return set.flags.some((f) =>
    flags[f] === undefined ? set.newFlags?.includes(f) === true : flags[f] !== false,
  );
}

/** Every toolset id, for validating a `load_toolset` argument. */
export const TOOLSET_IDS: readonly string[] = TOOLSETS.map((t) => t.id);

/** The toolset documenting a tool, or undefined when it is always-on (or unknown). */
export function toolsetForTool(tool: string): Toolset | undefined {
  if ((ALWAYS_ON_TOOLS as readonly string[]).includes(tool)) return undefined;
  return TOOLSETS.find((t) => t.tools.includes(tool));
}

/** Whether a tool may be called right now: always-on, or its toolset is loaded. */
export function isToolAvailable(tool: string, loaded: readonly string[]): boolean {
  const set = toolsetForTool(tool);
  return !set || loaded.includes(set.id);
}

/**
 * The index that replaces ~8,600 tokens of tool documentation.
 *
 * Only toolsets the environment actually permits are listed — a phone has no shell, so offering to
 * load the coding manual would be advertising something that cannot work. A loaded set is marked, so
 * the model can see it already has the details rather than loading them twice.
 */
export function toolsetIndexBlock(available: readonly string[], loaded: readonly string[] = []): string {
  const rows = TOOLSETS.filter((t) => available.includes(t.id));
  if (rows.length === 0) return "";
  const lines = rows.map((t) => `- ${t.id}${loaded.includes(t.id) ? " (loaded)" : ""} — ${t.trigger}`);
  return (
    "YOU CAN DO MORE THAN THE TOOLS BELOW. These groups are things you CAN do; their instructions " +
    "are not in front of you yet, which is what keeps room for the actual conversation. NEVER tell " +
    "the reader you are unable to do something in this list — load it and do it:\n" +
    lines.join("\n") +
    '\n\nTo load one: {"tool":"load_toolset","name":"<group>"}. The full instructions come straight ' +
    "back and stay for the rest of the conversation; then make the real call. If you call one of " +
    "their tools without loading it first you get the instructions back rather than an error, so a " +
    "guess costs nothing — but loading first is quicker."
  );
}
