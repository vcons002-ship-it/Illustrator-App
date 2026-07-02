import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComfyUIBackend } from "./comfyui-backend.js";
import type { Transport, TransportRequest, TransportResponse } from "../../transport/transport.js";

/**
 * Drives the generate() state machine end-to-end against a scripted transport:
 * submit → history poll (+ queue liveness) → /view image fetch, plus the failure
 * paths (submit retry, sustained outage, dropped prompt, execution error, cancel).
 */

const BASE = "http://127.0.0.1:8188";

function res(body: unknown, status = 200): TransportResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as TransportResponse;
}

function bytesRes(bytes: ArrayBuffer): TransportResponse {
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
    arrayBuffer: async () => bytes,
  } as unknown as TransportResponse;
}

type Step = TransportResponse | ((req: TransportRequest) => TransportResponse);
type Route = Step | Step[];

/** Routes requests by pathname; an array is consumed in order (its last step repeats).
 * A function step may throw to simulate a network failure. Records every request. */
function routedTransport(routes: Record<string, Route>): {
  transport: Transport;
  calls: TransportRequest[];
  urls: () => string[];
} {
  const calls: TransportRequest[] = [];
  const transport: Transport = {
    send: async (req) => {
      calls.push(req);
      const path = new URL(req.url).pathname;
      const route = routes[path];
      if (route === undefined) throw new Error(`unrouted request: ${req.method} ${path}`);
      const step = Array.isArray(route) ? (route.length > 1 ? route.shift()! : route[0]!) : route;
      return typeof step === "function" ? step(req) : step;
    },
  };
  return { transport, calls, urls: () => calls.map((c) => c.url) };
}

const FILE = { filename: "vr 1.png", subfolder: "sub", type: "output" };
const DONE_HISTORY = { p1: { outputs: { "9": { images: [FILE] } } } };
const RUNNING_QUEUE = { queue_running: [[0, "p1"]], queue_pending: [] };
const EMPTY_QUEUE = { queue_running: [], queue_pending: [] };
const INPUT = { prompt: "a cat by a window", anchors: [], quality: "standard" as const };

describe("ComfyUIBackend.generate state machine", () => {
  beforeEach(() => {
    // Node ships a global WebSocket — stub it away so the best-effort progress
    // socket never dials a real port (the backend treats "no WebSocket" as fine).
    vi.stubGlobal("WebSocket", undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("submits the workflow, polls history until done, then fetches the image bytes", async () => {
    const { transport, calls, urls } = routedTransport({
      "/prompt": res({ prompt_id: "p1" }),
      "/history/p1": [res({}), res(DONE_HISTORY)], // first poll: not done yet
      "/queue": res(RUNNING_QUEUE),
      "/view": bytesRes(new Uint8Array([7, 8, 9]).buffer),
    });
    const backend = new ComfyUIBackend({ baseUrl: `${BASE}/`, transport, pollIntervalMs: 0 });
    const progress: number[] = [];
    const out = await backend.generate({ ...INPUT, onProgress: (f) => progress.push(f) }, "model.safetensors");

    expect(new Uint8Array(out.bytes)).toEqual(new Uint8Array([7, 8, 9]));
    expect(out.mimeType).toBe("image/png");
    // The submit went first (trailing slash on the base URL was normalized away)
    // and carried the graph + our client id.
    const submit = calls[0]!;
    expect(submit.method).toBe("POST");
    expect(submit.url).toBe(`${BASE}/prompt`);
    const body = submit.body as { prompt: Record<string, { class_type?: string }>; client_id: string };
    expect(body.client_id).toBe("visual-reader");
    expect(body.prompt["3"]?.class_type).toBe("KSampler");
    // While unfinished, liveness came from the queue; history was re-polled to completion.
    expect(urls().filter((u) => u === `${BASE}/history/p1`)).toHaveLength(2);
    expect(urls()).toContain(`${BASE}/queue`);
    // The saved file's coordinates were URL-encoded into the final /view fetch.
    expect(urls()[urls().length - 1]).toBe(`${BASE}/view?filename=vr%201.png&subfolder=sub&type=output`);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it("retries the /prompt submit once after a 5xx, then renders normally", async () => {
    vi.useFakeTimers();
    const { transport, calls } = routedTransport({
      "/prompt": [res({ error: "busy" }, 502), res({ prompt_id: "p1" })],
      "/history/p1": res(DONE_HISTORY),
      "/view": bytesRes(new Uint8Array([1]).buffer),
    });
    const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 0 });
    const promise = backend.generate(INPUT, "model.safetensors");
    await vi.advanceTimersByTimeAsync(1_500); // the pause before the single resubmit
    vi.useRealTimers();
    const out = await promise;
    expect(new Uint8Array(out.bytes)).toEqual(new Uint8Array([1]));
    expect(calls.filter((c) => c.url === `${BASE}/prompt`)).toHaveLength(2);
  });

  it("retries the submit once after a network error too", async () => {
    vi.useFakeTimers();
    let first = true;
    const { transport, calls } = routedTransport({
      "/prompt": (req) => {
        void req;
        if (first) {
          first = false;
          throw new Error("socket hang up");
        }
        return res({ prompt_id: "p1" });
      },
      "/history/p1": res(DONE_HISTORY),
      "/view": bytesRes(new Uint8Array([2]).buffer),
    });
    const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 0 });
    const promise = backend.generate(INPUT, "model.safetensors");
    await vi.advanceTimersByTimeAsync(1_500);
    vi.useRealTimers();
    await expect(promise).resolves.toBeDefined();
    expect(calls.filter((c) => c.url === `${BASE}/prompt`)).toHaveLength(2);
  });

  it("does NOT retry a 4xx rejection and surfaces the error + node_errors detail", async () => {
    const { transport, calls } = routedTransport({
      "/prompt": res({ error: "invalid prompt", node_errors: { "3": { errors: ["bad input"] } } }, 400),
    });
    const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 0 });
    await expect(backend.generate(INPUT, "model.safetensors")).rejects.toThrow(
      /status 400.*invalid prompt.*node_errors/s,
    );
    expect(calls.filter((c) => c.url === `${BASE}/prompt`)).toHaveLength(1);
  });

  it("a second 5xx failure surfaces the submit error after exactly two attempts", async () => {
    vi.useFakeTimers();
    const { transport, calls } = routedTransport({
      "/prompt": res({ error: "cuda crashed" }, 500),
    });
    const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 0 });
    const promise = backend.generate(INPUT, "model.safetensors");
    const assertion = expect(promise).rejects.toThrow(/status 500.*cuda crashed/s);
    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;
    expect(calls.filter((c) => c.url === `${BASE}/prompt`)).toHaveLength(2);
  });

  it("tolerates the brief hand-off where the prompt is in neither history nor the queue", async () => {
    const { transport } = routedTransport({
      "/prompt": res({ prompt_id: "p1" }),
      "/history/p1": [res({}), res({}), res(DONE_HISTORY)], // history catches up within the grace window
      "/queue": res(EMPTY_QUEUE),
      "/view": bytesRes(new Uint8Array([5]).buffer),
    });
    const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 0 });
    const out = await backend.generate(INPUT, "model.safetensors");
    expect(new Uint8Array(out.bytes)).toEqual(new Uint8Array([5]));
  });

  it("fails once the prompt stays missing from both history and the queue past the grace window", async () => {
    const { transport, calls } = routedTransport({
      "/prompt": res({ prompt_id: "p1" }),
      "/history/p1": res({}),
      "/queue": res(EMPTY_QUEUE),
    });
    const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 0 });
    await expect(backend.generate(INPUT, "model.safetensors")).rejects.toThrow(/dropped the render/);
    // 8 grace polls + the failing 9th — it did NOT give up on the first miss.
    expect(calls.filter((c) => c.url === `${BASE}/queue`)).toHaveLength(9);
  });

  it("tolerates transient history blips (a hiccup never kills a working render)", async () => {
    const boom = (): TransportResponse => {
      throw new Error("fetch failed");
    };
    const { transport } = routedTransport({
      "/prompt": res({ prompt_id: "p1" }),
      "/history/p1": [boom, boom, res(DONE_HISTORY)],
      "/view": bytesRes(new Uint8Array([6]).buffer),
    });
    const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 0 });
    const out = await backend.generate(INPUT, "model.safetensors");
    expect(new Uint8Array(out.bytes)).toEqual(new Uint8Array([6]));
  });

  it("fails only after ComfyUI stays unreachable past idleTimeoutMs", async () => {
    const { transport, calls } = routedTransport({
      "/prompt": res({ prompt_id: "p1" }),
      "/history/p1": () => {
        throw new Error("fetch failed");
      },
    });
    const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 1, idleTimeoutMs: 25 });
    await expect(backend.generate(INPUT, "model.safetensors")).rejects.toThrow(
      /unreachable during the render/,
    );
    // It kept polling through the outage window rather than failing on the first hiccup.
    expect(calls.filter((c) => c.url === `${BASE}/history/p1`).length).toBeGreaterThan(2);
  });

  it("surfaces ComfyUI's real execution error when the render finished with no output", async () => {
    const failed = {
      p1: {
        outputs: {},
        status: {
          status_str: "error",
          messages: [
            ["execution_error", { exception_message: "CUDA out of memory", node_type: "KSampler", node_id: 3 }],
          ],
        },
      },
    };
    const { transport } = routedTransport({
      "/prompt": res({ prompt_id: "p1" }),
      "/history/p1": res(failed),
    });
    const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 0 });
    await expect(backend.generate(INPUT, "model.safetensors")).rejects.toThrow(
      /KSampler #3.*CUDA out of memory/s,
    );
  });

  it("cancel aborts the poll with an AbortError and tells ComfyUI to interrupt the job", async () => {
    const ctrl = new AbortController();
    const { transport, calls } = routedTransport({
      "/prompt": res({ prompt_id: "p1" }),
      "/history/p1": () => {
        ctrl.abort(); // the reader cancels mid-poll
        return res({});
      },
      "/queue": res(RUNNING_QUEUE),
      "/interrupt": res({}),
    });
    const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 0 });
    await expect(
      backend.generate({ ...INPUT, signal: ctrl.signal }, "model.safetensors"),
    ).rejects.toMatchObject({ name: "AbortError" });
    // The GPU is freed immediately: cancel POSTs /interrupt, not just an HTTP abort.
    expect(calls.some((c) => c.url === `${BASE}/interrupt` && c.method === "POST")).toBe(true);
  });

  it("low-VRAM frees the model after the render; the default keeps it warm", async () => {
    const routes = (): Record<string, Route> => ({
      "/prompt": res({ prompt_id: "p1" }),
      "/history/p1": res(DONE_HISTORY),
      "/view": bytesRes(new Uint8Array([1]).buffer),
      "/free": res({}),
    });
    {
      const { transport, calls, urls } = routedTransport(routes());
      const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 0 });
      await backend.generate({ ...INPUT, lowVram: true }, "model.safetensors");
      const freeIdx = urls().indexOf(`${BASE}/free`);
      const viewIdx = urls().findIndex((u) => u.startsWith(`${BASE}/view`));
      expect(freeIdx).toBeGreaterThan(viewIdx); // freed AFTER the image was collected
      expect(calls[freeIdx]!.body).toMatchObject({ unload_models: true, free_memory: true });
    }
    {
      const { transport, urls } = routedTransport(routes());
      const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 0 });
      await backend.generate(INPUT, "model.safetensors");
      expect(urls()).not.toContain(`${BASE}/free`);
    }
  });
});
