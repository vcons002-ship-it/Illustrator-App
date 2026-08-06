import { BUNDLED_LLM, IMAGE_PROVIDERS, LOCAL_TEXT_MODELS, TEXT_PROVIDERS, VIDEO_MODELS, comfyUrlForVideo } from "@visual-reader/core";
import {
  LOCAL_BACKEND_LABEL,
  LOCAL_ENGINE_DEFAULT_URL,
  applyLocalModelComponents,
  type InstalledModel,
  type LocalBackendId,
  type ReaderSettings,
} from "./SettingsPanel.js";

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
  /**
   * This pick changes the ACTIVE local image backend, so the host must reconnect — not merely store
   * a preference.
   *
   * A settings patch cannot do this job. Connecting probes the server and sets the transient
   * `engineBaseUrl`/`engineBackend` that the provider actually renders through, auto-starts
   * AUTOMATIC1111 from its install folder, brings the managed ComfyUI up for video, and falls back
   * with a readable message when the server isn't there. Flipping `localBackend` on its own left
   * every one of those undone and the engine pointed at the previous backend's URL.
   */
  connect?: { backend: LocalBackendId; url: string };
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
  /** Label for the group's active selection when it isn't in `options` yet — e.g. a configured local
   * chat server model before its model list has been fetched. Lets the tab summary show the real model
   * id (not "—") and keeps the chat tab treated as active. */
  activeFallbackLabel?: string;
  /** Dim caption for the group's sole/first section — where this group's renders actually go. */
  note?: string;
  /** A problem the reader has to fix before picking here does anything (rendered in the warning
   * colour, above the options). Distinct from `note` because one is context and the other is a
   * blocker: video with no ComfyUI configured will not render, however the tab looks. */
  warning?: string;
}

/** One provider/source section inside a tab of the switcher ("Cloud" / "Local"), derived from a group
 * by `sectionizeGroup` so the popover renders headers without re-deriving anything in JSX. */
export interface ModelMenuSection {
  /** Section header. Absent on a group's sole section (e.g. video), where a header would be noise. */
  label?: string;
  /** Dim caption under the header (e.g. video's "runs on local ComfyUI" note). */
  note?: string;
  /** A blocker for this section, in the warning colour — see {@link ModelMenuGroup.warning}. */
  warning?: string;
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
    // Single-source group — a "Local" header over everything says nothing; a note does. The note and
    // any warning are computed at BUILD time (only the builder sees settings), because what matters
    // here is not "video is ComfyUI" in the abstract but whether THIS reader has one.
    if (!g.options.length) return [];
    return [
      {
        note: g.note ?? "Video renders on your local ComfyUI.",
        ...(g.warning ? { warning: g.warning } : {}),
        options: g.options,
      },
    ];
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
    sections.push({
      label: "Local",
      options: local,
      ...(g.key === "image" && g.note ? { note: g.note } : {}),
      ...(hasBackendPicker ? { backendPicker: true } : {}),
    });
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
  // Nothing listed is active yet — fall back to the configured selection's label (e.g. a local server
  // chat model whose list hasn't loaded) so the tab summary never shows "—" for a real configuration.
  return g.activeFallbackLabel;
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

  /**
   * THE OTHER SETTINGS A MODEL PICK DRAGS WITH IT.
   *
   * Choosing a local checkpoint is not one field. The text encoder and VAE are remembered PER MODEL
   * (`localComponentsByModel`), and the Settings picker restores them through
   * `applyLocalModelComponents` on every select — precisely so switching models never leaves the
   * previous model's encoder selected. This menu wrote `localModel` alone, so it did exactly that:
   * pick a new checkpoint and the old model's text encoder stayed, which the engine reports as a
   * text-encoder failure at render time. Reported as a text-encoder error on the first switch.
   *
   * Derived by CALLING that same function rather than restating its rule, so the two can't drift.
   */
  const withComponents = (model: string): Partial<ReaderSettings> => {
    const next = applyLocalModelComponents(s, model);
    // "" is meaningful here — it is the AUTO setting, and the value that clears the previous model's
    // encoder. Coerced explicitly so an unremembered model resets rather than leaving the field out
    // of the patch, which would merge as "keep what's there" and reintroduce the bug.
    return { localModel: model, localTextEncoder: next.localTextEncoder ?? "", localVae: next.localVae ?? "" };
  };

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
  // WHICH MODE, decided by whether there are actually BACKENDS to choose between — not by whether the
  // caller passed an object.
  //
  // The host seeds this map as `{}` and fills it once the per-backend inventory loads. An empty object
  // is truthy, so the old `if (lists.imageModelsByBackend)` took the provider-first path, found no
  // backend ids, built an empty picker, and — because the flat fallback lives in the `else` — never
  // listed `imageModels` at all. The group's own guard (`image.length || localBackends?.length`) then
  // saw nothing on either side and dropped the Image tab out of the menu entirely. Reported as: only
  // chat and video show up. It bit exactly the readers with a purely local image setup, since a cloud
  // image key would have put an option in `image` and kept the tab alive by accident.
  const backendIds = Object.keys(lists.imageModelsByBackend ?? {}) as LocalBackendId[];
  if (backendIds.length > 0) {
    // Provider-first: list ComfyUI/AUTOMATIC1111 as backends to choose between, each with ONLY its own
    // installed checkpoints beneath it (never mixed with the other backend's models).
    localBackends = backendIds.map((id) => ({ id, label: LOCAL_BACKEND_LABEL[id], active: id === activeBackend }));
    localModelsByBackend = {};
    for (const id of backendIds) {
      // Switching backend needs a CONNECT, not a stored preference — and the URL comes from this
      // backend's own memory, because the live `localServerUrl` still points at the outgoing one.
      const url = s.localServerUrlByBackend?.[id]?.trim() || LOCAL_ENGINE_DEFAULT_URL[id];
      const switchesBackend = id !== activeBackend || s.imageProvider !== "local";
      localModelsByBackend[id] = (lists.imageModelsByBackend?.[id] ?? []).map((m) => ({
        id: `image:local:${id}:${m.id}`,
        label: m.label,
        sublabel: "local checkpoint",
        active: s.imageProvider === "local" && activeBackend === id && s.localModel === m.id,
        patch: { imageProvider: "local", localBackend: id, localServerUrl: url, ...withComponents(m.id) },
        ...(switchesBackend ? { connect: { backend: id, url } } : {}),
      }));
    }
  } else {
    // No backends known — flat fallback (backend-agnostic, matches legacy behaviour). This is also
    // the path taken BEFORE the per-backend inventory has loaded, which is why it must never be
    // skipped: it is the only thing standing between a still-loading map and an empty menu.
    for (const m of lists.imageModels) {
      image.push({
        id: `image:local:${m.id}`,
        label: m.label,
        sublabel: "local checkpoint",
        active: s.imageProvider === "local" && s.localModel === m.id,
        // No backend is known here, so there's nothing to reconnect — but the encoder/VAE still have
        // to follow the model, exactly as in the provider-first branch above.
        patch: { imageProvider: "local", ...withComponents(m.id) },
      });
    }
  }

  // ---------- Video (local ComfyUI only) ----------
  //
  // THE SPLIT THIS MENU HAS TO MAKE SENSE OF: images can render on AUTOMATIC1111, and video never
  // can — it always goes to a ComfyUI, at a URL remembered per backend, which may be a completely
  // different server from the one drawing the pictures. A reader on A1111 could pick a video model
  // here, see it tick, and get nothing, with the menu having said only "video renders on your local
  // ComfyUI" — true, and no help at all in working out whether they have one.
  //
  // So say which server, by name, and when there isn't one say that instead of a reassuring note.
  const activeVideo = s.videoModel ?? VIDEO_MODELS[0]?.id;
  const video: ModelMenuOption[] = VIDEO_MODELS.map((m) => ({
    id: `video:${m.id}`,
    label: m.label,
    active: activeVideo === m.id,
    patch: { videoModel: m.id },
  }));
  const videoComfyUrl = comfyUrlForVideo(s);
  const imagesOnA1111 = s.imageProvider === "local" && activeBackend === "a1111";
  const videoNote = videoComfyUrl
    ? `Video renders on ComfyUI at ${shortUrl(videoComfyUrl)}${
        imagesOnA1111 ? " — a separate server from the AUTOMATIC1111 drawing your images." : "."
      }`
    : undefined;
  const videoWarning = videoComfyUrl
    ? undefined
    : imagesOnA1111
      ? "Video needs ComfyUI, and your images run on AUTOMATIC1111 — which can't render video. Add a ComfyUI in Settings → Image engine; it can run alongside."
      : "No ComfyUI is configured yet, so video can't render. Set one up in Settings → Image engine.";

  // The IMAGE tab gets the other half of the same truth: switching the backend here moves where
  // pictures render and leaves video where it is. Only worth saying when both are actually in play.
  const imageNote =
    imagesOnA1111 && videoComfyUrl
      ? `Images render here; video stays on ComfyUI at ${shortUrl(videoComfyUrl)}.`
      : undefined;

  // When a local chat server model is configured but its model list hasn't been fetched yet, no llm
  // option carries `active` — surface the configured id so the tab summary + default-tab logic still
  // treat chat as the active group instead of falling through to "—" / the wrong tab.
  const llmActive = llm.some((o) => o.active);
  const llmFallback =
    !llmActive && localText && s.localTextBackend === "server" && s.localServerTextModel
      ? s.localServerTextModel
      : undefined;

  const groups: ModelMenuGroup[] = [];
  if (llm.length) groups.push({ key: "llm", label: "Chat model", options: llm, ...(llmFallback ? { activeFallbackLabel: llmFallback } : {}) });
  if (image.length || localBackends?.length) {
    groups.push({
      key: "image",
      label: "Image model",
      options: image,
      ...(imageNote ? { note: imageNote } : {}),
      ...(localBackends ? { localBackends } : {}),
      ...(localModelsByBackend ? { localModelsByBackend } : {}),
    });
  }
  if (video.length) {
    groups.push({
      key: "video",
      label: "Video model",
      options: video,
      ...(videoNote ? { note: videoNote } : {}),
      ...(videoWarning ? { warning: videoWarning } : {}),
    });
  }
  return groups;
}

/** A server URL short enough to sit in a menu caption: host:port, without the scheme or a trailing
 * slash. Falls back to the raw string when it isn't parseable, so a hand-typed value still shows. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
}
