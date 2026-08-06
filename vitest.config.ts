import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // apps/** is included so the feature-inventory gate can live beside the file it guards.
    // It reads App.tsx as TEXT (no DOM, no React render), which is what lets a node-env test
    // assert that a 13k-line component still offers every control it did before a sweep.
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
  },
});
