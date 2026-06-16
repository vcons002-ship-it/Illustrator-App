import { describe, expect, it } from "vitest";
import { MAX_SPEAK_CHARS, speakableText } from "./voice.js";

describe("speakableText", () => {
  it("strips markdown, code, and links into clean prose", () => {
    expect(speakableText("**Hi** there, see `x=1` and [the docs](https://e.com).")).toBe(
      "Hi there, see x=1 and the docs.",
    );
    expect(speakableText("Run this:\n```js\nconsole.log(1)\n```\ndone")).toContain("(code block)");
    expect(speakableText("Visit https://example.com/page now")).toContain("(link)");
  });
  it("caps very long replies", () => {
    expect(speakableText("a ".repeat(2000)).length).toBeLessThanOrEqual(MAX_SPEAK_CHARS);
  });
});
