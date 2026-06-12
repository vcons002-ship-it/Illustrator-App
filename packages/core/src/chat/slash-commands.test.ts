import { describe, expect, it } from "vitest";
import { parseBuddySlashCommand, parseChatSlashCommand } from "./slash-commands.js";
import type { BookSummary } from "../storage/store.js";

const library: BookSummary[] = [
  { id: "bk-1", title: "Frankenstein", addedAt: 1 },
  { id: "bk-2", title: "Fourth Wing", addedAt: 2 },
  { id: "bk-3", title: "The Time Machine", addedAt: 3 },
];

describe("parseChatSlashCommand", () => {
  it("ignores ordinary messages", () => {
    expect(parseChatSlashCommand("what happens next?")).toBeUndefined();
    expect(parseChatSlashCommand("ratio of 1/2")).toBeUndefined();
  });

  it("builds the matching tool calls", () => {
    expect(parseChatSlashCommand("/bible Violet")).toEqual({ call: { tool: "lookup_bible", query: "Violet" } });
    expect(parseChatSlashCommand("/book first dragon scene")).toEqual({
      call: { tool: "search_book", query: "first dragon scene" },
    });
    expect(parseChatSlashCommand("/web Krebs cycle")).toEqual({ call: { tool: "search_web", query: "Krebs cycle" } });
    expect(parseChatSlashCommand("/images jet engine cutaway")).toEqual({
      call: { tool: "search_images", query: "jet engine cutaway" },
    });
    expect(parseChatSlashCommand("/draw a castle at dusk")).toEqual({
      call: { tool: "generate_image", prompt: "a castle at dusk" },
    });
    expect(parseChatSlashCommand("/remember prefers watercolor")).toEqual({
      call: { tool: "remember", note: "prefers watercolor" },
    });
    expect(parseChatSlashCommand("/forget watercolor")).toEqual({ call: { tool: "forget", match: "watercolor" } });
  });

  it("inherits the model-path argument caps (query trimmed to 200 chars)", () => {
    const r = parseChatSlashCommand(`/web ${"x".repeat(500)}`);
    expect(r && "call" in r && r.call.tool === "search_web" && r.call.query.length).toBe(200);
  });

  it("returns usage for missing args and lists commands for unknown names", () => {
    expect(parseChatSlashCommand("/web")).toMatchObject({ error: expect.stringContaining("Usage: /web") });
    expect(parseChatSlashCommand("/")).toMatchObject({ error: expect.stringContaining("Unknown command") });
    expect(parseChatSlashCommand("/frobnicate now")).toMatchObject({
      error: expect.stringContaining("/bible"),
    });
  });
});

describe("parseBuddySlashCommand", () => {
  it("builds search/calc/style/memory calls", () => {
    expect(parseBuddySlashCommand("/books gothic horror", library)).toEqual({
      call: { tool: "search_books", query: "gothic horror" },
    });
    expect(parseBuddySlashCommand("/random", library)).toEqual({ call: { tool: "random_books" } });
    expect(parseBuddySlashCommand("/calc sqrt(144) * 2", library)).toEqual({
      call: { tool: "calculate", expression: "sqrt(144) * 2" },
    });
    expect(parseBuddySlashCommand("/style oil painting", library)).toEqual({
      call: { tool: "set_visual_style", style: "oil painting" },
    });
    expect(parseBuddySlashCommand("/remember loves sci-fi", library)).toEqual({
      call: { tool: "remember", note: "loves sci-fi" },
    });
  });

  it("resolves /open and /remove against library titles (case-insensitive, unique substring)", () => {
    expect(parseBuddySlashCommand("/open frankenstein", library)).toEqual({
      call: { tool: "open_library_book", id: "bk-1", visuals: false },
    });
    expect(parseBuddySlashCommand("/open time machine", library)).toEqual({
      call: { tool: "open_library_book", id: "bk-3", visuals: false },
    });
    expect(parseBuddySlashCommand("/remove fourth wing", library)).toEqual({
      call: { tool: "remove_library_book", id: "bk-2" },
    });
    // Ambiguous and missing titles explain themselves.
    expect(parseBuddySlashCommand("/open f", library)).toMatchObject({
      error: expect.stringContaining("matches several"),
    });
    expect(parseBuddySlashCommand("/open dune", library)).toMatchObject({
      error: expect.stringContaining("No library book"),
    });
    expect(parseBuddySlashCommand("/open dune", [])).toMatchObject({
      error: expect.stringContaining("library is empty"),
    });
  });

  it("opens URLs with an optional trailing mode flag", () => {
    expect(parseBuddySlashCommand("/open https://example.org/paper", library)).toEqual({
      call: { tool: "open_web_text", url: "https://example.org/paper", mode: "fiction", visuals: false },
    });
    expect(parseBuddySlashCommand("/open https://example.org/paper technical", library)).toEqual({
      call: { tool: "open_web_text", url: "https://example.org/paper", mode: "technical", visuals: false },
    });
  });

  it("ignores ordinary messages and rejects unknown commands", () => {
    expect(parseBuddySlashCommand("open something nice", library)).toBeUndefined();
    expect(parseBuddySlashCommand("/zap", library)).toMatchObject({
      error: expect.stringContaining("Available:"),
    });
  });
});
