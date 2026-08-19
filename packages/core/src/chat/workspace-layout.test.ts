import { describe, expect, it } from "vitest";
import {
  README_BEGIN,
  README_END,
  WORKSPACE_KINDS,
  buildWorkspaceReadme,
  chatFolderName,
  codeFileNameFor,
  kindForFile,
  mergeWorkspaceReadme,
  readmeChatId,
  workspacePathFor,
} from "./workspace-layout.js";

/**
 * Every chat wrote into one flat folder, because that is the default working directory and nothing
 * ever suggested otherwise — the prompt's worked examples are `analysis.py`, `dragon.html`,
 * `notes.md`. Weeks of unrelated conversations land in one listing and neither the reader nor the
 * assistant can tell which files belong together or what any of it was for.
 */
describe("kindForFile", () => {
  it("sorts a file by what it IS, not by who made it", () => {
    expect(kindForFile("report.md")).toBe("documents");
    expect(kindForFile("sales.csv")).toBe("data");
    expect(kindForFile("chart.png")).toBe("images");
  });

  /**
   * SOURCE FILES STAY WHERE COMMANDS RUN. This used to answer "code", and that quietly broke every
   * project of more than one file: a shell command runs in the workspace ROOT, so `main.py` written
   * with write_file (sorted into `code/`) and `test_main.py` made with a shell redirect (left at the
   * root) ended up in two directories, and the test could not import the module it was testing.
   * Nothing in the run looked wrong and the checklist went green.
   *
   * The app cannot sort what the shell writes, so the only way for the two to agree is for neither
   * to move anything. Changed deliberately; this is the rule, not an oversight.
   */
  it("never files something that RUNS, because the shell would not find it there", () => {
    for (const f of ["app.js", "main.py", "page.html", "style.css", "build.sh", "lib.rs"]) {
      expect(kindForFile(f), `${f} was filed away from where commands run`).toBeUndefined();
    }
  });

  /**
   * The interesting case, and deliberately a ROOT file: `index.html` is the entry point of whatever
   * the workspace holds — the thing a reader double-clicks. A single-page deliverable belongs at the
   * top of the folder, not one level down among its parts.
   */
  it("keeps a project's entry point and its config at the root", () => {
    for (const f of ["index.html", "README.md", "package.json", "AGENTS.md", "Makefile", ".gitignore"]) {
      expect(kindForFile(f), `${f} was buried in a subfolder`).toBeUndefined();
    }
  });

  it("leaves an unknown extension at the root rather than guessing", () => {
    // A file in the wrong folder is harder to find than one at the top.
    expect(kindForFile("archive.xyz")).toBeUndefined();
    expect(kindForFile("noextension")).toBeUndefined();
    expect(kindForFile("")).toBeUndefined();
  });

  it("does not care about case or leading directories", () => {
    expect(kindForFile("Deep/Nested/REPORT.MD")).toBe("documents");
  });
});

describe("workspacePathFor", () => {
  it("places a bare filename in its folder", () => {
    expect(workspacePathFor("notes.md")).toBe("documents/notes.md");
    expect(workspacePathFor("sales.csv")).toBe("data/sales.csv");
    // …but never source, which has to stay beside the shell that runs it.
    expect(workspacePathFor("app.js")).toBe("app.js");
  });

  it("leaves a path the model already placed alone", () => {
    // `code/` is still a kind, so a path the model chooses is honoured and the README groups it —
    // what changed is only that the app stops putting files there behind the shell's back.
    expect(workspacePathFor("code/app.js")).toBe("code/app.js");
    expect(workspacePathFor("src/lib/util.ts")).toBe("src/lib/util.ts");
  });

  it("keeps a root file at the root", () => {
    expect(workspacePathFor("index.html")).toBe("index.html");
    expect(workspacePathFor("package.json")).toBe("package.json");
  });

  it("cannot be talked out of the workspace", () => {
    expect(workspacePathFor("../../etc/passwd")).toBe("etc/passwd");
    expect(workspacePathFor("./app.js")).toBe("app.js");
  });
});

describe("chatFolderName", () => {
  it("names the folder after what the reader calls the chat", () => {
    expect(chatFolderName("Landing page", "s-1")).toBe("landing-page");
    expect(chatFolderName("Tide report — August", "s-2")).toBe("tide-report-august");
  });

  it("falls back to the session id, because the files still have to go somewhere", () => {
    expect(chatFolderName(undefined, "buddy-7")).toBe("buddy-7");
    expect(chatFolderName("   ", "buddy-7")).toBe("buddy-7");
    expect(chatFolderName("!!!", "!!!")).toBe("chat");
  });

  it("bounds the name so the path it prefixes does not become the problem", () => {
    const name = chatFolderName("a".repeat(200), "s-1");
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.endsWith("-")).toBe(false);
  });
});

/**
 * A folder structure says what KIND each file is and nothing about what any of it was FOR. The
 * README is the part a person can read six weeks later — and, because it is a file on disk rather
 * than chat history, the part the assistant can still read after the conversation that created it
 * has scrolled out of the context window.
 */
describe("buildWorkspaceReadme", () => {
  const entries = [
    { path: "index.html", note: "the page itself" },
    { path: "code/app.js", note: "particle field" },
    { path: "data/tides.csv" },
    { path: "documents/brief.md", note: "what was asked for" },
  ];

  it("groups by folder, roots first, and carries what each file was for", () => {
    const md = buildWorkspaceReadme("Landing page", entries);
    expect(md.startsWith("# Landing page")).toBe(true);
    expect(md).toContain("`index.html` — the page itself");
    expect(md).toContain("`code/app.js` — particle field");
    expect(md).toContain("`data/tides.csv`"); // no note is fine
    expect(md.indexOf("In this folder")).toBeLessThan(md.indexOf("### code"));
    expect(md.indexOf("### code")).toBeLessThan(md.indexOf("### data"));
  });

  it("says an empty workspace is empty, which is information", () => {
    expect(buildWorkspaceReadme("New chat", [])).toContain("Nothing saved here yet");
  });

  it("fences the generated part so a reader's own words can survive beside it", () => {
    const md = buildWorkspaceReadme("x", entries);
    expect(md).toContain(README_BEGIN);
    expect(md).toContain(README_END);
  });

  it("lists every kind it claims to sort into", () => {
    const md = buildWorkspaceReadme("x", WORKSPACE_KINDS.map((k) => ({ path: `${k}/f.txt` })));
    for (const k of WORKSPACE_KINDS) expect(md, `${k} has no section`).toContain(`### ${k}`);
  });
});

describe("mergeWorkspaceReadme", () => {
  const generated = buildWorkspaceReadme("Landing page", [{ path: "code/app.js" }]);

  it("writes the whole thing when there is nothing there", () => {
    expect(mergeWorkspaceReadme(undefined, generated)).toBe(generated);
    expect(mergeWorkspaceReadme("   ", generated)).toBe(generated);
  });

  it("replaces only the generated section, keeping the reader's words on both sides", () => {
    const prior = `# My project\n\nSome notes I wrote.\n\n${README_BEGIN}\nOLD LIST\n${README_END}\n\nMore of my notes.\n`;
    const merged = mergeWorkspaceReadme(prior, generated);
    expect(merged).toContain("Some notes I wrote.");
    expect(merged).toContain("More of my notes.");
    expect(merged).toContain("`code/app.js`");
    expect(merged).not.toContain("OLD LIST");
  });

  it("appends rather than overwriting a README with no markers", () => {
    // Overwriting a person's own notes to keep an index tidy is not a trade worth making.
    const mine = "# Notes\n\nEverything here is mine.\n";
    const merged = mergeWorkspaceReadme(mine, generated);
    expect(merged.startsWith(mine.trimEnd())).toBe(true);
    expect(merged).toContain("`code/app.js`");
  });

  it("round-trips, so repeated writes do not grow the file", () => {
    const once = mergeWorkspaceReadme(undefined, generated);
    expect(mergeWorkspaceReadme(once, generated)).toBe(once);
  });
});

describe("codeFileNameFor", () => {
  it("gives a titled code book a real extension, which is what the old rule never did", () => {
    // "Solar System Page" used to become `Solar_System_Page` — no extension, so nothing could sort,
    // run, render or open it.
    expect(codeFileNameFor("Solar System Page", "html")).toBe("solar-system-page.html");
    expect(codeFileNameFor("tide chart", "python")).toBe("tide-chart.py");
    expect(codeFileNameFor("Auth Service", "typescript")).toBe("auth-service.ts");
  });

  it("leaves a name that already carries one alone", () => {
    expect(codeFileNameFor("particles.js", "html")).toBe("particles.js");
    expect(codeFileNameFor("index.html")).toBe("index.html");
  });

  it("falls back to .txt rather than guessing an extension it doesn't know", () => {
    expect(codeFileNameFor("scratch", "brainfuck")).toBe("scratch.txt");
    expect(codeFileNameFor("scratch")).toBe("scratch.txt");
  });

  it("never produces an empty or unsafe name", () => {
    expect(codeFileNameFor("", "js")).toBe("code.js");
    expect(codeFileNameFor("///", "js")).toBe("code.js");
    expect(codeFileNameFor("../../etc/passwd", "sh")).not.toContain("/");
  });

  it("produces a name the layout then handles correctly — the point of having an extension", () => {
    // A code book lands beside whatever runs it…
    expect(workspacePathFor(codeFileNameFor("Solar System Page", "html"))).toBe("solar-system-page.html");
    // …and prose is still filed.
    expect(workspacePathFor(codeFileNameFor("Tide Report", "markdown"))).toBe("documents/tide-report.md");
  });
});

/**
 * A FOLDER HAS TO SAY WHOSE IT IS. Folders are named after the conversation, and the name a reader
 * sees for an unnamed chat is its POSITION in the list — so deleting an earlier chat makes "Chat 13"
 * come round again, and without an owner marker the second one would move into the first one's files.
 */
describe("chat ownership markers", () => {
  it("round-trips the owning chat id", () => {
    const readme = buildWorkspaceReadme("Tide report", [{ path: "code/a.js" }], "buddy-msxr09vq");
    expect(readmeChatId(readme)).toBe("buddy-msxr09vq");
  });

  it("survives a merge, so a reader's own notes cannot strip the folder's identity", () => {
    const first = buildWorkspaceReadme("Tide report", [], "buddy-abc");
    const edited = `# My notes\n\nI keep the CSVs here.\n\n${first.slice(first.indexOf(README_BEGIN))}`;
    const merged = mergeWorkspaceReadme(edited, buildWorkspaceReadme("Tide report", [{ path: "data/t.csv" }], "buddy-abc"));
    expect(readmeChatId(merged)).toBe("buddy-abc");
    expect(merged).toContain("I keep the CSVs here.");
    expect(merged).toContain("data/t.csv");
  });

  it("reports no owner for a folder made by hand, or before the marker existed", () => {
    expect(readmeChatId("# Just a folder\n\nnotes")).toBeUndefined();
    expect(readmeChatId(undefined)).toBeUndefined();
    // An unmarked folder must be treated as free rather than stranded, so this returning undefined
    // is what lets an older workspace keep being used.
    expect(readmeChatId(buildWorkspaceReadme("No id", []))).toBeUndefined();
  });
});

describe("whole-file rewrites of existing code are refused", () => {
  /**
   * The prompt has said "never rewrite a big file from memory" for a long time — in the file ledger,
   * every turn — and the model does it anyway, because "fix this" reaches for the whole file. Twice
   * the reader watched the consequence: a reply running out mid-file, and a verified 711-line page
   * re-typed from memory in three chunks purely to make a card appear. Persuasion has had its turn.
   */
  it("refuses a full overwrite of an existing source file", async () => {
    const { wholeFileRewriteRefusal } = await import("./workspace-layout.js");
    const r = wholeFileRewriteRefusal({ path: "flow3.html", exists: true, existingLines: 711 });
    expect(r).toBeTruthy();
    expect(r).toContain("711 lines");
    expect(r, "a refusal that doesn't say what to do instead is just a wall").toContain("edit_file");
    expect(r).toContain("delegate_coding_task");
    expect(r).toContain('"append":true');
    expect(r).toContain("/show flow3.html");
    expect(r, "the file must be reported as untouched").toContain("untouched");
  });

  it("leaves every legitimate write alone", async () => {
    const { wholeFileRewriteRefusal, REWRITE_GUARD_MIN_LINES } = await import("./workspace-layout.js");
    // A NEW file — the commonest thing it does, and never the failure mode.
    expect(wholeFileRewriteRefusal({ path: "flow3.html", exists: false, existingLines: 0 })).toBeUndefined();
    // An APPEND, which is the chunking protocol the prompt actually asks for.
    expect(wholeFileRewriteRefusal({ path: "flow3.html", append: true, exists: true, existingLines: 900 })).toBeUndefined();
    // A stub. Rewriting eight lines is quick, fits in a reply, and refusing it would only teach the
    // model that write_file is unreliable.
    expect(
      wholeFileRewriteRefusal({ path: "flow3.html", exists: true, existingLines: REWRITE_GUARD_MIN_LINES - 1 }),
    ).toBeUndefined();
    // Prose and data are deliberately outside the guard — a half-written note is obvious to its
    // reader, and regenerating a report or a table from a template is ordinary work.
    for (const path of ["report.md", "tide-data.csv", "notes.txt", "config.json"]) {
      expect(wholeFileRewriteRefusal({ path, exists: true, existingLines: 900 }), path).toBeUndefined();
    }
  });

  it("covers a source file wherever it sits in the folder", async () => {
    const { wholeFileRewriteRefusal } = await import("./workspace-layout.js");
    expect(wholeFileRewriteRefusal({ path: "code/app.js", exists: true, existingLines: 200 })).toBeTruthy();
    expect(wholeFileRewriteRefusal({ path: "src/lib/util.TS", exists: true, existingLines: 200 })).toBeTruthy();
  });
});

describe("stitching a file written in chunks", () => {
  /**
   * "Is it good at knowing where the previous code chunk stopped?" It had nothing to go on. The
   * append protocol was a byte concatenation and the feedback said only "APPENDED this chunk" — no
   * line count, no tail, no check on the join. So the model continued from its own memory of what it
   * had emitted, which is exactly what is unreliable after a reply ran out mid-file, and which may
   * not even be in context once history has been trimmed.
   */
  it("drops a passage the chunk re-sends from the end of the file", async () => {
    const { joinAppendedChunk } = await import("./workspace-layout.js");
    const onDisk = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
    // The model re-sends the last function it wrote before carrying on — the commonest join mistake,
    // because it is reconstructing from memory rather than from the file.
    const resent = "function b() {\n  return 2;\n}\n";
    const r = joinAppendedChunk(onDisk, `${resent}\nfunction c() {\n  return 3;\n}\n`);
    expect(r.trimmed).toBe(resent.length);
    expect(r.chunk).toBe("\nfunction c() {\n  return 3;\n}\n");
  });

  it("leaves a clean join exactly as it was", async () => {
    const { joinAppendedChunk } = await import("./workspace-layout.js");
    const r = joinAppendedChunk("line one\nline two\n", "line three\nline four\n");
    expect(r).toEqual({ chunk: "line three\nline four\n", trimmed: 0 });
  });

  it("is not fooled by repeated punctuation at a boundary", async () => {
    const { joinAppendedChunk } = await import("./workspace-layout.js");
    // `}` on both sides of a boundary is a coincidence; a re-sent paragraph is not.
    expect(joinAppendedChunk("  return 1;\n}\n", "}\nfunction next() {\n").trimmed).toBe(0);
    // Closing out of nested code: two line breaks, but nothing on those lines. Deleting this would
    // corrupt exactly the file the guard exists to protect.
    expect(joinAppendedChunk("    ok();\n  }\n}\n", "  }\n}\n\nnext();\n").trimmed).toBe(0);
    // Long, but still only punctuation and indentation.
    const bracey = "\n      }\n    }\n  }\n}\n";
    expect(joinAppendedChunk(`code();${bracey}`, `${bracey}more();\n`).trimmed).toBe(0);
  });

  it("reports where the file ends, bounded so one huge line can't flood the reply", async () => {
    const { fileTail } = await import("./workspace-layout.js");
    // The trailing newline is not one of the three lines — counting it would spend a third of the
    // anchor on nothing.
    expect(fileTail("a\nb\nc\nd\ne\n")).toBe("c\nd\ne");
    expect(fileTail("a\nb\nc\nd\ne")).toBe("c\nd\ne");
    const huge = `x${"y".repeat(5000)}`;
    const tail = fileTail(huge);
    expect(tail.length).toBeLessThanOrEqual(401);
    expect(tail.startsWith("…")).toBe(true);
  });
});
