import { portraitSubjects, visualSoulNotes, type SoulNote } from "./souls.js";
import type { PortraitScene } from "./portrait-scene.js";

export interface PortraitReference {
  bytes: ArrayBuffer;
  mimeType: string;
}

interface PortraitSoul {
  name: string;
  notes: readonly SoulNote[];
  refs: readonly PortraitReference[];
  /** Stories may cast only one of the two souls, or neither. */
  enabled?: boolean;
}

/**
 * Session references are useful for edits, but an old reader photo is not a reference for a later
 * assistant portrait. Only an explicit reference request can override the selected Soul's photos.
 * "Use your Soul photos" does not opt old chat attachments back in.
 */
function chatReferenceSelection(request: string): "none" | "latest" | "all" {
  const references = /\b(?:this|that|these|those|attached|uploaded|selected)\s+(?:(?:reference|background|source)\s+)?(photos?|pictures?|images?|references?)\b|\b(photos?|pictures?|images?|references?)\s+(?:that\s+)?(?:I|we)\s+(?:attached|uploaded|selected|sent)\b/gi;
  let selection: "none" | "latest" | "all" = "none";
  for (const match of request.matchAll(references)) {
    // A mention is not consent to use a reference. Restrict these checks to its clause so
    // "don't use your Soul photos; use this photo" can still make a positive choice.
    const before = request.slice(0, match.index).split(/[.,;!?\n]|\bbut\b/i).at(-1) ?? "";
    const after = request.slice(match.index + match[0].length).split(/[.,;!?\n]|\bbut\b/i)[0] ?? "";
    const excluded = /\b(?:no|not|never|without|ignore|exclude|excluding|avoid|don['’]t)\b/i.test(before) ||
      /^\s+(?:(?:should|must|can|may)\s+not|(?:is|are)\s+not\s+to|(?:shouldn|mustn|can)['’]t)\s+(?:be\s+)?(?:used?|included?|referenced?)\b/i.test(after);
    if (excluded) continue;
    const noun = (match[1] ?? match[2] ?? "").toLowerCase();
    if (noun.endsWith("s")) return "all";
    selection = "latest";
  }
  return selection;
}

/**
 * Assemble prompt and reference selection together so the two cannot select different identities.
 * For a Soul portrait, the model supplies a separate per-image scene and the selected Soul supplies
 * identity. Reusing the free-form prompt preserves any other person's appearance it already copied;
 * reusing the whole reader request loses resolved context and individual scenes in a batch.
 */
export function buildSoulPortraitRender(input: {
  userText: string;
  modelPrompt: string;
  scene?: PortraitScene;
  self: PortraitSoul;
  user: PortraitSoul;
  chatRefs?: readonly PortraitReference[];
  maxRefs?: number;
}): {
  prompt: string;
  refs: (PortraitReference & { weight: number })[];
  sources: { attached?: number; self?: number; user?: number; selfName?: string };
} {
  const names = { selfName: input.self.name, userName: input.user.name };
  const inferred = portraitSubjects({ userText: input.userText, modelPrompt: input.modelPrompt, ...names });
  const subject = {
    self: inferred.self && input.self.enabled !== false,
    user: inferred.user && input.user.enabled !== false,
  };
  const selected = (["self", "user"] as const).filter((kind) => subject[kind]);
  const scene = input.scene && [
    input.scene.action ? `Action: ${input.scene.action}` : "",
    input.scene.setting ? `Setting: ${input.scene.setting}` : "",
    input.scene.clothing ? `Clothing: ${input.scene.clothing}` : "",
    input.scene.composition ? `Composition: ${input.scene.composition}` : "",
  ].filter(Boolean).join("\n");
  if (selected.length && !scene) {
    throw new Error(
      "Soul portraits need a separate scene. Retry generate_image with scene: { action, setting, clothing, composition }. " +
      "Describe only this image's resolved scene; refer to the person as SUBJECT (ASSISTANT and READER for a pair). " +
      "Omit names and permanent appearance such as face, hair, eyes or body: the app supplies the selected Soul's identity.",
    );
  }
  const labels = {
    self: input.self.name.trim() || "the assistant",
    user: input.user.name.trim() || "the reader",
  };
  const identity = selected.map((kind) => {
    const look = visualSoulNotes(input[kind].notes);
    return look ? `Appearance of ${labels[kind]}: ${look}.` : "";
  }).filter(Boolean);
  const cast = selected.map((kind) => `${labels[kind]} (${kind === "self" ? "assistant" : "reader"})`);
  const prompt = selected.length
    ? [
        selected.length === 2 ? `Depict two distinct people: ${cast.join(" and ")}.` : `Portrait subject: ${cast[0]}.`,
        ...identity,
        scene,
        "Use the requested scene, pose, clothing and style with the subject's own appearance.",
        ...(selected.length === 2 ? ["Keep each person's appearance separate."] : []),
      ].join("\n")
    : input.modelPrompt;

  const chatSelection = selected.length === 0 ? "all" : chatReferenceSelection(input.userText);
  const candidates: (PortraitReference & { weight: number; source: "attached" | "self" | "user" })[] = [];
  if (chatSelection !== "none") {
    // A singular "this photo" means the latest choice, not every face adopted earlier in the chat.
    // Explicit plurals and ordinary non-Soul edits retain the complete session reference set.
    const newestFirst = [...(input.chatRefs ?? [])].reverse();
    const chatRefs = chatSelection === "latest" ? newestFirst.slice(0, 1) : newestFirst;
    candidates.push(...chatRefs.map((ref) => ({ ...ref, weight: 0.9, source: "attached" as const })));
  }
  for (const kind of selected) {
    candidates.push(...input[kind].refs.map((ref) => ({ ...ref, weight: 0.85, source: kind })));
  }
  const kept = candidates.slice(0, input.maxRefs ?? 10);
  const sources: { attached?: number; self?: number; user?: number; selfName?: string } = {};
  if (subject.self && input.self.name.trim()) sources.selfName = input.self.name.trim();
  for (const ref of kept) sources[ref.source] = (sources[ref.source] ?? 0) + 1;
  return {
    prompt,
    refs: kept.map(({ source: _source, ...ref }) => ref),
    sources,
  };
}
