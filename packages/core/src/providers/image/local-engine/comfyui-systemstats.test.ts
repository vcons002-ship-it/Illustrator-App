import { describe, expect, it } from "vitest";
import { ComfyUIBackend, parseNvidiaVramCsv, parseSystemStats, summarizeVram } from "./comfyui-backend.js";
import type { Transport, TransportRequest, TransportResponse } from "../../transport/transport.js";

/** A canned /system_stats payload shaped like ComfyUI's real response. */
const SYSTEM_STATS = {
  system: { os: "posix", comfyui_version: "0.3.0" },
  devices: [
    {
      name: "cuda:0 NVIDIA GeForce RTX 4090",
      type: "cuda",
      index: 0,
      vram_total: 25_757_220_864,
      vram_free: 12_000_000_000,
      torch_vram_total: 1_000_000_000,
      torch_vram_free: 500_000_000,
    },
  ],
};

/** Minimal transport that returns a fixed JSON for any GET and records the URLs it saw. */
function jsonTransport(payload: unknown, opts: { ok?: boolean } = {}): { transport: Transport; urls: string[] } {
  const urls: string[] = [];
  const transport: Transport = {
    async send(req: TransportRequest): Promise<TransportResponse> {
      urls.push(req.url);
      return {
        ok: opts.ok ?? true,
        status: opts.ok === false ? 500 : 200,
        json: <T>() => Promise.resolve(payload as T),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        text: () => Promise.resolve(JSON.stringify(payload)),
      };
    },
  };
  return { transport, urls };
}

describe("parseSystemStats", () => {
  it("extracts per-device VRAM totals (bytes)", () => {
    const devices = parseSystemStats(SYSTEM_STATS);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toEqual({
      name: "cuda:0 NVIDIA GeForce RTX 4090",
      vramTotal: 25_757_220_864,
      vramFree: 12_000_000_000,
    });
  });

  it("drops devices without a positive numeric total (e.g. a CPU device)", () => {
    const devices = parseSystemStats({
      devices: [
        { name: "cpu", type: "cpu", vram_total: 0, vram_free: 0 },
        { name: "cuda:0", vram_total: 8_000_000_000, vram_free: 4_000_000_000 },
      ],
    });
    expect(devices.map((d) => d.name)).toEqual(["cuda:0"]);
  });

  it("clamps free to [0, total] and defaults free to 0 when unreported", () => {
    const devices = parseSystemStats({
      devices: [
        { name: "g1", vram_total: 100, vram_free: 250 }, // over-reported free
        { name: "g2", vram_total: 100 }, // no free field
      ],
    });
    expect(devices[0]).toMatchObject({ vramFree: 100 });
    expect(devices[1]).toMatchObject({ vramFree: 0 });
  });

  it("returns [] for a missing/garbage payload instead of throwing", () => {
    expect(parseSystemStats(undefined)).toEqual([]);
    expect(parseSystemStats(null)).toEqual([]);
    expect(parseSystemStats({})).toEqual([]);
    expect(parseSystemStats({ devices: "nope" })).toEqual([]);
    expect(parseSystemStats("garbage")).toEqual([]);
  });
});

describe("summarizeVram", () => {
  it("reports total + used (MB) and the single GPU's short name", () => {
    const summary = summarizeVram(parseSystemStats(SYSTEM_STATS));
    // 25,757,220,864 B ≈ 24564 MB total; used = total − free (12 GB).
    expect(summary).toEqual({
      totalMb: Math.round(25_757_220_864 / (1024 * 1024)),
      usedMb: Math.round((25_757_220_864 - 12_000_000_000) / (1024 * 1024)),
      device: "NVIDIA GeForce RTX 4090", // cuda:0 prefix stripped
    });
  });

  it("sums multiple GPUs and labels the device count", () => {
    const summary = summarizeVram([
      { name: "cuda:0 A", vramTotal: 8_000_000_000, vramFree: 2_000_000_000 },
      { name: "cuda:1 B", vramTotal: 8_000_000_000, vramFree: 6_000_000_000 },
    ]);
    expect(summary?.device).toBe("2 GPUs");
    expect(summary?.totalMb).toBe(Math.round(16_000_000_000 / (1024 * 1024)));
    expect(summary?.usedMb).toBe(Math.round(8_000_000_000 / (1024 * 1024))); // 16GB total − 8GB free
  });

  it("returns undefined when there are no GPU devices", () => {
    expect(summarizeVram([])).toBeUndefined();
    expect(summarizeVram(parseSystemStats({ devices: [{ name: "cpu", vram_total: 0 }] }))).toBeUndefined();
  });
});

describe("parseNvidiaVramCsv (whole-GPU usage, includes the LLM)", () => {
  const MB = 1024 * 1024;

  it("parses 'name, totalMb, usedMb' lines into per-device byte stats", () => {
    const stats = parseNvidiaVramCsv("NVIDIA GeForce RTX 4090, 24564, 9000\n");
    expect(stats).toEqual([
      { name: "NVIDIA GeForce RTX 4090", vramTotal: 24564 * MB, vramFree: (24564 - 9000) * MB },
    ]);
    // used = total − free, so summarizeVram reports the nvidia-smi `used` figure straight through.
    expect(summarizeVram(stats)?.usedMb).toBe(9000);
  });

  it("handles multiple GPUs and skips blank lines", () => {
    const stats = parseNvidiaVramCsv("GPU0, 8000, 2000\n\nGPU1, 8000, 6000\n");
    expect(stats).toHaveLength(2);
    expect(summarizeVram(stats)).toMatchObject({ totalMb: 16000, usedMb: 8000, device: "2 GPUs" });
  });

  it("clamps used to [0, total] and keeps a GPU name that contains commas", () => {
    // A pathological name with a comma: the LAST two CSV fields are total/used, the rest is the name.
    const stats = parseNvidiaVramCsv("Fancy, Card, 4096, 5000");
    expect(stats[0]).toEqual({ name: "Fancy, Card", vramTotal: 4096 * MB, vramFree: 0 });
  });

  it("skips unparseable rows and yields [] for empty/garbage input", () => {
    expect(parseNvidiaVramCsv("")).toEqual([]);
    expect(parseNvidiaVramCsv("no driver running")).toEqual([]);
    expect(parseNvidiaVramCsv("GPU, abc, def")).toEqual([]);
    expect(parseNvidiaVramCsv("GPU, 0, 0")).toEqual([]); // zero total → not a real device
  });
});

describe("ComfyUIBackend.systemStats", () => {
  it("GETs /system_stats and returns the parsed devices", async () => {
    const { transport, urls } = jsonTransport(SYSTEM_STATS);
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188/", transport });
    const devices = await backend.systemStats();
    expect(urls).toContain("http://127.0.0.1:8188/system_stats");
    expect(devices[0]).toMatchObject({ vramTotal: 25_757_220_864 });
  });

  it("returns [] (never throws) when the engine errors or is unreachable", async () => {
    const errBackend = new ComfyUIBackend({
      baseUrl: "http://127.0.0.1:8188",
      transport: {
        async send(): Promise<TransportResponse> {
          throw new Error("ECONNREFUSED");
        },
      },
    });
    expect(await errBackend.systemStats()).toEqual([]);

    const { transport } = jsonTransport(SYSTEM_STATS, { ok: false });
    const downBackend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport });
    expect(await downBackend.systemStats()).toEqual([]);
  });
});
