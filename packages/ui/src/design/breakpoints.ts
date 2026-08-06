/**
 * The app's one breakpoint.
 *
 * It exists in two places by necessity — a media query in styles/layout.css for anything CSS
 * can decide, and this constant for the things it cannot (state seeds, and `inlineImages`,
 * which changes DOM ORDER and so has to be React's decision). A test asserts the two numbers
 * match, because a silent divergence would give a phone a desktop layout in one dimension and
 * a phone layout in the other.
 */
export const NARROW_PX = 760;
