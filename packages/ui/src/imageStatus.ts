import type { ImageResult } from "@visual-reader/core";

/**
 * Choose the image-panel placeholder text + whether it should pulse, given the
 * current result and whether generation has been started. Pure (no React) so it's
 * unit-testable and shared by `ImagePanel`.
 *
 * The render buffer emits `rendering` ONLY when a render actually starts, so a page
 * that's merely waiting in the queue (or gated until its chapter's bible lands) has
 * no result yet. We distinguish those: "painting…" (pulsing) means work is truly
 * underway; "waiting to be illustrated…" (static) means it's queued, not active.
 */
export function placeholderLabel(
  result: ImageResult | undefined,
  awaitingStart: boolean | undefined,
): { label: string; pulse: boolean } {
  // Front/back matter (title page, copyright, contents…) is never illustrated.
  if (result?.status === "skipped") {
    return { label: "No illustration — front/end matter", pulse: false };
  }
  if (result?.status === "error") {
    return { label: `couldn't render: ${result.error ?? "unknown error"}`, pulse: false };
  }
  // Generation not begun and nothing cached → call to action, not a fake spinner.
  if (awaitingStart && (!result || result.status === "queued")) {
    return { label: 'Press “Begin generating book” to illustrate this page', pulse: false };
  }
  // Actively working: the buffer set `rendering` (or we're building the prompt).
  if (result?.status === "rendering" || result?.status === "prompting") {
    const pct = result.progress;
    const label =
      typeof pct === "number" && pct > 0 && pct < 1
        ? `painting this page… ${Math.round(pct * 100)}%`
        : "painting this page…";
    return { label, pulse: true };
  }
  // Generation is on but this page hasn't started yet (no result / still queued) —
  // it's in line, not being painted. Say so plainly instead of implying activity.
  return { label: "waiting to be illustrated…", pulse: false };
}
