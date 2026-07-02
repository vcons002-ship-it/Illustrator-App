import { BUNDLED_LLM, IMAGE_PROVIDERS, LOCAL_TEXT_MODELS, TEXT_PROVIDERS, VIDEO_MODELS } from "@visual-reader/core";
import { LOCAL_BACKEND_LABEL, type InstalledModel, type LocalBackendId, type ReaderSettings } from "./SettingsPanel.js";

/**
 * The quick model-switcher menu that pops up from the chat input. This PURE builder turns the current
 * settings + the engine's installed lists into three groups of ready-to-pick options (chat / image /
 * video); each option carries the exact `patch` to merge into ReaderSettings when chosen, so the popover
 * component stays logic-free and this stays unit-testable. Switching PROVIDER (local ↔ cloud) is included:
 * a cloud provider only appears when its API key is set.
 */

export interface ModelMenuOption {
  /** Stable id for React keys. */
  id: string;
  label: string;
  /** Optional dim qualifier (e.g. "local server", "on-device"). */
  sublabel?: string;
  /** Is this the currently-selected model for its group? */
  active: boolean;
  /** The settings change to apply when this option is picked. */
  patch: Partial<ReaderSettings>;
}

export interface ModelMenuGroup {
  key: "llm" | "image" | "video";
  label: string;
  options: ModelMenuOption[];
  /** Image group only, when the caller supplies `imageModelsByBackend`: pick a local backend first, then
   * `localModelsByBackend[id]` lists ONLY that backend's installed checkpoints — instead of the flat,
   * backend-mixed list `options` would otherwise carry. */
  localBackends?: { id: LocalBackendId; label: string; active: boolean }[];
  localModelsByBackend?: Partial<Record<LocalBackendId, ModelMenuOption[]>>;
}

/** One provider/source section inside a tab of the switcher ("Cloud" / "Local"), derived from a group
 * by `sectionizeGroup` so the popover renders headers without re-deriving anything in JSX. */
export interface ModelMenuSection {
  /** Section header. Absent on a group's sole section (e.g. video), where a header would be noise. */
  label?: string;
  /** Dim caption under the header (e.g. video's "runs on local ComfyUI" note). */
  note?: string;
  options: ModelMenuOption[];
  /** Image group's "Local" section in provider-first mode: render the group's `localBackends` picker
   * here, with the chosen backend's `localModelsByBackend` checkpoints beneath it. */
  backendPicker?: boolean;
}

/**
 * Split a group's flat option list into provider/source sections. Pure and lossless: every option
 * lands in exactly one section, unchanged. Cloud vs local is read off each option's `patch` (the
 * one field that can't drift from what picking it actually does), not off id spelling.
 */
export function sectionizeGroup(g: ModelMenuGroup): ModelMenuSection[] {
  if (g.key === "video") {
    // Single-source group — a "Local" header over everything says nothing; a note does.
    if (!g.options.length) return [];
    return [{ note: "Video renders on your local ComfyUI.", options: g.options }];
  }
  const isLocal = (o: ModelMenuOption): boolean =>
    g.key === "llm" ? o.patch.textProvider === "local" : o.patch.imageProvider === "local";
  const cloud = g.options.filter((o) => !isLocal(o));
  const local = g.options.filter(isLocal);
  const sections: ModelMenuSection[] = [];
  if (cloud.length) sections.push({ label: "Cloud", options: cloud });
  // Provider-first image mode keeps its local checkpoints under localBackends/localModelsByBackend,
  // so the "Local" section exists (to host the backend picker) even with zero flat options.
  const hasBackendPicker = g.key === "image" && (g.localBackends?.length ?? 0) > 0;
  if (local.length || hasBackendPicker) {
    sections.push({ label: "Local", options: local, ...(hasBackendPicker ? { backendPicker: true } : {}) });
  }
  return sections;
}

/** The label of a group's active option — shown as the per-tab summary in the switcher's tab strip.
 * Checks the provider-first image lists too, where the active checkpoint isn't in `options`. */
export function activeModelLabel(g: ModelMenuGroup): string | undefined {
  const flat = g.options.find((o) => o.active);
  if (flat) return flat.label;
  for (const opts of Object.values(g.localModelsByBackend ?? {})) {
    const hit = opts?.find((o) => o.active);
    if (hit) return hit.label;
  }
  return undefined;
}

/** Which tab the switcher opens on: chat when it holds the active selection (the common case),
 * else the first group that does, else the first group at all. */
export function defaultMenuTab(groups: ModelMenuGroup[]): ModelMenuGroup["key"] {
  const llm = groups.find((g) => g.key === "llm");
  if (llm && activeModelLabel(llm) !== undefined) return "llm";
  const withActive = groups.find((g) => activeModelLabel(g) !== undefined);
  return withActive?.key ?? groups[0]?.key ?? "llm";
}

/** Case-insensitive label filter for the switcher's search box. Blank query → the list untouched. */
export function filterOptions(options: ModelMenuOption[], query: string): ModelMenuOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => o.label.toLowerCase().includes(q));
}

export function buildModelMenu(
  s: ReaderSettings,
  lists: {
    textModels: InstalledModel[];
    imageModels: InstalledModel[];
    /** Per-backend installed checkpoints (ComfyUI / AUTOMATIC1111). When provided, the image group
     * becomes provider-first (see `ModelMenuGroup.localBackends`) instead of one flat mixed list. */
    imageModelsByBackend?: Partial<Record<LocalBackendId, InstalledModel[]>>;
  },
  opts: { isDesktop: boolean },
): ModelMenuGroup[] {
  const keys = s.keys ?? {};
  const hasKey = (id: string): boolean => Boolean(keys[id]?.trim());

  // ---------- Chat (LLM) ----------
  const llm: ModelMenuOption[] = [];
  // Cloud providers you have a key for (switch provider).
  for (const p of TEXT_PROVIDERS) {
    if (p.local || !p.needsKey || !hasKey(p.id)) continue;
    llm.push({
      id: `text:${p.id}`,
      label: p.label,
      active: s.textProvider === p.id,
      patch: { textProvider: p.id as ReaderSettings["textProvider"] },
    });
  }
  const localText = s.textProvider === "local";
  // Desktop's built-in model.
  if (opts.isDesktop) {
    llm.push({
      id: "text:local-bundled",
      label: BUNDLED_LLM.label,
      active: localText && (s.localTextBackend ?? "bundled") === "bundled",
      patch: { textProvider: "local", localTextBackend: "bundled" },
    });
  }
  // Installed models on the connected local LLM server (Ollama / LM Studio / llama.cpp).
  for (const m of lists.textModels) {
    llm.push({
      id: `text:server:${m.id}`,
      label: m.label,
      sublabel: "local server",
      active: localText && s.localTextBackend === "server" && s.localServerTextModel === m.id,
      patch: { textProvider: "local", localTextBackend: "server", localServerTextModel: m.id },
    });
  }
  // On-device (WebGPU) models — only when that backend is already active, so the quick menu never kicks
  // off a multi-GB model download on a stray tap.
  if (localText && s.localTextBackend === "webgpu") {
    for (const m of LOCAL_TEXT_MODELS) {
      llm.push({
        id: `text:webgpu:${m.id}`,
        label: m.label,
        sublabel: "on-device",
        active: (s.localTextModel ?? LOCAL_TEXT_MODELS[0]?.id) === m.id,
        patch: { textProvider: "local", localTextBackend: "webgpu", localTextModel: m.id },
      });
    }
  }

  // ---------- Image ----------
  const image: ModelMenuOption[] = [];
  for (const p of IMAGE_PROVIDERS) {
    if (p.local || !p.needsKey || !hasKey(p.id)) continue;
    image.push({
      id: `image:${p.id}`,
      label: p.label,
      active: s.imageProvider === p.id,
      patch: { imageProvider: p.id as ReaderSettings["imageProvider"] },
    });
  }
  const activeBackend = s.localBackend ?? "comfyui";
  let localBackends: ModelMenuGroup["localBackends"];
  let localModelsByBackend: ModelMenuGroup["localModelsByBackend"];
  if (lists.imageModelsByBackend) {
    // Provider-first: list ComfyUI/AUTOMATIC1111 as backends to choose between, each with ONLY its own
    // installed checkpoints beneath it (never mixed with the other backend's models).
    const backendIds = Object.keys(lists.imageModelsByBackend) as LocalBackendId[];
    localBackends = backendIds.map((id) => ({ id, label: LOCAL_BACKEND_LABEL[id], active: id === activeBackend }));
    localModelsByBackend = {};
    for (const id of backendIds) {
      localModelsByBackend[id] = (lists.imageModelsByBackend[id] ?? []).map((m) => ({
        id: `image:local:${id}:${m.id}`,
        label: m.label,
        sublabel: "local checkpoint",
        active: s.imageProvider === "local" && activeBackend === id && s.localModel === m.id,
        patch: { imageProvider: "local", localBackend: id, localModel: m.id },
      }));
    }
  } else {
    // No by-backend inventory supplied — flat fallback (backend-agnostic, matches legacy behavior).
    for (const m of lists.imageModels) {
      image.push({
        id: `image:local:${m.id}`,
        label: m.label,
        sublabel: "local checkpoint",
        active: s.imageProvider === "local" && s.localModel === m.id,
        patch: { imageProvider: "local", localModel: m.id },
      });
    }
  }

  // ---------- Video (local ComfyUI only) ----------
  const activeVideo = s.videoModel ?? VIDEO_MODELS[0]?.id;
  const video: ModelMenuOption[] = VIDEO_MODELS.map((m) => ({
    id: `video:${m.id}`,
    label: m.label,
    active: activeVideo === m.id,
    patch: { videoModel: m.id },
  }));

  const groups: ModelMenuGroup[] = [];
  if (llm.length) groups.push({ key: "llm", label: "Chat model", options: llm });
  if (image.length || localBackends?.length) {
    groups.push({
      key: "image",
      label: "Image model",
      options: image,
      ...(localBackends ? { localBackends } : {}),
      ...(localModelsByBackend ? { localModelsByBackend } : {}),
    });
  }
  if (video.length) groups.push({ key: "video", label: "Video model", options: video });
  return groups;
}
