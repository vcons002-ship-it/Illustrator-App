import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComfyUIBackend } from "./comfyui-backend.js";
import type { WanVideoFiles } from "../image-provider.js";
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

  it("does NOT retry a thrown network error (can't prove the render wasn't already enqueued)", async () => {
    // A thrown error carries no Response, so we can't tell a pre-send failure from a response-read loss
    // AFTER ComfyUI already accepted + enqueued the job — resending would double-render. It surfaces
    // instead, after exactly one attempt.
    let attempts = 0;
    const { transport, calls } = routedTransport({
      "/prompt": () => {
        attempts++;
        throw new Error("socket hang up");
      },
    });
    const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 0 });
    await expect(backend.generate(INPUT, "model.safetensors")).rejects.toThrow(/socket hang up/);
    expect(attempts).toBe(1);
    expect(calls.filter((c) => c.url === `${BASE}/prompt`)).toHaveLength(1);
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

describe("ComfyUIBackend.generateVideo VRAM residency (long-form warmBatch)", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Text-to-video (no source image) so no /upload/image round-trip is needed.
  const wanModels: WanVideoFiles = {
    kind: "wan-i2v",
    highNoise: "wan_high.safetensors",
    lowNoise: "wan_low.safetensors",
    textEncoder: "umt5.safetensors",
    vae: "wan_vae.safetensors",
  };
  const VID_HISTORY = { p1: { outputs: { "113": { images: [{ filename: "vid.webp", subfolder: "", type: "output" }] } } } };
  const routes = (): Record<string, Route> => ({
    "/prompt": res({ prompt_id: "p1" }),
    "/history/p1": res(VID_HISTORY),
    "/view": bytesRes(new Uint8Array([1]).buffer),
    "/free": res({}),
  });

  it("frees the video model after a single clip (keepResident unset)", async () => {
    const { transport, urls } = routedTransport(routes());
    const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 0 });
    const out = await backend.generateVideo({ prompt: "pan across the valley" }, wanModels);
    expect(out.mimeType).toBe("image/webp"); // extension-derived MIME (SaveAnimatedWEBP)
    // The large video model is handed back so a chat LLM can reload.
    expect(urls()).toContain(`${BASE}/free`);
  });

  it("keeps the model resident between clips (keepResident: true skips the post-render /free)", async () => {
    const { transport, urls } = routedTransport(routes());
    const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 0 });
    await backend.generateVideo({ prompt: "next clip continues the motion", keepResident: true }, wanModels);
    // No /free — the orchestrator keeps the ~30 GB model loaded and frees ONCE after the last clip.
    expect(urls()).not.toContain(`${BASE}/free`);
  });
});

describe("a split-file model's component lookup recovers from a not-yet-ready engine", () => {
  /** `/object_info/<node>` shaped as ComfyUI returns it: a combo input is `[[...options], meta]`. */
  const nodeInfo = (node: string, key: string, options: string[]) =>
    res({ [node]: { input: { required: { [key]: [options, {}] } } } });

  it("waits for an engine that reports nothing at all, then renders", async () => {
    // "No encoders AND no VAEs" isn't a state a split-file family can render from, so it means the
    // engine hasn't finished scanning — not that the files are missing. Failing there reported two
    // folders whose contents were on disk the whole time.
    vi.useFakeTimers();
    try {
      let ready = false;
      // A cold engine reports NOTHING anywhere — no checkpoints, no UNETs, no encoders, no VAEs.
      // That's the signature this waits on; an engine that can name its models has scanned.
      const { transport } = routedTransport({
        "/object_info/CLIPLoader": () =>
          nodeInfo("CLIPLoader", "clip_name", ready ? ["mistral_small_flux2.safetensors"] : []),
        "/object_info/VAELoader": () =>
          nodeInfo("VAELoader", "vae_name", ready ? ["flux2-vae.safetensors"] : []),
        "/object_info/UNETLoader": () =>
          nodeInfo("UNETLoader", "unet_name", ready ? ["flux2-dev.safetensors"] : []),
        "/object_info/CheckpointLoaderSimple": () => nodeInfo("CheckpointLoaderSimple", "ckpt_name", []),
      });
      const backend = new ComfyUIBackend({ baseUrl: BASE, transport });
      const attempt = backend
        .generate({ ...INPUT, modelFamily: "flux2" as const }, "flux2-dev.safetensors")
        .catch((e: unknown) => e);
      // Engine finishes starting while we're waiting.
      await vi.advanceTimersByTimeAsync(4_000);
      ready = true;
      await vi.advanceTimersByTimeAsync(4_000);
      const err = await attempt;
      // It got past the component lookup (and then failed on the unrouted /prompt submit).
      expect(String(err)).not.toMatch(/text encoder/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads the file lists after a failure instead of failing all session", async () => {
    // An EMPTY list is a successful response, so it was cached like any other — and the engine
    // reports empty while it is still scanning its models folder. A few seconds of bad timing
    // (the app relaunching itself to update is exactly that) turned into a whole session of
    // "needs a text encoder" with the files sitting on disk.
    let ready = false;
    const { transport } = routedTransport({
      // A NON-empty VAE list throughout: the engine is up and scanned, it's the encoder that's
      // missing — a real configuration error, which must fail fast rather than wait.
      "/object_info/CLIPLoader": () =>
        nodeInfo("CLIPLoader", "clip_name", ready ? ["mistral_small_flux2.safetensors"] : []),
      "/object_info/VAELoader": () => nodeInfo("VAELoader", "vae_name", ["flux2-vae.safetensors"]),
      "/object_info/UNETLoader": () => nodeInfo("UNETLoader", "unet_name", ["flux2-dev.safetensors"]),
      "/object_info/CheckpointLoaderSimple": () => nodeInfo("CheckpointLoaderSimple", "ckpt_name", []),
    });
    const backend = new ComfyUIBackend({ baseUrl: BASE, transport });
    const input = { ...INPUT, modelFamily: "flux2" as const };

    await expect(backend.generate(input, "flux2-dev.safetensors")).rejects.toThrow(/text encoder/i);
    // The engine finishes starting; the very next attempt must see the files.
    ready = true;
    await expect(backend.generate(input, "flux2-dev.safetensors")).rejects.not.toThrow(/text encoder/i);
  });
});

describe("an explicit component choice is honoured or reported, never quietly replaced", () => {
  const nodeInfo2 = (node: string, key: string, options: string[]) =>
    res({ [node]: { input: { required: { [key]: [options, {}] } } } });

  /** Two Flux.2 encoders installed: the auto-detected one and the one the reader switched TO. */
  const twoEncoders = (extra: Record<string, () => TransportResponse> = {}) =>
    routedTransport({
      "/object_info/CLIPLoader": () =>
        nodeInfo2("CLIPLoader", "clip_name", ["mistral_small_flux2.safetensors", "mistral_small_flux2_fp8.safetensors"]),
      "/object_info/VAELoader": () => nodeInfo2("VAELoader", "vae_name", ["flux2-vae.safetensors"]),
      "/object_info/UNETLoader": () => nodeInfo2("UNETLoader", "unet_name", ["flux2-dev.safetensors"]),
      "/object_info/CheckpointLoaderSimple": () => nodeInfo2("CheckpointLoaderSimple", "ckpt_name", []),
      "/prompt": () => res({ prompt_id: "p1" }),
      ...extra,
    });

  it("uses the chosen file, not the one the family pattern would have picked", async () => {
    const { transport, calls } = twoEncoders();
    const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 0, idleTimeoutMs: 1 });
    await backend
      .generate(
        { ...INPUT, modelFamily: "flux2" as const, textEncoder: "mistral_small_flux2_fp8.safetensors" },
        "flux2-dev.safetensors",
      )
      .catch(() => undefined); // the render itself is unrouted past /prompt; only the graph matters
    const submitted = calls.find((c) => c.url.endsWith("/prompt"));
    expect(JSON.stringify(submitted?.body)).toContain("mistral_small_flux2_fp8.safetensors");
  });

  it("says so when the chosen file isn't there, instead of falling back to detection", async () => {
    // The silent fallback is the dangerous one: Settings still shows the reader's choice while the
    // render quietly uses the file they switched AWAY from.
    const { transport } = twoEncoders();
    const backend = new ComfyUIBackend({ baseUrl: BASE, transport, pollIntervalMs: 0, idleTimeoutMs: 1 });
    await expect(
      backend.generate(
        { ...INPUT, modelFamily: "flux2" as const, textEncoder: "qwen_3_8b.safetensors" },
        "flux2-dev.safetensors",
      ),
    ).rejects.toThrow(/qwen_3_8b\.safetensors.*Settings/s);
  });
});
