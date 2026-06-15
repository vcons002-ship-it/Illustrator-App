import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { dedupeProjectFiles, sanitizeProjectPath, zipProject } from "./project.js";

describe("sanitizeProjectPath", () => {
  it("keeps a safe relative path (including subfolders)", () => {
    expect(sanitizeProjectPath("index.html")).toBe("index.html");
    expect(sanitizeProjectPath("src/app.js")).toBe("src/app.js");
  });

  it("strips leading slashes, '..' traversal, backslashes, and illegal chars", () => {
    expect(sanitizeProjectPath("/etc/passwd")).toBe("etc/passwd"); // never absolute
    expect(sanitizeProjectPath("../../secret.txt")).toBe("secret.txt"); // no escape
    expect(sanitizeProjectPath("a/../b.js")).toBe("a/b.js");
    expect(sanitizeProjectPath("src\\win\\app.js")).toBe("src/win/app.js"); // backslash → /
    expect(sanitizeProjectPath('we:ir?d*name.js')).toBe("weirdname.js");
    expect(sanitizeProjectPath("   ")).toBe("");
  });
});

describe("dedupeProjectFiles", () => {
  it("suffixes colliding names before the extension and names the untitled", () => {
    const out = dedupeProjectFiles([
      { name: "app.js", content: "a" },
      { name: "app.js", content: "b" },
      { name: "", content: "c" },
    ]);
    expect(out.map((f) => f.name)).toEqual(["app.js", "app-2.js", "file-1.txt"]);
  });

  it("dedupes case-insensitively and within subfolders", () => {
    const out = dedupeProjectFiles([
      { name: "src/Util.js", content: "a" },
      { name: "src/util.js", content: "b" },
    ]);
    expect(out.map((f) => f.name)).toEqual(["src/Util.js", "src/util-2.js"]);
  });
});

describe("zipProject", () => {
  it("produces an archive that unzips to the right paths and contents", () => {
    const zip = zipProject([
      { name: "index.html", content: "<h1>hi</h1>" },
      { name: "src/app.js", content: "console.log(1)" },
    ]);
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual(["index.html", "src/app.js"]);
    expect(strFromU8(entries["index.html"]!)).toBe("<h1>hi</h1>");
    expect(strFromU8(entries["src/app.js"]!)).toBe("console.log(1)");
  });
});
