import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BookSource,
  CharacterPatch,
  ImageResult,
  ImportStats,
  VisualBible,
} from "@visual-reader/core";
import type { ProvidersDiagnostics, ReaderSettings } from "@visual-reader/ui";

export interface ImportResult {
  ok: boolean;
  stats?: ImportStats;
  error?: string;
}
import type { MainToWorker, WorkerToMain } from "./worker-protocol.js";

/**
 * Owns the engine Web Worker and surfaces its state to React. The worker does
 * all extraction + rendering; this hook just relays messages and keeps a copy
 * of the latest results so the UI re-renders. Changing settings re-opens the
 * current book so new keys/tier take effect immediately.
 */
export interface EngineWorkerApi {
  bible: VisualBible | undefined;
  results: Map<number, ImageResult>;
  status: string;
  /** Persistent Visual-Bible line (building… / complete · model), separate from `status`. */
  bibleStatus: string;
  /** Structured chapter/prompt progress (for the always-visible workflow bar). */
  workflow: { bibleDone: number; bibleTotal: number; promptsDone: number; promptsTotal: number };
  /** Rolling average ms per rendered image (0 until measured), for ETAs. */
  avgRenderMs: number;
  /** Which providers are live vs. silent mock fallbacks (undefined until first init). */
  providers: ProvidersDiagnostics | undefined;
  /** Whether generation has been started for the current book. */
  generating: boolean;
  /** Independent pause state for the bible build vs. image rendering. */
  paused: { bible: boolean; images: boolean };
  openBook: (book: BookSource) => void;
  startGeneration: () => void;
  pause: () => void;
  resume: () => void;
  /** Pause/resume the Visual Bible build alone (frees the GPU for images). */
  pauseBible: () => void;
  resumeBible: () => void;
  /** Pause/resume image rendering alone (frees the GPU for the bible build). */
  pauseImages: () => void;
  resumeImages: () => void;
  regenerateStoryboard: () => void;
  regenerateAllImages: () => void;
  regenerateImage: (unitIndex: number) => void;
  /** Discard stored illustration prompts and rebuild them (LLM); images kept. */
  rebuildPrompts: () => void;
  /** Save a user correction to a character (persisted; existing images unchanged). */
  updateCharacter: (characterId: string, patch: CharacterPatch) => void;
  /** Add a user-uploaded IP-Adapter reference image (multi-view, capped per character). */
  addCharacterReference: (characterId: string, image: { bytes: ArrayBuffer; mimeType: string }) => void;
  /** Remove one of a character's reference images (deletes its stored bytes). */
  removeCharacterReference: (characterId: string, refId: string) => void;
  /** Fetch a reference image's bytes for a thumbnail (undefined when missing). */
  getCharacterReference: (refId: string) => Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined>;
  /** Download the current Visual Bible (+ AI rules) as a JSON file. */
  exportBible: () => void;
  /** Import a Visual Bible JSON onto the current book. */
  importBible: (json: string) => void;
  /** Series continuity: carry a prior book's bible into the current book. */
  carryOverBible: (fromBookId: string) => void;
  /** Result of the last import (success stats or an error), or undefined. */
  importResult: ImportResult | undefined;
  /** Clear the last import result (e.g. on closing the import dialog). */
  clearImportResult: () => void;
  /** Repaint from a unit to the end with current settings (earlier units kept). */
  paintForward: (fromUnit: number) => void;
}

export function useEngineWorker(settings: ReaderSettings): EngineWorkerApi {
  const workerRef = useRef<Worker | undefined>(undefined);
  const lastBook = useRef<BookSource | undefined>(undefined);
  // Whether the user has begun generating the current book. Survives the
  // settings-driven re-open (which builds a fresh engine) so generation resumes
  // instead of silently reverting to "not started".
  const generationRequested = useRef(false);
  const [bible, setBible] = useState<VisualBible | undefined>();
  const [results, setResults] = useState<Map<number, ImageResult>>(new Map());
  const [status, setStatus] = useState("");
  const [bibleStatus, setBibleStatus] = useState("");
  const [workflow, setWorkflow] = useState({
    bibleDone: 0,
    bibleTotal: 0,
    promptsDone: 0,
    promptsTotal: 0,
  });
  const [avgRenderMs, setAvgRenderMs] = useState(0);
  // Per-unit render start times + a rolling average, for image ETAs.
  const renderStart = useRef<Map<number, number>>(new Map());
  const renderAvg = useRef<{ avg: number; n: number }>({ avg: 0, n: 0 });
  const [providers, setProviders] = useState<ProvidersDiagnostics | undefined>();
  const [generating, setGenerating] = useState(false);
  const [paused, setPaused] = useState<{ bible: boolean; images: boolean }>({
    bible: false,
    images: false,
  });
  const [importResult, setImportResult] = useState<ImportResult | undefined>();
  // In-flight getCharacterReference requests, resolved by `characterReference` replies.
  const refRequests = useRef<
    Map<number, (image: { bytes: ArrayBuffer; mimeType: string } | undefined) => void>
  >(new Map());
  const nextRefRequestId = useRef(1);

  const send = (msg: MainToWorker, transfer: Transferable[] = []) =>
    workerRef.current?.postMessage(msg, transfer);

  useEffect(() => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./engine.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch (err) {
      setStatus(
        `Error: couldn't start the engine worker — ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    // Surface worker load/runtime crashes instead of failing silently (a dead
    // worker = no badges, no generation, endless "painting…").
    worker.onerror = (e: ErrorEvent) => {
      setStatus(
        `Error: engine worker crashed — ${e.message || "module failed to load"}` +
          (e.filename ? ` (${e.filename}:${e.lineno})` : ""),
      );
    };
    worker.onmessageerror = () => setStatus("Error: engine worker sent an undecodable message");
    worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
      const msg = event.data;
      switch (msg.type) {
        case "status":
          setStatus(msg.message);
          break;
        case "providers":
          setProviders(msg.diagnostics);
          break;
        case "generating":
          setGenerating(msg.value);
          break;
        case "paused":
          setPaused({ bible: msg.bible, images: msg.images });
          break;
        case "opened":
          setBible(msg.bible);
          break;
        case "update":
          setResults((prev) => new Map(prev).set(msg.pageIndex, msg.result));
          // Time each image (first "rendering" → "ready") into a rolling average.
          if (msg.result.status === "rendering" && !renderStart.current.has(msg.pageIndex)) {
            renderStart.current.set(msg.pageIndex, Date.now());
          } else if (msg.result.status === "ready") {
            const startedAt = renderStart.current.get(msg.pageIndex);
            renderStart.current.delete(msg.pageIndex);
            if (startedAt) {
              const dur = Date.now() - startedAt;
              const a = renderAvg.current;
              a.avg = (a.avg * a.n + dur) / (a.n + 1);
              a.n += 1;
              setAvgRenderMs(a.avg);
            }
          }
          break;
        case "bibleStatus":
          setBibleStatus(msg.text);
          break;
        case "workflow":
          setWorkflow({
            bibleDone: msg.bibleDone,
            bibleTotal: msg.bibleTotal,
            promptsDone: msg.promptsDone,
            promptsTotal: msg.promptsTotal,
          });
          break;
        case "export":
          downloadJson(msg.json, "visual-bible.json");
          break;
        case "imported":
          setImportResult({
            ok: msg.ok,
            ...(msg.stats ? { stats: msg.stats } : {}),
            ...(msg.error ? { error: msg.error } : {}),
          });
          break;
        case "characterReference": {
          const resolve = refRequests.current.get(msg.requestId);
          refRequests.current.delete(msg.requestId);
          resolve?.(msg.image);
          break;
        }
        case "error":
          setStatus(`Error: ${msg.message}`);
          break;
      }
    };
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  // Apply settings; re-open the current book so new keys/tier take effect, and
  // resume generation if it was already running (the re-open built a new engine).
  useEffect(() => {
    send({ type: "init", settings });
    if (lastBook.current) {
      setResults(new Map());
      send({ type: "open", book: lastBook.current });
      if (generationRequested.current) send({ type: "start" });
    }
  }, [settings]);

  const openBook = useCallback(
    (book: BookSource) => {
      lastBook.current = book;
      generationRequested.current = false; // a new book waits for the button
      setBible(undefined);
      setResults(new Map());
      send({ type: "init", settings });
      send({ type: "open", book });
    },
    [settings],
  );

  const startGeneration = useCallback(() => {
    generationRequested.current = true;
    send({ type: "start" });
  }, []);
  const pause = useCallback(() => send({ type: "pause" }), []);
  const resume = useCallback(() => {
    generationRequested.current = true;
    send({ type: "resume" });
  }, []);
  const pauseBible = useCallback(() => send({ type: "pauseBible" }), []);
  const resumeBible = useCallback(() => {
    generationRequested.current = true;
    send({ type: "resumeBible" });
  }, []);
  const pauseImages = useCallback(() => send({ type: "pauseImages" }), []);
  const resumeImages = useCallback(() => {
    generationRequested.current = true;
    send({ type: "resumeImages" });
  }, []);
  const regenerateStoryboard = useCallback(() => {
    generationRequested.current = true;
    send({ type: "regenerateStoryboard" });
  }, []);
  const rebuildPrompts = useCallback(() => {
    generationRequested.current = true;
    send({ type: "rebuildPrompts" });
  }, []);
  const regenerateAllImages = useCallback(() => {
    generationRequested.current = true;
    send({ type: "regenerateAllImages" });
  }, []);
  const regenerateImage = useCallback((unitIndex: number) => {
    generationRequested.current = true;
    send({ type: "regenerateImage", unitIndex });
  }, []);
  const updateCharacter = useCallback(
    (characterId: string, patch: CharacterPatch) =>
      send({ type: "updateCharacter", characterId, patch }),
    [],
  );
  const addCharacterReference = useCallback(
    (characterId: string, image: { bytes: ArrayBuffer; mimeType: string }) =>
      send({ type: "addCharacterReference", characterId, image }),
    [],
  );
  const removeCharacterReference = useCallback(
    (characterId: string, refId: string) =>
      send({ type: "removeCharacterReference", characterId, refId }),
    [],
  );
  const getCharacterReference = useCallback(
    (refId: string): Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined> =>
      new Promise((resolve) => {
        const requestId = nextRefRequestId.current++;
        refRequests.current.set(requestId, resolve);
        send({ type: "getCharacterReference", refId, requestId });
      }),
    [],
  );
  const exportBible = useCallback(() => send({ type: "exportBible" }), []);
  const importBible = useCallback((json: string) => {
    setImportResult(undefined);
    send({ type: "importBible", json });
  }, []);
  const clearImportResult = useCallback(() => setImportResult(undefined), []);
  const carryOverBible = useCallback((fromBookId: string) => send({ type: "carryOverBible", fromBookId }), []);
  const paintForward = useCallback(
    (fromUnit: number) => send({ type: "paintForward", fromUnit }),
    [],
  );

  return {
    bible,
    results,
    status,
    bibleStatus,
    workflow,
    avgRenderMs,
    providers,
    generating,
    paused,
    openBook,
    startGeneration,
    pause,
    resume,
    pauseBible,
    resumeBible,
    pauseImages,
    resumeImages,
    regenerateStoryboard,
    regenerateAllImages,
    regenerateImage,
    rebuildPrompts,
    exportBible,
    importBible,
    importResult,
    clearImportResult,
    carryOverBible,
    updateCharacter,
    addCharacterReference,
    removeCharacterReference,
    getCharacterReference,
    paintForward,
  };
}

/** Trigger a browser download of a JSON string. */
function downloadJson(json: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
