import type { VisualReaderStore } from "../storage/store.js";
import { type NoteEntry, type NoteStoreSpec, loadNotes, saveNotes, rememberIn, forgetIn } from "./note-store.js";

/**
 * The two identity "souls" — durable notes, separate from reader-memory, that capture
 * IDENTITY rather than preferences:
 *  - SELF  ("who you are"): the assistant's own persona, look, and voice — so when it
 *    plays itself in a story (You & me roleplay) it stays consistent.
 *  - USER  ("who the reader is"): what the assistant knows about the reader's own
 *    character — look, personality — so it can portray them when they play themselves.
 *
 * Same bounded note machinery as reader-memory (`note-store.ts`), under different memo
 * keys, plus a short NAME per soul (used to seed the played character names in roleplay).
 * Edited via the Soul panels AND the remember/forget tools (`about:"self"|"user"`).
 */

export type SoulKind = "self" | "user";

export const SELF_SOUL_KEY = "self-soul";
export const ABOUT_YOU_SOUL_KEY = "about-you-soul";
export const MAX_SOUL_NOTES = 40;
export const MAX_SOUL_NOTE_CHARS = 1000;
export const MAX_SOUL_NAME_CHARS = 80;

const SPECS: Record<SoulKind, NoteStoreSpec> = {
  self: { key: SELF_SOUL_KEY, maxNotes: MAX_SOUL_NOTES, maxChars: MAX_SOUL_NOTE_CHARS },
  user: { key: ABOUT_YOU_SOUL_KEY, maxNotes: MAX_SOUL_NOTES, maxChars: MAX_SOUL_NOTE_CHARS },
};
const NAME_KEY: Record<SoulKind, string> = { self: "self-soul-name", user: "about-you-soul-name" };
const FORGET_LABEL: Record<SoulKind, string> = { self: "self-soul note", user: "about-you note" };

/** A single durable identity note. */
export type SoulNote = NoteEntry;

export function loadSoul(store: VisualReaderStore, kind: SoulKind): Promise<SoulNote[]> {
  return loadNotes(store, SPECS[kind]);
}

/** Replace the WHOLE list — for the editable Soul panel. */
export function saveSoul(store: VisualReaderStore, kind: SoulKind, notes: readonly SoulNote[]): Promise<SoulNote[]> {
  return saveNotes(store, SPECS[kind], notes);
}

export function rememberSoul(store: VisualReaderStore, kind: SoulKind, text: string): Promise<SoulNote[]> {
  return rememberIn(store, SPECS[kind], text);
}

export function forgetSoul(store: VisualReaderStore, kind: SoulKind, match: string): Promise<SoulNote[]> {
  return forgetIn(store, SPECS[kind], match, FORGET_LABEL[kind]);
}

/** The played character's NAME for this soul ("" when unset). */
export async function loadSoulName(store: VisualReaderStore, kind: SoulKind): Promise<string> {
  return ((await store.getMemo?.(NAME_KEY[kind])) ?? "").trim();
}

export async function saveSoulName(store: VisualReaderStore, kind: SoulKind, name: string): Promise<void> {
  await store.putMemo?.(NAME_KEY[kind], name.trim().slice(0, MAX_SOUL_NAME_CHARS));
}

/** System-prompt block for the assistant's own identity ("" when empty). */
export function selfSoulPromptBlock(notes: readonly SoulNote[], name = ""): string {
  if (notes.length === 0 && !name) return "";
  return (
    "WHO YOU ARE (your own durable identity — persona, look, and voice; stay consistent with this, " +
    "and embody it when you play yourself in a story):\n" +
    (name ? `- Name: ${name}\n` : "") +
    notes.map((n) => `- ${n.text}`).join("\n")
  );
}

/** System-prompt block for what the assistant knows about the reader's own character ("" when empty). */
export function userSoulPromptBlock(notes: readonly SoulNote[], name = ""): string {
  if (notes.length === 0 && !name) return "";
  return (
    "WHO THE READER IS (durable identity facts about the reader's own character — look, personality, " +
    "how they like to be portrayed; use these when the reader plays themselves):\n" +
    (name ? `- Name: ${name}\n` : "") +
    notes.map((n) => `- ${n.text}`).join("\n")
  );
}
