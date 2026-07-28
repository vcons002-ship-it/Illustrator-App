import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../storage/store.js";
import {
  MAX_CREATIVE_LOG,
  MAX_THREAD_RUN,
  RECENT_TOPICS_SHOWN,
  isExploredNote,
  loadCreativeLog,
  migrateExploredNotes,
  recentTopics,
  recordExplored,
  sameThread,
  threadRun,
} from "./creative-log.js";
import { MAX_MEMORY_NOTES, loadMemory, rememberNote } from "./reader-memory.js";

describe("the creative log", () => {
  it("records topics, newest last, deduped case-insensitively", async () => {
    const store = new InMemoryStore();
    await recordExplored(store, "Salt marshes");
    await recordExplored(store, "Tuning systems");
    await recordExplored(store, "salt marshes"); // same topic, different case

    expect((await loadCreativeLog(store)).map((e) => e.text)).toEqual(["Tuning systems", "salt marshes"]);
  });

  it("keeps a month of exploring and evicts the oldest past the cap", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < MAX_CREATIVE_LOG + 5; i++) await recordExplored(store, `topic ${i}`);
    const log = await loadCreativeLog(store);
    expect(log).toHaveLength(MAX_CREATIVE_LOG);
    expect(log[0]!.text).toBe("topic 5");
    expect(log[log.length - 1]!.text).toBe(`topic ${MAX_CREATIVE_LOG + 4}`);
  });

  it("recentTopics takes the NEWEST few, in reading order", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < RECENT_TOPICS_SHOWN + 4; i++) await recordExplored(store, `topic ${i}`);
    const recent = recentTopics(await loadCreativeLog(store));
    expect(recent).toHaveLength(RECENT_TOPICS_SHOWN);
    expect(recent[0]).toBe("topic 4");
    expect(recent[recent.length - 1]).toBe(`topic ${RECENT_TOPICS_SHOWN + 3}`);
  });

  it("an empty log yields no topics (a first run has nothing to avoid)", async () => {
    expect(recentTopics(await loadCreativeLog(new InMemoryStore()))).toEqual([]);
  });
});

/**
 * Reading around one subject for a few pieces IS following a thread, and the feature exists so it
 * can. This only measures how long it has stayed there, so the brief can suggest a change of scene
 * once it has gone on a while — and say nothing at all until then.
 */
describe("noticing a thread", () => {
  it("matches topics sharing a subject word, including plurals and derived forms", () => {
    expect(sameThread("Salt marshes and carbon", "How a salt marsh migrates")).toBe(true);
    expect(sameThread("Tuning systems before equal temperament", "Just intonation and tuning")).toBe(true);
    expect(sameThread("Salt marshes and carbon", "Roman concrete in seawater")).toBe(false);
  });

  it("doesn't call two topics related on grammar alone", () => {
    // Both are full of shared short/common words; neither shares a SUBJECT.
    expect(sameThread("What happens when these break down", "Where those have been before")).toBe(false);
  });

  it("counts only the unbroken run at the end of the list", () => {
    expect(threadRun([])).toBe(0);
    expect(threadRun(["Roman concrete"])).toBe(1);
    expect(threadRun(["Salt marshes", "Roman concrete"])).toBe(1);
    expect(threadRun(["Roman concrete", "Concrete in seawater"])).toBe(2);
    // An older piece on the same subject doesn't count — the run was already broken by the marshes.
    expect(threadRun(["Roman concrete", "Salt marshes", "Concrete in seawater"])).toBe(1);
  });

  it("MAX_THREAD_RUN leaves room for a real thread before nudging", () => {
    const thread = ["Roman concrete", "Concrete in seawater", "Concrete and volcanic ash"];
    expect(threadRun(thread.slice(0, 2)) >= MAX_THREAD_RUN).toBe(false); // two in a row: left alone
    expect(threadRun(thread) >= MAX_THREAD_RUN).toBe(true); // three: time to look elsewhere
  });
});

describe("migrating the old explored: notes out of reader memory", () => {
  it("moves them to the log, strips the prefix, and takes them OUT of memory", async () => {
    const store = new InMemoryStore();
    await rememberNote(store, "prefers oil-painting style");
    await rememberNote(store, "explored: salt marshes");
    await rememberNote(store, "Explored: tuning systems"); // the prefix test is case-insensitive
    await rememberNote(store, "never spoil endings");

    const moved = await migrateExploredNotes(store);

    expect(moved).toBe(2);
    expect((await loadCreativeLog(store)).map((e) => e.text)).toEqual(["salt marshes", "tuning systems"]);
    // The reader's own memories are untouched, and the ledger notes no longer occupy slots in a list
    // that evicts the oldest — which is how exploring was deleting them.
    expect((await loadMemory(store)).map((n) => n.text)).toEqual(["prefers oil-painting style", "never spoil endings"]);
  });

  it("is a no-op when there's nothing to move, and is safe to run repeatedly", async () => {
    const store = new InMemoryStore();
    await rememberNote(store, "prefers oil-painting style");
    await recordExplored(store, "salt marshes");

    expect(await migrateExploredNotes(store)).toBe(0);
    expect(await migrateExploredNotes(store)).toBe(0);
    expect((await loadCreativeLog(store)).map((e) => e.text)).toEqual(["salt marshes"]);
    expect((await loadMemory(store)).map((n) => n.text)).toEqual(["prefers oil-painting style"]);
  });

  it("doesn't duplicate a topic already in the log", async () => {
    const store = new InMemoryStore();
    await recordExplored(store, "salt marshes");
    await rememberNote(store, "explored: Salt Marshes");

    await migrateExploredNotes(store);

    expect((await loadCreativeLog(store)).map((e) => e.text)).toEqual(["salt marshes"]);
    expect(await loadMemory(store)).toEqual([]);
  });

  it("frees the memory slots the ledger was eating", async () => {
    const store = new InMemoryStore();
    // A memory list entirely consumed by explore notes: the state a few days of exploring produced.
    for (let i = 0; i < MAX_MEMORY_NOTES; i++) await rememberNote(store, `explored: topic ${i}`);
    expect(await loadMemory(store)).toHaveLength(MAX_MEMORY_NOTES);

    await migrateExploredNotes(store);

    expect(await loadMemory(store)).toEqual([]);
    expect(await loadCreativeLog(store)).toHaveLength(MAX_MEMORY_NOTES);
  });

  it("isExploredNote only matches the ledger prefix", () => {
    expect(isExploredNote("explored: salt marshes")).toBe(true);
    expect(isExploredNote("  Explored: salt marshes")).toBe(true);
    expect(isExploredNote("has explored: salt marshes")).toBe(false);
    expect(isExploredNote("wants to explore salt marshes")).toBe(false);
  });
});
