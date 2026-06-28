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
