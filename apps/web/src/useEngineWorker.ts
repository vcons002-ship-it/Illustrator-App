import { useCallback, useEffect, useRef, useState } from "react";
import type { BookSource, ImageResult, VisualBible } from "@visual-reader/core";
import type { ReaderSettings } from "@visual-reader/ui";
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
  openBook: (book: BookSource) => void;
  goTo: (pageIndex: number) => void;
  prerenderAll: () => void;
}

export function useEngineWorker(settings: ReaderSettings): EngineWorkerApi {
  const workerRef = useRef<Worker | undefined>(undefined);
  const lastBook = useRef<BookSource | undefined>(undefined);
  const [bible, setBible] = useState<VisualBible | undefined>();
  const [results, setResults] = useState<Map<number, ImageResult>>(new Map());
  const [status, setStatus] = useState("");

  const send = (msg: MainToWorker, transfer: Transferable[] = []) =>
    workerRef.current?.postMessage(msg, transfer);

  useEffect(() => {
    const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
      const msg = event.data;
      switch (msg.type) {
        case "status":
          setStatus(msg.message);
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

  // Apply settings; re-open the current book so new keys/tier take effect.
  useEffect(() => {
    send({ type: "init", settings });
    if (lastBook.current) {
      setResults(new Map());
      send({ type: "open", book: lastBook.current });
    }
  }, [settings]);

  const openBook = useCallback(
    (book: BookSource) => {
      lastBook.current = book;
      setBible(undefined);
      setResults(new Map());
      send({ type: "init", settings });
      send({ type: "open", book });
    },
    [settings],
  );

  const goTo = useCallback((pageIndex: number) => send({ type: "goto", pageIndex }), []);
  const prerenderAll = useCallback(() => send({ type: "prerenderAll" }), []);

  return { bible, results, status, openBook, goTo, prerenderAll };
}
