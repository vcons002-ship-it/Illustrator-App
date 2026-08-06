/**
 * Re-export shim. The real tokens now live in `design/` — `design/tokens.ts` holds the `var()`
 * mirrors and `design/recipes.ts` the composite style objects.
 *
 * This file stays for one migration so the ten components importing it by relative path don't
 * churn in the same diff as the tokenising sweep. It is deleted in the final pass.
 */
export * from "./design/recipes.js";
