/**
 * Pure derivation of a single "what's downloading right now" list from the host's existing download
 * state. The app tracks model/checkpoint/LoRA/video downloads in one `modelProgress` map (0..100, keyed
 * by catalog id or filename) with an optional `downloadStage` label for split-file models, and Ollama
 * text-model pulls in a separate `pullProgress` map. This folds all of them into one normalized list so a
 * single status surface can show every in-flight download regardless of kind. PURE (no React, no I/O).
 */
export interface DownloadStatusItem {
  /** The underlying state key (catalog id / filename / ollama model name). */
  key: string;
  /** Friendly label for display (resolved from a catalog, else the key itself). */
  label: string;
  /** 0..100. */
  percent: number;
  /** Split-file progress note, e.g. "file 2/4: …" (model downloads only). */
  stage?: string;
  /** Free-text status, e.g. Ollama's "pulling manifest" (text-model pulls only). */
  detail?: string;
  kind: "model" | "text-model";
}

export interface DownloadStatusInput {
  /** Model/checkpoint/LoRA/video progress, 0..100, keyed by catalog id or filename. */
  modelProgress: Record<string, number>;
  /** Optional split-file stage label keyed the same as modelProgress. */
  downloadStage?: Record<string, string>;
  /** Ollama text-model pulls (cleared on completion). */
  pullProgress?: Record<string, { status: string; percent?: number }>;
  /** Friendly label for a model key (catalog lookup); falls back to the key when undefined. */
  labelFor?: (key: string) => string | undefined;
  /** Keys to suppress — e.g. the per-file children of a multi-file model already shown by its parent row. */
  hideKey?: (key: string) => boolean;
}

const clamp = (n: number): number => (n < 0 ? 0 : n > 100 ? 100 : n);

/**
 * The currently-active downloads, model rows first (sorted by label) then text-model pulls. A model entry
 * that has reached 100 is treated as finished and omitted (the host leaves completed entries at 100 in the
 * map); text-model pulls are always shown while present since the host deletes them on completion.
 */
export function activeDownloads(input: DownloadStatusInput): DownloadStatusItem[] {
  const { modelProgress, downloadStage = {}, pullProgress = {}, labelFor, hideKey } = input;
  const models: DownloadStatusItem[] = [];
  for (const [key, percent] of Object.entries(modelProgress)) {
    if (percent >= 100) continue; // completed downloads linger at 100 — only surface in-flight ones
    if (hideKey?.(key)) continue; // child files folded under their parent's row
    const stage = downloadStage[key];
    models.push({
      key,
      label: labelFor?.(key) || key,
      percent: clamp(percent),
      ...(stage ? { stage } : {}),
      kind: "model",
    });
  }
  models.sort((a, b) => a.label.localeCompare(b.label));
  const texts: DownloadStatusItem[] = [];
  for (const [key, p] of Object.entries(pullProgress)) {
    texts.push({
      key,
      label: labelFor?.(key) || key,
      percent: typeof p.percent === "number" ? clamp(p.percent) : 0,
      ...(p.status ? { detail: p.status } : {}),
      kind: "text-model",
    });
  }
  texts.sort((a, b) => a.label.localeCompare(b.label));
  return [...models, ...texts];
}
