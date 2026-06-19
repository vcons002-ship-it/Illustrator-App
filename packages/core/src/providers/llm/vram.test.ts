import { describe, it, expect } from "vitest";
import {
  parseParamsB,
  estimateModelVramGb,
  comboVramGb,
  combFitsCard,
  RECOMMENDED_WORKER_COMBOS,
} from "./vram.js";

describe("parseParamsB", () => {
  it("reads a plain param count", () => {
    expect(parseParamsB("Qwen/Qwen3-4B")).toBe(4);
    expect(parseParamsB("qwen3:4b")).toBe(4);
  });
  it("takes the TOTAL params of an MoE id, not the active count", () => {
    expect(parseParamsB("Qwen3-30B-A3B")).toBe(30);
  });
  it("ignores version-like numbers without a B suffix", () => {
    expect(parseParamsB("Llama-3.1-8B")).toBe(8);
    expect(parseParamsB("Qwen3-1.7B")).toBeCloseTo(1.7);
  });
  it("returns undefined for an opaque alias", () => {
    expect(parseParamsB("my-local-model")).toBeUndefined();
    expect(parseParamsB("")).toBeUndefined();
  });
});

describe("estimateModelVramGb", () => {
  it("estimates Q4 by default and scales with quant", () => {
    const q4 = estimateModelVramGb("Qwen3-4B");
    const fp16 = estimateModelVramGb("Qwen3-4B", "fp16");
    expect(q4).toBeDefined();
    expect(fp16).toBeDefined();
    expect(fp16!).toBeGreaterThan(q4!);
  });
  it("puts a 4B worker in single-digit GB and a 30B main under ~20 GB at Q4", () => {
    expect(estimateModelVramGb("Qwen3-4B")!).toBeLessThan(5);
    expect(estimateModelVramGb("Qwen3-30B-A3B")!).toBeLessThan(20);
  });
  it("returns undefined when params can't be read", () => {
    expect(estimateModelVramGb("mystery")).toBeUndefined();
  });
});

describe("comboVramGb", () => {
  it("sums main + worker when both are known", () => {
    const c = comboVramGb("Qwen3-30B-A3B", "Qwen3-4B");
    expect(c.mainGb).toBeDefined();
    expect(c.workerGb).toBeDefined();
    expect(c.totalGb).toBeCloseTo(c.mainGb! + c.workerGb!, 1);
  });
  it("totals over only the known side when one id is blank/unknown", () => {
    const c = comboVramGb("", "Qwen3-4B");
    expect(c.mainGb).toBeUndefined();
    expect(c.totalGb).toBe(c.workerGb);
  });
  it("is empty when nothing is known", () => {
    expect(comboVramGb("", "")).toEqual({});
  });
});

describe("combFitsCard", () => {
  it("fits the recommended 30B+4B combo on a 32 GB card with KV headroom", () => {
    const c = comboVramGb("Qwen3-30B-A3B", "Qwen3-4B");
    const v = combFitsCard(c.totalGb, 32);
    expect(v.fits).toBe(true);
    expect(v.headroomGb).toBeGreaterThan(2);
  });
  it("does not fit two big models on one card", () => {
    const c = comboVramGb("Qwen3-30B-A3B", "Qwen3-30B-A3B");
    expect(combFitsCard(c.totalGb, 32).fits).toBe(false);
  });
  it("treats unknown total as not-fitting", () => {
    expect(combFitsCard(undefined, 32).fits).toBe(false);
  });
});

describe("RECOMMENDED_WORKER_COMBOS", () => {
  it("are all real, parseable, and fit a 32 GB card", () => {
    expect(RECOMMENDED_WORKER_COMBOS.length).toBeGreaterThan(0);
    for (const combo of RECOMMENDED_WORKER_COMBOS) {
      const c = comboVramGb(combo.main, combo.worker);
      expect(c.totalGb).toBeDefined();
      expect(combFitsCard(c.totalGb, 32).fits).toBe(true);
    }
  });
});
