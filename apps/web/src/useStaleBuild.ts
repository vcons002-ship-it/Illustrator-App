import { useEffect, useRef, useState } from "react";
import { loadBuildStamp, refetchBuildSha } from "./build-stamp.js";

/** Don't ask more than once a minute, however often the app is brought to the front. */
export const STALE_CHECK_THROTTLE_MS = 60_000;
/** A quiet backstop for an app left open and visible for hours. */
export const STALE_CHECK_INTERVAL_MS = 30 * 60_000;

/**
 * WHETHER THE PAGE IS RUNNING A BUILD THE SERVER NO LONGER SERVES.
 *
 * The cache headers already make a rebuild reach a phone the moment it does a fresh load — the HTML
 * shell is `no-cache, must-revalidate` and only the content-hashed assets cache long. What was
 * missing is anything that makes a fresh load HAPPEN. A browser tab reloads whenever you revisit it;
 * an installed app is resumed, returning you to a page that may be days old, and standalone display
 * has neither an address bar nor pull-to-refresh to force one with. Nothing polled, either —
 * `loadBuildStamp` reads once and caches — so the phone would run old code indefinitely, silently.
 *
 * VISIBILITY IS THE TRIGGER, not a timer, because returning to the app is exactly the moment the
 * staleness begins to matter and exactly the moment a reload costs nothing. The interval is only a
 * backstop for a session left open and visible.
 *
 * One-way on purpose: once stale, it stays stale. A desktop mid-rebuild can briefly serve the old
 * stamp again, and a notice that appeared and then vanished before it could be tapped is worse than
 * no notice.
 */
export function useStaleBuild(): boolean {
  const [stale, setStale] = useState(false);
  const running = useRef("");
  const lastCheck = useRef(0);
  const staleRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadBuildStamp().then((s) => {
      if (!cancelled) running.current = s.sha;
    });

    const check = async (): Promise<void> => {
      // "unstamped" is the fallback for a stamp that could not be read at startup; comparing
      // against it would declare every build stale forever.
      if (staleRef.current || !running.current || running.current === "unstamped") return;
      const now = Date.now();
      if (now - lastCheck.current < STALE_CHECK_THROTTLE_MS) return;
      lastCheck.current = now;
      const served = await refetchBuildSha();
      if (cancelled || !served || served === running.current) return;
      staleRef.current = true;
      setStale(true);
    };

    const onVisible = (): void => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    const id = setInterval(() => void check(), STALE_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(id);
    };
  }, []);

  return stale;
}
