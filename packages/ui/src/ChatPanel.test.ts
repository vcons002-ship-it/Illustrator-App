import { describe, expect, it } from "vitest";
import { fileForLang, linkifyText, parseMessageBlocks } from "./ChatPanel.js";

describe("linkifyText", () => {
  it("returns a single text run when there are no links", () => {
    expect(linkifyText("just some prose")).toEqual([{ text: "just some prose" }]);
  });

  it("splits a URL out of surrounding prose", () => {
    expect(linkifyText("see https://example.com/x for more")).toEqual([
      { text: "see " },
      { url: "https://example.com/x" },
      { text: " for more" },
    ]);
  });

  it("keeps trailing sentence punctuation out of the link", () => {
    expect(linkifyText("here: https://example.org/page.")).toEqual([
      { text: "here: " },
      { url: "https://example.org/page" },
      { text: "." },
    ]);
  });

  it("handles multiple links", () => {
    const segs = linkifyText("a http://one.com b https://two.com c");
    expect(segs.filter((s) => "url" in s)).toEqual([{ url: "http://one.com" }, { url: "https://two.com" }]);
  });

  it("ignores non-http schemes and bare words", () => {
    expect(linkifyText("email me at a@b.com or ftp://x")).toEqual([{ text: "email me at a@b.com or ftp://x" }]);
  });
});

describe("parseMessageBlocks", () => {
  it("returns one text block when there's no code fence", () => {
    expect(parseMessageBlocks("just prose")).toEqual([{ type: "text", text: "just prose" }]);
  });

  it("splits prose and a fenced code block, capturing the language", () => {
    const blocks = parseMessageBlocks("Here you go:\n```html\n<h1>Hi</h1>\n```\nDone.");
    expect(blocks).toEqual([
      { type: "text", text: "Here you go:\n" },
      { type: "code", lang: "html", code: "<h1>Hi</h1>" },
      { type: "text", text: "\nDone." },
    ]);
  });

  it("handles a fence with no language and multiple blocks", () => {
    const blocks = parseMessageBlocks("```\na\n```\nmid\n```js\nb\n```");
    expect(blocks.filter((b) => b.type === "code")).toEqual([
      { type: "code", lang: "", code: "a" },
      { type: "code", lang: "js", code: "b" },
    ]);
  });
});

describe("fileForLang", () => {
  it("maps languages to an extension, base name, and mime", () => {
    expect(fileForLang("html")).toEqual({ ext: "html", base: "page", mime: "text/html" });
    expect(fileForLang("csv")).toEqual({ ext: "csv", base: "sheet", mime: "text/csv" });
    expect(fileForLang("python")).toMatchObject({ ext: "py", base: "file" });
    expect(fileForLang("markdown")).toMatchObject({ ext: "md", base: "document", mime: "text/markdown" });
    expect(fileForLang("")).toMatchObject({ ext: "txt", mime: "text/plain" });
  });
});
