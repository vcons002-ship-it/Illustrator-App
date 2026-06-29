import { describe, expect, it } from "vitest";
import { resolveViewAs, type BookSource } from "./book.js";

const base = { id: "b", title: "T", chapters: [], pages: [] } satisfies Partial<BookSource> as BookSource;

describe("resolveViewAs (reader view-category best-guess)", () => {
  it("an explicit viewAs always wins (the reader overrode the guess)", () => {
    expect(resolveViewAs({ ...base, viewAs: "text", contentMode: "fiction", kind: "story" })).toBe("text");
    expect(resolveViewAs({ ...base, viewAs: "document", contentMode: "fiction" })).toBe("document");
  });

  it("a story-as-you-go book illustrates", () => {
    expect(resolveViewAs({ ...base, kind: "story", contentMode: "fiction" })).toBe("story");
  });

  it("a fiction novel (or unset contentMode) illustrates; technical/non-fiction reads as a document", () => {
    expect(resolveViewAs({ ...base, contentMode: "fiction" })).toBe("story");
    expect(resolveViewAs({ ...base })).toBe("story"); // unset contentMode = imported novel
    expect(resolveViewAs({ ...base, contentMode: "technical" })).toBe("document");
    // A created/plain document opts out of illustration with an explicit viewAs.
    expect(resolveViewAs({ ...base, viewAs: "document" })).toBe("document");
  });

  it("spreadsheets are data, source code is code", () => {
    expect(resolveViewAs({ ...base, data: { columns: [], rows: [] }, contentMode: "technical" })).toBe("data");
    expect(resolveViewAs({ ...base, dataSheets: [{ name: "S", table: { columns: [], rows: [] } }] })).toBe("data");
    expect(resolveViewAs({ ...base, contentMode: "code" })).toBe("code");
  });
});
