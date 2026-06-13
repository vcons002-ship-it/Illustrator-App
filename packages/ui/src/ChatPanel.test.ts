import { describe, expect, it } from "vitest";
import { linkifyText } from "./ChatPanel.js";

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
