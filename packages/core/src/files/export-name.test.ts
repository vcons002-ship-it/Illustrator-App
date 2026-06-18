import { describe, expect, it } from "vitest";
import { exportFilename, slugify } from "./export-name.js";

describe("slugify", () => {
  it("keeps safe chars, hyphenates spaces, drops the rest", () => {
    expect(slugify("My Book: A Tale!")).toBe("My-Book-A-Tale");
    expect(slugify('a/b\\c*d?e"f<g>h|i')).toBe("a-b-c-d-e-f-g-h-i");
    expect(slugify("café résumé")).toBe("cafe-resume"); // NFKD folds accents to base letters
    expect(slugify("  spaced   out  ")).toBe("spaced-out");
  });

  it("caps length and trims trailing punctuation", () => {
    expect(slugify("x".repeat(80)).length).toBe(60);
    expect(slugify("report...")).toBe("report");
    expect(slugify("---lead---")).toBe("lead");
  });

  it("reduces to empty when nothing safe remains", () => {
    expect(slugify("日本語")).toBe("");
    expect(slugify("")).toBe("");
  });
});

describe("exportFilename", () => {
  it("slugs the base and appends a single extension", () => {
    expect(exportFilename("My Book", "html")).toBe("My-Book.html");
    expect(exportFilename("My Book", ".epub")).toBe("My-Book.epub"); // leading dot not doubled
    expect(exportFilename("日本語", "csv")).toBe("export.csv"); // empty → fallback
    expect(exportFilename("", "xlsx", "data")).toBe("data.xlsx");
  });
});
