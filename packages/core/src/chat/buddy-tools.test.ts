import { describe, expect, it } from "vitest";
import {
  buildBuddySystemPrompt,
  formatBuddyToolResult,
  parseBuddyToolCall,
} from "./buddy-tools.js";

describe("parseBuddyToolCall", () => {
  it("parses the search tools", () => {
    expect(parseBuddyToolCall('{"tool":"search_books","query":"frankenstein"}')).toEqual({
      tool: "search_books",
      query: "frankenstein",
    });
    expect(parseBuddyToolCall('{"tool":"search_web","query":"citric acid cycle"}')).toEqual({
      tool: "search_web",
      query: "citric acid cycle",
    });
  });

  it("parses open_library_book with a defaulted visuals flag", () => {
    expect(parseBuddyToolCall('{"tool":"open_library_book","id":"text-abc123"}')).toEqual({
      tool: "open_library_book",
      id: "text-abc123",
      visuals: false,
    });
    expect(
      parseBuddyToolCall('{"tool":"open_library_book","id":"text-abc123","visuals":true}'),
    ).toEqual({ tool: "open_library_book", id: "text-abc123", visuals: true });
  });

  it("parses open_web_text and defaults mode to fiction", () => {
    expect(
      parseBuddyToolCall(
        '{"tool":"open_web_text","url":"https://example.org/book.txt","title":"A Book","visuals":true}',
      ),
    ).toEqual({
      tool: "open_web_text",
      url: "https://example.org/book.txt",
      title: "A Book",
      mode: "fiction",
      visuals: true,
    });
    expect(
      parseBuddyToolCall('{"tool":"open_web_text","url":"https://example.org/a","mode":"technical"}'),
    ).toMatchObject({ mode: "technical", visuals: false });
  });

  it("rejects non-http URLs", () => {
    expect(
      parseBuddyToolCall('{"tool":"open_web_text","url":"file:///etc/passwd"}'),
    ).toBeUndefined();
    expect(
      parseBuddyToolCall('{"tool":"open_web_text","url":"javascript:alert(1)"}'),
    ).toBeUndefined();
  });

  it("parses the assistant-side tools (images, random picks, style, render)", () => {
    expect(parseBuddyToolCall('{"tool":"search_images","query":"thermodynamic cycle diagram"}')).toEqual({
      tool: "search_images",
      query: "thermodynamic cycle diagram",
    });
    expect(parseBuddyToolCall('{"tool":"random_books"}')).toEqual({ tool: "random_books" });
    expect(
      parseBuddyToolCall('{"tool":"set_visual_style","style":"oil painting","pagesPerImage":"chapter"}'),
    ).toEqual({ tool: "set_visual_style", style: "oil painting", pagesPerImage: "chapter" });
    expect(parseBuddyToolCall('{"tool":"set_visual_style","pagesPerImage":3}')).toEqual({
      tool: "set_visual_style",
      pagesPerImage: 3,
    });
    // No-op style call (neither field) is rejected; page counts are clamped.
    expect(parseBuddyToolCall('{"tool":"set_visual_style"}')).toBeUndefined();
    expect(parseBuddyToolCall('{"tool":"set_visual_style","pagesPerImage":99}')).toEqual({
      tool: "set_visual_style",
      pagesPerImage: 10,
    });
    expect(
      parseBuddyToolCall('{"tool":"generate_image","prompt":"an apple","steps":20,"style":"watercolor"}'),
    ).toEqual({ tool: "generate_image", prompt: "an apple", steps: 20, style: "watercolor" });
  });

  it("only fires when the entire reply is one JSON object", () => {
    expect(
      parseBuddyToolCall('Sure! {"tool":"search_books","query":"dracula"}'),
    ).toBeUndefined();
    expect(parseBuddyToolCall("just prose")).toBeUndefined();
    expect(parseBuddyToolCall('{"tool":"unknown_tool","query":"x"}')).toBeUndefined();
  });

  it("accepts a fenced JSON reply and caps argument lengths", () => {
    expect(parseBuddyToolCall('```json\n{"tool":"search_books","query":"poe"}\n```')).toEqual({
      tool: "search_books",
      query: "poe",
    });
    const long = "q".repeat(500);
    expect(parseBuddyToolCall(`{"tool":"search_web","query":"${long}"}`)?.tool === "search_web").toBe(
      true,
    );
    const parsed = parseBuddyToolCall(`{"tool":"search_web","query":"${long}"}`);
    expect(parsed && "query" in parsed ? parsed.query.length : 0).toBe(200);
  });
});

describe("formatBuddyToolResult", () => {
  it("numbers book hits with their text URLs", () => {
    const text = formatBuddyToolResult(
      { tool: "search_books", query: "frankenstein" },
      {
        books: [
          {
            title: "Frankenstein",
            author: "Mary Shelley",
            textUrl: "https://gutenberg.org/files/84.txt",
            pageUrl: "https://gutenberg.org/ebooks/84",
          },
        ],
      },
    );
    expect(text).toContain("[1] Frankenstein — Mary Shelley");
    expect(text).toContain("https://gutenberg.org/files/84.txt");
    expect(text).toContain("open_web_text");
  });

  it("reports an open with structure and the visuals state", () => {
    const started = formatBuddyToolResult(
      { tool: "open_library_book", id: "x", visuals: true },
      { opened: { title: "Dracula", chapters: 27, pages: 310, visuals: true } },
    );
    expect(started).toContain('"Dracula"');
    expect(started).toContain("27 chapters");
    expect(started).toContain("generation has started");
    const waiting = formatBuddyToolResult(
      { tool: "open_library_book", id: "x", visuals: false },
      { opened: { title: "Dracula", chapters: 1, pages: 1, visuals: false } },
    );
    expect(waiting).toContain("presses Start");
  });

  it("formats the assistant-side results (random picks, images, style, render)", () => {
    const random = formatBuddyToolResult(
      { tool: "random_books" },
      { books: [{ title: "Dracula", author: "Bram Stoker", textUrl: "https://g.test/345.txt" }] },
    );
    expect(random).toContain("random classics");
    expect(random).toContain("[1] Dracula — Bram Stoker");
    const figures = formatBuddyToolResult(
      { tool: "search_images", query: "carnot cycle" },
      { imageHits: [{ link: "https://img.test/c.png", title: "Carnot cycle.png" }] },
    );
    expect(figures).toContain("already shown to the reader inline");
    const style = formatBuddyToolResult(
      { tool: "set_visual_style", style: "oil painting", pagesPerImage: "chapter" },
      { applied: { style: "Oil painting", pagesPerImage: "chapter" } },
    );
    expect(style).toContain('art style "Oil painting"');
    expect(style).toContain("per chapter");
    expect(
      formatBuddyToolResult({ tool: "generate_image", prompt: "an apple" }, { image: { ok: true } }),
    ).toContain("shown to the reader");
  });

  it("formats failures with a recovery instruction", () => {
    const text = formatBuddyToolResult(
      { tool: "open_web_text", url: "https://x.test", mode: "fiction", visuals: false },
      { error: "CORS blocked" },
    );
    expect(text).toContain("failed: CORS blocked");
    expect(text).toContain("pasting/uploading");
  });
});

describe("buildBuddySystemPrompt", () => {
  it("lists the library with ids and switches persona text", () => {
    const prompt = buildBuddySystemPrompt({
      persona: "entertainment",
      library: [{ id: "text-1", title: "Dune", author: "Frank Herbert", addedAt: 1 }],
    });
    expect(prompt).toContain('"Dune" by Frank Herbert — id: text-1');
    expect(prompt).toContain("reading buddy");
    const tech = buildBuddySystemPrompt({ persona: "technical", library: [] });
    expect(tech).toContain("research buddy");
    expect(tech).toContain("LIBRARY is empty");
  });
});
