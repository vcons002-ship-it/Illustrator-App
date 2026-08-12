/**
 * The app's breakpoints.
 *
 * Each exists in two places by necessity — a media query in styles/layout.css for anything CSS
 * can decide, and a constant here for the things it cannot (state seeds, and `inlineImages`,
 * which changes DOM ORDER and so has to be React's decision). Tests assert the numbers match,
 * because a silent divergence would give a screen a desktop layout in one dimension and a phone
 * layout in the other.
 */

/** Phone chrome: single-column flow, tighter padding, the dock starting as a bar. */
export const NARROW_PX = 760;

/**
 * THE WIDTH AT WHICH AN ART COLUMN BESIDE THE PROSE STOPS COSTING MORE THAN IT GIVES.
 *
 * It is not a taste call, it is the grid's own arithmetic:
 *
 *   640 prose + 320 art minimum + 120 (three 40px gaps) + 40 padding = 1120
 *
 * Below that there is no way to satisfy both tracks. The art track has a hard 320px floor and
 * the prose track is `minmax(0, 640px)` — it can shrink to nothing — so the prose is what gives
 * way, and it gives way silently.
 *
 * Reported from an unfolded foldable, around 840px wide: FOLDED it sits under NARROW_PX and gets
 * the full-width single column; UNFOLDED it clears 760, the art column engages, and the reading
 * measure drops to roughly 360px. Opening the phone made the column narrower. Between 760 and
 * here, the art belongs below the text — which is what the phone layout already does.
 */
export const ART_COLUMN_PX = 1120;
