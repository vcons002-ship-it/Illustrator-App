import { describe, expect, it } from "vitest";
import {
  buildJsonRpc,
  buildStdioExchange,
  formatMcpTools,
  parseJsonRpcResult,
  parseMaybeSse,
  parseMcpServers,
  parseToolCallText,
  parseToolsList,
  pickStdioResult,
  MCP_PRESETS,
} from "./mcp.js";

describe("parseMcpServers", () => {
  it("parses HTTP (url) and stdio (command) servers, dedupes, ignores comments/junk", () => {
    const text =
      "weather https://w.example/mcp\n" +
      "github=https://gh.example/mcp\n" +
      "files npx -y @modelcontextprotocol/server-filesystem /home/me\n" +
      "# a comment\n" +
      "\n" +
      "weather https://dup/mcp";
    expect(parseMcpServers(text)).toEqual([
      { name: "weather", kind: "http", url: "https://w.example/mcp" },
      { name: "github", kind: "http", url: "https://gh.example/mcp" },
      { name: "files", kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/me"] },
    ]);
    expect(parseMcpServers(undefined)).toEqual([]);
  });

  it("every MCP_PRESET line parses to exactly one server (incl. the Unreal stdio example)", () => {
    for (const p of MCP_PRESETS) {
      const parsed = parseMcpServers(p.line);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.kind).toBe(p.desktopOnly ? p.line.includes("://") ? "http" : "stdio" : "http");
    }
    const unreal = MCP_PRESETS.find((p) => p.label === "Unreal Engine")!;
    expect(parseMcpServers(unreal.line)[0]).toMatchObject({ name: "unreal", kind: "stdio", command: "python" });
  });
});

describe("stdio exchange", () => {
  it("builds the init + initialized + request lines and picks the id-2 result", () => {
    const { lines, resultId } = buildStdioExchange("tools/list", {});
    expect(resultId).toBe(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 1, method: "initialize" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ method: "notifications/initialized" });
    expect(JSON.parse(lines[2]!)).toMatchObject({ id: 2, method: "tools/list" });
    const stdout = [
      "starting server…", // a log line, ignored
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "read_file" }] } }),
    ];
    expect(parseToolsList(pickStdioResult(stdout, 2))).toEqual([{ name: "read_file" }]);
  });
  it("throws when there's no matching response", () => {
    expect(() => pickStdioResult(["log only"], 2)).toThrow(/no response/i);
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
