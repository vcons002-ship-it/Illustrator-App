import type { ChapterScene, KeyEvent, ScenePrompt, VisualBible } from "../types/bible.js";

/**
 * Upsert a keyEvent into a chapter's storyboard scene (creating the scene if needed),
 * replacing any existing event with the same pageRange so re-runs are idempotent.
 * Returns a new bible (does not mutate the input).
 */
export function addKeyEvent(bible: VisualBible, chapterIndex: number, ev: KeyEvent): VisualBible {
  const storyboard: ChapterScene[] = bible.storyboard.map((s) => ({ ...s }));
  let scene = storyboard.find((s) => s.chapterIndex === chapterIndex);
  if (!scene) {
    scene = { chapterIndex, summary: "", keyMoment: "", location: "", locationChange: "", keyEvents: [] };
    storyboard.push(scene);
    storyboard.sort((a, b) => a.chapterIndex - b.chapterIndex);
  }
  const kept = (scene.keyEvents ?? []).filter(
    (e) => !(e.pageRange[0] === ev.pageRange[0] && e.pageRange[1] === ev.pageRange[1]),
  );
  scene.keyEvents = [...kept, ev].sort((a, b) => a.pageRange[0] - b.pageRange[0]);
  return { ...bible, storyboard };
}

/** Drop every stored keyEvent (e.g. "rebuild illustration prompts"). New bible. */
export function clearKeyEvents(bible: VisualBible): VisualBible {
  return {
    ...bible,
    storyboard: bible.storyboard.map((s) => {
      const { keyEvents: _drop, ...rest } = s;
      return rest;
    }),
  };
}

/** Inclusive-range overlap (in pages) between two [start, end] ranges; 0 if disjoint. */
function overlap(a: [number, number], b: [number, number]): number {
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  return hi >= lo ? hi - lo + 1 : 0;
}

/**
 * Find the stored Layer-1 prompt for a render unit: among the chapter's keyEvents,
 * the one whose `pageRange` overlaps the unit's `pageRange` the most (ties → earliest).
 * Returns undefined when the unit has no range, the chapter has no events, or nothing
 * overlaps — in which case the pipeline falls back to the live LLM.
 */
export function resolveKeyEvent(
  bible: VisualBible,
  chapterIndex: number,
  pageRange: [number, number] | undefined,
): KeyEvent | undefined {
  return resolveKeyEventIn(
    bible.storyboard.find((s) => s.chapterIndex === chapterIndex),
    pageRange,
  );
}

/**
 * Same matching, but against an already-located scene — for callers that hold an
 * indexed chapter→scene lookup (the engine's per-pump gate) and would otherwise
 * re-scan the storyboard per page.
 */
export function resolveKeyEventIn(
  scene: ChapterScene | undefined,
  pageRange: [number, number] | undefined,
): KeyEvent | undefined {
  if (!pageRange) return undefined;
  const events = scene?.keyEvents;
  if (!events || events.length === 0) return undefined;

  let best: KeyEvent | undefined;
  let bestOverlap = 0;
  for (const ev of events) {
    const o = overlap(ev.pageRange, pageRange);
    if (o > bestOverlap) {
      bestOverlap = o;
      best = ev;
    }
  }
  return bestOverlap > 0 ? best : undefined;
}

/**
 * Flatten a Layer-1 scene prompt to the natural-language base prompt the pipeline's
 * Layer-2 formatting (quality tags + identity emphasis + IP-Adapter) consumes.
 * Prefers the structured five fields (external-AI authored); falls back to a
 * pre-composed `text` (the app's own precompute). Returns "" if nothing is set.
 */
export function composeScenePrompt(p: ScenePrompt): string {
  const structured = [p.subject, p.action, p.environment, p.mood, p.composition]
    .map((s) => (s ?? "").trim())
    .filter(Boolean);
  if (structured.length > 0) return structured.join(". ");
  return (p.text ?? "").trim();
}

/**
 * Commit a base prompt to the keyEvent's beat-level location ("one picture, one
 * place"). Appends an explicit setting clause when the prompt doesn't already name
 * the place — naming it also lets bible-term injection expand it into the location's
 * full visual description. No-op when the event has no location (older Bibles) or
 * the prompt names it already.
 */
export function anchorSetting(prompt: string, location: string | undefined): string {
  const place = (location ?? "").trim();
  if (!prompt || !place || prompt.toLowerCase().includes(place.toLowerCase())) return prompt;
  return `${prompt.replace(/[\s.]+$/, "")}. Setting: ${place}.`;
}
