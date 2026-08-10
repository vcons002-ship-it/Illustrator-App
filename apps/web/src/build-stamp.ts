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

/**
 * Re-read the stamp from the server, deliberately NOT memoised.
 *
 * `loadBuildStamp` caches because the running bundle's identity cannot change while the page is
 * loaded. This exists for the opposite question — what is the server serving NOW — which is a
 * different thing the moment the desktop is rebuilt under a page that stays open. An installed app
 * is the case that makes it matter: it is resumed rather than reloaded, so it can sit on a bundle
 * from days ago, and standalone display has no address bar and no pull-to-refresh to notice with.
 *
 * Returns undefined on any failure — offline, desktop asleep, mid-restart. A build check must never
 * be the thing that reports a problem; it is the least important request the app makes.
 */
export async function refetchBuildSha(): Promise<string | undefined> {
  try {
    const r = await fetch("/build.json", { cache: "no-store" });
    if (!r.ok) return undefined;
    const s = (await r.json()) as Partial<BuildStamp>;
    return typeof s.sha === "string" && s.sha ? s.sha : undefined;
  } catch {
    return undefined;
  }
}

/** One line for the UI / the model: "abc1234 (branch, built 2026-07-27 19:25Z)". PURE. */
export function formatBuildStamp(s: BuildStamp): string {
  const detail = [s.branch, s.at ? `built ${s.at}` : ""].filter(Boolean).join(", ");
  return detail ? `${s.sha} (${detail})` : s.sha;
}
