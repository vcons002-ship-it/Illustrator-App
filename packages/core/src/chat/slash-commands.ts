import type { BookSummary } from "../storage/store.js";
import { parseToolCall, type ToolCall } from "./chat-tools.js";
import { parseBuddyToolCall, type BuddyToolCall } from "./buddy-tools.js";

/**
 * Slash commands — the deterministic way to call a chat tool. Typing "/" in
 * either chat panel lists these; sending "/cmd args" executes the tool DIRECTLY
 * in the worker (no LLM round: instant, free, and immune to a model deciding
 * not to cooperate). Every command builds the same ToolCall/BuddyToolCall the
 * model would emit, round-tripped through the regular parsers so the exact same
 * argument caps and validation apply.
 */

export interface SlashCommandInfo {
  /** Command name without the slash ("web" → "/web"). */
  name: string;
  /** Argument hint shown in the menu ("" for none). */
  args: string;
  description: string;
}

export type SlashParse<T> = { call: T } | { error: string };

/** In-book chat commands (ToolCall union). */
export const CHAT_SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: "bible", args: "<name or term>", description: "Full Visual Bible detail for a character, place, or term" },
  { name: "book", args: "<keywords>", description: "Find passages elsewhere in the book" },
  { name: "web", args: "<query>", description: "Search the web" },
  { name: "images", args: "<query>", description: "Find a real figure/diagram/photo" },
  { name: "draw", args: "<prompt>", description: "Generate a new image (one-click confirm)" },
  { name: "remember", args: "<note>", description: "Save a note to long-term memory" },
  { name: "forget", args: "<text>", description: "Remove memory notes containing this text" },
];

/** Landing-buddy commands (BuddyToolCall union). */
export const BUDDY_SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: "web", args: "<query>", description: "Search the web" },
  { name: "books", args: "<query>", description: "Search Project Gutenberg" },
  { name: "random", args: "", description: "Surprise picks from the classics shelf" },
  { name: "open", args: "<title | url> [technical]", description: "Open a library book or fetch a URL into the reader" },
  { name: "story", args: "<opening scene>", description: "Start an illustrated story you co-write as you go" },
  { name: "remove", args: "<title>", description: "Remove a book from the library" },
  { name: "images", args: "<query>", description: "Find a real figure/diagram/photo" },
  // The DETERMINISTIC way to adopt a reference, and what the gallery's "Use as reference" button
  // sends. The button used to ask the model in English ("use this exact picture as a reference: …"),
  // which made a reader's explicit click depend on the model recognising the request, choosing
  // use_image_reference, and picking the url form over a re-search. A click is not a request.
  { name: "reference", args: "<image url | description>", description: "Use a picture as the reference for images in this chat" },
  { name: "draw", args: "<prompt>", description: "Generate a new image (one-click confirm)" },
  { name: "calc", args: "<expression>", description: "Exact arithmetic (sqrt, sin, ^, !, pi…)" },
  // The DETERMINISTIC way to a real number. Everything else about the market tools is persuasion —
  // the model deciding, each turn, whether a price question warrants loading a toolset — and a
  // reader who just wants the quote shouldn't be relying on that judgement going their way.
  { name: "quote", args: "<ticker>", description: "Live quote for a ticker — price, day range, volume" },
  { name: "ta", args: "<ticker> [interval] [range]", description: "Technicals for a ticker — VWAP, moving averages, RSI" },
  { name: "style", args: "<art style>", description: "Set the app's art style" },
  { name: "remember", args: "<note>", description: "Save a note to long-term memory" },
  { name: "forget", args: "<text>", description: "Remove memory notes containing this text" },
];

/** The desktop-only `/find` command — handled on the MAIN thread, never the LLM
 * (filesystem access is offered solely through this explicit user command, so no
 * web page or book text can talk the model into reading the user's disk). */
export const FIND_FILES_COMMAND: SlashCommandInfo = {
  name: "find",
  args: "<keywords>",
  description: "Search your computer for a book/PDF/text file to open",
};

/**
 * `/code` — hand a job STRAIGHT to the external coding agent, with no model turn in front of it.
 *
 * `delegate_coding_task` is a tool the model MAY choose, and asking for it in plain language is not
 * the same as getting it: told in so many words to "use delegate_coding_task", a model wrote one
 * file with `write_file`, made another with a shell redirect, and ticked its own checklist green —
 * a reasonable-looking turn that never went near the agent. Persuasion is the wrong instrument for
 * a decision the reader has already made.
 *
 * So this is a main-thread command, like `/find`: the reader's words become the agent's task, the
 * host runs it, and the model is not consulted about whether to. That is the whole point.
 */
export const DELEGATE_CODING_COMMAND: SlashCommandInfo = {
  name: "code",
  args: "<what to build or change>",
  description: "Hand the job straight to the external coding agent (Aider/Codex) — no model in between",
};

/**
 * PUT A FILE CARD BACK IN THE CHAT.
 *
 * A card is how a file becomes usable from a phone — 💾 Download, 📖 Open in app, 📖 Read here — and
 * cards only ever appeared as a side effect of the assistant WRITING something. So a file that was
 * written earlier, or edited before the card carried its content, or simply scrolled away, could not
 * be got back at all: the reader could see it in the ledger and had no way to ask for it. Reported as
 * not being able to bring the card back into the chat to download it.
 *
 * Main-thread, like `/find` and `/code`. The file is already on disk and the reader has already named
 * it, so there is nothing for the model to decide and no reason for its cooperation to be a
 * dependency — this session has spent a lot of time on turns that could not make a tool call.
 */
export const SHOW_FILE_COMMAND: SlashCommandInfo = {
  name: "show",
  args: "<file in this chat's folder>",
  description: "Put a file card in the chat — download it, open it, or read it here",
};

/** Buddy commands shown for the given platform (desktop adds local-file search + delegation). */
export function buddySlashCommands(desktop: boolean, canDelegateCoding = false): SlashCommandInfo[] {
  return [
    ...BUDDY_SLASH_COMMANDS,
    ...(desktop ? [FIND_FILES_COMMAND, SHOW_FILE_COMMAND] : []),
    // Only when it can actually run: a command that answers "the agent isn't set up" is worse than
    // one the reader never sees offered.
    ...(desktop && canDelegateCoding ? [DELEGATE_CODING_COMMAND] : []),
  ];
}

/** "/web foo bar" → { name: "web", args: "foo bar" }; undefined for non-slash text. */
function splitSlash(text: string): { name: string; args: string } | undefined {
  const m = /^\/(\S*)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return undefined;
  return { name: m[1]!.toLowerCase(), args: m[2]!.trim() };
}

function usage(info: SlashCommandInfo): { error: string } {
  return { error: `Usage: /${info.name} ${info.args}`.trim() + ` — ${info.description}.` };
}

function unknown(name: string, commands: SlashCommandInfo[]): { error: string } {
  return {
    error: `Unknown command /${name}. Available: ${commands.map((c) => `/${c.name}`).join(", ")}.`,
  };
}

/** Build via the regular parser so the model-path caps/validation apply identically. */
function viaParser<T>(parse: (text: string) => T | undefined, obj: unknown): T | undefined {
  return parse(JSON.stringify(obj));
}

/**
 * Parse an in-book chat slash command. Returns undefined for ordinary messages
 * (not starting with "/"), a tool call to execute, or a usage error to show.
 */
export function parseChatSlashCommand(text: string): SlashParse<ToolCall> | undefined {
  const s = splitSlash(text);
  if (!s) return undefined;
  const info = CHAT_SLASH_COMMANDS.find((c) => c.name === s.name);
  if (!info) return unknown(s.name, CHAT_SLASH_COMMANDS);
  const tool = (
    { bible: "lookup_bible", book: "search_book", web: "search_web", images: "search_images" } as const
  )[s.name];
  const call = tool
    ? viaParser(parseToolCall, { tool, query: s.args })
    : s.name === "draw"
      ? viaParser(parseToolCall, { tool: "generate_image", prompt: s.args })
      : s.name === "remember"
        ? viaParser(parseToolCall, { tool: "remember", note: s.args })
        : viaParser(parseToolCall, { tool: "forget", match: s.args });
  return call ? { call } : usage(info);
}

/**
 * Parse a landing-buddy slash command. `library` resolves /open and /remove by
 * title (or id) — exact match first, then a unique substring match.
 */
export function parseBuddySlashCommand(
  text: string,
  library: readonly BookSummary[],
): SlashParse<BuddyToolCall> | undefined {
  const s = splitSlash(text);
  if (!s) return undefined;
  const info = BUDDY_SLASH_COMMANDS.find((c) => c.name === s.name);
  if (!info) return unknown(s.name, BUDDY_SLASH_COMMANDS);
  switch (s.name) {
    case "web":
    case "images": {
      const tool = s.name === "web" ? ("search_web" as const) : ("search_images" as const);
      const call = viaParser(parseBuddyToolCall, { tool, query: s.args });
      return call ? { call } : usage(info);
    }
    case "books": {
      const call = viaParser(parseBuddyToolCall, { tool: "search_books", query: s.args });
      return call ? { call } : usage(info);
    }
    case "reference": {
      // A URL names the EXACT picture (what the gallery button sends); anything else is a search
      // for one. Same distinction the tool itself draws, made here so the button never re-searches
      // and lands on a different picture than the one the reader pointed at.
      const isUrl = /^https?:\/\/\S+$/i.test(s.args);
      const call = viaParser(parseBuddyToolCall, {
        tool: "use_image_reference",
        ...(isUrl ? { url: s.args } : { query: s.args }),
      });
      return call ? { call } : usage(info);
    }
    case "random":
      return { call: { tool: "random_books" } };
    case "calc": {
      const call = viaParser(parseBuddyToolCall, { tool: "calculate", expression: s.args });
      return call ? { call } : usage(info);
    }
    case "quote": {
      // Only the first word is the ticker; "/quote AAPL please" is a ticker, not a symbol lookup.
      const symbol = s.args.split(/\s+/)[0] ?? "";
      const call = viaParser(parseBuddyToolCall, { tool: "stock_quote", symbol: symbol.toUpperCase() });
      return call ? { call } : usage(info);
    }
    case "ta": {
      const [symbol, interval, range] = s.args.split(/\s+/);
      const call = viaParser(parseBuddyToolCall, {
        tool: "market_analysis",
        symbol: (symbol ?? "").toUpperCase(),
        ...(interval ? { interval } : {}),
        ...(range ? { range } : {}),
      });
      return call ? { call } : usage(info);
    }
    case "style": {
      const call = viaParser(parseBuddyToolCall, { tool: "set_visual_style", style: s.args });
      return call ? { call } : usage(info);
    }
    case "draw": {
      const call = viaParser(parseBuddyToolCall, { tool: "generate_image", prompt: s.args });
      return call ? { call } : usage(info);
    }
    case "remember": {
      const call = viaParser(parseBuddyToolCall, { tool: "remember", note: s.args });
      return call ? { call } : usage(info);
    }
    case "forget": {
      const call = viaParser(parseBuddyToolCall, { tool: "forget", match: s.args });
      return call ? { call } : usage(info);
    }
    case "story": {
      // Story "as you go" is started by a click (the ✍️ Story button), never by the model. The
      // Story-setup modal sends a JSON payload (opening + workflow/cast/characters/roleplay); a
      // plain-text "/story <opening>" is still the quick path. The first words become the title.
      if (!s.args) return usage(info);
      const titleFrom = (text: string) => text.split(/[.!?\n]/)[0]!.trim().split(/\s+/).slice(0, 6).join(" ") || "Our Story";
      if (s.args.startsWith("{")) {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(s.args) as Record<string, unknown>;
        } catch {
          return usage(info);
        }
        const opening = typeof payload.opening === "string" ? payload.opening : "";
        const soFar = typeof payload.soFar === "string" ? payload.soFar.trim() : "";
        // With a chat carried in, the premise is optional — that conversation IS the premise.
        if (!opening.trim() && !soFar) return usage(info);
        const title =
          typeof payload.title === "string" && payload.title.trim()
            ? payload.title
            : titleFrom(opening.trim() || soFar);
        const call = viaParser(parseBuddyToolCall, {
          tool: "start_story",
          title,
          opening,
          ...(typeof payload.style === "string" ? { style: payload.style } : {}),
          ...(Array.isArray(payload.characters) ? { characters: payload.characters } : {}),
          ...(payload.roleplay && typeof payload.roleplay === "object" ? { roleplay: payload.roleplay } : {}),
          // The chat the story has already been told in, when the reader chose to bring it along.
          ...(typeof payload.soFar === "string" ? { soFar: payload.soFar } : {}),
        });
        return call ? { call } : usage(info);
      }
      const call = viaParser(parseBuddyToolCall, { tool: "start_story", title: titleFrom(s.args), opening: s.args });
      return call ? { call } : usage(info);
    }
    case "remove": {
      if (!s.args) return usage(info);
      const hit = resolveLibraryBook(s.args, library);
      if ("error" in hit) return hit;
      return { call: { tool: "remove_library_book", id: hit.id } };
    }
    default: {
      // open
      if (!s.args) return usage(info);
      // Optional trailing mode flag: "/open <url> technical" (URLs only — library
      // books keep their stored mode).
      const modeMatch = /\s+(technical|fiction)$/i.exec(s.args);
      const target = modeMatch ? s.args.slice(0, modeMatch.index).trim() : s.args;
      const mode = modeMatch?.[1]?.toLowerCase() === "technical" ? ("technical" as const) : ("fiction" as const);
      if (/^https?:\/\//i.test(target)) {
        const call = viaParser(parseBuddyToolCall, {
          tool: "open_web_text",
          url: target,
          mode,
          visuals: false,
        });
        return call ? { call } : usage(info);
      }
      const hit = resolveLibraryBook(target, library);
      if ("error" in hit) return hit;
      return { call: { tool: "open_library_book", id: hit.id, visuals: false } };
    }
  }
}

/** Title/id → one library book: exact id, exact title, then UNIQUE substring. */
function resolveLibraryBook(
  query: string,
  library: readonly BookSummary[],
): { id: string } | { error: string } {
  const q = query.trim().toLowerCase();
  const byId = library.find((b) => b.id.toLowerCase() === q);
  if (byId) return { id: byId.id };
  const exact = library.filter((b) => b.title.toLowerCase() === q);
  if (exact.length === 1) return { id: exact[0]!.id };
  const partial = library.filter((b) => b.title.toLowerCase().includes(q));
  if (partial.length === 1) return { id: partial[0]!.id };
  if (partial.length > 1) {
    return {
      error: `"${query}" matches several books: ${partial
        .slice(0, 5)
        .map((b) => `"${b.title}"`)
        .join(", ")} — be more specific.`,
    };
  }
  return {
    error: library.length
      ? `No library book matches "${query}".`
      : `The library is empty — open a book first.`,
  };
}
