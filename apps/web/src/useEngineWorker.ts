import { useCallback, useEffect, useRef, useState } from "react";
import type { BookSource, ImageResult, VisualBible } from "@visual-reader/core";
import type { ProvidersDiagnostics, ReaderSettings } from "@visual-reader/ui";
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
  /** Which providers are live vs. silent mock fallbacks (undefined until first init). */
  providers: ProvidersDiagnostics | undefined;
  /** Whether generation has been started for the current book. */
  generating: boolean;
  openBook: (book: BookSource) => void;
  startGeneration: () => void;
  goTo: (pageIndex: number) => void;
  prerenderAll: () => void;
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
  const [providers, setProviders] = useState<ProvidersDiagnostics | undefined>();
  const [generating, setGenerating] = useState(false);

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
        case "opened":
          setBible(msg.bible);
          break;
        case "update":
          setResults((prev) => new Map(prev).set(msg.pageIndex, msg.result));
          break;
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
  const goTo = useCallback((pageIndex: number) => send({ type: "goto", pageIndex }), []);
  const prerenderAll = useCallback(() => send({ type: "prerenderAll" }), []);

  return { bible, results, status, providers, generating, openBook, startGeneration, goTo, prerenderAll };
}
