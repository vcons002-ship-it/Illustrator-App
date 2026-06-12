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
    expect(parseBuddyToolCall('{"tool":"calculate","expression":"sqrt(144) * 2"}')).toEqual({
      tool: "calculate",
      expression: "sqrt(144) * 2",
    });
    expect(parseBuddyToolCall('{"tool":"calculate"}')).toBeUndefined();
    expect(
      parseBuddyToolCall(
        '{"tool":"set_visual_style","style":"oil painting","pagesPerImage":"chapter","illustrateAfter":"chapter"}',
      ),
    ).toEqual({
      tool: "set_visual_style",
      style: "oil painting",
      pagesPerImage: "chapter",
      illustrateAfter: "chapter",
    });
    expect(parseBuddyToolCall('{"tool":"set_visual_style","pagesPerImage":3}')).toEqual({
      tool: "set_visual_style",
      pagesPerImage: 3,
    });
    // No-op style call (no field) is rejected; page counts clamp; bad cadence dropped.
    expect(parseBuddyToolCall('{"tool":"set_visual_style"}')).toBeUndefined();
    expect(parseBuddyToolCall('{"tool":"set_visual_style","illustrateAfter":"weekly"}')).toBeUndefined();
    expect(parseBuddyToolCall('{"tool":"set_visual_style","pagesPerImage":99}')).toEqual({
      tool: "set_visual_style",
      pagesPerImage: 10,
    });
    expect(
      parseBuddyToolCall('{"tool":"generate_image","prompt":"an apple","steps":20,"style":"watercolor"}'),
    ).toEqual({ tool: "generate_image", prompt: "an apple", steps: 20, style: "watercolor" });
  });

  it("parses open_pasted_text (defaults title/mode) and remove_library_book", () => {
    expect(
      parseBuddyToolCall('{"tool":"open_pasted_text","text":"Two roads diverged…","visuals":true}'),
    ).toEqual({
      tool: "open_pasted_text",
      text: "Two roads diverged…",
      title: "Pasted text",
      mode: "fiction",
      visuals: true,
    });
    // Empty/whitespace text is rejected (nothing to open).
    expect(parseBuddyToolCall('{"tool":"open_pasted_text","text":"   "}')).toBeUndefined();
    expect(parseBuddyToolCall('{"tool":"remove_library_book","id":"text-abc"}')).toEqual({
      tool: "remove_library_book",
      id: "text-abc",
    });
    expect(parseBuddyToolCall('{"tool":"remove_library_book"}')).toBeUndefined();
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
      {
        books: [
          {
            title: "Dracula",
            author: "Bram Stoker",
            textUrl: "https://g.test/345.txt",
            subjects: ["Horror tales", "Vampires"],
          },
        ],
      },
    );
    expect(random).toContain("random classics");
    expect(random).toContain("[1] Dracula — Bram Stoker [Horror tales, Vampires]");
    const figures = formatBuddyToolResult(
      { tool: "search_images", query: "carnot cycle" },
      { imageHits: [{ link: "https://img.test/c.png", title: "Carnot cycle.png" }] },
    );
    expect(figures).toContain("already shown to the reader inline");
    const style = formatBuddyToolResult(
      { tool: "set_visual_style", style: "oil painting", pagesPerImage: "chapter", illustrateAfter: "chapter" },
      { applied: { style: "Oil painting", pagesPerImage: "chapter", illustrateAfter: "chapter" } },
    );
    expect(style).toContain('art style "Oil painting"');
    expect(style).toContain("per chapter");
    expect(style).toContain("as each chapter finishes");
    expect(
      formatBuddyToolResult({ tool: "generate_image", prompt: "an apple" }, { image: { ok: true } }),
    ).toContain("shown to the reader");
    expect(
      formatBuddyToolResult(
        { tool: "calculate", expression: "sqrt(144) * 2" },
        { calc: { expression: "sqrt(144) * 2", result: "24" } },
      ),
    ).toContain("sqrt(144) * 2 = 24");
  });

  it("formats remove_library_book (hit and miss)", () => {
    expect(
      formatBuddyToolResult({ tool: "remove_library_book", id: "x" }, { removed: "Dune" }),
    ).toContain('removed "Dune"');
    expect(
      formatBuddyToolResult({ tool: "remove_library_book", id: "x" }, {}),
    ).toContain("nothing matched");
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

  it("freeform leads as a general assistant and never steers toward books", () => {
    const prompt = buildBuddySystemPrompt({ persona: "freeform", library: [] });
    expect(prompt).toContain("general conversational assistant");
    expect(prompt).toContain("OPERATE ON REQUEST");
    expect(prompt).toContain("NEVER steer the chat toward opening");
  });

  it("every persona carries the show-me-vs-generate image-tool rule", () => {
    for (const persona of ["freeform", "entertainment", "technical"] as const) {
      const prompt = buildBuddySystemPrompt({ persona, library: [] });
      expect(prompt).toContain("PICKING THE IMAGE TOOL");
      expect(prompt).toContain("search_images");
      // The persona text itself must not bias toward generation.
      expect(prompt).not.toContain("offer concept art");
    }
  });
});
