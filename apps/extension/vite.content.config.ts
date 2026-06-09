import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Builds the content script as a single classic IIFE bundle (MV3 content
 * scripts are not ES modules), reusing the shared core + ui packages.
 */
export default defineConfig({
  plugins: [react()],
  // Emit the bundle as pure ASCII (non-ASCII chars become \uXXXX escapes). MV3
  // content scripts must be UTF-8, and an ASCII-only file is valid UTF-8 no
  // matter how the host toolchain re-encodes it — avoids Chrome's "isn't UTF-8
  // encoded" load error when multi-byte chars get mangled on checkout.
  esbuild: { charset: "ascii" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: "src/content.tsx",
      formats: ["iife"],
      name: "VisualReaderContent",
      fileName: () => "content.js",
    },
    // The on-device LLM (@mlc-ai/web-llm) is a web-app/desktop feature; keep it
    // out of the single-file content script. If local text is selected in the
    // extension, the dynamic import fails and the provider falls back to the mock.
    rollupOptions: { external: ["@mlc-ai/web-llm"], output: { extend: true } },
  },
});
