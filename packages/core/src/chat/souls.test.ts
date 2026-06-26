import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../storage/store.js";
import { loadMemory } from "./reader-memory.js";
import {
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
} from "./souls.js";

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
