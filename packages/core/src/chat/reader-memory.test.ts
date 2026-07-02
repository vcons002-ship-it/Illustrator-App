import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../storage/store.js";
import {
  MAX_MEMORY_NOTES,
  MAX_NOTE_CHARS,
  loadMemory,
  memoryPromptBlock,
  rememberNote,
  forgetNote,
  saveMemory,
} from "./reader-memory.js";

describe("reader memory", () => {
  it("starts empty and persists remembered notes through the store", async () => {
    const store = new InMemoryStore();
    expect(await loadMemory(store)).toEqual([]);
    await rememberNote(store, "prefers watercolor style");
    await rememberNote(store, "never spoil endings");
    const notes = await loadMemory(store);
    expect(notes.map((n) => n.text)).toEqual(["prefers watercolor style", "never spoil endings"]);
    expect(notes.every((n) => typeof n.at === "number")).toBe(true);
  });

  it("dedupes case-insensitively (a repeated note refreshes, not duplicates)", async () => {
    const store = new InMemoryStore();
    await rememberNote(store, "Prefers Watercolor");
    await rememberNote(store, "prefers watercolor");
    const notes = await loadMemory(store);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe("prefers watercolor"); // latest wording wins
  });

  it("trims, caps note length, and rejects empty notes", async () => {
    const store = new InMemoryStore();
    const long = `  ${"x".repeat(MAX_NOTE_CHARS + 50)}  `;
    const notes = await rememberNote(store, long);
    expect(notes[0]!.text).toHaveLength(MAX_NOTE_CHARS);
    await expect(rememberNote(store, "   ")).rejects.toThrow(/nothing to remember/);
  });

  it("evicts the oldest note past the cap", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < MAX_MEMORY_NOTES + 3; i++) await rememberNote(store, `note ${i}`);
    const notes = await loadMemory(store);
    expect(notes).toHaveLength(MAX_MEMORY_NOTES);
    expect(notes[0]!.text).toBe("note 3"); // 0..2 evicted
    expect(notes[notes.length - 1]!.text).toBe(`note ${MAX_MEMORY_NOTES + 2}`);
  });

  it("forgets by case-insensitive substring and throws when nothing matches", async () => {
    const store = new InMemoryStore();
    await rememberNote(store, "prefers watercolor style");
    await rememberNote(store, "reading the Empyrean series");
    const kept = await forgetNote(store, "WATERCOLOR");
    expect(kept.map((n) => n.text)).toEqual(["reading the Empyrean series"]);
    await expect(forgetNote(store, "oil painting")).rejects.toThrow(/no memory note contains/);
  });

  it("survives a corrupt stored memo (treats it as empty)", async () => {
    const store = new InMemoryStore();
    await store.putMemo("reader-memory", "{not json");
    expect(await loadMemory(store)).toEqual([]);
  });

  it("keeps the NEWEST notes when a stored list exceeds the cap (load matches eviction direction)", async () => {
    const store = new InMemoryStore();
    // Simulate a memo written by an older build / larger cap: more entries than MAX_MEMORY_NOTES.
    const over = Array.from({ length: MAX_MEMORY_NOTES + 5 }, (_, i) => ({ text: `note ${i}`, at: i }));
    await store.putMemo("reader-memory", JSON.stringify(over));
    const notes = await loadMemory(store);
    expect(notes).toHaveLength(MAX_MEMORY_NOTES);
    expect(notes[0]!.text).toBe("note 5"); // oldest 5 dropped, newest kept
    expect(notes[notes.length - 1]!.text).toBe(`note ${MAX_MEMORY_NOTES + 4}`);
  });

  it("renders a prompt block only when notes exist", () => {
    expect(memoryPromptBlock([])).toBe("");
    const block = memoryPromptBlock([{ text: "prefers watercolor", at: 1 }]);
    expect(block).toContain("READER MEMORY");
    expect(block).toContain("- prefers watercolor");
  });

  it("saveMemory replaces the whole list, trimming, de-duping, dropping blanks, and bounding", async () => {
    const store = new InMemoryStore();
    await rememberNote(store, "old note"); // gets replaced wholesale by saveMemory
    const saved = await saveMemory(store, [
      { text: "  keep me  ", at: 10 },
      { text: "", at: 11 }, // blank → dropped
      { text: "Keep Me", at: 12 }, // case-insensitive dup of the first → dropped
      { text: "x".repeat(MAX_NOTE_CHARS + 50), at: 13 }, // over-long → trimmed
    ]);
    expect(saved.map((n) => n.text)).toEqual(["keep me", "x".repeat(MAX_NOTE_CHARS)]);
    // Persisted: a fresh load matches what saveMemory returned (and "old note" is gone).
    expect((await loadMemory(store)).map((n) => n.text)).toEqual(["keep me", "x".repeat(MAX_NOTE_CHARS)]);
  });

  it("saveMemory bounds an over-long list to the cap (keeps the most recent)", async () => {
    const store = new InMemoryStore();
    const many = Array.from({ length: MAX_MEMORY_NOTES + 5 }, (_, i) => ({ text: `note ${i}`, at: i }));
    const saved = await saveMemory(store, many);
    expect(saved).toHaveLength(MAX_MEMORY_NOTES);
    expect(saved[saved.length - 1]!.text).toBe(`note ${MAX_MEMORY_NOTES + 4}`);
  });
});
