import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * A stamp identifying THIS build, baked in at compile time.
 *
 * Without one there is no way to tell a bug from a stale build — the app updates itself, so "it still
 * does X" and "it still does X because you're running last week's bundle" look identical from the
 * outside, and both have cost real time to untangle. The assistant is told this string so asking it
 * which build it's on gives a straight answer. Falls back to "dev" outside a git checkout.
 */
function buildStamp(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const when = new Date().toISOString().slice(0, 16).replace("T", " ");
    return sha ? `${sha} (built ${when}Z)` : "dev";
  } catch {
    return "dev";
  }
}

/**
 * Cross-Origin Isolation (COOP/COEP) is required for the local WebGPU/WASM tier
 * (SharedArrayBuffer, multi-threaded inference). We use `credentialless` (not
 * `require-corp`) for COEP so the on-device LLM (WebLLM) can still download its
 * model weights from a cross-origin CDN that doesn't send CORP headers — under
 * `require-corp` that fetch is blocked and the model never loads. `credentialless`
 * keeps cross-origin isolation while allowing those no-credentials subresource loads.
 */
const setIsolationHeaders = (res: { setHeader: (k: string, v: string) => void }) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
};
type HeaderServer = {
  middlewares: { use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void };
};
const crossOriginIsolation = {
  name: "cross-origin-isolation",
  configureServer(server: HeaderServer) {
    server.middlewares.use((_req, res, next) => {
      setIsolationHeaders(res);
      next();
    });
  },
  configurePreviewServer(server: HeaderServer) {
    server.middlewares.use((_req, res, next) => {
      setIsolationHeaders(res);
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), crossOriginIsolation],
  define: { __BUILD_STAMP__: JSON.stringify(buildStamp()) },
  server: { port: 5173 },
  // ES-module worker so the engine worker can lazy-load the on-device LLM
  // (@mlc-ai/web-llm) as a separate chunk (code-splitting needs "es", not iife).
  worker: { format: "es" },
});
