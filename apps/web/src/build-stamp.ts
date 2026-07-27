/**
 * This bundle's identity, resolved SAFELY.
 *
 * `__BUILD_STAMP__` is substituted by Vite's `define` (vite.config.ts), which is read only when the
 * dev server STARTS. The desktop app runs `cargo tauri dev`, so that server is long-lived: after an
 * in-app update pulls a change to vite.config.ts, the still-running server keeps its old config and
 * the identifier is never substituted. Referencing it bare would then be a ReferenceError at render —
 * a blank window instead of a missing line.
 *
 * So it's read through `typeof`, and the fallback says what to do rather than pretending to be a
 * version. The same guard covers any other build path that doesn't apply the define (a test, a
 * consumer bundling the source directly).
 */
export function buildStamp(): string {
  return typeof __BUILD_STAMP__ === "string" && __BUILD_STAMP__ ? __BUILD_STAMP__ : "unstamped — restart the app to record it";
}
