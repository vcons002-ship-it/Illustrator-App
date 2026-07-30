import { describe, expect, it } from "vitest";
import type { SoulNote } from "@visual-reader/core";
import {
  deleteSoulNoteAt,
  editSoulNoteAt,
  nextSoulNoteTimestamp,
  soulNoteRows,
} from "./soul-note-editing.js";

describe("Soul note row interactions", () => {
  it("edits only the selected row when two notes share a timestamp", () => {
    const notes: SoulNote[] = [
      { text: "old blue eyes", at: 50 },
      { text: "keep this separate detail", at: 50 },
    ];

    const edited = editSoulNoteAt(notes, 0, "current green eyes", 40);

    expect(edited).toEqual([
      { text: "keep this separate detail", at: 50 },
      { text: "current green eyes", at: 51 },
    ]);
    expect(notes[0]!.text).toBe("old blue eyes");
    expect(soulNoteRows(edited).map((row) => row.note.text)).toEqual([
      "current green eyes",
      "keep this separate detail",
    ]);
  });

  it("gives an edited correction a unique newest timestamp", () => {
    const notes: SoulNote[] = [
      { text: "foundational appearance", at: 5_000 },
      { text: "later personality detail", at: 6_000 },
    ];

    expect(nextSoulNoteTimestamp(notes, 100)).toBe(6_001);
    expect(editSoulNoteAt(notes, 0, "corrected appearance", 100).at(-1)?.at).toBe(6_001);
  });

  it("gives a newly added row a collision-free timestamp", () => {
    const notes: SoulNote[] = [
      { text: "one", at: 100 },
      { text: "two", at: 100 },
    ];

    expect(nextSoulNoteTimestamp(notes, 100)).toBe(101);
  });

  it("can edit and delete one legacy row whose timestamp is missing", () => {
    const notes = [
      { text: "legacy appearance without a timestamp" },
      { text: "another legacy detail without a timestamp" },
    ] as SoulNote[];

    const rows = soulNoteRows(notes);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    expect(rows.map((row) => row.sourceIndex)).toEqual([1, 0]);

    const edited = editSoulNoteAt(notes, 0, "current appearance", 700);
    expect(edited).toEqual([
      { text: "another legacy detail without a timestamp" },
      { text: "current appearance", at: 700 },
    ]);

    expect(deleteSoulNoteAt(notes, 0)).toEqual([
      { text: "another legacy detail without a timestamp" },
    ]);
  });

  it("deletes only the chosen row when timestamps collide", () => {
    const notes: SoulNote[] = [
      { text: "remove me", at: 10 },
      { text: "keep me", at: 10 },
      { text: "also keep me", at: 9 },
    ];

    expect(deleteSoulNoteAt(notes, 1)).toEqual([
      { text: "remove me", at: 10 },
      { text: "also keep me", at: 9 },
    ]);
  });

  it("keeps an edited foundational note through the next append-only eviction", () => {
    const notes: SoulNote[] = [
      { text: "foundational appearance", at: 1 },
      { text: "middle note", at: 2 },
      { text: "newest note", at: 3 },
    ];

    const edited = editSoulNoteAt(notes, 0, "corrected appearance", 4);
    const afterNextAppend = [
      ...edited,
      { text: "assistant-added note", at: 5 },
    ].slice(-3);

    expect(afterNextAppend.map((entry) => entry.text)).toEqual([
      "newest note",
      "corrected appearance",
      "assistant-added note",
    ]);
  });
});
