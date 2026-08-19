import { describe, expect, it } from "vitest";
import { jsonSyntaxError, syntaxCheckFor, syntaxCheckNote } from "./syntax-check.js";

describe("syntaxCheckFor", () => {
  const found = { node: "node", python: "python3" };

  it("parses JavaScript without running it", () => {
    const c = syntaxCheckFor("tide-clock.js", found);
    expect(c?.command).toBe('node --check "tide-clock.js"');
    expect(c?.label).toBe("node --check");
  });

  /**
   * The reported failure: one numeric literal split across two lines, and the WHOLE page dead rather
   * than the one button. A page's <script> is where a syntax error is fatal, and it is exactly what
   * a run in the wild checked by hand — successfully — before reporting PARSE OK.
   */
  it("checks a page's inline script, compiling without calling", () => {
    const c = syntaxCheckFor("flow3.html", found);
    expect(c?.command).toContain("new Function(b)");
    expect(c?.command, "the file must never be executed by its own check").not.toContain("eval(");
    // No script is a pass — plenty of pages are markup only.
    expect(c?.command).toContain("no inline script to check");
  });

  it("parses Python without littering the folder", () => {
    const c = syntaxCheckFor("tide-clock.py", found);
    expect(c?.command).toContain("ast.parse");
    expect(c?.command, "py_compile would leave a __pycache__ nobody asked for").not.toContain("py_compile");
  });

  it("uses the interpreter the host actually resolved", () => {
    expect(syntaxCheckFor("a.py", { python: "py" })?.command.startsWith("py -c")).toBe(true);
    // No interpreter → no check, rather than a command that cannot run.
    expect(syntaxCheckFor("a.py", {})).toBeUndefined();
    expect(syntaxCheckFor("a.js", {})).toBeUndefined();
  });

  it("says nothing for a language it cannot check cheaply", () => {
    // A check that is silently ABSENT is better than one that is silently wrong: TypeScript needs
    // tsc and a project, and CSS/Rust/Go have no cheap parser to hand.
    for (const f of ["app.ts", "styles.css", "main.rs", "server.go", "notes.md"]) {
      expect(syntaxCheckFor(f, found), f).toBeUndefined();
    }
  });

  it("refuses a path it would have to quote its way around", () => {
    // A mis-quoted command reports a syntax error in the wrong thing, which is worse than no check.
    for (const f of ['we"ird.js', "it's.js", "back\\slash.js", "sub$dir.js"]) {
      expect(syntaxCheckFor(f, found), f).toBeUndefined();
    }
  });
});

describe("jsonSyntaxError", () => {
  it("is checked in the host, where the position survives", () => {
    expect(jsonSyntaxError("a.json", '{"a":1}')).toBeUndefined();
    expect(jsonSyntaxError("a.json", "{a:1}")).toBeTruthy();
    // Only for JSON — everything else is somebody else's job.
    expect(jsonSyntaxError("a.js", "{a:1}")).toBeUndefined();
  });
});

describe("syntaxCheckNote", () => {
  it("makes a failure impossible to report as success", () => {
    const bad = syntaxCheckNote("node --check", false, "SyntaxError: Unexpected token");
    expect(bad).toContain("DOES NOT PARSE");
    expect(bad).toContain("you have just broken it");
    expect(bad).toContain("do not report this work as done");
    expect(syntaxCheckNote("node --check", true, "")).toContain("the file parses");
  });

  it("keeps the note short enough to ride on every write", () => {
    expect(syntaxCheckNote("x", false, "e".repeat(5000)).length).toBeLessThan(900);
  });
});
