import { describe, expect, it } from "vitest";
import { resolveVideoModelFiles, videoModelDownloads, videoModelById, VIDEO_MODELS } from "./video-models.js";
import type { VideoModelFiles } from "./image-provider.js";

/** The engine filenames a model resolves to, excluding the `kind` discriminator. */
function fileNames(files: VideoModelFiles): string[] {
  return Object.entries(files)
    .filter(([k]) => k !== "kind")
    .map(([, v]) => v as string);
}

describe("video-models", () => {
  it("defaults to Wan 2.2 for an unknown/unset id", () => {
    const a = resolveVideoModelFiles(undefined);
    const b = resolveVideoModelFiles("nope");
    expect(a.kind).toBe("wan-i2v");
    expect(b.kind).toBe("wan-i2v");
    if (a.kind === "wan-i2v") expect(a.highNoise).toContain("wan2.2_i2v_high_noise");
    if (b.kind === "wan-i2v") expect(b.lowNoise).toContain("wan2.2_i2v_low_noise");
  });
  it("resolves the LTX-2.3 entry to a checkpoint + gemma text encoder", () => {
    const f = resolveVideoModelFiles("ltx2.3-i2v-22b");
    expect(f.kind).toBe("ltx2-i2v");
    if (f.kind === "ltx2-i2v") {
      expect(f.checkpoint).toContain("ltx-2.3-22b-dev");
      expect(f.textEncoder).toContain("gemma");
    }
  });
  it("applies per-file overrides over the catalog default (any family)", () => {
    const f = resolveVideoModelFiles("ltx2.3-i2v-22b", { checkpoint: "my-ltx.safetensors", lora: "speed.safetensors" });
    expect(f.kind).toBe("ltx2-i2v");
    if (f.kind === "ltx2-i2v") {
      expect(f.checkpoint).toBe("my-ltx.safetensors");
      expect(f.lora).toBe("speed.safetensors");
    }
  });
  it("carries independent high/low-noise LoRA overrides for Wan", () => {
    const f = resolveVideoModelFiles("wan2.2-i2v-14b", { loraHigh: "hi.safetensors", loraLow: "lo.safetensors" });
    expect(f.kind).toBe("wan-i2v");
    if (f.kind === "wan-i2v") {
      expect(f.loraHigh).toBe("hi.safetensors");
      expect(f.loraLow).toBe("lo.safetensors");
    }
  });
  it("downloads cover every engine file, each into a ComfyUI subfolder, over https", () => {
    const dls = videoModelDownloads("wan2.2-i2v-14b");
    const files = resolveVideoModelFiles("wan2.2-i2v-14b");
    const names = dls.map((d) => d.filename);
    for (const f of fileNames(files)) expect(names).toContain(f);
    for (const d of dls) {
      expect(["checkpoints", "diffusion_models", "text_encoders", "vae"]).toContain(d.folder);
      expect(d.url).toMatch(/^https:\/\/.+\.safetensors$/);
    }
  });
  it("every catalog entry's files all have a matching download", () => {
    for (const m of VIDEO_MODELS) {
      const dl = videoModelById(m.id)!.downloads.map((d) => d.filename);
      for (const f of fileNames(m.files)) expect(dl).toContain(f);
    }
  });
});
