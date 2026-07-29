import { describe, expect, it } from "vitest";
import { MAX_CHARACTER_DESCRIPTOR_CHARS } from "../providers/image/bible-injection.js";
import { InMemoryStore } from "../storage/store.js";
import { loadMemory } from "./reader-memory.js";
import {
  type SoulNote,
  soulNotesForPrompt,
  SOUL_PROMPT_BUDGET_CHARS,
  SELF_SOUL_KEY,
  ABOUT_YOU_SOUL_KEY,
  MAX_SOUL_NOTES,
  loadSoul,
  saveSoul,
  rememberSoul,
  forgetSoul,
  loadSoulName,
  saveSoulName,
  selfSoulPromptBlock,
  userSoulPromptBlock,
  selfPortraitPrompt,
  visualSoulNotes,
  SOUL_LOOK_BUDGET_CHARS,
} from "./souls.js";

describe("selfPortraitPrompt", () => {
  const look = [{ text: "silver hair", at: 1 }, { text: "long charcoal coat", at: 2 }];
  it("folds the assistant's look in when it's a self-portrait (by self-reference)", () => {
    const out = selfPortraitPrompt("a watercolor of yourself by the sea", "Sage", look);
    expect(out).toContain("a watercolor of yourself by the sea");
    expect(out).toMatch(/depict Sage with this appearance: silver hair, long charcoal coat/);
  });
  it("triggers on the assistant's name", () => {
    expect(selfPortraitPrompt("Sage standing in the rain", "Sage", look)).toMatch(/appearance: silver hair/);
  });
  it("triggers on 'draw you' style phrasing", () => {
    expect(selfPortraitPrompt("draw you as a knight", "Sage", look)).toMatch(/depict Sage/);
  });
  it("leaves an unrelated subject untouched", () => {
    expect(selfPortraitPrompt("a red apple on a table", "Sage", look)).toBe("a red apple on a table");
  });
  it("is a no-op when there's no look to add", () => {
    expect(selfPortraitPrompt("a selfie of you", "Sage", [])).toBe("a selfie of you");
  });
});

describe("identity souls", () => {
  it("keeps self and user souls in separate stores, distinct from reader memory", async () => {
    const store = new InMemoryStore();
    await rememberSoul(store, "self", "silver hair, long coat");
    await rememberSoul(store, "user", "tall, dark curls");
    expect((await loadSoul(store, "self")).map((n) => n.text)).toEqual(["silver hair, long coat"]);
    expect((await loadSoul(store, "user")).map((n) => n.text)).toEqual(["tall, dark curls"]);
    // Souls never bleed into reader memory.
    expect(await loadMemory(store)).toEqual([]);
    // And they live under their own keys.
    expect(await store.getMemo(SELF_SOUL_KEY)).toContain("silver hair");
    expect(await store.getMemo(ABOUT_YOU_SOUL_KEY)).toContain("dark curls");
  });

  it("dedupes, caps, and forgets per soul (with a soul-specific error)", async () => {
    const store = new InMemoryStore();
    await rememberSoul(store, "self", "Warm wit");
    await rememberSoul(store, "self", "warm wit"); // dup refresh
    expect(await loadSoul(store, "self")).toHaveLength(1);
    await rememberSoul(store, "self", "wears glasses");
    const kept = await forgetSoul(store, "self", "GLASSES");
    expect(kept.map((n) => n.text)).toEqual(["warm wit"]);
    await expect(forgetSoul(store, "self", "nope")).rejects.toThrow(/no self-soul note contains/);
  });

  it("evicts the oldest note past the cap", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < MAX_SOUL_NOTES + 2; i++) await rememberSoul(store, "user", `fact ${i}`);
    const notes = await loadSoul(store, "user");
    expect(notes).toHaveLength(MAX_SOUL_NOTES);
    expect(notes[0]!.text).toBe("fact 2");
  });

  it("saveSoul replaces the whole list (panel edit)", async () => {
    const store = new InMemoryStore();
    await rememberSoul(store, "self", "old");
    const saved = await saveSoul(store, "self", [
      { text: "  keep  ", at: 1 },
      { text: "Keep", at: 2 }, // dup
      { text: "", at: 3 }, // blank
    ]);
    expect(saved.map((n) => n.text)).toEqual(["keep"]);
    expect((await loadSoul(store, "self")).map((n) => n.text)).toEqual(["keep"]);
  });

  it("stores a name per soul", async () => {
    const store = new InMemoryStore();
    expect(await loadSoulName(store, "self")).toBe("");
    await saveSoulName(store, "self", "  Sage  ");
    await saveSoulName(store, "user", "Alex");
    expect(await loadSoulName(store, "self")).toBe("Sage");
    expect(await loadSoulName(store, "user")).toBe("Alex");
  });

  it("renders prompt blocks only when there's a name or notes", () => {
    expect(selfSoulPromptBlock([], "")).toBe("");
    expect(userSoulPromptBlock([], "")).toBe("");
    const self = selfSoulPromptBlock([{ text: "silver hair", at: 1 }], "Sage");
    expect(self).toContain("WHO YOU ARE");
    expect(self).toContain("Name: Sage");
    expect(self).toContain("- silver hair");
    // The identity applies to ordinary chat, not just story roleplay.
    expect(self).toMatch(/EVERY conversation/);
    expect(self).toMatch(/ordinary chat/i);
    const you = userSoulPromptBlock([{ text: "bold", at: 1 }], "Alex");
    expect(you).toContain("WHO THE READER IS");
    expect(you).toContain("Name: Alex");
  });
});

describe("how many identity notes survive", () => {
  const note = (text: string, at = 1): SoulNote => ({ text, at });

  it("keeps far more than it shows — storage and prompt budget are separate limits", () => {
    // The point of raising the cap: the store no longer destroys the character underneath a few
    // weeks of the assistant's own notes. What rides in every prompt stays bounded regardless.
    expect(MAX_SOUL_NOTES).toBeGreaterThanOrEqual(200);
    const many = Array.from({ length: MAX_SOUL_NOTES }, (_, i) => note(`trait number ${i} — a sentence of roughly typical length`));
    const { shown, omitted } = soulNotesForPrompt(many);
    expect(shown.length).toBeLessThan(many.length);
    expect(shown.length + omitted).toBe(many.length);
    const rendered = shown.map((n) => `- ${n.text}`).join("\n");
    expect(rendered.length).toBeLessThanOrEqual(SOUL_PROMPT_BUDGET_CHARS);
  });

  it("keeps the NEWEST when it can't keep everything, in the order they were written", () => {
    const notes = [note("oldest"), note("middle"), note("newest")];
    const { shown } = soulNotesForPrompt(notes, 24); // room for about two
    expect(shown.map((n) => n.text)).toEqual(["middle", "newest"]);
  });

  it("always reserves an early physical description before filling the budget with recent notes", () => {
    const appearance = note("silver hair, grey eyes, lean build, and a long charcoal coat", 1);
    const recent = Array.from({ length: 20 }, (_, i) =>
      note(`curiosity number ${i} about an abstract topic`, i + 2),
    );
    const { shown, omitted } = soulNotesForPrompt([appearance, ...recent], 180);
    expect(shown).toContainEqual(appearance);
    expect(shown.at(-1)?.text).toContain("curiosity number 19");
    expect(omitted).toBeGreaterThan(0);
  });

  it("keeps an old appearance visible in both self and reader prompt blocks", () => {
    const oldLook = note("auburn braid, green eyes, and a jagged scar through one eyebrow", 1);
    const newer = Array.from({ length: 120 }, (_, i) =>
      note(`a newer personality observation number ${i}`, i + 2),
    );
    const notes = [oldLook, ...newer];
    expect(selfSoulPromptBlock(notes, "Sage")).toContain(oldLook.text);
    expect(userSoulPromptBlock(notes, "Alex")).toContain(oldLook.text);
  });

  it("says how many it left out rather than presenting a partial self as the whole", () => {
    // 120 notes of ~45 chars is ~5.4k — comfortably past the 4k budget, so some are genuinely left out.
    const many = Array.from({ length: 120 }, (_, i) => note(`a reasonably wordy identity note number ${i}`));
    const block = selfSoulPromptBlock(many, "Iris");
    expect(block).toMatch(/\+ \d+ other stored notes kept, not shown here/);
    expect(block).toContain("Name: Iris");
  });

  it("always shows at least one note, even one longer than the whole budget", () => {
    const { shown, omitted } = soulNotesForPrompt([note("x".repeat(5000))], 100);
    expect(shown).toHaveLength(1);
    expect(omitted).toBe(0);
  });

  it("is unchanged for a small soul — no budget line, nothing dropped", () => {
    const block = selfSoulPromptBlock([note("Warm, dry, direct.")]);
    expect(block).toContain("- Warm, dry, direct.");
    expect(block).not.toContain("not shown here");
  });
});

/**
 * Seeding a played character's LOOK from the soul.
 *
 * The soul is a mixed bag, and since the assistant started adding its own notes from what it reads
 * it's mostly personality. The story setup used to join every note and cut at 200 characters, so the
 * played character's visual description became "I'm drawn to problems where the obvious answer is
 * wrong; I find pure taxo" — and at beat one that's the ONLY thing the image model has, because
 * extraction hasn't read the prose yet. It's why the opening picture of a story came out poor and a
 * later re-render didn't.
 */
describe("visualSoulNotes", () => {
  const note = (text: string, at = 1): SoulNote => ({ text, at });

  it("keeps the notes that describe a look and drops the ones that don't", () => {
    const notes = [
      note("I'm drawn to problems where the obvious answer is wrong"),
      note("Warm, dry wit; silver hair; wears a long coat"),
      note("I find pure taxonomy dull"),
      note("Tall, with a jagged scar across one eyebrow"),
    ];
    expect(visualSoulNotes(notes)).toBe(
      "Warm, dry wit; silver hair; wears a long coat; Tall, with a jagged scar across one eyebrow",
    );
  });

  it("returns nothing when the soul is all personality — better neutral than misleading", () => {
    const notes = [
      note("I'm drawn to problems where the obvious answer is wrong"),
      note("I find pure taxonomy dull"),
    ];
    expect(visualSoulNotes(notes)).toBe("");
  });

  it("never cuts a note in half — whole notes only, up to the budget", () => {
    const long = note("silver hair that falls past the shoulders, always slightly unkempt");
    const out = visualSoulNotes([long, note("wears a long grey coat")], 70);
    expect(out).toBe(long.text); // the second didn't fit, so it isn't there at all
    expect(out.endsWith("unkempt")).toBe(true);
  });

  it("recognises clothing, colouring, build and age as description", () => {
    expect(visualSoulNotes([note("wears wire-rimmed glasses")])).toBeTruthy();
    expect(visualSoulNotes([note("auburn braid")])).toBeTruthy();
    expect(visualSoulNotes([note("stocky, broad across the shoulders")])).toBeTruthy();
    expect(visualSoulNotes([note("somewhere in her forties")])).toBeTruthy();
  });

  it("is empty for an empty soul", () => {
    expect(visualSoulNotes([])).toBe("");
  });

  /**
   * The budget is deliberately the same number the image prompt will accept for one character, so
   * the soul is never the tighter of the two. It used to be 200 against a 160-character descriptor
   * cap — two different arbitrary limits, with the smaller one silently winning downstream.
   */
  it("has the same budget the picture will actually accept", () => {
    expect(SOUL_LOOK_BUDGET_CHARS).toBe(MAX_CHARACTER_DESCRIPTOR_CHARS);
  });

  it("fits a real description of a person, not a fragment", () => {
    const notes = [
      note("silver hair falling past the shoulders, always slightly unkempt"),
      note("sharp grey eyes, deep-set, and a jagged scar through the left eyebrow"),
      note("lean and rangy, stands very straight; weathered olive skin"),
      note("wears a long charcoal coat over a high-collared shirt"),
    ];
    const out = visualSoulNotes(notes);
    expect(out.length).toBeGreaterThan(200); // the old ceiling
    expect(out).toContain("charcoal coat"); // the LAST note still makes it in
  });
});
