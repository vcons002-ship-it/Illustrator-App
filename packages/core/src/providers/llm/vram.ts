/**
 * VRAM ESTIMATOR — a small, honest "will this LLM combo fit on my GPU?" helper for the worker-tier
 * router settings. It is deliberately ROUGH: it reads the parameter count out of a model id
 * (e.g. "Qwen/Qwen3-4B" → 4B, "Qwen3-30B-A3B" → 30B total) and multiplies by bytes-per-parameter
 * for the quantization. Weights dominate; we add a small fixed runtime/KV-cache headroom so the
 * number errs slightly high rather than low. This is NOT a precise allocator — actual usage depends
 * on context length, batch size (concurrent sub-agents), and the serving engine — but it is good
 * enough to tell "a 4B worker next to a 30B main fits a 32 GB card" from "two 30B models won't".
 */

/** Quantization presets → bytes per weight parameter (incl. a little format overhead). */
export type Quant = "q4" | "q8" | "fp16";
const BYTES_PER_PARAM: Record<Quant, number> = { q4: 0.55, q8: 1.06, fp16: 2.1 };

/** Fixed per-model runtime + minimal KV-cache headroom, in GB. Concurrency/long context add more. */
const RUNTIME_OVERHEAD_GB = 1.0;

/**
 * Pull the TOTAL parameter count (in billions) out of a model id. Matches every `<number>B` token
 * and takes the LARGEST, which is the total parameter count for both dense ("8B") and MoE
 * ("30B-A3B" → 30, not the 3B active) models — MoE active-params affect speed, not VRAM. Returns
 * `undefined` when no `<n>B` token is present (e.g. an opaque endpoint alias).
 */
export function parseParamsB(modelId: string): number | undefined {
  const matches = modelId.match(/(\d+(?:\.\d+)?)\s*[Bb]\b/g);
  if (!matches) return undefined;
  let max = 0;
  for (const m of matches) {
    const n = parseFloat(m);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? max : undefined;
}

/**
 * Estimate the VRAM (GB) a single model needs to be served at `quant` (default Q4). `undefined` when
 * the param count can't be read from the id. Rounded to one decimal.
 */
export function estimateModelVramGb(modelId: string, quant: Quant = "q4"): number | undefined {
  const b = parseParamsB(modelId);
  if (b === undefined) return undefined;
  const gb = b * BYTES_PER_PARAM[quant] + RUNTIME_OVERHEAD_GB;
  return Math.round(gb * 10) / 10;
}

/** A two-tier (main + worker) VRAM estimate. `total` is the sum of whichever parts are known. */
export interface ComboVram {
  mainGb?: number;
  workerGb?: number;
  totalGb?: number;
}

/** Estimate VRAM for a main+worker pair. Either id may be blank/unknown; totals over what's known. */
export function comboVramGb(mainId: string, workerId: string, quant: Quant = "q4"): ComboVram {
  const mainGb = mainId.trim() ? estimateModelVramGb(mainId, quant) : undefined;
  const workerGb = workerId.trim() ? estimateModelVramGb(workerId, quant) : undefined;
  const parts = [mainGb, workerGb].filter((x): x is number => x !== undefined);
  const out: ComboVram = {};
  if (mainGb !== undefined) out.mainGb = mainGb;
  if (workerGb !== undefined) out.workerGb = workerGb;
  if (parts.length > 0) out.totalGb = Math.round(parts.reduce((a, b) => a + b, 0) * 10) / 10;
  return out;
}

/** A curated two-tier recommendation for the worker-tier router (sized for a 32 GB card at Q4). */
export interface WorkerCombo {
  main: string;
  worker: string;
  note: string;
}

/** Recommended main+worker pairings, mirroring VLLM-SETUP.md. VRAM is computed, not hard-coded. */
export const RECOMMENDED_WORKER_COMBOS: readonly WorkerCombo[] = [
  { main: "Qwen3-30B-A3B", worker: "Qwen3-4B", note: "best quality; MoE main (~3B active = fast)" },
  { main: "Qwen3-14B", worker: "Qwen3-4B", note: "more headroom → higher worker concurrency" },
  { main: "Qwen3-14B", worker: "Qwen3-1.7B", note: "fastest fan-out for simple subtasks" },
];

/** Verdict for a given combo against a card's VRAM budget. `headroomGb` is what's left for KV cache. */
export function combFitsCard(totalGb: number | undefined, cardGb: number): { fits: boolean; headroomGb: number } {
  if (totalGb === undefined) return { fits: false, headroomGb: cardGb };
  const headroomGb = Math.round((cardGb - totalGb) * 10) / 10;
  // Want real room left for KV cache / concurrency, not a razor-thin fit.
  return { fits: headroomGb >= 2, headroomGb };
}
