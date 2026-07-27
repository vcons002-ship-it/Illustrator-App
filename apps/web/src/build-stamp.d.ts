/**
 * Injected by Vite (`define` in vite.config.ts) — the git sha + build time of THIS bundle.
 *
 * It exists so a stale build is distinguishable from a bug. The app updates itself, so "it still
 * does X" and "it still does X because this bundle predates the fix" look identical from outside;
 * the assistant is told this string so asking it which build it's on answers that in one message.
 */
declare const __BUILD_STAMP__: string;
