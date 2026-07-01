import { describe, expect, it } from "vitest";
import { Automatic1111Backend } from "./automatic1111-backend.js";
import type { Transport, TransportRequest, TransportResponse } from "../../transport/transport.js";

/** A transport that records every request and returns an empty-OK response. */
function recordingTransport(): { transport: Transport; calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  const res = {
    ok: true,
    status: 200,
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => "",
  } as unknown as TransportResponse;
  return { calls, transport: { send: async (r) => (calls.push(r), res) } };
}

describe("Automatic1111Backend.freeMemory", () => {
  it("unloads the checkpoint so a co-resident LLM can reclaim the GPU", async () => {
    const { transport, calls } = recordingTransport();
    const backend = new Automatic1111Backend({ baseUrl: "http://127.0.0.1:7860/", transport });
    await backend.freeMemory();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://127.0.0.1:7860/sdapi/v1/unload-checkpoint");
  });

  it("never throws when the server can't unload (older A1111 build)", async () => {
    const backend = new Automatic1111Backend({
      baseUrl: "http://127.0.0.1:7860",
      transport: { send: async () => { throw new Error("404 not found"); } },
    });
    await expect(backend.freeMemory()).resolves.toBeUndefined();
  });
});

describe("Automatic1111Backend reloads the checkpoint after an unload", () => {
  /** Records URLs and returns a valid txt2img image so generate() succeeds. */
  function txt2imgTransport(): { transport: Transport; urls: string[] } {
    const urls: string[] = [];
    const res = (body: unknown): TransportResponse =>
      ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0), text: async () => "" }) as unknown as TransportResponse;
    return {
      urls,
      transport: {
        send: async (r) => {
          urls.push(r.url);
          return r.url.endsWith("/txt2img") ? res({ images: ["AA=="] }) : res({});
        },
      },
    };
  }
  const input = { prompt: "a cat", anchors: [], quality: "standard" as const };

  it("reload-checkpoints BEFORE the next txt2img once freeMemory unloaded it", async () => {
    const { transport, urls } = txt2imgTransport();
    const base = "http://127.0.0.1:7899"; // unique base URL — the unloaded set is module-global
    const backend = new Automatic1111Backend({ baseUrl: base, transport });
    await backend.freeMemory(); // marks this base URL unloaded
    urls.length = 0;
    await backend.generate(input, "model.safetensors");
    // reload-checkpoint must be sent, and BEFORE the txt2img.
    const reloadIdx = urls.indexOf(`${base}/sdapi/v1/reload-checkpoint`);
    const txt2imgIdx = urls.indexOf(`${base}/sdapi/v1/txt2img`);
    expect(reloadIdx).toBeGreaterThanOrEqual(0);
    expect(reloadIdx).toBeLessThan(txt2imgIdx);
  });

  it("does NOT reload again on the next render (the successful render cleared the mark)", async () => {
    const { transport, urls } = txt2imgTransport();
    const base = "http://127.0.0.1:7898";
    const backend = new Automatic1111Backend({ baseUrl: base, transport });
    await backend.freeMemory();
    await backend.generate(input, "model.safetensors"); // reloads + clears the mark
    urls.length = 0;
    await backend.generate(input, "model.safetensors"); // second render: no reload
    expect(urls).not.toContain(`${base}/sdapi/v1/reload-checkpoint`);
  });
});

describe("Automatic1111Backend error messages", () => {
  /** A transport whose send() returns a non-OK response with the given JSON body. */
  function failing(status: number, body: unknown): Transport {
    const res = {
      ok: false,
      status,
      statusText: "Internal Server Error",
      json: async () => body,
      text: async () => JSON.stringify(body),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as TransportResponse;
    return { send: async () => res };
  }

  it("surfaces A1111's actual error body (not a bare status) on a 500 render", async () => {
    const backend = new Automatic1111Backend({
      baseUrl: "http://127.0.0.1:7860",
      transport: failing(500, { error: "OutOfMemoryError", detail: "CUDA out of memory" }),
    });
    await expect(
      backend.generate(
        { prompt: "a cat", anchors: [], quality: "standard" },
        "model.safetensors",
      ),
    ).rejects.toThrow(/OutOfMemoryError — CUDA out of memory/);
  });

  it("adds a checkpoint/OOM hint on a 500 so a stale model setting is diagnosable", async () => {
    const backend = new Automatic1111Backend({
      baseUrl: "http://127.0.0.1:7860",
      transport: failing(500, { detail: "model 'ghost.safetensors' not found" }),
    });
    await expect(
      backend.generate({ prompt: "a cat", anchors: [], quality: "standard" }, "ghost.safetensors"),
    ).rejects.toThrow(/check the selected model in Settings/);
  });
});
