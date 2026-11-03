import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrateLtx25VideoSelection } from "@visual-reader/core";

describe("LTX-2.5 desktop settings migration", () => {
  it("is applied when saved settings load, not by replacing profile data", () => {
    const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    expect(app).toContain("migrateLtx25VideoSelection(migrated.videoModel, migrated.videoFiles)");
    expect(app).toContain("if (ltx25) Object.assign(migrated, ltx25)");
  });
  it("changes only model selection/files, leaving video tuning and all unrelated settings intact", () => {
    const old = {
      videoModel: "ltx2.3-i2v-22b",
      videoFiles: { checkpoint: "old.safetensors" },
      videoParams: { "ltx2-i2v": { frames: 201, fps: 24, highRes: false, audio: false } },
      localModel: "keep-image-model.safetensors", localContextTokens: 50000,
      keysEnc: { iv: [1], ciphertext: [2] }, currentProject: "preserve-project",
    };
    const next = { ...old, ...migrateLtx25VideoSelection(old.videoModel, old.videoFiles) };
    expect(next.videoModel).toBe("ltx2.5-i2v-22b");
    for (const key of ["videoParams", "localModel", "localContextTokens", "keysEnc", "currentProject"] as const) {
      expect(next[key]).toBe(old[key]);
    }
    expect(old.videoFiles.checkpoint).toBe("old.safetensors");
  });
});
