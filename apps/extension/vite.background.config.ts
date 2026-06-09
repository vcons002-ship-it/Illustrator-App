import { defineConfig } from "vite";

/** Builds the service worker as a single IIFE bundle (no module SW needed). */
export default defineConfig({
  // Pure-ASCII output (see vite.content.config.ts) so the bundle is valid UTF-8
  // regardless of how the host toolchain re-encodes the file.
  esbuild: { charset: "ascii" },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: "src/background.ts",
      formats: ["iife"],
      name: "VisualReaderBackground",
      fileName: () => "background.js",
    },
  },
});
