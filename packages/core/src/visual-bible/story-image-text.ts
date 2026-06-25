/**
 * Strip quoted DIALOGUE from a story beat before it's used as the image prompt's passage.
 *
 * The full beat prose is otherwise injected verbatim into the image request, so a vivid line of
 * speech ("Look at the dragon behind you!") can hijack the rendered subject even when no dragon is
 * in the scene. The drawn CAST is already governed by the tracked present-set, but the inferred
 * action/scene is not — so for story beats we hand the image model the ACTION/narration with quoted
 * speech removed. The reader still sees the full prose, and Bible continuity extraction still gets
 * the complete text; only the image-facing passage is de-dialogued.
 *
 * Only double quotes and smart quotes are stripped (not the straight apostrophe), so contractions
 * like "don't" / "it's" survive. If a beat is ALL dialogue (nothing left), the original prose is
 * returned so the image still has something to work from (the present cast/location carry it).
 */
export function actionTextForImage(prose: string): string {
  const stripped = prose
    // Matched double / smart-double spans: "…" or “…”.
    .replace(/["“][^"”]*["”]/g, " ")
    // Matched smart-single spans: ‘…’ (straight ' is left alone to protect contractions).
    .replace(/‘[^’]*’/g, " ")
    // An unterminated double/smart-double quote runs to the end of the text.
    .replace(/["“][^"”]*$/g, " ")
    // Tidy the seams left by removal.
    .replace(/\s+([,.;:!?…])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return stripped || prose.trim();
}
