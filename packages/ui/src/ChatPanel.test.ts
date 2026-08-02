import { describe, expect, it } from "vitest";
import {
  classifyBlocks,
  fileActionKeys,
  fileForLang,
  inlineReadableText,
  isTextDocument,
  linkifyText,
  parseFenceInfo,
  parseMessageBlocks,
  projectFilesFromBlocks,
  splitRunTogetherFiles,
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

describe("classifyBlocks (file vs inline snippet — document de-fragmentation)", () => {
  const big = (n: number) => "x".repeat(n);

  it("a document with several BARE code examples renders them inline, not as saveable files", () => {
    const doc =
      "Here is a guide.\n```js\nconst a = 1;\n```\nMore prose explaining things at length.\n" +
      "```js\nconst b = 2;\n```\nEven more discussion.";
    const blocks = parseMessageBlocks(doc);
    const kinds = classifyBlocks(blocks);
    // No fenced block becomes a "file" — they're illustrative snippets.
    expect(kinds.filter((k) => k === "file")).toHaveLength(0);
    expect(kinds.filter((k) => k === "snippet")).toHaveLength(2);
  });

  it("a sole DOMINANT block (the whole reply IS the file) is a saveable file even unnamed", () => {
    const blocks = parseMessageBlocks(`Here's your page:\n\`\`\`html\n${big(2000)}\n\`\`\``);
    const kinds = classifyBlocks(blocks);
    expect(kinds).toContain("file");
    expect(kinds.filter((k) => k === "file")).toHaveLength(1);
  });

  it("a tiny unnamed sole snippet stays inline (not a file card)", () => {
    const kinds = classifyBlocks(parseMessageBlocks("Sure:\n```js\nfoo();\n```"));
    expect(kinds).not.toContain("file");
  });

  it("filename-tagged blocks are always files (genuine multi-file answers keep their cards)", () => {
    const kinds = classifyBlocks(parseMessageBlocks("```html index.html\n<a></a>\n```\nand\n```css styles.css\nbody{}\n```"));
    expect(kinds.filter((k) => k === "file")).toHaveLength(2);
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

describe("isTextDocument / inlineReadableText (Read here)", () => {
  const buf = (s: string): ArrayBuffer => {
    const u = new TextEncoder().encode(s);
    const b = new ArrayBuffer(u.byteLength);
    new Uint8Array(b).set(u);
    return b;
  };

  it("recognises a .md written to disk, which arrives with NO mime at all", () => {
    // The exact card that had no way to be read: `write_file` surfaces a path with `mime: ""`.
    expect(isTextDocument({ name: "notes.md", mime: "" })).toBe(true);
    expect(isTextDocument({ name: "notes.markdown", mime: "" })).toBe(true);
    expect(isTextDocument({ name: "notes.txt", mime: "" })).toBe(true);
  });

  it("recognises a text document by mime when the name has no useful extension", () => {
    expect(isTextDocument({ name: "document", mime: "text/markdown" })).toBe(true);
    expect(isTextDocument({ name: "document", mime: "text/plain" })).toBe(true);
  });

  it("is not fooled by other files", () => {
    expect(isTextDocument({ name: "report.pdf", mime: "application/pdf" })).toBe(false);
    expect(isTextDocument({ name: "sheet.csv", mime: "text/csv" })).toBe(false);
    expect(isTextDocument({ name: "shot.png", mime: "image/png" })).toBe(false);
    // "README.mdx" is not Markdown this renderer should claim.
    expect(isTextDocument({ name: "README.mdx", mime: "" })).toBe(false);
  });

  it("uses the card's own content when it carries it", () => {
    expect(inlineReadableText({ name: "a.md", mime: "text/markdown", content: "# Hi" })).toBe("# Hi");
  });

  it("decodes the text out of a card that carries ONLY bytes", () => {
    // Before, this card offered no Read button at all even though the chat could render it.
    expect(inlineReadableText({ name: "a.md", mime: "text/markdown", bytes: buf("# Hi\n\nthere") })).toBe("# Hi\n\nthere");
  });

  it("offers nothing for a text card with neither content nor bytes (it must be fetched)", () => {
    expect(inlineReadableText({ name: "notes.md", mime: "" })).toBeUndefined();
    expect(inlineReadableText({ name: "notes.md", mime: "", bytes: new ArrayBuffer(0) })).toBeUndefined();
  });

  it("offers nothing for a non-text file, even one carrying bytes", () => {
    expect(inlineReadableText({ name: "report.pdf", mime: "application/pdf", bytes: buf("%PDF-1.4") })).toBeUndefined();
  });

  it("reads a written .txt straight from the card, without going back to disk", () => {
    // The card for a file the assistant just wrote used to carry only its path, so showing text the
    // app was already holding meant a round-trip through the desktop's file-read command — a second
    // door, with its own permission check, that the write had not gone through. Now a full write
    // carries its content, and this is a pure lookup.
    expect(inlineReadableText({ name: "haiku1.txt", mime: "", content: "old pond\nfrog leaps in\nwater's sound" })).toBe(
      "old pond\nfrog leaps in\nwater's sound",
    );
  });

  it("declines undecodable bytes rather than rendering replacement characters", () => {
    const bad = new Uint8Array([0xff, 0xfe, 0xff, 0xfe]);
    const b = new ArrayBuffer(bad.byteLength);
    new Uint8Array(b).set(bad);
    expect(inlineReadableText({ name: "a.md", mime: "text/markdown", bytes: b })).toBeUndefined();
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

describe("several files run together in one fence", () => {
  // Reported, with a screenshot: "generate 3 more as separate documents" came back as ONE card,
  // `text · haiku_6.txt`, whose body was haiku 6, then the line `text haiku_7.txt`, then haiku 7,
  // then `text haiku_8.txt`, then haiku 8. The model named three files in the fence line's own
  // grammar and only fenced the first, and one card for three files is not something the reader can
  // undo — Save, Save all as project and Open in app all read the parsed blocks.
  const runTogether = [
    "```text haiku_6.txt",
    "Golden summer sun,",
    "Warm breeze whispers through the trees,",
    "Daylight lingers long.",
    "text haiku_7.txt",
    "Silver moon above,",
    "Stars dance in the velvet night,",
    "Silent world asleep.",
    "text haiku_8.txt",
    "Crisp air turns to cold,",
    "Crimson leaves drift to the ground,",
    "Winter's breath is near.",
    "```",
  ].join("\n");

  it("comes out as three named files, not one", () => {
    const code = parseMessageBlocks(runTogether).filter((b) => b.type === "code");
    expect(code.map((b) => (b as { filename?: string }).filename)).toEqual([
      "haiku_6.txt",
      "haiku_7.txt",
      "haiku_8.txt",
    ]);
    expect((code[0] as { code: string }).code).toBe("Golden summer sun,\nWarm breeze whispers through the trees,\nDaylight lingers long.");
    expect((code[2] as { code: string }).code).toBe("Crisp air turns to cold,\nCrimson leaves drift to the ground,\nWinter's breath is near.");
    // No header line survives inside any file's content.
    for (const b of code) expect((b as { code: string }).code).not.toMatch(/^text \S+\.\S+$/m);
  });

  it("each one saves and zips under its own name", () => {
    const blocks = parseMessageBlocks(runTogether);
    expect(projectFilesFromBlocks(blocks).map((f) => f.name)).toEqual(["haiku_6.txt", "haiku_7.txt", "haiku_8.txt"]);
    // Named blocks are file cards, so all three get their own Save button.
    expect(classifyBlocks(blocks).filter((k) => k === "file")).toHaveLength(3);
  });

  it("leaves a real file alone — a document that merely LISTS filenames is one file", () => {
    // The false split is the dangerous direction: it would silently cut a file in half. A bare
    // filename on its own line is ordinary content and must not be read as a fence header.
    const listing = "```markdown notes.md\nFiles in this project:\n\nREADME.md\nsetup.py\nsrc/app.js\n```";
    const code = parseMessageBlocks(listing).filter((b) => b.type === "code");
    expect(code).toHaveLength(1);
    expect((code[0] as { code: string }).code).toContain("README.md");
  });

  it("leaves prose that happens to name a file alone", () => {
    // Two tokens, but the first isn't this block's language, so it isn't a header.
    const doc = "```text notes.txt\nSee also chapter_two.txt\nfor the rest.\n```";
    expect(parseMessageBlocks(doc).filter((b) => b.type === "code")).toHaveLength(1);
  });

  it("doesn't split an unnamed block, or one whose headers have no bodies", () => {
    expect(splitRunTogetherFiles({ type: "code", lang: "text", code: "text a.txt\nhi" })).toHaveLength(1);
    expect(
      splitRunTogetherFiles({ type: "code", lang: "text", code: "text b.txt\ntext c.txt", filename: "a.txt" }),
    ).toHaveLength(1);
  });

  it("still parses properly fenced files exactly as before", () => {
    const proper = "```html index.html\n<p>hi</p>\n```\n\n```css styles.css\np{color:red}\n```";
    const code = parseMessageBlocks(proper).filter((b) => b.type === "code");
    expect(code.map((b) => (b as { filename?: string }).filename)).toEqual(["index.html", "styles.css"]);
  });
});
