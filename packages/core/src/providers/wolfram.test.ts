import { describe, expect, it } from "vitest";
import { queryWolfram } from "./wolfram.js";
import type { Transport, TransportRequest, TransportResponse } from "./transport/transport.js";

function transport(status: number, body: string): Transport & { last?: TransportRequest } {
  const t: Transport & { last?: TransportRequest } = {
    send(req: TransportRequest): Promise<TransportResponse> {
      t.last = req;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: <T>() => Promise.reject(new Error("not json")) as Promise<T>,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        text: () => Promise.resolve(body),
      });
    },
  };
  return t;
}

describe("queryWolfram", () => {
  it("sends input + appid to the LLM API and returns the trimmed answer", async () => {
    const t = transport(200, "  Distance: about 384,400 km  \n");
    const out = await queryWolfram({ appId: "ABC-123", query: "distance to the moon", transport: t });
    expect(out).toBe("Distance: about 384,400 km");
    expect(t.last!.url).toContain("/api/v1/llm-api");
    expect(t.last!.url).toContain("appid=ABC-123");
    expect(t.last!.url).toContain("input=distance%20to%20the%20moon");
  });

  it("surfaces Wolfram's explanation text on a miss (non-OK)", async () => {
    const t = transport(501, "Wolfram|Alpha did not understand your input");
    await expect(queryWolfram({ appId: "k", query: "asdfgh", transport: t })).rejects.toThrow(
      /did not understand/,
    );
  });

  it("caps the answer to maxChars", async () => {
    const t = transport(200, "x".repeat(5000));
    const out = await queryWolfram({ appId: "k", query: "q", transport: t, maxChars: 100 });
    expect(out.length).toBe(100);
  });
});
