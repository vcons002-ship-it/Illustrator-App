import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Builds the content script as a single classic IIFE bundle (MV3 content
 * scripts are not ES modules), reusing the shared core + ui packages.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: "src/content.tsx",
      formats: ["iife"],
      name: "VisualReaderContent",
      fileName: () => "content.js",
    },
    rollupOptions: { output: { extend: true } },
  },
});
