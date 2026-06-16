import { describe, expect, it } from "vitest";
import {
  buildJsonRpc,
  formatMcpTools,
  parseJsonRpcResult,
  parseMaybeSse,
  parseMcpServers,
  parseToolCallText,
  parseToolsList,
} from "./mcp.js";

describe("parseMcpServers", () => {
  it("parses name/url lines (space or =), dedupes, ignores junk", () => {
    const text = "weather https://w.example/mcp\ngithub=https://gh.example/mcp\n# note\nbad-line\nweather https://dup/mcp";
    expect(parseMcpServers(text)).toEqual([
      { name: "weather", url: "https://w.example/mcp" },
      { name: "github", url: "https://gh.example/mcp" },
    ]);
    expect(parseMcpServers(undefined)).toEqual([]);
  });
});

describe("JSON-RPC envelope + result", () => {
  it("builds a 2.0 request and unwraps result / throws error", () => {
    const req = buildJsonRpc("tools/list", { a: 1 });
    expect(req).toMatchObject({ jsonrpc: "2.0", method: "tools/list", params: { a: 1 } });
    expect(typeof req.id).toBe("number");
    expect(parseJsonRpcResult({ result: { tools: [] } })).toEqual({ tools: [] });
    expect(() => parseJsonRpcResult({ error: { code: -32601, message: "no method" } })).toThrow(/no method/);
  });
});

describe("parseMaybeSse", () => {
  it("reads plain JSON and the last SSE data line", () => {
    expect(parseMaybeSse('{"result":1}')).toEqual({ result: 1 });
    expect(parseMaybeSse('event: message\ndata: {"result":2}\n\n')).toEqual({ result: 2 });
    expect(parseMaybeSse("")).toEqual({});
  });
});

describe("tools list + call output", () => {
  it("normalises tools/list and extracts tools/call text", () => {
    const tools = parseToolsList({ tools: [{ name: "get_weather", description: "weather by city" }, { notname: 1 }] });
    expect(tools).toEqual([{ name: "get_weather", description: "weather by city" }]);
    expect(formatMcpTools("wx", tools)).toContain("get_weather — weather by city");
    expect(parseToolCallText({ content: [{ type: "text", text: "72F" }, { type: "text", text: "sunny" }] })).toBe("72F\nsunny");
    expect(parseToolCallText("plain")).toBe("plain");
  });
});
