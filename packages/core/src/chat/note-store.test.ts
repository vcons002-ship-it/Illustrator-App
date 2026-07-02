import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../storage/store.js";
import { forgetIn, loadNotes, rememberIn, saveNotes, type NoteEntry, type NoteStoreSpec } from "./note-store.js";

const spec: NoteStoreSpec = { key: "test-notes", maxNotes: 3, maxChars: 20 };

describe("note-store save/load roundtrip", () => {
  it("persists a saved list as one memo and loads it back unchanged", async () => {
    const store = new InMemoryStore();
    const saved = await saveNotes(store, spec, [{ text: "likes tea", at: 1 }]);
    expect(saved).toEqual([{ text: "likes tea", at: 1 }]);
    expect(await loadNotes(store, spec)).toEqual(saved);
  });

  it("cleans on save: trims + caps chars, drops blanks, dedupes case-insensitively keeping the first", async () => {
    const store = new InMemoryStore();
    const saved = await saveNotes(store, spec, [
      { text: "  Likes tea  ", at: 1 },
      { text: "", at: 2 },
      { text: "   ", at: 3 },
      { text: "likes TEA", at: 4 }, // case-insensitive dupe of the first
      { text: "a very long note that overflows the cap", at: 5 },
    ]);
    expect(saved.map((n) => n.text)).toEqual(["Likes tea", "a very long note tha"]);
  });

  it("keeps the NEWEST notes when the list exceeds maxNotes", async () => {
    const store = new InMemoryStore();
    const notes = ["one", "two", "three", "four"].map((text, i) => ({ text, at: i }));
    const saved = await saveNotes(store, spec, notes);
    expect(saved.map((n) => n.text)).toEqual(["two", "three", "four"]);
    expect((await loadNotes(store, spec)).map((n) => n.text)).toEqual(["two", "three", "four"]);
  });

  it("fills a missing timestamp with now", async () => {
    const store = new InMemoryStore();
    const before = Date.now();
    const saved = await saveNotes(store, spec, [{ text: "x" } as NoteEntry]);
    expect(saved[0]!.at).toBeGreaterThanOrEqual(before);
  });
});

describe("loadNotes corrupt/legacy payload recovery", () => {
  it("returns [] when the memo is absent", async () => {
    expect(await loadNotes(new InMemoryStore(), spec)).toEqual([]);
  });

  it("returns [] for corrupt JSON instead of throwing", async () => {
    const store = new InMemoryStore();
    await store.putMemo(spec.key, "{not json");
    expect(await loadNotes(store, spec)).toEqual([]);
  });

  it("returns [] for a non-array payload", async () => {
    const store = new InMemoryStore();
    await store.putMemo(spec.key, '{"a":1}');
    expect(await loadNotes(store, spec)).toEqual([]);
  });

  it("drops malformed entries and keeps only the newest maxNotes", async () => {
    const store = new InMemoryStore();
    await store.putMemo(
      spec.key,
      JSON.stringify([
        { text: 1 }, // wrong type → dropped
        null,
        { text: "a", at: 1 },
        { text: "b", at: 2 },
        { text: "c", at: 3 },
        { text: "d", at: 4 },
      ]),
    );
    // The cap keeps the END of the append-ordered list (the newest notes), not the start.
    expect((await loadNotes(store, spec)).map((n) => n.text)).toEqual(["b", "c", "d"]);
  });
});

describe("rememberIn", () => {
  it("appends, moves a re-remembered note to the end, and evicts the oldest past the cap", async () => {
    const store = new InMemoryStore();
    await rememberIn(store, spec, "one");
    await rememberIn(store, spec, "two");
    await rememberIn(store, spec, "ONE"); // case-insensitive dupe: replaced + moved to the end
    expect((await loadNotes(store, spec)).map((n) => n.text)).toEqual(["two", "ONE"]);

    await rememberIn(store, spec, "three");
    await rememberIn(store, spec, "four"); // cap of 3 → "two" (the oldest) evicted
    expect((await loadNotes(store, spec)).map((n) => n.text)).toEqual(["ONE", "three", "four"]);
  });

  it("throws on a blank note", async () => {
    await expect(rememberIn(new InMemoryStore(), spec, "   ")).rejects.toThrow(/nothing to remember/);
  });
});

describe("forgetIn", () => {
  it("removes every note containing the match, case-insensitively", async () => {
    const store = new InMemoryStore();
    await rememberIn(store, spec, "likes tea");
    await rememberIn(store, spec, "drinks TEA daily");
    await rememberIn(store, spec, "owns a dog");
    const kept = await forgetIn(store, spec, "Tea");
    expect(kept.map((n) => n.text)).toEqual(["owns a dog"]);
    expect((await loadNotes(store, spec)).map((n) => n.text)).toEqual(["owns a dog"]);
  });

  it("throws with the store's label when nothing matches", async () => {
    const store = new InMemoryStore();
    await rememberIn(store, spec, "owns a dog");
    await expect(forgetIn(store, spec, "ghost", "self-soul note")).rejects.toThrow(
      /no self-soul note contains "ghost"/,
    );
  });

  it("throws on a blank match", async () => {
    await expect(forgetIn(new InMemoryStore(), spec, "  ")).rejects.toThrow(/nothing to forget/);
  });
});
