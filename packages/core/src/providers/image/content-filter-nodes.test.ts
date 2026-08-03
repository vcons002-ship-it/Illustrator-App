import { describe, expect, it } from "vitest";
import { contentFilterNodes } from "./local-engine/comfyui-backend.js";
import { renderPromptRecord } from "./sd-prompt.js";

describe("contentFilterNodes — where to look when an engine seems to censor", () => {
  it("names the published packs that filter a finished image", () => {
    // ComfyUI core ships no safety checker, and this backend wires none — but custom_nodes is
    // arbitrary third-party Python, and a pack added for something else can bring one along.
    expect(
      contentFilterNodes([
        "KSampler",
        "NSFWDetection",
        "VAEDecode",
        "SafetyChecker",
        "CheckpointLoaderSimple",
        "NudeNetDetector",
        "Content_Filter",
      ]),
    ).toEqual(["Content_Filter", "NSFWDetection", "NudeNetDetector", "SafetyChecker"]);
  });

  it("says nothing about an ordinary install", () => {
    expect(contentFilterNodes(["KSampler", "VAEDecode", "SaveImage", "IPAdapterAdvanced", "ReferenceLatent"])).toEqual([]);
  });

  it("doesn't cry wolf over a name that merely contains a word", () => {
    // "SafeTensorLoader" is a file format, not a filter; "ImageBlur" is an ordinary effect node.
    expect(contentFilterNodes(["SafeTensorLoader", "ImageBlur", "ImageSharpen"])).toEqual([]);
  });
});

describe("and the render record says so", () => {
  it("names them, and is clear the app didn't wire them", () => {
    const out = renderPromptRecord("x", "", {
      engine: "ComfyUI",
      family: "sdxl",
      filterNodes: ["NSFWDetection", "SafetyChecker"],
    });
    expect(out).toContain("Image-filtering nodes are installed on this engine: NSFWDetection, SafetyChecker");
    // Reported, not concluded — installed is not the same as used, and this backend wires none.
    expect(out).toContain("never wires one into a render");
  });

  it("stays silent on an ordinary install", () => {
    expect(renderPromptRecord("x", "", { engine: "ComfyUI", family: "sdxl", filterNodes: [] })).not.toContain("⚠");
    expect(renderPromptRecord("x", "", { engine: "ComfyUI", family: "sdxl" })).not.toContain("⚠");
  });
});
