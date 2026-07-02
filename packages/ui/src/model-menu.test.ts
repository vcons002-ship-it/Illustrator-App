import { describe, expect, it } from "vitest";
import { activeModelLabel, buildModelMenu, defaultMenuTab, filterOptions, sectionizeGroup } from "./model-menu.js";
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

describe("sectionizeGroup", () => {
  it("splits the chat group into Cloud and Local sections without losing or reordering options", () => {
    const groups = groupsOf(
      { textProvider: "local", localTextBackend: "server", localServerTextModel: "qwen3:8b", keys: { claude: "k", openai: "k" } },
      { textModels: [model("qwen3:8b", "Qwen3 8B")] },
    );
    const llm = groups.find((g) => g.key === "llm")!;
    const sections = sectionizeGroup(llm);
    expect(sections.map((s) => s.label)).toEqual(["Cloud", "Local"]);
    const cloud = sections[0]!;
    const local = sections[1]!;
    expect(cloud.options.every((o) => o.patch.textProvider !== "local")).toBe(true);
    expect(local.options.map((o) => o.id)).toEqual(["text:local-bundled", "text:server:qwen3:8b"]);
    // Lossless: every option lands in exactly one section, unchanged.
    expect([...cloud.options, ...local.options]).toEqual(llm.options);
  });

  it("omits an empty section (no cloud keys → Local only)", () => {
    const llm = groupsOf({ textProvider: "local" }).find((g) => g.key === "llm")!;
    const sections = sectionizeGroup(llm);
    expect(sections.map((s) => s.label)).toEqual(["Local"]);
  });

  it("splits the flat image group into Cloud and Local (no backend picker)", () => {
    const groups = groupsOf(
      { imageProvider: "local", localModel: "a.safetensors", keys: { flux: "k" } },
      { imageModels: [model("a.safetensors")] },
    );
    const sections = sectionizeGroup(groups.find((g) => g.key === "image")!);
    expect(sections.map((s) => s.label)).toEqual(["Cloud", "Local"]);
    expect(sections[1]!.backendPicker).toBeUndefined();
    expect(sections[1]!.options.map((o) => o.id)).toEqual(["image:local:a.safetensors"]);
  });

  it("flags the image Local section as the backend picker in provider-first mode", () => {
    const groups = buildModelMenu(
      { ...DEFAULT_SETTINGS, imageProvider: "local", keys: { flux: "k" } },
      { textModels: [], imageModels: [], imageModelsByBackend: { comfyui: [model("sdxl.safetensors")] } },
      { isDesktop: true },
    );
    const sections = sectionizeGroup(groups.find((g) => g.key === "image")!);
    const local = sections.find((s) => s.label === "Local")!;
    expect(local.backendPicker).toBe(true);
    // Checkpoints live under localModelsByBackend, so the section itself carries none.
    expect(local.options).toEqual([]);
  });

  it("gives the video group one unlabeled section with the local-ComfyUI note", () => {
    const video = groupsOf({}).find((g) => g.key === "video")!;
    const sections = sectionizeGroup(video);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.label).toBeUndefined();
    expect(sections[0]!.note).toMatch(/ComfyUI/);
    expect(sections[0]!.options).toEqual(video.options);
  });
});

describe("activeModelLabel", () => {
  it("returns the active flat option's label", () => {
    const llm = groupsOf({ textProvider: "claude", keys: { claude: "k" } }).find((g) => g.key === "llm")!;
    expect(activeModelLabel(llm)).toBe("Claude (Anthropic)");
  });

  it("finds the active checkpoint inside the provider-first image lists", () => {
    const groups = buildModelMenu(
      { ...DEFAULT_SETTINGS, imageProvider: "local", localBackend: "comfyui", localModel: "sdxl.safetensors" },
      { textModels: [], imageModels: [], imageModelsByBackend: { comfyui: [model("sdxl.safetensors", "SDXL")] } },
      { isDesktop: true },
    );
    expect(activeModelLabel(groups.find((g) => g.key === "image")!)).toBe("SDXL");
  });

  it("is undefined when nothing in the group is active", () => {
    // Cloud text provider selected but its key unset → the bundled option is the only row, inactive.
    const llm = groupsOf({ textProvider: "claude" }).find((g) => g.key === "llm")!;
    expect(activeModelLabel(llm)).toBeUndefined();
  });
});

describe("defaultMenuTab", () => {
  it("opens on chat when it holds the active selection", () => {
    const groups = groupsOf({ textProvider: "claude", keys: { claude: "k" } });
    expect(defaultMenuTab(groups)).toBe("llm");
  });

  it("falls to the first group WITH an active selection when chat has none", () => {
    // textProvider "claude" without a key → the chat group exists but nothing in it is active.
    const groups = groupsOf({ textProvider: "claude", imageProvider: "local", localModel: "a.safetensors" }, { imageModels: [model("a.safetensors")] });
    expect(defaultMenuTab(groups)).toBe("image");
  });

  it("defaults to llm on an empty menu", () => {
    expect(defaultMenuTab([])).toBe("llm");
  });
});

describe("filterOptions", () => {
  const llmOf = (): ReturnType<typeof groupsOf>[number] =>
    groupsOf({ textProvider: "local" }, { textModels: [model("qwen3:8b", "Qwen3 8B"), model("gemma3:4b", "Gemma3 4B")] }).find(
      (g) => g.key === "llm",
    )!;

  it("filters by label, case-insensitively", () => {
    const opts = llmOf().options;
    expect(filterOptions(opts, "QWEN").map((o) => o.id)).toEqual(["text:server:qwen3:8b"]);
    expect(filterOptions(opts, "nope")).toEqual([]);
  });

  it("returns the list untouched for a blank query", () => {
    const opts = llmOf().options;
    expect(filterOptions(opts, "")).toEqual(opts);
    expect(filterOptions(opts, "   ")).toEqual(opts);
  });
});
