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

/**
 * ONE OWNER FOR THE SCROLL POSITION.
 *
 * Both chat panels had their own copy of "scroll to the bottom when these props change", and the
 * browser's scroll anchoring was quietly adjusting the same scrollTop underneath them — so content
 * settling above the viewport drifted the view up and nothing pulled it back. Reported as the chat
 * jumping higher. The hook is the only owner now; a panel re-growing its own copy, or the
 * `overflow-anchor` opt-out going missing, brings the drift straight back.
 */
describe("following the conversation", () => {
  const panels = ["ChatBuddyPanel.tsx", "ChatPanel.tsx"] as const;

  it("leaves the scroll position to useStickToBottom in both panels", () => {
    for (const f of panels) {
      const src = readFileSync(join(import.meta.dirname, f), "utf8");
      expect(src, f).toContain("useStickToBottom(");
      // Its own copy would be a second owner again. (ThinkingBlock scrolls its OWN <pre>;
      // that is a different element and not the conversation.)
      expect(src, f).not.toContain("nearBottomRef");
    }
  });

  it("keeps the browser out of it", () => {
    const recipes = readFileSync(join(import.meta.dirname, "design", "recipes.ts"), "utf8");
    expect(recipes).toMatch(/chatScrollStyle[\s\S]*?overflowAnchor: "none"/);
  });
});

/**
 * A SETTLED BUBBLE OWNS NO ANIMATION.
 *
 * `animation` is one property. A class that declares it holds a claim on the element for as long as
 * it is present, so anything else that sets that property cancels the animation on the way in and
 * RESTARTS it on the way out. `.vr-card.is-tap` — the touch feedback, which every bubble matches, at
 * higher specificity — did exactly that: a finger on a message replayed its whole entrance, and the
 * bubble faded up from blurred and translated as if it were reloading. `.vr-msg--solidify` did the
 * same one message later, when the class came off the previous reply.
 *
 * Putting the entrance back on the base class would bring both straight back, so the invariant is
 * the thing worth pinning: the animation lives only on classes a bubble sheds when it finishes.
 */
describe("the message entrance", () => {
  const css = readFileSync(join(import.meta.dirname, "styles", "components.css"), "utf8");
  const block = (sel: string): string => new RegExp(`\\${sel} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";

  it("is declared only on the class the bubble sheds", () => {
    expect(block(".vr-msg--arriving")).toMatch(/animation:\s*vr-msg-in/);
    expect(block(".vr-msg"), ".vr-msg claims `animation` again").not.toMatch(/animation/);
  });

  it("takes the user variant and the sheen with it", () => {
    expect(css).toContain('.vr-msg--arriving[data-from="user"]');
    expect(css).toContain(".vr-msg--arriving::after");
    expect(css).not.toMatch(/\.vr-msg\[data-from="user"\] \{[^}]*animation/);
  });

  it("keeps a bubble from lifting under a finger, and still cleans up after itself", () => {
    expect(block(".vr-msg.vr-card.is-tap")).toMatch(/animation:\s*none/);
    // Refusing the lift means `vr-tap-lift` never ends on a bubble — waiting only on that left every
    // tapped message wearing `is-tap` for good. The glow it DOES play has to clear it instead.
    const hook = readFileSync(join(import.meta.dirname, "usePointerFeedback.ts"), "utf8");
    expect(hook).toContain('e.animationName === "vr-tap-glow"');
    // And nothing gets tap feedback mid-entrance: that would cancel the entrance and restart it.
    expect(hook).toContain('!card.classList.contains("vr-msg--arriving")');
  });

  it("is shed by the panel when the entrance ends", () => {
    const panel = readFileSync(join(import.meta.dirname, "ChatPanel.tsx"), "utf8");
    expect(panel).toContain("onAnimationEnd");
    // Not a child's animation, and not the ::after sheen — either would end the entrance early.
    expect(panel).toContain("e.target === e.currentTarget && !e.pseudoElement");
    // The condense carries the same claim, so it comes off with the same flag.
    expect(panel).toContain("justFinished && arriving");
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
