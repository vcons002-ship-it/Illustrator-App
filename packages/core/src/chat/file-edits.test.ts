import { describe, expect, it } from "vitest";
import { applyFileEdits, applyLineUpserts, extractSection, summarizeFileEdits } from "./file-edits.js";

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

  it("applyLineUpserts: collapses duplicates an earlier blind append left behind", () => {
    expect(applyLineUpserts("- Bo: ?\n- Cy: yes\n- Bo: yes", [{ match: "Bo", line: "Bo: no" }]).text).toBe("- Bo: no\n- Cy: yes");
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
    expect(s).toContain("more surrounding context");
  });
});
