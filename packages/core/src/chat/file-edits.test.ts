import { describe, expect, it } from "vitest";
import { applyFileEdits, applyLineUpserts, extractSection, summarizeAmbiguousLines, summarizeFileEdits } from "./file-edits.js";

describe("applyFileEdits", () => {
  it("applies a single unique edit", () => {
    const r = applyFileEdits("const a = 1;\nconst b = 2;\n", [{ search: "const a = 1;", replace: "const a = 42;" }]);
    expect(r.content).toBe("const a = 42;\nconst b = 2;\n");
    expect(r.applied).toBe(1);
    expect(r.failures).toEqual([]);
  });

  it("applies multiple edits in order against the evolving text", () => {
    const r = applyFileEdits("x\ny\nz\n", [
      { search: "x", replace: "1" },
      { search: "y", replace: "2" },
    ]);
    expect(r.content).toBe("1\n2\nz\n");
    expect(r.applied).toBe(2);
  });

  it("reports not_found and leaves the file unchanged for that edit", () => {
    const r = applyFileEdits("hello world", [{ search: "goodbye", replace: "x" }]);
    expect(r.content).toBe("hello world");
    expect(r.applied).toBe(0);
    expect(r.failures).toEqual([{ index: 0, search: "goodbye", reason: "not_found" }]);
  });

  it("reports ambiguous when the search matches 2+ times (never guesses)", () => {
    const r = applyFileEdits("foo\nfoo\n", [{ search: "foo", replace: "bar" }]);
    expect(r.content).toBe("foo\nfoo\n"); // untouched
    expect(r.failures[0]).toMatchObject({ reason: "ambiguous" });
  });

  it("a later edit can disambiguate after an earlier one changed the text", () => {
    // First edit makes the second occurrence unique.
    const r = applyFileEdits("foo\nfoo\n", [
      { search: "foo\nfoo", replace: "FOO\nfoo" }, // unique multi-line anchor
      { search: "foo", replace: "bar" }, // now only one 'foo' remains
    ]);
    expect(r.content).toBe("FOO\nbar\n");
    expect(r.applied).toBe(2);
  });

  it("inserts the replacement VERBATIM even when it contains $-substitution sequences", () => {
    // String.replace treats `$&`, `` $` ``, `$'`, `$$`, `$1` in a STRING replacement as substitution
    // patterns — a model-supplied replacement using those (regex code, shell/awk snippets, prices) would
    // be corrupted. The function-form replacer inserts the text literally, so every `$…` survives.
    const r = applyFileEdits("const price = OLD;", [{ search: "OLD", replace: "$& $` $' $$ $1 $100" }]);
    expect(r.content).toBe("const price = $& $` $' $$ $1 $100;");
    expect(r.applied).toBe(1);
    // `$&` would otherwise re-insert the whole match; confirm it stays the two literal characters.
    const amp = applyFileEdits("X", [{ search: "X", replace: "[$&]" }]);
    expect(amp.content).toBe("[$&]");
  });

  it("applyLineUpserts: overwrites a checklist entry in place instead of adding a second one", () => {
    const doc = "## Attendees\n\n- [x] Ada — confirmed\n- [ ] Bo — no reply\n- [ ] Cy — no reply\n\nNotes below.";
    const r = applyLineUpserts(doc, [{ match: "Bo", line: "[x] Bo — confirmed" }]);
    expect(r.text).toBe("## Attendees\n\n- [x] Ada — confirmed\n- [x] Bo — confirmed\n- [ ] Cy — no reply\n\nNotes below.");
    expect(r.replaced).toEqual(["Bo"]);
  });

  it("applyLineUpserts: a new entry joins the list rather than trailing after the prose under it", () => {
    const doc = "## Attendees\n\n- [ ] Ada\n\nNotes below.";
    expect(applyLineUpserts(doc, [{ match: "Bo", line: "[x] Bo" }]).text).toBe("## Attendees\n\n- [ ] Ada\n- [x] Bo\n\nNotes below.");
  });

  it("applyLineUpserts: a checkbox is STATE (the caller can tick it); the bullet is formatting to keep", () => {
    // Ticking: the new text brings "[x]", so the box changes but the "- " stays.
    expect(applyLineUpserts("- [ ] Bo", [{ match: "Bo", line: "[x] Bo — confirmed" }]).text).toBe("- [x] Bo — confirmed");
    // No box in the new text → the existing one is left exactly as it was.
    expect(applyLineUpserts("- [x] Bo", [{ match: "Bo", line: "Bo — still in" }]).text).toBe("- [x] Bo — still in");
    // A bullet in the new text wins, and is never doubled up with the old one.
    expect(applyLineUpserts("- Bo: ?", [{ match: "Bo", line: "* Bo: yes" }]).text).toBe("* Bo: yes");
    // Indentation of a nested list item survives.
    expect(applyLineUpserts("- Team\n  - Bo: ?", [{ match: "Bo", line: "Bo: yes" }]).text).toBe("- Team\n  - Bo: yes");
  });

  it("applyLineUpserts: a label matching SEVERAL lines changes nothing and hands them back", () => {
    // Sharing an opening does not make two lines duplicates. Rewriting the first and deleting the rest
    // (which it used to do) destroys real content to satisfy a vague match.
    const doc = "## Expenses\n- Bo: brought chips\n- Bo: allergic to nuts\n- Cy: cake";
    const r = applyLineUpserts(doc, [{ match: "Bo", line: "Bo: paid $20" }]);
    expect(r.text).toBe(doc); // untouched — nothing lost
    expect(r.replaced).toEqual([]);
    expect(r.added).toEqual([]);
    expect(r.ambiguous).toEqual([{ match: "Bo", lines: ["- Bo: brought chips", "- Bo: allergic to nuts"] }]);
    // A longer label singles one out, and only that line changes.
    expect(applyLineUpserts(doc, [{ match: "Bo: allergic", line: "Bo: allergic to nuts and shellfish" }]).text).toBe(
      "## Expenses\n- Bo: brought chips\n- Bo: allergic to nuts and shellfish\n- Cy: cake",
    );
  });

  it("applyLineUpserts: dedupe is opt-in, and is what heals a genuinely double-entered list", () => {
    const doubled = "- Bo: ?\n- Cy: yes\n- Bo: yes";
    expect(applyLineUpserts(doubled, [{ match: "Bo", line: "Bo: no" }]).text).toBe(doubled); // ambiguous by default
    const healed = applyLineUpserts(doubled, [{ match: "Bo", line: "Bo: no", dedupe: true }]);
    expect(healed.text).toBe("- Bo: no\n- Cy: yes");
    expect(healed.ambiguous).toEqual([]);
  });

  it("applyLineUpserts: one ambiguous entry doesn't block the others in the same call", () => {
    const doc = "- Bo: chips\n- Bo: nuts\n- Cy: ?";
    const r = applyLineUpserts(doc, [
      { match: "Bo", line: "Bo: x" },
      { match: "Cy", line: "Cy: yes" },
    ]);
    expect(r.text).toBe("- Bo: chips\n- Bo: nuts\n- Cy: yes");
    expect(r.replaced).toEqual(["Cy"]);
    expect(r.ambiguous.map((a) => a.match)).toEqual(["Bo"]);
  });

  it("summarizeAmbiguousLines quotes the candidates so the next call can name one", () => {
    const s = summarizeAmbiguousLines([{ match: "Bo", lines: ["- Bo: chips", "- Bo: nuts"] }]);
    expect(s).toContain('"Bo" matches 2 lines');
    expect(s).toContain("Bo: chips");
    expect(s).toContain("Bo: nuts");
    expect(summarizeAmbiguousLines([])).toBe("");
  });

  it("applyLineUpserts: matches on a word boundary, and handles numbered lists + empty text", () => {
    expect(applyLineUpserts("- Bobby: no\n- Bo: ?", [{ match: "Bo:", line: "Bo: yes" }]).text).toBe("- Bobby: no\n- Bo: yes");
    expect(applyLineUpserts("1. Ada\n2. Bo: ?", [{ match: "Bo", line: "Bo: yes" }]).text).toBe("1. Ada\n2. Bo: yes");
    // A new entry can't reuse "2." verbatim (it would repeat the number), so it falls back to a dash.
    expect(applyLineUpserts("1. Ada", [{ match: "Bo", line: "Bo: yes" }]).text).toBe("1. Ada\n- Bo: yes");
    expect(applyLineUpserts("", [{ match: "Bo", line: "Bo: yes" }]).text).toBe("Bo: yes");
  });

  it("extractSection: a heading and everything under it, including deeper subsections", () => {
    const doc = "# Brief\n\nintro\n\n## Scope\n\nin scope\n\n### Detail\n\nfine print\n\n## Risks\n\nthings\n";
    expect(extractSection(doc, "Scope")).toBe("## Scope\n\nin scope\n\n### Detail\n\nfine print");
    expect(extractSection(doc, "## Scope")).toBe("## Scope\n\nin scope\n\n### Detail\n\nfine print"); // hashes optional
    expect(extractSection(doc, "risks")).toBe("## Risks\n\nthings"); // case-insensitive
    // The top heading takes the whole document; a shallower heading is what ends a section.
    expect(extractSection(doc, "Brief")).toBe(doc.trimEnd());
    expect(extractSection(doc, "Budget")).toBeUndefined();
    expect(extractSection(doc, "")).toBeUndefined();
  });

  it("summarizeFileEdits: clean vs failures", () => {
    expect(summarizeFileEdits("a.ts", { content: "", applied: 2, failures: [] })).toContain("applied 2 edit");
    const s = summarizeFileEdits("a.ts", { content: "", applied: 1, failures: [{ index: 1, search: "x", reason: "ambiguous" }] });
    expect(s).toContain("1 applied, 1 FAILED");
    // Wording changed with the evidence: an ambiguous edit now names the LINES it matched, so the
    // model can anchor on one instead of being told to add context somewhere unspecified.
    expect(s).toContain("more surrounding text");
  });

  /**
   * A MISS USED TO REPORT ONLY THAT IT MISSED, so the model's next move was to guess again — from
   * the same information that produced the wrong guess. Real coding harnesses answer a failed patch
   * with the surrounding text, because a bad anchor is nearly always off by indentation or one
   * token, and one look at the real line ends it.
   */
  it("shows the closest real text when an anchor misses", () => {
    const file = "function tick() {\n    const ready = 1;\n    return ready;\n}\n";
    // The model reproduced the line with a tab where the file has spaces — the commonest miss there
    // is, and one that no amount of re-guessing fixes without seeing the real thing.
    const r = applyFileEdits(file, [{ search: "\tconst ready = 1;", replace: "\tconst ready = 2;" }]);
    expect(r.applied).toBe(0);
    expect(r.failures[0]!.nearest?.line).toBe(2);
    expect(r.failures[0]!.nearest?.text).toContain("    const ready = 1;");
    const summary = summarizeFileEdits("tick.js", r);
    expect(summary).toContain("closest text in the file is at line 2");
    expect(summary).toContain("character for character");
  });

  it("names the lines an ambiguous anchor matched", () => {
    const file = "a();\nsame();\nb();\nsame();\n";
    const r = applyFileEdits(file, [{ search: "same();", replace: "other();" }]);
    expect(r.failures[0]!.at).toEqual([2, 4]);
    expect(summarizeFileEdits("x.js", r)).toContain("lines 2, 4");
  });

  it("offers no nearest line when nothing in the file resembles the anchor", () => {
    // Evidence or silence — a "closest" line that shares nothing is a guess dressed as evidence.
    const r = applyFileEdits("alpha();\nbeta();\n", [{ search: "completely unrelated content here", replace: "x" }]);
    expect(r.failures[0]!.nearest).toBeUndefined();
    expect(summarizeFileEdits("x.js", r)).toContain("copy the `search` from it verbatim");
  });
});
