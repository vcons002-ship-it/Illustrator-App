import { describe, expect, it } from "vitest";
import { activeDownloads } from "./download-status.js";

describe("activeDownloads", () => {
  it("returns nothing when idle", () => {
    expect(activeDownloads({ modelProgress: {} })).toEqual([]);
  });
  it("omits finished (100%) model entries but keeps in-flight ones", () => {
    const items = activeDownloads({ modelProgress: { done: 100, busy: 42 } });
    expect(items.map((i) => i.key)).toEqual(["busy"]);
    expect(items[0]!.percent).toBe(42);
    expect(items[0]!.kind).toBe("model");
  });
  it("applies friendly labels and the split-file stage", () => {
    const items = activeDownloads({
      modelProgress: { "wan2.2-i2v-14b": 50 },
      downloadStage: { "wan2.2-i2v-14b": "file 2/4: low_noise.safetensors" },
      labelFor: (k) => (k === "wan2.2-i2v-14b" ? "Wan 2.2" : undefined),
    });
    expect(items[0]!.label).toBe("Wan 2.2");
    expect(items[0]!.stage).toBe("file 2/4: low_noise.safetensors");
  });
  it("falls back to the key when no label resolver matches", () => {
    const items = activeDownloads({ modelProgress: { "my-file.safetensors": 10 } });
    expect(items[0]!.label).toBe("my-file.safetensors");
  });
  it("hides suppressed child-file keys (folded under a parent row)", () => {
    const items = activeDownloads({
      modelProgress: { "wan2.2-i2v-14b": 25, "low_noise.safetensors": 80 },
      hideKey: (k) => k === "low_noise.safetensors",
    });
    expect(items.map((i) => i.key)).toEqual(["wan2.2-i2v-14b"]);
  });
  it("includes Ollama text-model pulls with their status, after model rows", () => {
    const items = activeDownloads({
      modelProgress: { "zzz-model": 5 },
      pullProgress: { "llama3:8b": { status: "pulling manifest", percent: 12 } },
    });
    expect(items.map((i) => i.kind)).toEqual(["model", "text-model"]);
    const pull = items.find((i) => i.kind === "text-model")!;
    expect(pull.detail).toBe("pulling manifest");
    expect(pull.percent).toBe(12);
  });
  it("defaults an unknown-size pull to 0%", () => {
    const items = activeDownloads({ modelProgress: {}, pullProgress: { m: { status: "starting…" } } });
    expect(items[0]!.percent).toBe(0);
  });
});
