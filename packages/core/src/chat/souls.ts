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
/** Per-note character cap — generous enough for a real character bio/paragraph. Matches reader-memory's
 * MAX_NOTE_CHARS; kept as its own constant since souls are a separate bounded list. */
export const MAX_SOUL_NOTE_CHARS = 2000;
export const MAX_SOUL_NAME_CHARS = 80;

const SPECS: Record<SoulKind, NoteStoreSpec> = {
  self: { key: SELF_SOUL_KEY, maxNotes: MAX_SOUL_NOTES, maxChars: MAX_SOUL_NOTE_CHARS },
  user: { key: ABOUT_YOU_SOUL_KEY, maxNotes: MAX_SOUL_NOTES, maxChars: MAX_SOUL_NOTE_CHARS },
};
const NAME_KEY: Record<SoulKind, string> = { self: "self-soul-name", user: "about-you-soul-name" };
const FORGET_LABEL: Record<SoulKind, string> = { self: "self-soul note", user: "about-you note" };
const IMAGES_KEY: Record<SoulKind, string> = { self: "self-soul-images", user: "about-you-soul-images" };
/** How many reference photos a soul may hold — a couple of angles is plenty for character conditioning. */
export const MAX_SOUL_IMAGES = 3;

/** A reference photo attached to a soul: stored base64 (JSON-able in the KV store), decoded to bytes
 * only when fed to the image model as a character reference. */
export interface SoulImage {
  mimeType: string;
  dataBase64: string;
}

function isSoulImage(v: unknown): v is SoulImage {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as SoulImage).mimeType === "string" &&
    typeof (v as SoulImage).dataBase64 === "string" &&
    (v as SoulImage).dataBase64.length > 0
  );
}

/** The soul's reference photos ([] when none). */
export async function loadSoulImages(store: VisualReaderStore, kind: SoulKind): Promise<SoulImage[]> {
  const raw = await store.getMemo?.(IMAGES_KEY[kind]).catch(() => undefined);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(isSoulImage).slice(0, MAX_SOUL_IMAGES) : [];
  } catch {
    return [];
  }
}

/** Replace the soul's reference photos (capped at MAX_SOUL_IMAGES). */
export async function saveSoulImages(store: VisualReaderStore, kind: SoulKind, images: readonly SoulImage[]): Promise<void> {
  await store.putMemo?.(IMAGES_KEY[kind], JSON.stringify(images.filter(isSoulImage).slice(0, MAX_SOUL_IMAGES)));
}

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
    "WHO YOU ARE (your own durable identity — your persona, character, voice, and look). This is who " +
    "you are in EVERY conversation: by default speak and carry yourself as this character — in ordinary " +
    "chat just as much as when you play yourself in a story. Stay consistent with it (it shapes your " +
    "tone and manner, never your willingness to help or your honesty):\n" +
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * When an in-chat image is of the ASSISTANT ITSELF, fold its identity "soul" appearance into the
 * image prompt so "draw yourself" reliably renders its real look (the soul is otherwise only TEXT in
 * the model's context, which it may or may not apply). Triggers when the prompt names the assistant
 * (whole word) OR self-references it ("yourself", "a selfie", "portrait/picture of you", "draw you").
 * Returns the prompt UNCHANGED when it isn't about the assistant or there's no look to add (so an
 * ordinary "draw an apple" is untouched).
 */
export function selfPortraitPrompt(prompt: string, name: string, notes: readonly SoulNote[]): string {
  if (!prompt.trim() || !isSelfPortraitRequest(prompt, name)) return prompt;
  return foldSoulLook(prompt, name, notes, "the assistant");
}

/** Symmetric to selfPortraitPrompt for the USER soul — when the image is of the READER ("draw me", "a
 * picture of me", their character name), fold the user soul's appearance into the prompt. */
export function userPortraitPrompt(prompt: string, name: string, notes: readonly SoulNote[]): string {
  if (!prompt.trim() || !isUserPortraitRequest(prompt, name)) return prompt;
  return foldSoulLook(prompt, name, notes, "the reader");
}

/** True when an image request is of the ASSISTANT itself — it names the assistant (whole word) or
 * self-references it ("yourself", "a selfie", "portrait of you", "draw you"). */
export function isSelfPortraitRequest(prompt: string, name: string): boolean {
  const p = prompt.toLowerCase();
  const t = name.trim();
  const named = !!t && new RegExp(`\\b${escapeRegExp(t.toLowerCase())}\\b`).test(p);
  return (
    named ||
    /\byourself\b/.test(p) ||
    /\ba selfie\b/.test(p) ||
    /\b(portrait|picture|photo|image|drawing|painting|selfie|avatar|likeness)\s+of\s+you\b/.test(p) ||
    /\b(draw|paint|render|generate|make|create)\s+you\b/.test(p) ||
    /\byour\s+(self-?portrait|portrait|avatar|likeness)\b/.test(p)
  );
}

/** True when an image request is of the READER — names their character or self-references them
 * ("myself", "a picture of me", "my portrait", "draw me" — but NOT "draw me a/an/the …", which is
 * "make something FOR me", not a portrait OF me). */
export function isUserPortraitRequest(prompt: string, name: string): boolean {
  const p = prompt.toLowerCase();
  const t = name.trim();
  const named = !!t && new RegExp(`\\b${escapeRegExp(t.toLowerCase())}\\b`).test(p);
  return (
    named ||
    /\bmyself\b/.test(p) ||
    /\b(portrait|picture|photo|image|drawing|painting|selfie|avatar|likeness)\s+of\s+me\b/.test(p) ||
    /\bmy\s+(self-?portrait|portrait|avatar|likeness)\b/.test(p) ||
    /\b(draw|paint|render|sketch)\s+me\b(?!\s+(a|an|the|some|this|that|one)\b)/.test(p)
  );
}

/** Append the soul's appearance to a prompt (no-op when the soul has no look notes). */
function foldSoulLook(prompt: string, name: string, notes: readonly SoulNote[], fallback: string): string {
  const look = notes.map((n) => n.text.trim()).filter(Boolean).join(", ");
  if (!look) return prompt;
  return `${prompt} — depict ${name.trim() || fallback} with this appearance: ${look}`;
}
