import { useCallback, useEffect, useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  Automatic1111Backend,
  BUNDLED_LLM,
  ComfyUIBackend,
  DEFAULT_LOCAL_TEXT_SERVER,
  DirectTransport,
  LOCAL_IMAGE_MODELS,
  LOCAL_TEXT_SERVER_DEFAULT_URL,
  LocalServerLLMProvider,
  VIDEO_MODELS,
  getImageStyle,
  imageModelVramCostGb,
  ollamaModelMatches,
  shouldDeferLocalEngineAutostart,
  videoModelById,
  videoModelDownloads,
  type BookSource,
  type LocalTextServerId,
} from "@visual-reader/core";
import {
  LOCAL_ENGINE_DEFAULT_URL,
  applyLocalModelComponents,
  type InstalledModel,
  type LocalBackendId,
  type ReaderSettings,
} from "@visual-reader/ui";
import {
  desktopFetch,
  downloadFfmpeg,
  downloadLora,
  downloadModel,
  ensureA1111,
  ensureEngine,
  ensureLocalLlm,
  gpuVramMb,
  isDesktop,
  listLocalModels,
  listLoras,
  loraFamilies,
  onEngineProgress,
  onLlmProgress,
  onModelProgress,
} from "./runtime.js";
import type { AppSyncMessage } from "./remote-sync.js";

/**
 * The local-engine lifecycle, extracted whole from App.tsx: starting/adopting an image engine
 * (app-managed ComfyUI or a user-run ComfyUI/AUTOMATIC1111 — "who launched it" is resolved inside,
 * never a setting), the low-VRAM deferred start, the bundled/local-server text-model bring-up, and
 * every Settings download (checkpoints, LoRAs, video models, ffmpeg, Ollama pulls) + Connect
 * handler. The resolver chain (probe → self-provision → managed fallback) is private; the hook
 * returns only what the UI wires up. Inventory/progress/status live in App state — the hook writes
 * them through the passed setters so the render (and the phone mirror) see them unchanged.
 */
export interface LocalEngineDeps {
  isRemoteClient: boolean;
  sendAppSync: (msg: AppSyncMessage) => void;
  settings: ReaderSettings;
  settingsRef: MutableRefObject<ReaderSettings>;
  setSettings: Dispatch<SetStateAction<ReaderSettings>>;
  book: BookSource | undefined;
  bookRef: MutableRefObject<BookSource | undefined>;
  /** Hand a freshly-started engine's URL straight to the worker (no wait on the settings sync). */
  applyEngineConfig: (baseUrl: string, backend?: LocalBackendId) => void;
  setEngineStatus: (status: string) => void;
  setLocalError: (text: string) => void;
  setModelProgress: Dispatch<SetStateAction<Record<string, number>>>;
  setDownloadStage: Dispatch<SetStateAction<Record<string, string>>>;
  setPullProgress: Dispatch<SetStateAction<Record<string, { status: string; percent?: number }>>>;
  setTextModels: (models: InstalledModel[]) => void;
  setInstalledModels: (models: InstalledModel[]) => void;
  setInstalledModelsByBackend: Dispatch<SetStateAction<Partial<Record<LocalBackendId, InstalledModel[]>>>>;
  setInstalledLoras: (loras: string[]) => void;
  setLoraFamilyMap: (families: Record<string, string>) => void;
  setInstalledTextEncoders: (files: string[]) => void;
  setInstalledVaes: (files: string[]) => void;
  setInstalledDiffusionModels: (files: string[]) => void;
  setInstalledUpscalers: (files: string[]) => void;
  setInstalledLtxTextEncoders: (files: string[]) => void;
  setConnectingLocal: (v: boolean) => void;
  setConnectingLocalText: (v: boolean) => void;
  /** Phone-relay seams from useRemoteMirror: the hook assigns its Connect / ffmpeg handlers here so
   * the early-registered relay handler reaches them. */
  connectLocalServerRef: MutableRefObject<(backend: LocalBackendId, url: string) => void>;
  downloadFfmpegRef: MutableRefObject<() => void>;
}

/** Best-effort filename from a download URL (for pasted checkpoint/LoRA URLs). */
function fileNameFromUrl(url: string): string {
  try {
    const base = new URL(url).pathname.split("/").filter(Boolean).pop();
    const clean = base ? decodeURIComponent(base) : "";
    if (clean) return /\.(safetensors|ckpt|pt)$/i.test(clean) ? clean : `${clean}.safetensors`;
  } catch {
    /* fall through */
  }
  return "model.safetensors";
}

export function useLocalEngine(deps: LocalEngineDeps) {
  const {
    isRemoteClient,
    sendAppSync,
    settings,
    settingsRef,
    setSettings,
    book,
    bookRef,
    applyEngineConfig,
    setEngineStatus,
    setLocalError,
    setModelProgress,
    setDownloadStage,
    setPullProgress,
    setTextModels,
    setInstalledModels,
    setInstalledModelsByBackend,
    setInstalledLoras,
    setLoraFamilyMap,
    setInstalledTextEncoders,
    setInstalledVaes,
    setInstalledDiffusionModels,
    setInstalledUpscalers,
    setInstalledLtxTextEncoders,
    setConnectingLocal,
    setConnectingLocalText,
    connectLocalServerRef,
    downloadFfmpegRef,
  } = deps;

  // Per-entry file position, to fold per-file Rust progress into one combined bar.
  const multiFile = useRef<Record<string, { index: number; count: number }>>({});
  // Low-VRAM deferred engine start: at boot we DON'T self-launch a local engine (so a large local LLM can
  // take the whole GPU); it spins up on the first image instead. `engineDeferredRef` marks that we
  // skipped the eager start; `managedBaseUrlRef` holds the app-managed ComfyUI's URL the moment IT starts
  // (read race-free, before the React settings sync); `engineStartingRef` coalesces concurrent lazy starts.
  const engineDeferredRef = useRef(false);
  const managedBaseUrlRef = useRef<string | undefined>(undefined);
  const engineStartingRef = useRef<
    Promise<{ ok: true; baseUrl: string; backend: LocalBackendId } | { ok: false; reason: string }> | undefined
  >(undefined);

  // Desktop: subscribe to engine-setup and model-download progress (Rust events).
  useEffect(() => {
    if (!isDesktop) return;
    const unEngine = onEngineProgress((p) => {
      setEngineStatus(p.phase === "ready" ? "" : p.percent !== undefined ? `${p.message} ${Math.round(p.percent)}%` : p.message);
    });
    const unModel = onModelProgress((p) => {
      // A split-file model reports per-file percent under one id; fold it into the
      // entry's combined 0..100 using the current file position.
      const mf = multiFile.current[p.id];
      const pct = mf ? ((mf.index + p.percent / 100) / mf.count) * 100 : p.percent;
      setModelProgress((prev) => ({ ...prev, [p.id]: pct }));
    });
    const unLlm = onLlmProgress((p) => {
      setEngineStatus(
        p.phase === "ready"
          ? ""
          : p.percent !== undefined
            ? `${p.message} ${Math.round(p.percent)}%`
            : p.message,
      );
    });
    return () => {
      void unEngine?.then((fn) => fn());
      void unModel?.then((fn) => fn());
      void unLlm?.then((fn) => fn());
    };
  }, []);

  // Desktop: when text is set to the BUILT-IN model, make sure the bundled
  // llama-server is running (downloads/launches on first use) and point the
  // local-server provider at it — mirrors the image-engine setup above.
  useEffect(() => {
    if (
      !isDesktop ||
      settings.textProvider !== "local" ||
      settings.localTextBackend !== "bundled" ||
      settings.localServerTextUrl
    )
      return;
    let cancelled = false;
    void (async () => {
      try {
        setEngineStatus("Starting the built-in model…");
        const { baseUrl, model } = await ensureLocalLlm();
        if (cancelled) return;
        setEngineStatus("");
        // List the running model so the picker isn't empty — and so a LINKED PHONE sees it via the
        // inventory mirror (the phone has no local server to query). The bundled server reports this
        // one model id; without this, textModels stayed [] and the phone showed "connect locally".
        setTextModels([{ id: model, label: BUNDLED_LLM.label }]);
        setSettings((s) => ({ ...s, localServerTextUrl: baseUrl, localServerTextModel: model }));
      } catch (err) {
        if (!cancelled) {
          setEngineStatus("");
          setLocalError(`Built-in model failed to start: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.textProvider, settings.localTextBackend, settings.localServerTextUrl]);

  // Desktop: when the text provider is a LOCAL SERVER (Ollama / LM Studio / llama.cpp) with a saved
  // URL, list its models on load so the picker is populated without a manual reconnect — and so a
  // linked phone (which can't reach the desktop's localhost server) sees the list via the inventory
  // mirror. Best-effort; a wedged/offline server just leaves the list as-is.
  useEffect(() => {
    if (!isDesktop || settings.textProvider !== "local" || settings.localTextBackend !== "server") return;
    const url =
      settings.localServerTextUrl?.trim() ||
      LOCAL_TEXT_SERVER_DEFAULT_URL[settings.localTextServer ?? DEFAULT_LOCAL_TEXT_SERVER];
    if (!url) return;
    let cancelled = false;
    void LocalServerLLMProvider.listModels(url)
      .then((models) => {
        if (!cancelled && models.length) setTextModels(models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [settings.textProvider, settings.localTextBackend, settings.localServerTextUrl, settings.localTextServer]);

  // Start (or reuse) the app-managed ComfyUI and load its inventory; point the ACTIVE engine at it
  // (always ComfyUI). Returns `true` on success, or a reason string (`"unavailable"` off the desktop)
  // so the resolver can fall back. Desktop only — `ensureEngine` rejects elsewhere.
  const startManagedEngine = useCallback(async (): Promise<true | string> => {
    if (!isDesktop) return "unavailable";
    try {
      setEngineStatus("Setting up the local engine…");
      // Detect VRAM once: it both caps Auto-quality AND decides --lowvram (best-effort; undefined on
      // non-NVIDIA GPUs leaves Auto uncapped).
      const vram = await gpuVramMb();
      // VRAM- and model-aware --lowvram: offload the big text encoder to system RAM ONLY when the
      // chosen image model won't comfortably fit the GPU. When VRAM is unknown, fall back to the
      // manual Low-VRAM toggle. (fp8 weights stay tied to the toggle separately, in the workflow.)
      const LOWVRAM_HEADROOM_GB = 4; // activations/latents/runtime overhead beyond the weights
      const s = settingsRef.current;
      const modelCostGb = imageModelVramCostGb(s.localModel ?? "");
      const needsLowVram =
        vram === undefined ? !!s.lowVram : modelCostGb > 0 && (modelCostGb + LOWVRAM_HEADROOM_GB) * 1024 > vram;
      const baseUrl = await ensureEngine(needsLowVram, s.showEngineConsole);
      const models = await listLocalModels();
      const loras = await listLoras();
      // Detect each LoRA's base architecture (reads only the safetensors header) so the UI can flag
      // one that won't load on the active model.
      const families = await loraFamilies();
      setEngineStatus("");
      setInstalledModels(models);
      setInstalledModelsByBackend((m) => ({ ...m, comfyui: models }));
      setInstalledLoras(loras);
      setLoraFamilyMap(families);
      // The managed engine is ComfyUI — read its text-encoder + VAE files over the HTTP API (same as
      // the "connect" path) so the split-file dropdowns are populated on desktop too.
      try {
        // Through the Rust bridge (CORS-exempt) — the managed engine is desktop-only, and a browser
        // fetch from the packaged app's Tauri-scheme origin would be CORS-blocked (empty dropdowns).
        const engine = new ComfyUIBackend({ baseUrl, transport: new DirectTransport(desktopFetch) });
        const [comps, vid] = await Promise.all([engine.listComponents(), engine.listVideoComponents()]);
        setInstalledTextEncoders(comps.textEncoders);
        setInstalledVaes(comps.vaes);
        setInstalledDiffusionModels(vid.diffusionModels);
        setInstalledUpscalers(vid.upscalers);
        setInstalledLtxTextEncoders(vid.ltxTextEncoders);
      } catch {
        /* leave components empty — the fields fall back to manual entry */
      }
      // Record the URL synchronously (refs don't wait for the React re-render) so a deferred lazy start
      // can hand it straight to the worker, and clear the deferred flag now that the engine is up.
      managedBaseUrlRef.current = baseUrl;
      engineDeferredRef.current = false;
      setSettings((cur) => ({
        ...cur,
        engineBaseUrl: baseUrl,
        engineBackend: "comfyui",
        // Remember the managed ComfyUI URL per-backend so VIDEO routing (comfyUrlForVideo) still finds it
        // even when the user's IMAGE backend is AUTOMATIC1111 — the two engines run side by side.
        localServerUrlByBackend: { ...cur.localServerUrlByBackend, comfyui: baseUrl },
        ...(vram ? { gpuVramMb: vram } : {}),
      }));
      return true;
    } catch (err) {
      setEngineStatus("");
      return err instanceof Error ? err.message : String(err);
    }
  }, []);

  // Probe a self-hosted SD server (ComfyUI/A1111): list its models + components and, on success,
  // point the ACTIVE engine at it (engineBaseUrl + engineBackend) and pick a sensible model. Throws
  // if the server can't be reached (so the resolver / connect handler can fall back).
  const probeServer = useCallback(async (backend: LocalBackendId, url: string): Promise<void> => {
    if (!url) throw new Error("no server URL set");
    // On desktop, reach the server through the Rust HTTP bridge (CORS-exempt) — the same path
    // generation uses. A plain browser fetch is CORS-bound, and in the PACKAGED app the WebView
    // origin is the Tauri custom scheme (not localhost:5173), which a self-hosted A1111/ComfyUI
    // `--cors-allow-origins` set for the dev origin won't match — so the link "stops working" in prod.
    const transport = isDesktop ? new DirectTransport(desktopFetch) : undefined;
    const engine =
      backend === "a1111"
        ? new Automatic1111Backend({ baseUrl: url, ...(transport ? { transport } : {}) })
        : new ComfyUIBackend({ baseUrl: url, ...(transport ? { transport } : {}) });
    const models = await engine.listModels(); // throws when the server is unreachable
    setInstalledModels(models);
    setInstalledModelsByBackend((m) => ({ ...m, [backend]: models }));
    try {
      const comps = await engine.listComponents();
      setInstalledTextEncoders(comps.textEncoders);
      setInstalledVaes(comps.vaes);
      if (engine instanceof ComfyUIBackend) {
        const vid = await engine.listVideoComponents();
        setInstalledDiffusionModels(vid.diffusionModels);
        setInstalledUpscalers(vid.upscalers);
        setInstalledLtxTextEncoders(vid.ltxTextEncoders);
      }
    } catch {
      /* leave components empty (A1111 has none; a ComfyUI miss falls back to manual entry) */
    }
    setSettings((s) => {
      const base: ReaderSettings = {
        ...s,
        engineBaseUrl: url,
        engineBackend: backend,
        // Persist this backend's URL so the OTHER engine's URL survives — video always routes to the
        // remembered ComfyUI URL even while images run on AUTOMATIC1111 (both alive at once).
        localServerUrlByBackend: { ...s.localServerUrlByBackend, [backend]: url },
      };
      // Keep the current model if the server still has it; otherwise pick its first + restore that
      // model's remembered encoder/VAE combo.
      if (s.localModel && models.some((m) => m.id === s.localModel)) return base;
      const localModel = models[0]?.id;
      return localModel ? applyLocalModelComponents(base, localModel) : base;
    });
  }, []);

  /** The URL remembered for a backend — whichever is currently ACTIVE reads `localServerUrl` (kept in
   * sync with its slot in `localServerUrlByBackend`); the other reads its own slot directly. */
  const knownUrlFor = useCallback((s: ReaderSettings, backend: LocalBackendId): string => {
    return ((s.localBackend ?? "comfyui") === backend ? s.localServerUrl : s.localServerUrlByBackend?.[backend]) || "";
  }, []);

  // Get SOME engine running for `backend`: try a remembered URL first (a server the user is already
  // running costs us nothing to just probe), then self-provision (app-managed ComfyUI, or auto-launch
  // AUTOMATIC1111 from its install folder) — falling back to the app-managed ComfyUI on total failure so
  // images never fully dead-end. Both backends are the SAME kind of thing here: an HTTP engine that's
  // either already reachable or ours to launch — "who started it" is resolved inside this one function,
  // not a separate setting. Reused by boot resolution, the low-VRAM deferred-start unstick paths, and the
  // interactive Connect button's fallback.
  const startActiveLocalEngine = useCallback(
    async (backend: LocalBackendId): Promise<{ ok: true; baseUrl: string; backend: LocalBackendId } | { ok: false; reason: string }> => {
      if (backend === "a1111") {
        const s = settingsRef.current;
        const url = knownUrlFor(s, "a1111") || LOCAL_ENGINE_DEFAULT_URL.a1111;
        const tryProbe = async (): Promise<boolean> => {
          try {
            await probeServer("a1111", url);
            return true;
          } catch {
            return false;
          }
        };
        if (await tryProbe()) return { ok: true, baseUrl: url, backend: "a1111" };
        if (isDesktop && s.a1111Path) {
          setEngineStatus("Starting AUTOMATIC1111…");
          try {
            await ensureA1111(s.a1111Path, s.showEngineConsole);
          } catch {
            /* couldn't auto-start — the retry probe below still tries a manually-started one */
          }
          setEngineStatus("");
          if (await tryProbe()) return { ok: true, baseUrl: url, backend: "a1111" };
        }
        // Nothing reachable (and nothing more of ours to launch) — fall back to the app-managed ComfyUI.
        const managed = await startManagedEngine();
        return managed === true ? { ok: true, baseUrl: managedBaseUrlRef.current ?? "", backend: "comfyui" } : { ok: false, reason: managed };
      }
      const url = knownUrlFor(settingsRef.current, "comfyui");
      if (url) {
        try {
          await probeServer("comfyui", url);
          return { ok: true, baseUrl: url, backend: "comfyui" };
        } catch {
          /* fall through to self-provisioning the app-managed engine */
        }
      }
      const managed = await startManagedEngine();
      return managed === true ? { ok: true, baseUrl: managedBaseUrlRef.current ?? "", backend: "comfyui" } : { ok: false, reason: managed };
    },
    [knownUrlFor, probeServer, startManagedEngine],
  );

  // Resolve which local engine actually renders for the chosen backend, falling back to the OTHER engine
  // when it can't be reached (so a bad URL or an unreachable server never dead-ends).
  const resolveLocalEngine = useCallback(async (): Promise<void> => {
    const s = settingsRef.current;
    if (s.imageProvider !== "local") return;
    const backend = s.localBackend ?? "comfyui";
    const backendName = backend === "a1111" ? "AUTOMATIC1111" : "ComfyUI";
    const knownUrl = knownUrlFor(s, backend);
    setLocalError("");
    if (!knownUrl && !isDesktop) return; // nothing configured off-desktop yet — wait for Connect, no error noise
    // LOW-VRAM deferred start: don't self-launch an engine at boot — a large local LLM can then take the
    // whole GPU. It starts lazily on the first standalone image (ensureRenderEngineReady) or eagerly when
    // a book opens (its bible build needs it). A URL the user already configured is still probed now
    // (it's their process, not ours to schedule) — only the SELF-LAUNCH case defers. Skipped once a book
    // is open (its bible build needs the engine regardless).
    if (
      !knownUrl &&
      isDesktop &&
      !bookRef.current &&
      shouldDeferLocalEngineAutostart({
        lowVram: s.lowVram,
        gpuVramMb: s.gpuVramMb,
        imageModel: s.localModel,
        chatBackend: s.localTextBackend,
        serverTextModel: s.localServerTextModel,
      })
    ) {
      engineDeferredRef.current = true;
      return;
    }
    const res = await startActiveLocalEngine(backend);
    if (res.ok) {
      if (res.backend !== backend) setLocalError(`Couldn't reach ${backendName} — using the app-managed ComfyUI engine instead.`);
      return;
    }
    setLocalError(
      knownUrl
        ? `Couldn't reach your ${backendName} server at ${knownUrl}: ${res.reason}. Check the URL + that it's running with CORS for ${location.origin}.`
        : `Local engine setup failed: ${res.reason}`,
    );
  }, [knownUrlFor, startActiveLocalEngine]);

  // Lazily start the deferred (low-VRAM) engine before a STANDALONE render, then hand its URL to the
  // worker immediately (applyEngineConfig) so the render — which rebuilds providers fresh from settings —
  // uses it without waiting on the debounced settings sync. No-op when not deferred (already running, a
  // user's own server, or low-VRAM off). Concurrent calls share ONE in-flight start.
  const ensureRenderEngineReady = useCallback(async (): Promise<void> => {
    if (!engineDeferredRef.current) return;
    setEngineStatus("Starting the local image engine…");
    const start = engineStartingRef.current ?? startActiveLocalEngine(settingsRef.current.localBackend ?? "comfyui");
    engineStartingRef.current = start;
    try {
      const res = await start;
      if (res.ok) applyEngineConfig(res.baseUrl, res.backend);
    } finally {
      engineStartingRef.current = undefined;
    }
  }, [startActiveLocalEngine, applyEngineConfig]);

  // LOW-VRAM: when a book opens while the engine was deferred, start it now — a bible build needs it, and
  // the full start path rebuilds the book's persistent engine with the real URL (vs. the tune-only flush
  // used for standalone chat/playground renders). Desktop + local-image only.
  useEffect(() => {
    if (!book || !engineDeferredRef.current) return;
    if (!isDesktop || settingsRef.current.imageProvider !== "local") return;
    void startActiveLocalEngine(settingsRef.current.localBackend ?? "comfyui");
  }, [book, startActiveLocalEngine]);

  // Re-resolve the active engine when the local path is chosen and whenever the active BACKEND changes
  // (incl. a picked-from-the-quick-menu checkpoint on the other backend, which needs its engine actually
  // connected — not just `localModel` updated). NOT on URL keystrokes — those are committed explicitly
  // via Connect. `resolveLocalEngine` is stable, so this only fires on the listed inputs.
  useEffect(() => {
    // A linked phone has NO local engine — it mirrors the desktop's settings (incl. imageProvider:
    // "local"), but the engine runs on the desktop. Probing here would hit the PHONE's own
    // 127.0.0.1 and fail with a misleading "couldn't reach ComfyUI / CORS" error. The phone shows a
    // compact engine pill in the status bar instead (see the isRemoteClient badge branch).
    if (isRemoteClient) return;
    if (settings.imageProvider !== "local") return;
    void resolveLocalEngine();
  }, [isRemoteClient, settings.imageProvider, settings.localBackend, resolveLocalEngine]);

  // Desktop: list the app-managed engine's installed image models on startup with a CHEAP folder scan
  // (no need to boot ComfyUI), so the picker + the phone-link inventory are populated immediately —
  // even before the engine resolves, and even when the image provider is currently CLOUD (so the
  // phone can still see + switch to a local model). Harmless to attempt even when the active backend is
  // AUTOMATIC1111 or a custom ComfyUI server — `probeServer` overwrites this with the real inventory once
  // the engine actually resolves; this is just a fast first paint.
  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    void (async () => {
      try {
        const [models, loras] = await Promise.all([listLocalModels(), listLoras()]);
        if (cancelled) return;
        if (models.length) setInstalledModels(models);
        if (loras.length) setInstalledLoras(loras);
      } catch {
        /* managed engine not installed yet — nothing to list */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Download a catalog model: every component file of a split-file model (diffusion
  // model + text encoder + VAE, each into its ComfyUI subfolder), or the single
  // checkpoint. Sequential, with one combined progress bar; already-present files
  // are skipped on the Rust side, so a retry resumes where it failed. On success
  // the model is auto-selected so it "just works".
  // For the unified download indicator: a friendly label for a progress key (catalog id / filename), and
  // the set of video component filenames to suppress (they download under their model's parent row).
  const downloadLabelFor = useCallback(
    (key: string): string | undefined =>
      videoModelById(key)?.label ?? LOCAL_IMAGE_MODELS.find((m) => m.id === key)?.label,
    [],
  );
  const videoChildFiles = useMemo(() => {
    const s = new Set<string>();
    for (const m of VIDEO_MODELS) for (const d of m.downloads) s.add(d.filename);
    return s;
  }, []);
  const isVideoChildFile = useCallback((key: string) => videoChildFiles.has(key), [videoChildFiles]);

  const onDownloadModel = useCallback(async (id: string) => {
    const model = LOCAL_IMAGE_MODELS.find((m) => m.id === id);
    if (!model) return;
    const files = model.files ?? [{ filename: model.filename, url: model.url, folder: "checkpoints" as const }];
    setModelProgress((prev) => ({ ...prev, [id]: 0 }));
    let currentFile = files[0]!.filename;
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        currentFile = f.filename;
        multiFile.current[id] = { index: i, count: files.length };
        if (files.length > 1) {
          setDownloadStage((prev) => ({ ...prev, [id]: `file ${i + 1}/${files.length}: ${f.filename}` }));
        }
        await downloadModel({ id, filename: f.filename, url: f.url, folder: f.folder });
        setModelProgress((prev) => ({ ...prev, [id]: ((i + 1) / files.length) * 100 }));
      }
      setInstalledModels(await listLocalModels());
      setSettings((s) => applyLocalModelComponents(s, model.filename));
    } catch (err) {
      setModelProgress((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setLocalError(
        `Model download failed at ${currentFile}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Retrying skips files that finished.`,
      );
    } finally {
      delete multiFile.current[id];
      setDownloadStage((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }, []);

  // Download the app's own managed ffmpeg (static, no external DLL) so long-form video stitching never
  // depends on PATH/winget — the class of problem that produces a "some.dll was not found" crash when a
  // shared ffmpeg install gets split up. Progress rides the existing model-download progress dict under
  // id "ffmpeg" (see the onModelProgress listener above), so no separate progress plumbing is needed.
  const onDownloadFfmpeg = useCallback(async () => {
    // On a linked PHONE there's no filesystem of its own — the DESKTOP owns it. Relay the request;
    // the desktop runs the real download and mirrors progress back via EngineInventory.ffmpegProgress.
    if (isRemoteClient) {
      setModelProgress((prev) => ({ ...prev, ffmpeg: 0 }));
      sendAppSync({ type: "vrcmd:downloadFfmpeg" });
      return;
    }
    setModelProgress((prev) => ({ ...prev, ffmpeg: 0 }));
    try {
      await downloadFfmpeg();
    } catch (err) {
      setModelProgress((prev) => {
        const next = { ...prev };
        delete next.ffmpeg;
        return next;
      });
      setLocalError(`ffmpeg download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [isRemoteClient, sendAppSync]);
  useEffect(() => {
    downloadFfmpegRef.current = onDownloadFfmpeg;
  }, [onDownloadFfmpeg]);

  // Download an image-to-video model's files (Wan 2.2: two experts + encoder + VAE) into ComfyUI's
  // diffusion_models / text_encoders / vae folders, with the same per-file progress as image models.
  const onDownloadVideoModel = useCallback(async (id: string) => {
    const files = videoModelDownloads(id);
    if (files.length === 0) return;
    setModelProgress((prev) => ({ ...prev, [id]: 0 }));
    let currentFile = files[0]!.filename;
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        currentFile = f.filename;
        multiFile.current[id] = { index: i, count: files.length };
        setDownloadStage((prev) => ({ ...prev, [id]: `file ${i + 1}/${files.length}: ${f.filename}` }));
        // Report progress under the MODEL id (not the filename) so the per-file Rust progress folds into
        // the model's single combined bar (multiFile above) — matching onDownloadModel. Using the filename
        // as the id breaks the fold (the bar sits at 0% until each file finishes) and the live per-file
        // progress lands on a child-file key the download indicator hides, so it looks like nothing happens.
        await downloadModel({ id, filename: f.filename, url: f.url, folder: f.folder });
        setModelProgress((prev) => ({ ...prev, [id]: ((i + 1) / files.length) * 100 }));
      }
    } catch (err) {
      setModelProgress((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setLocalError(`Video model download failed at ${currentFile}: ${err instanceof Error ? err.message : String(err)}. Retrying skips finished files.`);
    } finally {
      delete multiFile.current[id];
      setDownloadStage((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }, []);

  // Download a text model INTO Ollama from the Settings menu (no terminal needed),
  // with live progress; on success refresh the model list and auto-select it.
  const onPullTextModel = useCallback(
    async (model: string) => {
      const url =
        settings.localServerTextUrl?.trim() ||
        LOCAL_TEXT_SERVER_DEFAULT_URL[settings.localTextServer ?? DEFAULT_LOCAL_TEXT_SERVER];
      setLocalError("");
      setPullProgress((prev) => ({ ...prev, [model]: { status: "starting…" } }));
      try {
        await LocalServerLLMProvider.pullModel(url, model, (p) =>
          setPullProgress((prev) => ({ ...prev, [model]: p })),
        );
        const models = await LocalServerLLMProvider.listModels(url);
        setTextModels(models);
        const installed = models.find((m) => ollamaModelMatches(m.id, model))?.id ?? model;
        setSettings((s) => ({ ...s, localServerTextUrl: url, localServerTextModel: installed }));
      } catch (err) {
        setLocalError(
          `Couldn't download ${model}: ${err instanceof Error ? err.message : String(err)}. ` +
            `Make sure Ollama is running (it resumes where it left off).`,
        );
      } finally {
        setPullProgress((prev) => {
          const next = { ...prev };
          delete next[model];
          return next;
        });
      }
    },
    [settings.localServerTextUrl, settings.localTextServer],
  );

  // Download the LoRA for a style into the managed engine — from the catalog URL,
  // or a URL the user pasted (customUrl). Saved as the style's LoRA name.
  const onDownloadStyleLora = useCallback(async (styleId: string, customUrl?: string) => {
    const lora = getImageStyle(styleId).local?.lora;
    if (!lora) return;
    const url = customUrl?.trim() || lora.url;
    if (!url) return;
    const id = lora.name;
    const filename = lora.filename ?? `${lora.name}.safetensors`;
    setModelProgress((prev) => ({ ...prev, [id]: 0 }));
    try {
      await downloadLora({ id, filename, url });
      setModelProgress((prev) => ({ ...prev, [id]: 100 }));
      setInstalledLoras(await listLoras());
      setLoraFamilyMap(await loraFamilies());
      setSettings((s) => ({ ...s })); // refresh providers so the engine picks it up
    } catch (err) {
      setModelProgress((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setLocalError(`Style pack download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  // Download a checkpoint from a pasted URL into the managed engine.
  const onDownloadModelUrl = useCallback(async (url: string) => {
    const clean = url.trim();
    if (!clean) return;
    const filename = fileNameFromUrl(clean);
    setModelProgress((prev) => ({ ...prev, [filename]: 0 }));
    try {
      await downloadModel({ id: filename, filename, url: clean });
      setModelProgress((prev) => ({ ...prev, [filename]: 100 }));
      setInstalledModels(await listLocalModels());
      setSettings((s) => ({ ...s }));
    } catch (err) {
      setModelProgress((prev) => {
        const next = { ...prev };
        delete next[filename];
        return next;
      });
      setLocalError(`Model download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  // Connect to a backend (AUTOMATIC1111 / ComfyUI): probe it and make it the active image engine,
  // remembering the URL UNDER its backend so reconnecting later restores it. On failure, fall back to
  // the app-managed ComfyUI (desktop) instead of dead-ending.
  const onConnectLocalServer = useCallback(
    async (backend: LocalBackendId, url: string) => {
      // On a linked PHONE there's no engine of its own — the DESKTOP owns the network + install folder.
      // Remember the URL locally (so the field/mirror keep it), then relay Connect: the desktop probes /
      // auto-starts the server and mirrors the resulting settings (engineBaseUrl/models) back.
      if (isRemoteClient) {
        setSettings((s) => ({
          ...s,
          localBackend: backend,
          localServerUrl: url,
          localServerUrlByBackend: { ...(s.localServerUrlByBackend ?? {}), [backend]: url },
        }));
        sendAppSync({ type: "vrcmd:connectLocalServer", backend, url });
        return;
      }
      setLocalError("");
      setConnectingLocal(true);
      const name = backend === "a1111" ? "AUTOMATIC1111" : "ComfyUI";
      // Persist the choice + per-backend URL memory whether or not the probe succeeds, so the field
      // keeps what the user typed and reconnecting restores it.
      const remember = (s: ReaderSettings): ReaderSettings => ({
        ...s,
        localBackend: backend,
        localServerUrl: url,
        localServerUrlByBackend: { ...(s.localServerUrlByBackend ?? {}), [backend]: url },
      });
      // Auto-start AUTOMATIC1111 from its install folder (desktop) so the user doesn't have to launch it
      // by hand. Best-effort: if there's no folder set / it isn't an A1111 install / non-desktop, fall
      // through to a plain connect (which surfaces its own "is it running?" hint on failure).
      const cur = settingsRef.current;
      if (backend === "a1111" && isDesktop && cur.a1111Path) {
        try {
          await ensureA1111(cur.a1111Path, cur.showEngineConsole);
        } catch {
          /* couldn't auto-start — probeServer below still tries to connect to a manually-started one */
        }
      }
      try {
        await probeServer(backend, url); // sets engineBaseUrl/engineBackend/models on success
        setSettings(remember);
        // Both engines alive: when images run on A1111, also make sure the managed ComfyUI (for VIDEO) is up
        // and its URL is current — but ONLY if it was set up before (a remembered URL), so we never trigger a
        // surprise multi-GB ComfyUI download just from connecting A1111. Doesn't touch the active image engine.
        if (backend === "a1111" && isDesktop && cur.localServerUrlByBackend?.comfyui) {
          try {
            const comfyUrl = await ensureEngine(false, cur.showEngineConsole);
            setSettings((s) => ({ ...s, localServerUrlByBackend: { ...s.localServerUrlByBackend, comfyui: comfyUrl } }));
          } catch {
            /* ComfyUI didn't come up — a later video render surfaces a clear "start ComfyUI" message */
          }
        }
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        setSettings(remember);
        // Fallback so a bad URL doesn't leave the user with no engine.
        const managed = await startActiveLocalEngine("comfyui");
        if (managed.ok) {
          setLocalError(`Couldn't reach ${name} at ${url} — using the app-managed engine instead. (${why})`);
        } else {
          setLocalError(
            `Couldn't reach ${name} at ${url}: ${why}. Make sure it's running with its API and CORS enabled for ${location.origin}.`,
          );
        }
      } finally {
        setConnectingLocal(false);
      }
    },
    [probeServer, startActiveLocalEngine, isRemoteClient, sendAppSync],
  );
  useEffect(() => {
    connectLocalServerRef.current = onConnectLocalServer;
  }, [onConnectLocalServer]);

  // Connect to a local LLM server (Ollama / LM Studio / llama.cpp), load its model
  // list, and remember it for next time. A direct fetch is fine in the web app
  // (the browser calls localhost); the extension equivalent passes a proxy transport.
  const onConnectLocalTextServer = useCallback(async (server: LocalTextServerId, url: string) => {
    setLocalError("");
    setConnectingLocalText(true);
    try {
      const models = await LocalServerLLMProvider.listModels(url);
      setTextModels(models);
      setSettings((s) => {
        const keep = s.localServerTextModel && models.some((m) => m.id === s.localServerTextModel);
        const localServerTextModel = keep ? s.localServerTextModel : models[0]?.id;
        return {
          ...s,
          localTextServer: server,
          localServerTextUrl: url,
          ...(localServerTextModel ? { localServerTextModel } : {}),
        };
      });
    } catch (err) {
      setLocalError(
        `Couldn't reach ${server} at ${url}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Make sure it's running, and (for Ollama in a browser) set OLLAMA_ORIGINS to ${location.origin}.`,
      );
    } finally {
      setConnectingLocalText(false);
    }
  }, []);

  // Ping the sub-agent "worker" endpoint (vLLM/llama.cpp/Ollama) and report the models it serves, so
  // Settings can confirm the tier is live before you rely on it. Same direct-fetch path as the local
  // text-server connect above (the browser calls localhost); GET /models is the OpenAI-compatible probe.
  const onTestSubAgentEndpoint = useCallback(
    async (url: string): Promise<{ ok: boolean; models?: string[]; error?: string }> => {
      try {
        const models = await LocalServerLLMProvider.listModels(url);
        return { ok: true, models: models.map((m) => m.id) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [],
  );
  return {
    ensureRenderEngineReady,
    downloadLabelFor,
    isVideoChildFile,
    onDownloadModel,
    onDownloadModelUrl,
    onDownloadVideoModel,
    onDownloadFfmpeg,
    onPullTextModel,
    onDownloadStyleLora,
    onConnectLocalServer,
    onConnectLocalTextServer,
    onTestSubAgentEndpoint,
  };
}
