import { describe, expect, it } from "vitest";
import { resolveVideoModelFiles, videoModelDownloads, videoModelById, VIDEO_MODELS } from "./video-models.js";

describe("video-models", () => {
  it("defaults to Wan 2.2 for an unknown/unset id", () => {
    expect(resolveVideoModelFiles(undefined).highNoise).toContain("wan2.2_i2v_high_noise");
    expect(resolveVideoModelFiles("nope").lowNoise).toContain("wan2.2_i2v_low_noise");
  });
  it("downloads cover every engine file, each into a ComfyUI subfolder, over https", () => {
    const dls = videoModelDownloads("wan2.2-i2v-14b");
    const files = resolveVideoModelFiles("wan2.2-i2v-14b");
    const names = dls.map((d) => d.filename);
    for (const f of Object.values(files)) expect(names).toContain(f);
    for (const d of dls) {
      expect(["diffusion_models", "text_encoders", "vae"]).toContain(d.folder);
      expect(d.url).toMatch(/^https:\/\/.+\.safetensors$/);
    }
  });
  it("every catalog entry's files all have a matching download", () => {
    for (const m of VIDEO_MODELS) {
      const dl = videoModelById(m.id)!.downloads.map((d) => d.filename);
      for (const f of Object.values(m.files)) expect(dl).toContain(f);
    }
  });
});
