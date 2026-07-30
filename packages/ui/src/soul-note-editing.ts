import type { SoulNote } from "@visual-reader/core";

/**
 * A Soul note's timestamp is historical data, not a safe row id: legacy/imported notes may omit it,
 * and two notes can legitimately share the same millisecond. Keep the source-array index alongside
 * each displayed row so one Edit/Delete action always targets exactly the row the reader chose.
 */
export interface SoulNoteRow {
  note: SoulNote;
  sourceIndex: number;
  key: string;
}

function finiteTimestamp(note: SoulNote): number | undefined {
  return Number.isFinite(note.at) ? Math.trunc(note.at) : undefined;
}

/** Newest-first display rows with collision-safe action identity and React keys. */
export function soulNoteRows(notes: readonly SoulNote[]): SoulNoteRow[] {
  return notes
    .map((note, sourceIndex) => ({
      note,
      sourceIndex,
      key: `${sourceIndex}:${finiteTimestamp(note) ?? "missing"}:${note.text}`,
    }))
    .sort((a, b) => {
      const aAt = finiteTimestamp(a.note);
      const bAt = finiteTimestamp(b.note);
      // Legacy notes with no usable timestamp retain their relative source order after dated notes.
      if (aAt === undefined && bAt === undefined) return b.sourceIndex - a.sourceIndex;
      if (aAt === undefined) return 1;
      if (bAt === undefined) return -1;
      return bAt - aAt || b.sourceIndex - a.sourceIndex;
    });
}

/**
 * An edit is a new correction chronologically, even though it replaces the selected source row.
 * Advance past both wall-clock time and every stored timestamp so rapid edits/imported future dates
 * cannot collide or leave a corrected appearance behind an older description.
 */
export function nextSoulNoteTimestamp(
  notes: readonly SoulNote[],
  writtenAt = Date.now(),
): number {
  const latest = notes.reduce((max, note) => {
    const at = finiteTimestamp(note);
    return at === undefined ? max : Math.max(max, at);
  }, 0);
  const now = Number.isFinite(writtenAt) ? Math.max(0, Math.trunc(writtenAt)) : 0;
  return Math.max(now, latest + 1);
}

/**
 * Replace exactly one displayed source row and append the correction as the newest Soul fact.
 * Note storage evicts from the front of this append-ordered array, so merely changing `at` in place
 * would let the next append evict a freshly edited foundational note.
 */
export function editSoulNoteAt(
  notes: readonly SoulNote[],
  sourceIndex: number,
  text: string,
  writtenAt = Date.now(),
): SoulNote[] {
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= notes.length) {
    return [...notes];
  }
  const at = nextSoulNoteTimestamp(notes, writtenAt);
  const selected = notes[sourceIndex]!;
  return [
    ...notes.filter((_note, index) => index !== sourceIndex),
    { ...selected, text, at },
  ];
}

/** Delete exactly one displayed source row, even when timestamps are missing or duplicated. */
export function deleteSoulNoteAt(
  notes: readonly SoulNote[],
  sourceIndex: number,
): SoulNote[] {
  return notes.filter((_note, index) => index !== sourceIndex);
}
