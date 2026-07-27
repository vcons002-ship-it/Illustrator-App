/**
 * This bundle's identity, read at RUNTIME from `/build.json`.
 *
 * Written by scripts/build-stamp.mjs on every `pnpm build` (and `dev`), and served from `public/`, so
 * a rebuild plus a plain reload refreshes it. That's the whole point of not baking it in with Vite's
 * `define`: the desktop app runs `cargo tauri dev`, whose vite server reads its config once at
 * startup and is NOT restarted by `app.restart()` — a compile-time value could only be refreshed by
 * closing the terminal running desktop.bat, which put it out of the in-app updater's reach.
 *
 * Cached after the first read: it cannot change while the page is loaded, and both the UI and the
 * engine worker ask for it.
 */
export interface BuildStamp {
  sha: string;
  branch?: string;
  at: string;
}

let cached: Promise<BuildStamp> | undefined;

export function loadBuildStamp(): Promise<BuildStamp> {
  cached ??= fetch("/build.json", { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<BuildStamp>) : Promise.reject(new Error(String(r.status)))))
    // Never let a missing stamp break a render or a chat turn — it's diagnostic, not load-bearing.
    .catch(() => ({ sha: "unstamped", at: "" }));
  return cached;
}

/** One line for the UI / the model: "abc1234 (branch, built 2026-07-27 19:25Z)". PURE. */
export function formatBuildStamp(s: BuildStamp): string {
  const detail = [s.branch, s.at ? `built ${s.at}` : ""].filter(Boolean).join(", ");
  return detail ? `${s.sha} (${detail})` : s.sha;
}
