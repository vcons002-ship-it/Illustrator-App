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

describe("DirectTransport multipart", () => {
  it("builds FormData with text fields and multiple files (no JSON content-type)", async () => {
    let body: unknown;
    let headers: Record<string, string> | undefined;
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      body = init?.body;
      headers = init?.headers as Record<string, string>;
      return okResponse;
    }) as unknown as typeof fetch;

    const t = new DirectTransport(fakeFetch);
    await t.send({
      url: "http://x/images/edits",
      multipart: {
        fields: { prompt: "a knight", model: "gpt-image-1" },
        files: [
          { field: "image[]", bytes: new TextEncoder().encode("A").buffer, filename: "a.png", contentType: "image/png" },
          { field: "image[]", bytes: new TextEncoder().encode("B").buffer, filename: "b.png", contentType: "image/png" },
        ],
      },
    });

    expect(body).toBeInstanceOf(FormData);
    const fd = body as FormData;
    expect(fd.get("prompt")).toBe("a knight");
    expect(fd.getAll("image[]")).toHaveLength(2);
    // fetch must set the multipart boundary itself — we must NOT force application/json.
    expect(headers?.["content-type"]).toBeUndefined();
  });
});
