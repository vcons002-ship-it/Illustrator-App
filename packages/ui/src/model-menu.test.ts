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
    // The encoder/VAE ride along: they're remembered per model, and writing localModel alone left
    // the previous model's encoder selected (a text-encoder failure at render time).
    expect(a.patch).toEqual({
      imageProvider: "local",
      localModel: "a.safetensors",
      localTextEncoder: "",
      localVae: "",
    });
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
      {
        ...DEFAULT_SETTINGS,
        imageProvider: "local",
        localBackend: "comfyui",
        localModel: "sdxl.safetensors",
        // A resolved engine, so the ComfyUI picks below need no reconnect (the rule is "is the engine
        // already up on this backend", not "does this change backend").
        engineBaseUrl: "http://127.0.0.1:8188",
        engineBackend: "comfyui",
      },
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
    expect(comfy[0]!.patch).toEqual({
      imageProvider: "local",
      localBackend: "comfyui",
      localServerUrl: "http://127.0.0.1:8188",
      localModel: "sdxl.safetensors",
      localTextEncoder: "",
      localVae: "",
    });
    // The engine is already up on this backend — nothing to reconnect.
    expect(comfy[0]!.connect).toBeUndefined();
    const a1111 = image.localModelsByBackend!.a1111!;
    expect(a1111).toHaveLength(1);
    expect(a1111[0]!.active).toBe(false);
    expect(a1111[0]!.patch).toEqual({
      imageProvider: "local",
      localBackend: "a1111",
      localServerUrl: "http://127.0.0.1:7860",
      localModel: "juggernaut.safetensors",
      localTextEncoder: "",
      localVae: "",
    });
    // Switching backend needs a real connect, not just a stored preference.
    expect(a1111[0]!.connect).toEqual({ backend: "a1111", url: "http://127.0.0.1:7860" });
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

  it("falls back to the configured local server model id before the model list loads", () => {
    // Local chat server configured, but lists.textModels is still empty (not yet fetched) → no option
    // is active, so without a fallback the tab summary would read "—".
    const llm = groupsOf({ textProvider: "local", localTextBackend: "server", localServerTextModel: "qwen3:8b" }).find(
      (g) => g.key === "llm",
    )!;
    expect(llm.options.some((o) => o.active)).toBe(false);
    expect(activeModelLabel(llm)).toBe("qwen3:8b");
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

  it("treats a configured local chat server as chat-active even before its model list loads", () => {
    // Local server chat configured with no fetched models AND a local image checkpoint that IS active.
    // Without the fallback, chat has no active option and the menu would open on the image tab.
    const groups = groupsOf(
      { textProvider: "local", localTextBackend: "server", localServerTextModel: "qwen3:8b", imageProvider: "local", localModel: "a.safetensors" },
      { imageModels: [model("a.safetensors")] },
    );
    expect(defaultMenuTab(groups)).toBe("llm");
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

describe("the AUTOMATIC1111 / ComfyUI split", () => {
  const videoOf = (s: Partial<ReaderSettings>) => groupsOf(s).find((g) => g.key === "video")!;
  const A1111 = { imageProvider: "local", localBackend: "a1111" } as Partial<ReaderSettings>;

  it("names the ComfyUI video actually renders on, host:port not a full URL", () => {
    const g = videoOf({ localServerUrlByBackend: { comfyui: "http://127.0.0.1:8188/" } });
    expect(g.note).toContain("127.0.0.1:8188");
    expect(g.note).not.toContain("http://");
    expect(g.warning).toBeUndefined();
  });

  it("says the two servers are DIFFERENT when images are on AUTOMATIC1111", () => {
    // The case the note exists for: pictures come from one server, video from another, and nothing
    // on screen used to say so.
    const g = videoOf({ ...A1111, localServerUrlByBackend: { comfyui: "http://10.0.0.5:8188" } });
    expect(g.note).toContain("separate server");
    expect(g.note).toContain("AUTOMATIC1111");
  });

  it("WARNS, rather than reassures, when an A1111 reader has no ComfyUI at all", () => {
    // Previously this tab said "Video renders on your local ComfyUI." to someone who had none — true,
    // and no help in working out why nothing rendered.
    const g = videoOf(A1111);
    expect(g.note).toBeUndefined();
    expect(g.warning).toContain("can't render video");
    expect(g.warning).toContain("Settings");
  });

  it("warns more plainly when there's simply no ComfyUI yet", () => {
    const g = videoOf({});
    expect(g.warning).toContain("No ComfyUI is configured");
    expect(g.warning).not.toContain("AUTOMATIC1111"); // they aren't on it — don't invent a conflict
  });

  it("tells the image tab that switching backend leaves video where it is", () => {
    const ckpt = { imageModels: [model("sdxl.safetensors")] };
    const img = groupsOf({ ...A1111, localServerUrlByBackend: { comfyui: "http://127.0.0.1:8188" } }, ckpt).find(
      (g) => g.key === "image",
    )!;
    expect(img.note).toContain("video stays on ComfyUI");
    // Not said when there's no second server in play — it would be noise.
    expect(
      groupsOf({ imageProvider: "local", localBackend: "comfyui" }, ckpt).find((g) => g.key === "image")!.note,
    ).toBeUndefined();
  });

  it("carries the note and warning through sectionize, where the popover reads them", () => {
    const g = videoOf(A1111);
    const [section] = sectionizeGroup(g);
    expect(section!.warning).toBe(g.warning);
    // A group with neither still gets the generic caption rather than nothing.
    const plain = sectionizeGroup({ key: "video", label: "Video model", options: videoOf({}).options });
    expect(plain[0]!.note).toContain("ComfyUI");
  });
});

describe("the image tab survives an empty by-backend inventory", () => {
  const withMap = (imageModelsByBackend: Parameters<typeof buildModelMenu>[1]["imageModelsByBackend"]) =>
    buildModelMenu(
      { ...DEFAULT_SETTINGS, imageProvider: "local" },
      { textModels: [model("llama")], imageModels: [model("sdxl.safetensors")], ...(imageModelsByBackend ? { imageModelsByBackend } : {}) },
      { isDesktop: true },
    );

  it("keeps the Image tab when the map is still EMPTY — the host's initial state", () => {
    // `{}` is truthy, so this used to take the provider-first path, find no backends, skip the flat
    // fallback that lives in the else, and drop the tab entirely. Reported as: only chat and video
    // show up. It bit purely-local setups, since a cloud image key would have kept the tab alive.
    const groups = withMap({});
    expect(groups.map((g) => g.key)).toEqual(["llm", "image", "video"]);
    const image = groups.find((g) => g.key === "image")!;
    expect(image.options.map((o) => o.label)).toContain("sdxl.safetensors");
    // Flat mode, so no backend picker to render.
    expect(image.localBackends).toBeUndefined();
  });

  it("still goes provider-first the moment a backend IS known", () => {
    const image = withMap({ comfyui: [model("sdxl.safetensors")] }).find((g) => g.key === "image")!;
    expect(image.localBackends?.map((b) => b.id)).toEqual(["comfyui"]);
    expect(image.localModelsByBackend?.comfyui?.map((o) => o.label)).toEqual(["sdxl.safetensors"]);
    // Provider-first keeps checkpoints OUT of the flat list, so they can't appear twice.
    expect(image.options.map((o) => o.label)).not.toContain("sdxl.safetensors");
  });

  it("shows a backend that reports NO checkpoints, rather than falling back to a mixed list", () => {
    // A known-but-empty backend is real information ("you have A1111, it has nothing installed").
    const image = withMap({ a1111: [] }).find((g) => g.key === "image")!;
    expect(image.localBackends?.map((b) => b.id)).toEqual(["a1111"]);
    expect(image.options).toEqual([]);
  });

  it("behaves the same whether the map is absent or empty", () => {
    expect(withMap(undefined).map((g) => g.key)).toEqual(withMap({}).map((g) => g.key));
  });
});

describe("a model pick carries the settings that must move with it", () => {
  const byBackend = { comfyui: [model("sdxl.safetensors")], a1111: [model("jugg.safetensors")] };
  const build = (s: Partial<ReaderSettings>) =>
    buildModelMenu({ ...DEFAULT_SETTINGS, ...s }, { textModels: [], imageModels: [], imageModelsByBackend: byBackend }, { isDesktop: true });

  it("restores the encoder/VAE remembered for the model it selects", () => {
    // Reported as a text-encoder error on the first switch: the menu wrote localModel alone, so the
    // PREVIOUS model's encoder stayed selected and the render failed at the engine.
    const g = build({
      imageProvider: "local",
      localBackend: "comfyui",
      localTextEncoder: "old_encoder.safetensors",
      localVae: "old.vae",
      localComponentsByModel: { "sdxl.safetensors": { textEncoder: "clip_l.safetensors", vae: "sdxl.vae" } },
    });
    const pick = g.find((x) => x.key === "image")!.localModelsByBackend!.comfyui![0]!;
    expect(pick.patch.localTextEncoder).toBe("clip_l.safetensors");
    expect(pick.patch.localVae).toBe("sdxl.vae");
  });

  it("CLEARS them to auto for a model with nothing remembered, rather than leaving them out", () => {
    // Omitting the fields would merge as "keep what's there" — the exact bug, one step removed.
    const g = build({ imageProvider: "local", localBackend: "comfyui", localTextEncoder: "old_encoder.safetensors" });
    const pick = g.find((x) => x.key === "image")!.localModelsByBackend!.comfyui![0]!;
    expect(pick.patch.localTextEncoder).toBe("");
    expect(pick.patch.localVae).toBe("");
  });

  it("asks for a RECONNECT when the pick changes backend, with that backend's own URL", () => {
    const g = build({
      imageProvider: "local",
      localBackend: "comfyui",
      localServerUrl: "http://127.0.0.1:8188",
      localServerUrlByBackend: { comfyui: "http://127.0.0.1:8188", a1111: "http://127.0.0.1:7860" },
      engineBaseUrl: "http://127.0.0.1:8188",
      engineBackend: "comfyui",
    });
    const image = g.find((x) => x.key === "image")!;
    const other = image.localModelsByBackend!.a1111![0]!;
    expect(other.connect).toEqual({ backend: "a1111", url: "http://127.0.0.1:7860" });
    // ...and the patch carries that URL too, so the stored state is consistent even if the host
    // can't connect (a linked phone, say).
    expect(other.patch.localServerUrl).toBe("http://127.0.0.1:7860");
  });

  it("does NOT reconnect for a pick within a backend whose engine is already UP", () => {
    const g = build({
      imageProvider: "local",
      localBackend: "comfyui",
      engineBaseUrl: "http://127.0.0.1:8188",
      engineBackend: "comfyui",
    });
    expect(g.find((x) => x.key === "image")!.localModelsByBackend!.comfyui![0]!.connect).toBeUndefined();
  });

  it("DOES reconnect on the same backend when no engine is resolved — the post-rebuild case", () => {
    // engineBaseUrl is transient: an update rebuild clears it while every persisted setting still
    // says "local". Gating on a backend CHANGE made this look like a no-op switch, so nothing
    // reconnected and the render went to an engine that wasn't there.
    const g = build({ imageProvider: "local", localBackend: "comfyui" });
    expect(g.find((x) => x.key === "image")!.localModelsByBackend!.comfyui![0]!.connect).toEqual({
      backend: "comfyui",
      url: "http://127.0.0.1:8188",
    });
  });

  it("reconnects when the running engine is on the OTHER backend than the stored preference", () => {
    // engineBackend is what's actually running; localBackend is only what was asked for. A fallback
    // to the managed ComfyUI makes them disagree, and the running one is the truth.
    const g = build({ imageProvider: "local", localBackend: "a1111", engineBaseUrl: "http://x", engineBackend: "comfyui" });
    const image = g.find((x) => x.key === "image")!;
    expect(image.localModelsByBackend!.comfyui![0]!.connect).toBeUndefined();
    expect(image.localModelsByBackend!.a1111![0]!.connect).toBeDefined();
  });

  it("reconnects when coming from a CLOUD provider, where no local engine is up at all", () => {
    const g = build({ imageProvider: "flux", localBackend: "comfyui" });
    expect(g.find((x) => x.key === "image")!.localModelsByBackend!.comfyui![0]!.connect).toBeDefined();
  });

  it("falls back to the backend's default URL when none is remembered", () => {
    const g = build({ imageProvider: "local", localBackend: "comfyui" });
    const other = g.find((x) => x.key === "image")!.localModelsByBackend!.a1111![0]!;
    expect(other.connect!.url).toMatch(/7860/);
  });
});
