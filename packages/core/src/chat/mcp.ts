import type { Transport } from "../providers/transport/transport.js";

/**
 * MCP (Model Context Protocol) client — lets the buddy call tools exposed by the user's own
 * **MCP servers**, so it inherits a whole ecosystem of integrations without us hand-coding each.
 * This targets **HTTP / "streamable HTTP" servers** (JSON-RPC 2.0 over POST, answered as JSON or
 * SSE) reachable through the app's CORS-exempt transport — no Rust needed. The pure JSON-RPC
 * builders + parsers + server-config parsing are unit-tested; the network fns take an injected
 * Transport. (stdio servers — which need a spawned process — are a desktop follow-up.)
 */

export interface McpServer {
  name: string;
  url: string;
}
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Parse the Settings "MCP servers" text — one server per line: `name https://host/mcp`. */
export function parseMcpServers(text: string | undefined): McpServer[] {
  if (!text) return [];
  const out: McpServer[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^\s=]+)\s*[=\s]\s*(https?:\/\/\S+?)\s*$/.exec(line);
    if (m && !out.some((s) => s.name === m[1])) out.push({ name: m[1]!, url: m[2]! });
  }
  return out;
}

let rpcId = 0;
/** A JSON-RPC 2.0 request envelope. */
export function buildJsonRpc(method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: ++rpcId, method, ...(params !== undefined ? { params } : {}) };
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** Unwrap a JSON-RPC response — returns `result`, throws the server's error message. */
export function parseJsonRpcResult(json: unknown): unknown {
  const r = json as JsonRpcResponse;
  if (r && r.error) throw new Error(r.error.message || `MCP error ${r.error.code ?? ""}`);
  return r?.result;
}

/** A streamable-HTTP body may be plain JSON or SSE (`data: {json}`); accept both. */
export function parseMaybeSse(body: string): unknown {
  const t = body.trim();
  if (!t) return {};
  if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(t);
  const data = t
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  const last = data[data.length - 1];
  return last ? JSON.parse(last) : {};
}

/** The tools from a `tools/list` result, normalised. */
export function parseToolsList(result: unknown): McpTool[] {
  const tools = (result as { tools?: unknown[] })?.tools;
  if (!Array.isArray(tools)) return [];
  const out: McpTool[] = [];
  for (const t of tools) {
    const o = t as Record<string, unknown>;
    if (typeof o.name !== "string") continue;
    out.push({
      name: o.name,
      ...(typeof o.description === "string" ? { description: o.description } : {}),
      ...(o.inputSchema ? { inputSchema: o.inputSchema } : {}),
    });
  }
  return out;
}

/** Pull the text out of a `tools/call` result (content: [{type:"text", text}, …]). */
export function parseToolCallText(result: unknown): string {
  const content = (result as { content?: unknown[] })?.content;
  if (!Array.isArray(content)) return typeof result === "string" ? result : JSON.stringify(result ?? {});
  return content
    .map((c) => {
      const o = c as Record<string, unknown>;
      return o.type === "text" && typeof o.text === "string" ? o.text : JSON.stringify(o);
    })
    .join("\n")
    .trim();
}

/** A compact, model-facing listing of a server's tools for the system prompt / a tool result. */
export function formatMcpTools(server: string, tools: readonly McpTool[]): string {
  if (tools.length === 0) return `[mcp ${server}: no tools]`;
  const rows = tools.map((t) => `· ${t.name}${t.description ? ` — ${t.description}` : ""}`).join("\n");
  return `[mcp ${server} — ${tools.length} tools]\n${rows}`;
}

async function rpc(transport: Transport, url: string, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
  const res = await transport.send({
    url,
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: buildJsonRpc(method, params),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`MCP ${method} failed (HTTP ${res.status})`);
  return parseJsonRpcResult(parseMaybeSse(await res.text()));
}

/** List a server's tools (best-effort handshake first; some servers don't require it). */
export async function mcpListTools(transport: Transport, url: string, signal?: AbortSignal): Promise<McpTool[]> {
  try {
    await rpc(transport, url, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "VisualReader", version: "1.0" } }, signal);
  } catch {
    /* stateless server — proceed straight to tools/list */
  }
  return parseToolsList(await rpc(transport, url, "tools/list", {}, signal));
}

/** Call a tool and return its text output. */
export async function mcpCallTool(
  transport: Transport,
  url: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  return parseToolCallText(await rpc(transport, url, "tools/call", { name, arguments: args }, signal));
}
