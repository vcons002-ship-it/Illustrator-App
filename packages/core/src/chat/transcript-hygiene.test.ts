import { describe, expect, it } from "vitest";
import type { ChatTurn } from "../providers/llm/chat.js";
import { progressNudge, toolLimitNudge, MAX_BUDDY_TOOL_ROUNDS, TOOL_PROGRESS_EVERY } from "./buddy-tools.js";
import { stripPersistedDirectives } from "./transcript-hygiene.js";
import { buildCreativeIdlePrompt } from "./buddy-tools.js";

/** The exact text the app used to persist, taken from the generators themselves — so this stays
 * honest if the wording is ever edited. */
const LIMIT = toolLimitNudge(MAX_BUDDY_TOOL_ROUNDS - 1);
const PROGRESS = progressNudge(TOOL_PROGRESS_EVERY);

describe("stripPersistedDirectives", () => {
  it("cuts the tool-limit directive but KEEPS the tool results it was appended to", () => {
    const turns: ChatTurn[] = [
      { role: "user", content: "research the flight options" },
      { role: "assistant", content: '{"tool":"search_web","query":"flights"}' },
      { role: "user", content: `[search_web — 3 results]\n· Delta 8am` + LIMIT },
    ];
    const out = stripPersistedDirectives(turns);
    expect(out).toHaveLength(3);
    expect(out[2]!.content).toBe("[search_web — 3 results]\n· Delta 8am");
    expect(out[2]!.content).not.toMatch(/Do NOT call another tool/i);
  });

  it("cuts the progress + re-issue directives the same way", () => {
    const results = "[search_web — 2 results]";
    const deferred = "\n\n[Re-issue the remaining host tool (image/command/plan/etc.) now if you still need it.]";
    expect(stripPersistedDirectives([{ role: "user", content: results + PROGRESS }])[0]!.content).toBe(results);
    expect(stripPersistedDirectives([{ role: "user", content: results + deferred }])[0]!.content).toBe(results);
  });

  it("cuts at the EARLIEST directive when several were appended together", () => {
    const out = stripPersistedDirectives([{ role: "user", content: `[results]${PROGRESS}${LIMIT}` }]);
    expect(out[0]!.content).toBe("[results]");
  });

  it("drops a turn that was ONLY a directive", () => {
    const out = stripPersistedDirectives([
      { role: "user", content: "do the thing" },
      { role: "user", content: LIMIT },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe("do the thing");
  });

  it("drops the app-managed step nudges entirely (they record nothing)", () => {
    const turns: ChatTurn[] = [
      { role: "user", content: "[✓ Previous step done. Now do ONLY step 3 of 5: Render the sunset. Call its tool and stop — don't recap or explain.]" },
      { role: "user", content: "[You haven't done the current step yet. Do it now: Save the recap. Call the tool and stop — no commentary.]" },
      { role: "user", content: "[Your last attempt didn't satisfy this step (no image). Do it again now: Render it. Just call the tool — no commentary.]" },
      { role: "assistant", content: "done" },
    ];
    const out = stripPersistedDirectives(turns);
    expect(out).toEqual([{ role: "assistant", content: "done" }]);
  });

  it("leaves ordinary conversation untouched, same reference when nothing changed", () => {
    const turns: ChatTurn[] = [
      { role: "user", content: "what's on my calendar?" },
      { role: "assistant", content: "Two things." },
      { role: "user", content: "[list_events — events]\n· 9am standup" },
    ];
    expect(stripPersistedDirectives(turns)).toBe(turns); // identical reference — stable for a memo
  });

  it("never touches assistant turns, even if they quote a directive back", () => {
    const turns: ChatTurn[] = [{ role: "assistant", content: `I was told: ${LIMIT}` }];
    expect(stripPersistedDirectives(turns)).toBe(turns);
  });

  it("doesn't cut a reader quoting the phrase mid-message", () => {
    // The real directives are always appended after a blank line (or are the whole turn); a reader
    // mentioning the words inside a sentence must survive intact.
    const quoted = { role: "user" as const, content: "why do you keep saying [You've reached this turn's tool-call limit ...] at me?" };
    expect(stripPersistedDirectives([quoted])).toEqual([quoted]);
  });

  it("is idempotent", () => {
    const once = stripPersistedDirectives([{ role: "user", content: `[results]${LIMIT}` }]);
    expect(stripPersistedDirectives(once)).toEqual(once);
  });
});

describe("the idle-creative brief", () => {
  it("is replaced with a plain sentence, not replayed as the reader's instructions", () => {
    // Replayed verbatim, "nobody is waiting on you" and "don't ask the reader anything" would make
    // the model refuse to ask questions of someone sitting right there in that same chat.
    const brief = buildCreativeIdlePrompt(["tardigrades"]);
    const out = stripPersistedDirectives([
      { role: "user", content: brief },
      { role: "assistant", content: "Wrote up something about Roman concrete." },
      { role: "user", content: "tell me more about that" },
    ]);
    expect(out[0]!.content).toBe("(I had some free time, so I went off and explored something on my own.)");
    expect(out[0]!.content).not.toMatch(/nobody is waiting/i);
    expect(out[0]!.content).not.toMatch(/don't ask the reader/i);
    expect(out[0]!.content).not.toMatch(/ONLY search/);
    // The turn is KEPT, not dropped — the model should still know why that stretch exists.
    expect(out).toHaveLength(3);
    expect(out[2]!.content).toBe("tell me more about that");
  });

  it("leaves a reader who happens to write something similar alone", () => {
    const turns: ChatTurn[] = [{ role: "user", content: "I was exploring on my own the other day and found this" }];
    expect(stripPersistedDirectives(turns)).toBe(turns); // same reference: nothing changed
  });
});
