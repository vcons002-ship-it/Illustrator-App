import type { Transport } from "../providers/transport/transport.js";

/**
 * MCP (Model Context Protocol) client — lets the buddy call tools exposed by the user's own
 * **MCP servers**, so it inherits a whole ecosystem of integrations without us hand-coding each.
 * This targets **HTTP / "streamable HTTP" servers** (JSON-RPC 2.0 over POST, answered as JSON or
 * SSE) reachable through the app's CORS-exempt transport — no Rust needed. The pure JSON-RPC
 * builders + parsers + server-config parsing are unit-tested; the network fns take an injected
 * Transport. (stdio servers — which need a spawned process — are a desktop follow-up.)
 */

export type McpServer =
  | { name: string; kind: "http"; url: string }
  | { name: string; kind: "stdio"; command: string; args: string[] };
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Parse the Settings "MCP servers" text — one server per line:
 *   `name https://host/mcp`           → an HTTP / streamable-HTTP server, or
 *   `name npx -y @scope/server arg…`  → a stdio server (a local command the desktop spawns).
 * Whether the value starts with http(s):// decides the kind. Lines starting with # are comments.
 */
export function parseMcpServers(text: string | undefined): McpServer[] {
  if (!text) return [];
  const out: McpServer[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([^\s=]+)\s*(?:=\s*|\s+)(.+)$/.exec(line);
    if (!m) continue;
    const name = m[1]!;
    const rest = m[2]!.trim();
    if (out.some((s) => s.name === name)) continue;
    if (/^https?:\/\//i.test(rest)) {
      out.push({ name, kind: "http", url: rest.split(/\s+/)[0]! });
    } else {
      const parts = rest.split(/\s+/);
      out.push({ name, kind: "stdio", command: parts[0]!, args: parts.slice(1) });
    }
  }
  return out;
}

/** Ready-to-paste MCP server examples for the Settings field, so a reader can connect a
 * common integration (or see the exact line shape) without hunting for syntax. `line` is
 * literally what goes in the "MCP servers" box; stdio ones need the desktop app. Each `line`
 * round-trips through {@link parseMcpServers}. */
export interface McpPreset {
  /** Short label for the UI. */
  label: string;
  /** Whether it needs the desktop app (stdio spawns a local process). */
  desktopOnly: boolean;
  /** The exact settings line to add. */
  line: string;
  /** One-liner: what it gives the buddy. */
  hint: string;
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    label: "GitHub",
    desktopOnly: true,
    line: "github npx -y @modelcontextprotocol/server-github",
    hint: "Browse repos, issues, and PRs from chat (set GITHUB_TOKEN in the server's env).",
  },
  {
    label: "Filesystem",
    desktopOnly: true,
    line: "files npx -y @modelcontextprotocol/server-filesystem /path/to/folder",
    hint: "Give the buddy read/write access to one folder you choose.",
  },
  {
    label: "Unreal Engine",
    desktopOnly: true,
    line: "unreal python C:\\path\\to\\unreal-mcp\\server.py",
    hint: "Drive the Unreal Editor (spawn/edit actors, run Python) via a community Unreal MCP bridge — install its UE plugin + server, then point this at the server's launch command.",
  },
  {
    label: "HTTP server",
    desktopOnly: false,
    line: "myserver https://mcp.example.com/mcp",
    hint: "Any streamable-HTTP MCP server (works in the web app too — no desktop needed).",
  },
];

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

// ----------------------------------------------------------- stdio servers

/**
 * The newline-delimited JSON-RPC lines for a one-shot **stdio** exchange: `initialize` (id 1),
 * the `notifications/initialized` notification, then the real request (id 2). The desktop
 * transport writes these to the spawned server's stdin (one per line) and returns its stdout
 * lines; pick the id-2 response with `pickStdioResult`. Stateless per call — robust + simple.
 */
export function buildStdioExchange(method: string, params: unknown): { lines: string[]; resultId: number } {
  const init = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "VisualReader", version: "1.0" } },
  };
  const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
  const req = { jsonrpc: "2.0", id: 2, method, ...(params !== undefined ? { params } : {}) };
  return { lines: [JSON.stringify(init), JSON.stringify(initialized), JSON.stringify(req)], resultId: 2 };
}

/**
 * Find the JSON-RPC response with `id` among a stdio server's stdout lines (skipping log lines
 * and notifications) and unwrap its result — throwing the server's error, or a clear message
 * when there's no response at all.
 */
export function pickStdioResult(lines: readonly string[], id: number): unknown {
  for (const line of lines) {
    const t = line.trim();
    if (!t || t[0] !== "{") continue;
    try {
      const obj = JSON.parse(t) as { id?: number };
      if (obj.id === id) return parseJsonRpcResult(obj);
    } catch {
      /* a log line that happened to start with "{" — skip it */
    }
  }
  throw new Error("the MCP server returned no response (check the command, and that it's an MCP stdio server)");
}
