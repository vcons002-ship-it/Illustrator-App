import { describe, expect, it } from "vitest";
import { buildModelMenu } from "./model-menu.js";
import { DEFAULT_SETTINGS, type InstalledModel, type ReaderSettings } from "./SettingsPanel.js";

const model = (id: string, label = id): InstalledModel => ({ id, label });
const groupsOf = (s: Partial<ReaderSettings>, lists?: { textModels?: InstalledModel[]; imageModels?: InstalledModel[] }, isDesktop = true) =>
  buildModelMenu({ ...DEFAULT_SETTINGS, ...s }, { textModels: lists?.textModels ?? [], imageModels: lists?.imageModels ?? [] }, { isDesktop });

describe("buildModelMenu", () => {
  it("builds chat / image / video groups", () => {
    const groups = groupsOf({ imageProvider: "local" }, { imageModels: [model("sdxl.safetensors")] });
    expect(groups.map((g) => g.key)).toEqual(["llm", "image", "video"]);
  });

  it("lists a cloud provider ONLY when its key is set, and flags the active one", () => {
    const withKey = groupsOf({ textProvider: "claude", keys: { claude: "sk-ant-x" } });
    const llm = withKey.find((g) => g.key === "llm")!;
    const claude = llm.options.find((o) => o.id === "text:claude")!;
    expect(claude.active).toBe(true);
    expect(claude.patch).toEqual({ textProvider: "claude" });
    // Gemini has no key → absent.
    expect(llm.options.some((o) => o.id === "text:gemini")).toBe(false);
  });

  it("offers installed local-server chat models with the right patch + active flag", () => {
    const groups = groupsOf(
      { textProvider: "local", localTextBackend: "server", localServerTextModel: "qwen3:8b" },
      { textModels: [model("qwen3:8b", "Qwen3 8B"), model("gemma3:4b", "Gemma3 4B")] },
    );
    const llm = groups.find((g) => g.key === "llm")!;
    const qwen = llm.options.find((o) => o.id === "text:server:qwen3:8b")!;
    expect(qwen.active).toBe(true);
    expect(qwen.patch).toEqual({ textProvider: "local", localTextBackend: "server", localServerTextModel: "qwen3:8b" });
    expect(llm.options.find((o) => o.id === "text:server:gemma3:4b")!.active).toBe(false);
  });

  it("offers local image checkpoints (switching provider to local) with active on the current one", () => {
    const groups = groupsOf(
      { imageProvider: "local", localModel: "a.safetensors" },
      { imageModels: [model("a.safetensors"), model("b.safetensors")] },
    );
    const image = groups.find((g) => g.key === "image")!;
    const a = image.options.find((o) => o.id === "image:local:a.safetensors")!;
    expect(a.active).toBe(true);
    expect(a.patch).toEqual({ imageProvider: "local", localModel: "a.safetensors" });
    expect(image.options.find((o) => o.id === "image:local:b.safetensors")!.active).toBe(false);
  });

  it("lists both video models and flags the selected one (default = first when unset)", () => {
    const video = groupsOf({ videoModel: "ltx2.3-i2v-22b" }).find((g) => g.key === "video")!;
    expect(video.options).toHaveLength(2);
    expect(video.options.find((o) => o.id === "video:ltx2.3-i2v-22b")!.active).toBe(true);
    expect(video.options[0]!.patch).toEqual({ videoModel: "wan2.2-i2v-14b" });
    // Unset → the first catalog entry is active.
    const dflt = groupsOf({}).find((g) => g.key === "video")!;
    expect(dflt.options.find((o) => o.active)!.id).toBe("video:wan2.2-i2v-14b");
  });

  it("omits the built-in model on non-desktop", () => {
    const web = groupsOf({ textProvider: "local" }, {}, false).find((g) => g.key === "llm");
    expect(web?.options.some((o) => o.id === "text:local-bundled")).toBeFalsy();
  });

  it("goes provider-first for images when imageModelsByBackend is supplied", () => {
    const groups = buildModelMenu(
      { ...DEFAULT_SETTINGS, imageProvider: "local", localBackend: "comfyui", localModel: "sdxl.safetensors" },
      {
        textModels: [],
        imageModels: [],
        imageModelsByBackend: {
          comfyui: [model("sdxl.safetensors", "SDXL")],
          a1111: [model("juggernaut.safetensors", "Juggernaut")],
        },
      },
      { isDesktop: true },
    );
    const image = groups.find((g) => g.key === "image")!;
    // No flat mixed list — checkpoints only live under localModelsByBackend now.
    expect(image.options.some((o) => o.id.startsWith("image:local:"))).toBe(false);
    expect(image.localBackends).toEqual([
      { id: "comfyui", label: "ComfyUI", active: true },
      { id: "a1111", label: "AUTOMATIC1111", active: false },
    ]);
    const comfy = image.localModelsByBackend!.comfyui!;
    expect(comfy).toHaveLength(1);
    expect(comfy[0]!.active).toBe(true);
    expect(comfy[0]!.patch).toEqual({ imageProvider: "local", localBackend: "comfyui", localModel: "sdxl.safetensors" });
    const a1111 = image.localModelsByBackend!.a1111!;
    expect(a1111).toHaveLength(1);
    expect(a1111[0]!.active).toBe(false);
    expect(a1111[0]!.patch).toEqual({ imageProvider: "local", localBackend: "a1111", localModel: "juggernaut.safetensors" });
  });
});
