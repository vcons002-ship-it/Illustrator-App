/**
 * Continuity helpers for LONG-FORM (chained-clip) video. Each clip is conditioned ONLY on the
 * previous clip's last frame — the chain has no other memory. So the moment the subject walks out
 * of frame, or the model invents a cut/scene change, the next clip's conditioning image no longer
 * contains the subject and the render drifts off the source material with nothing to pull it back.
 * These helpers fight that at the only levers the pipeline has:
 *   1. the POSITIVE prompt — every clip re-states the persistent subject (the anchor) and pins the
 *      shot to one continuous, subject-in-frame camera move;
 *   2. the NEGATIVE prompt — scene cuts / exits / pans-away are suppressed alongside the usual
 *      artifact terms.
 * Pure and unit-tested; the host's long-video loop applies them per clip.
 */

/** Cap for the persistent subject description carried into every clip's prompt. */
export const MAX_SUBJECT_CHARS = 300;

/** Appended to every chained clip: pins one continuous shot with the subject visible throughout.
 * Wan's umt5 / LTX's Gemma encoders both follow plain-language directives like this well. */
export const IN_FRAME_CLAUSE =
  "Single continuous shot: the main subject stays fully visible in frame for the entire clip; " +
  "no cuts, no scene change, no fade, and the camera never pans away from the subject.";

/** Scene-lock additions for the NEGATIVE prompt of every chained clip. */
export const SCENE_LOCK_NEGATIVE =
  "scene change, scene cut, jump cut, new scene, different location, montage, fade to black, " +
  "subject leaves the frame, subject exits, empty frame, camera pans away from the subject";

/**
 * A chained clip's full positive prompt: the persistent subject anchor (unless the shot prompt
 * already re-states it verbatim), the shot's own motion prompt, then the in-frame clause. The
 * anchor is what keeps clip N's text describing the SAME character/object as clip 1 even after
 * the conditioning frame has drifted.
 */
export function anchorClipPrompt(subject: string | undefined, clip: string): string {
  const s = subject?.trim().replace(/[.\s]+$/, "");
  const body = clip.trim();
  const anchored = s && !body.toLowerCase().includes(s.toLowerCase()) ? `${s}. ${body}` : body;
  return `${anchored}${/[.!?]$/.test(anchored) ? "" : "."} ${IN_FRAME_CLAUSE}`;
}

/** The full negative prompt for a chained clip: scene-lock terms plus the base artifact terms the
 * model family would otherwise get by default (passing a negative REPLACES the default, so the
 * default's terms must ride along). */
export function longVideoNegative(baseNegative: string): string {
  return `${SCENE_LOCK_NEGATIVE}, ${baseNegative}`;
}
