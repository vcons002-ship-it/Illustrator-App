import { describe, expect, it } from "vitest";
import { fileOutline, outlineBlock, OUTLINE_MIN_LINES } from "./file-outline.js";

const pad = (n: number): string => Array.from({ length: n }, (_, i) => `// filler ${i}`).join("\n");

describe("fileOutline", () => {
  it("finds the definitions a change would target", () => {
    const src = [
      "const W = 800;",
      "function rebuild() {",
      "  return 1;",
      "}",
      "const draw = () => {",
      "};",
      "class Field {",
      "}",
      "def tick():",
    ].join("\n");
    expect(fileOutline(src)).toEqual([
      { line: 2, label: "function rebuild()" },
      { line: 5, label: "draw()" },
      { line: 7, label: "class Field" },
      { line: 9, label: "def tick()" },
    ]);
  });

  /**
   * `if (x) {` is shaped exactly like a method, and an outline made mostly of `if` and `for` is worse
   * than no outline at all — it costs the reply and points nowhere.
   */
  it("does not mistake a statement for a definition", () => {
    const src = ["if (ready) {", "for (let i = 0; i < n; i++) {", "while (go) {", "switch (k) {", "tick() {"].join("\n");
    expect(fileOutline(src)).toEqual([{ line: 5, label: "tick()" }]);
  });

  it("indexes a page by its landmarks", () => {
    const src = ['<div id="stage">', "<script>", "</script>", "<style>", "#stage {"].join("\n");
    expect(fileOutline(src).map((e) => e.label)).toEqual(['<div id="stage">', "<script>", "<style>", "#stage"]);
  });

  it("keeps both ENDS when a file has more landmarks than fit", () => {
    // The top of a file says what it is; the bottom of a generated page is where the wiring lives,
    // which is exactly where the reported bug was.
    const many = Array.from({ length: 200 }, (_, i) => `function f${i}() {`).join("\n");
    const got = fileOutline(many, 10);
    expect(got).toHaveLength(10);
    expect(got[0]!.label).toBe("function f0()");
    expect(got[got.length - 1]!.label).toBe("function f199()");
  });
});

describe("outlineBlock", () => {
  it("says nothing about a file small enough to just read", () => {
    expect(outlineBlock("a.js", "function a() {\nb();\n")).toBe("");
  });

  it("maps a big file and tells the model to read a range", () => {
    const src = `${pad(OUTLINE_MIN_LINES)}\nfunction a() {\nfunction b() {\nfunction c() {\n`;
    const block = outlineBlock("flow3.html", src);
    expect(block).toContain("outline of flow3.html");
    expect(block).toContain(`${OUTLINE_MIN_LINES + 1}  function a()`);
    expect(block).toContain('"from":N,"to":M');
  });

  it("says nothing rather than guessing when it finds no structure", () => {
    // Prose, a log, a data dump: three entries is the floor, below which an "outline" is noise.
    expect(outlineBlock("notes.txt", `${pad(400)}\n`)).toBe("");
  });
});
