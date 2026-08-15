import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CARDED_TOOLS, describeCallArgs } from "./ChatBuddyPanel.js";

const source = readFileSync(join(import.meta.dirname, "ChatBuddyPanel.tsx"), "utf8");

/**
 * WHY THIS FILE READS ITS OWN SOURCE.
 *
 * The bug it guards is structural, not behavioural: the approval cards used to be the last children
 * of the scrolling message list, so on a phone — where the chat dock is a few hundred pixels tall —
 * a run that stopped to ask permission showed one activity line and nothing else. No command to
 * read, no Deny to press, and no way to tell a run that was waiting from one that had hung.
 *
 * Nothing a rendered component exposes distinguishes "in the scroller" from "below it", and this
 * panel is far too large to render here. Where the block SITS in the JSX is the fact worth pinning,
 * so the test reads the file, the same way the token-parity and feature-inventory gates do.
 */
describe("the approval dock", () => {
  it("sits outside the scrolling message list, not inside it", () => {
    const scroller = source.indexOf("onScroll={trackNearBottom}");
    const dock = source.indexOf("<div style={approvalDockStyle}>");
    const scrollerEnd = source.indexOf("\n      </div>", scroller);
    expect(scroller).toBeGreaterThan(-1);
    expect(dock).toBeGreaterThan(-1);
    // The scroller's own closing tag comes FIRST. If the cards drift back inside it, this flips.
    expect(scrollerEnd).toBeGreaterThan(scroller);
    expect(dock).toBeGreaterThan(scrollerEnd);
  });

  it("renders whether or not the history is collapsed", () => {
    // The old stand-in was `{minimized && (props.pendingTool || …)}` — a banner saying an approval
    // existed somewhere else. The card itself is unconditional on `minimized` now, so a collapsed
    // dock shows the real thing instead of a pointer to it.
    const guard = source.match(/\{\(props\.pendingTool \|\| \(props\.agentApprovals\?\.length \?\? 0\) > 0\) && \(/g);
    expect(guard).toHaveLength(1);
    expect(source).not.toContain("⚠ Waiting for your approval.");
  });

  /**
   * The catch-all is the point: nine tools have a written card, and anything else the policy decides
   * to ASK about used to suspend the turn behind a card that was never rendered — a silent hang with
   * no approve and no deny. Being absent from CARDED_TOOLS must cost a nicer card, never the card.
   */
  it("has a real card for every tool it claims one for", () => {
    for (const tool of CARDED_TOOLS) {
      expect(source).toContain(`props.pendingTool?.tool === "${tool}"`);
    }
    expect(source).toContain("!CARDED_TOOLS.has(props.pendingTool.tool)");
  });

  it("claims a card for every tool that has one", () => {
    const rendered = [...source.matchAll(/props\.pendingTool\?\.tool === "([a-z_]+)"/g)].map((m) => m[1]!);
    expect(new Set(rendered)).toEqual(new Set(CARDED_TOOLS));
  });
});

describe("the generic card's read-out", () => {
  it("names every argument except the tool itself", () => {
    expect(describeCallArgs({ tool: "control_ui", action: "click", window: "Notepad", target: "Save" })).toBe(
      'action: "click"\nwindow: "Notepad"\ntarget: "Save"',
    );
  });

  it("says so rather than going blank when a call carries nothing", () => {
    expect(describeCallArgs({ tool: "list_events" })).toBe("(no arguments)");
  });

  /**
   * A `write_file` can carry 200k of content. Rendered whole it pushes the Run and Deny buttons off
   * a phone screen — which is precisely the failure this card exists to prevent, reintroduced by the
   * card itself.
   */
  it("clips a payload nobody is going to proofread", () => {
    const line = describeCallArgs({ tool: "write_file", path: "a.py", content: "x".repeat(5000) }).split("\n")[1]!;
    expect(line.length).toBeLessThanOrEqual(400);
    expect(line).toContain("…");
  });
});
