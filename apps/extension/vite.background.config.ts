import { defineConfig } from "vite";

/** Builds the service worker as a single IIFE bundle (no module SW needed). */
export default defineConfig({
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
