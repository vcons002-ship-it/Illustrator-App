import { describe, it, expect } from "vitest";
import { DirectTransport } from "./transport.js";

const okResponse = {
  ok: true,
  status: 200,
  json: async () => ({}),
  arrayBuffer: async () => new ArrayBuffer(0),
  text: async () => "",
} as unknown as Response;

describe("DirectTransport cancellation", () => {
  it("forwards an AbortSignal to fetch", async () => {
    let seen: AbortSignal | null | undefined;
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      seen = init?.signal;
      return okResponse;
    }) as unknown as typeof fetch;

    const t = new DirectTransport(fakeFetch);
    const ac = new AbortController();
    await t.send({ url: "http://x/y", method: "POST", body: {}, signal: ac.signal });
    expect(seen).toBe(ac.signal);
  });

  it("rejects when the signal aborts mid-request", async () => {
    const hangingFetch = (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;

    const t = new DirectTransport(hangingFetch);
    const ac = new AbortController();
    const pending = t.send({ url: "http://x", signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toThrow();
  });
});
