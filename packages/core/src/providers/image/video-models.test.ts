import { describe, expect, it } from "vitest";
import { resolveVideoModelFiles, videoModelDownloads, videoModelById, migrateLtx25VideoSelection, VIDEO_MODELS } from "./video-models.js";
import type { VideoModelFiles } from "./image-provider.js";

/** The engine filenames a model resolves to, excluding the `kind` discriminator. */
function fileNames(files: VideoModelFiles): string[] {
  return Object.entries(files)
    .filter(([k]) => k !== "kind" && k !== "version")
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
  it("resolves an old LTX selection to the replacement split LTX-2.5 graph", () => {
    const f = resolveVideoModelFiles("ltx2.3-i2v-22b");
    expect(f.kind).toBe("ltx2-i2v");
    if (f.kind === "ltx2-i2v" && f.version === "2.5") {
      expect(f.diffusionModel).toContain("ltx-2.5-22b-distilled-transformer");
      expect(f.textEncoder).toContain("gemma4-12b-with-proj-ltx-2.5");
      expect(f.vae).toContain("ltx-2.5-video-vae");
      expect(f.audioVae).toContain("ltx-2.5-audio-vae");
      expect(f).not.toHaveProperty("checkpoint");
      expect(f).not.toHaveProperty("distilledLora");
    }
    expect(f).toMatchObject({ version: "2.5" });
  });
  it("applies per-file overrides + an LTX LoRA stack over the catalog default", () => {
    const f = resolveVideoModelFiles("ltx2.5-i2v-22b", {
      diffusionModel: "my-ltx25-nvfp4.safetensors",
      ltxLoras: [{ name: "speed.safetensors", strength: 0.7 }, { name: "  " }],
    });
    expect(f.kind).toBe("ltx2-i2v");
    if (f.kind === "ltx2-i2v" && f.version === "2.5") {
      expect(f.diffusionModel).toBe("my-ltx25-nvfp4.safetensors");
      // Blank-named rows are dropped; strengths preserved.
      expect(f.loras).toEqual([{ name: "speed.safetensors", strength: 0.7 }]);
    }
  });
  it("migrates only the old selection and removes incompatible fixed components", () => {
    const old = {
      checkpoint: "old.safetensors", distilledLora: "speed.safetensors",
      vae: "old-wan-vae.safetensors",
      textEncoder: "gemma_3_12B_it_fp4_mixed.safetensors",
      upscaler: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
      ltxLoras: [{ name: "ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors" }, { name: "custom-style.safetensors", strength: 0.5 }],
      loraHigh: "wan-motion.safetensors",
    };
    const migrated = migrateLtx25VideoSelection("ltx2.3-i2v-22b", old)!;
    expect(migrated.videoModel).toBe("ltx2.5-i2v-22b");
    expect(migrated.videoFiles).toEqual({ loraHigh: old.loraHigh, ltxLoras: [old.ltxLoras[1]] });
    expect(old.checkpoint).toBe("old.safetensors");
    expect(migrateLtx25VideoSelection("wan2.2-i2v-14b", old)).toBeUndefined();
    expect(migrateLtx25VideoSelection("ltx2.5-i2v-22b", old)).toBeUndefined();
  });
  it("does not download the obsolete speed LoRA or combined checkpoint", () => {
    const files = videoModelDownloads("ltx2.5-i2v-22b");
    expect(files).toHaveLength(5);
    expect(files.some((f) => f.folder === "checkpoints" || f.folder === "loras")).toBe(false);
    expect(files.every((f) => f.url.startsWith("https://huggingface.co/Lightricks/LTX-2.5/resolve/main/"))).toBe(true);
    expect(videoModelById("ltx2.3-i2v-22b")?.id).toBe("ltx2.5-i2v-22b");
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
