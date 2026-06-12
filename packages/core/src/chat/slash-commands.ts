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
  { name: "remove", args: "<title>", description: "Remove a book from the library" },
  { name: "images", args: "<query>", description: "Find a real figure/diagram/photo" },
  { name: "draw", args: "<prompt>", description: "Generate a new image (one-click confirm)" },
  { name: "calc", args: "<expression>", description: "Exact arithmetic (sqrt, sin, ^, !, pi…)" },
  { name: "style", args: "<art style>", description: "Set the app's art style" },
  { name: "remember", args: "<note>", description: "Save a note to long-term memory" },
  { name: "forget", args: "<text>", description: "Remove memory notes containing this text" },
];

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
    case "random":
      return { call: { tool: "random_books" } };
    case "calc": {
      const call = viaParser(parseBuddyToolCall, { tool: "calculate", expression: s.args });
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
