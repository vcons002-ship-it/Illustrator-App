import { describe, expect, it } from "vitest";
import {
  IPADAPTER_DOWNLOADS,
  IPADAPTER_SUPPORTED_FAMILIES,
  ipAdapterDownloadSizeGB,
  ipAdapterReadiness,
  ipAdapterReadinessMessage,
} from "./ipadapter-install.js";

describe("IP-Adapter install list", () => {
  it("covers both halves: an encoder that reads the photo, and an adapter per SD family", () => {
    // Weights without nodes degrades gracefully; NODES WITHOUT WEIGHTS does not — the app detects
    // the nodes, builds the chain, and ComfyUI then fails on a missing model. The list has to be
    // complete or installing it is worse than not.
    expect(IPADAPTER_DOWNLOADS.filter((f) => f.folder === "clip_vision")).toHaveLength(1);
    const adapters = IPADAPTER_DOWNLOADS.filter((f) => f.folder === "ipadapter");
    expect(adapters.map((f) => f.filename)).toEqual([
      "ip-adapter_sdxl_vit-h.safetensors",
      "ip-adapter_sd15.safetensors",
    ]);
  });

  it("names each file the way ComfyUI will list it, and points at a real download", () => {
    for (const f of IPADAPTER_DOWNLOADS) {
      expect(f.filename, f.filename).toMatch(/\.safetensors$/);
      expect(f.url, f.filename).toMatch(/^https:\/\/huggingface\.co\//);
      expect(f.sizeMB, f.filename).toBeGreaterThan(0);
      expect(f.note.trim().length, f.filename).toBeGreaterThan(0);
    }
    // The encoder is renamed on the way in: upstream it's a bare "model.safetensors", which would be
    // unidentifiable in the clip_vision folder beside anything else.
    const enc = IPADAPTER_DOWNLOADS.find((f) => f.folder === "clip_vision")!;
    expect(enc.url).toContain("image_encoder/model.safetensors");
    expect(enc.filename).not.toBe("model.safetensors");
  });

  it("reports a real total size rather than a guess", () => {
    expect(ipAdapterDownloadSizeGB()).toBeCloseTo(3.2, 1);
    expect(ipAdapterDownloadSizeGB([{ filename: "a", url: "u", folder: "ipadapter", sizeMB: 512, note: "n" }])).toBe(0.5);
  });
});

describe("ipAdapterReadiness — three different 'no's, not one silent nothing", () => {
  it("an unsupported checkpoint is the FIRST thing reported, before anything to install", () => {
    // Offering the download beside a Flux-only install would be selling something that can't work.
    const r = ipAdapterReadiness({ nodesInstalled: false, modelsInstalled: false, family: "flux" });
    expect(r).toEqual({ ready: false, reason: "family" });
    expect(ipAdapterReadinessMessage(r.reason)).toContain("SD 1.5 and SDXL");
    expect(ipAdapterReadinessMessage(r.reason)).toContain("Gemini");
  });

  it("missing nodes and missing models are told apart — they need different actions", () => {
    expect(ipAdapterReadiness({ nodesInstalled: false, modelsInstalled: true, family: "sdxl" }).reason).toBe("nodes");
    expect(ipAdapterReadiness({ nodesInstalled: true, modelsInstalled: false, family: "sdxl" }).reason).toBe("models");
    expect(ipAdapterReadinessMessage("nodes")).toContain("restart the engine");
    expect(ipAdapterReadinessMessage("models")).toContain("models aren't");
  });

  it("is ready when both halves are there on a supported family", () => {
    for (const family of IPADAPTER_SUPPORTED_FAMILIES) {
      expect(ipAdapterReadiness({ nodesInstalled: true, modelsInstalled: true, family })).toEqual({ ready: true });
    }
    // No checkpoint chosen yet → judge only what's installed.
    expect(ipAdapterReadiness({ nodesInstalled: true, modelsInstalled: true })).toEqual({ ready: true });
  });
});
