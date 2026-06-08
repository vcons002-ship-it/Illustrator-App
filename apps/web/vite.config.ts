import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Cross-Origin Isolation (COOP/COEP) is required for the local WebGPU/WASM tier
 * (SharedArrayBuffer, multi-threaded inference). We set it now so the local tier
 * can be enabled later without touching the dev/preview server.
 */
const crossOriginIsolation = {
  name: "cross-origin-isolation",
  configureServer(server: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), crossOriginIsolation],
  server: { port: 5173 },
  // ES-module worker so the engine worker can lazy-load the on-device LLM
  // (@mlc-ai/web-llm) as a separate chunk (code-splitting needs "es", not iife).
  worker: { format: "es" },
});
