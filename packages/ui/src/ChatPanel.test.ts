import { describe, expect, it } from "vitest";
import {
  fileActionKeys,
  fileForLang,
  linkifyText,
  parseFenceInfo,
  parseMessageBlocks,
  projectFilesFromBlocks,
} from "./ChatPanel.js";

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

  it("turns a markdown link into one labeled link (not the raw bracketed URL)", () => {
    expect(linkifyText("see [Elephant photo](https://commons.example/File:E.jpg) here")).toEqual([
      { text: "see " },
      { url: "https://commons.example/File:E.jpg", label: "Elephant photo" },
      { text: " here" },
    ]);
  });

  it("linkifies bare URLs in the prose around a markdown link", () => {
    const segs = linkifyText("[A](https://a.com) then https://b.com");
    expect(segs).toEqual([
      { url: "https://a.com", label: "A" },
      { text: " then " },
      { url: "https://b.com" },
    ]);
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

  it("reads a filename from the fence (after the lang, a bare filename, or a path)", () => {
    expect(parseMessageBlocks("```html index.html\n<h1>hi</h1>\n```")[0]).toEqual({
      type: "code",
      lang: "html",
      code: "<h1>hi</h1>",
      filename: "index.html",
    });
    expect(parseMessageBlocks("```app.js\nx\n```")[0]).toEqual({ type: "code", lang: "js", code: "x", filename: "app.js" });
    expect(parseMessageBlocks("```js src/util.js\nx\n```")[0]).toEqual({
      type: "code",
      lang: "js",
      code: "x",
      filename: "src/util.js",
    });
    expect(parseMessageBlocks("```js\nx\n```")[0]).toEqual({ type: "code", lang: "js", code: "x" }); // no filename
  });
});

describe("parseFenceInfo", () => {
  it("splits lang + optional filename, tolerating title=\"…\"", () => {
    expect(parseFenceInfo("html")).toEqual({ lang: "html" });
    expect(parseFenceInfo("html index.html")).toEqual({ lang: "html", filename: "index.html" });
    expect(parseFenceInfo('python title="main.py"')).toEqual({ lang: "python", filename: "main.py" });
    expect(parseFenceInfo("styles.css")).toEqual({ lang: "css", filename: "styles.css" });
    expect(parseFenceInfo("")).toEqual({ lang: "" });
  });
});

describe("projectFilesFromBlocks", () => {
  it("collects named multi-file blocks into project files", () => {
    const blocks = parseMessageBlocks("```html index.html\n<a></a>\n```\nand\n```css styles.css\nbody{}\n```");
    expect(projectFilesFromBlocks(blocks)).toEqual([
      { name: "index.html", content: "<a></a>" },
      { name: "styles.css", content: "body{}" },
    ]);
  });

  it("falls back to a generic name for an unnamed block", () => {
    expect(projectFilesFromBlocks(parseMessageBlocks("```js\nx\n```"))).toEqual([{ name: "file.js", content: "x" }]);
  });
});

describe("fileActionKeys (universal file card)", () => {
  const all = { download: true, openInApp: true, openInLibrary: true, openOnPC: true };

  it("offers every action for a created code file on desktop, in stable order", () => {
    expect(fileActionKeys("code", all, true)).toEqual(["dl", "app", "lib", "pc"]);
  });

  it("hides Open-on-PC when not on desktop", () => {
    expect(fileActionKeys("code", all, false)).toEqual(["dl", "app", "lib"]);
  });

  it("does not offer Open-in-library for a bare image (but still download / open / on-PC)", () => {
    expect(fileActionKeys("image", all, true)).toEqual(["dl", "app", "pc"]);
  });

  it("an export only downloads or opens on PC (not in app / library)", () => {
    expect(fileActionKeys("export", all, true)).toEqual(["dl", "pc"]);
  });

  it("a found PC file with only open-in-app + open-on-PC wired", () => {
    expect(fileActionKeys("found", { openInApp: true, openOnPC: true }, true)).toEqual(["app", "pc"]);
  });

  it("renders nothing when no callbacks are wired", () => {
    expect(fileActionKeys("text", {}, true)).toEqual([]);
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
