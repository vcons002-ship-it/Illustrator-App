import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBuddyTurn, runChatTurn, parseBuddyToolCall, parseToolCall, formatBuddyToolResult, formatToolResult, ollamaToolSchemas, inferDoneWhen, type ChatCapable } from "@visual-reader/core";
import { buildProviders } from "./buildProviders.js";
import { DEFAULT_SETTINGS } from "./SettingsPanel.js";

function llmScript(): ChatCapable {
  let n = 0;
  return { async chat() { return n++ === 0 ? '{"tool":"search_news","query":"ACME earnings","freshness":"day","domains":["sec.gov"]}' : "Here are the verified sources."; } };
}

describe("current research from settings through the app tool loops", () => {
  it("routes main chat news through the desktop CORS transport and back with provenance", async () => {
    const requests: { url: string; headers: Headers }[] = [];
    const built = buildProviders({ ...DEFAULT_SETTINGS, keys: { brave: "synthetic-key" } }, {
      corsFetch: async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response(JSON.stringify({ results: [{ url: "https://www.sec.gov/filing", title: "Earnings announcement", description: "Verified source text", page_age: "2026-10-17" }] }), { status: 200 });
      },
    });
    const outcome = await runBuddyTurn({
      llm: llmScript(), system: "Research current news", history: [],
      deps: {
        searchNews: (q, options) => built.imageSearch.searchNews!(q, 5, options),
        openLibraryBook: async () => { throw new Error("unused"); }, openWebText: async () => { throw new Error("unused"); },
        openPastedText: async () => { throw new Error("unused"); }, removeLibraryBook: async () => ({ removed: "unused" }), setVisualStyle: async () => ({}),
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/news/search?");
    expect(new URL(requests[0]!.url).searchParams.get("freshness")).toBe("pd");
    expect(requests[0]?.headers.get("X-Subscription-Token")).toBe("synthetic-key");
    const result = outcome.toolResults[0]!;
    expect(result.call.tool).toBe("search_news");
    expect(result.result.hits?.[0]).toMatchObject({ provider: "brave", sourceType: "news", publishedAt: "2026-10-17" });
    expect(outcome.transcript.some((m) => m.content.includes("provider: brave"))).toBe(true);
  });
  it("fails clearly without a news key and makes no Wikipedia or other network request", async () => {
    let calls = 0;
    const built = buildProviders({ ...DEFAULT_SETTINGS, keys: {} }, { corsFetch: async () => { calls++; throw new Error("must not fetch"); } });
    await expect(built.imageSearch.searchNews!("ACME today")).rejects.toThrow(/API key/);
    expect(calls).toBe(0);
  });
  it("also carries freshness, source dates and news failures through book chat", async () => {
    let seen: unknown;
    const outcome = await runChatTurn({
      llm: llmScript(), system: "Read current sources", history: [],
      tools: { searchNews: async (_q, options) => {
        seen = options;
        return [{ link: "https://www.sec.gov/filing", provider: "fixture", publishedAt: "2026-10-17", sourceType: "news" }];
      } },
    });
    expect(seen).toEqual({ freshness: "day", domains: ["sec.gov"] });
    expect(outcome.toolResults[0]?.call.tool).toBe("search_news");
    expect(outcome.transcript.some((m) => m.content.includes("2026-10-17"))).toBe(true);
  });
  it("independently selects Brave images when Tavily handles text", async () => {
    const requests: string[] = [];
    const built = buildProviders({ ...DEFAULT_SETTINGS, keys: { brave: "b", tavily: "t" }, webSearchProvider: "tavily", imageSearchProvider: "brave" }, {
      corsFetch: async (input) => { requests.push(String(input)); return new Response(JSON.stringify({ results: [{ url: "https://example.com/page", properties: { url: "https://example.com/image.png" } }] })); },
    });
    expect(built.searchBackend).toBe("tavily");
    expect((await built.imageSearch.search("reference"))[0]).toMatchObject({ link: "https://example.com/image.png", contextLink: "https://example.com/page" });
    expect(requests[0]).toContain("api.search.brave.com/res/v1/images/search");
  });
  it("keeps freshness/domain arguments in BOTH book and main chat parsers", () => {
    const call = '{"tool":"search_news","query":"ACME","freshness":"day","domains":["sec.gov"]}';
    const expected = { tool: "search_news", query: "ACME", freshness: "day", domains: ["sec.gov"] };
    expect(parseBuddyToolCall(call)).toEqual(expected);
    expect(parseToolCall(call)).toEqual(expected);
    expect(ollamaToolSchemas({ loadedToolsets: [] }).some((s) => s.function.name === "search_news")).toBe(true);
    expect(parseBuddyToolCall('{"tool":"search_web","query":"x","freshness":"forever"}')).toBeUndefined();
    expect(parseToolCall('{"tool":"search_news","query":"x","domains":["https://sec.gov"]}')).toBeUndefined();
  });
  it("does not tell either chat to invent news after a provider error", () => {
    const call = { tool: "search_news", query: "ACME" } as const;
    expect(formatBuddyToolResult(call, { error: "API quota exhausted" })).toContain("Tell the reader");
    expect(formatToolResult(call, { error: "API quota exhausted" })).toMatch(/do not invent current facts/);
  });
  it("compiles inferred news tasks to the news tool, not a general-web grammar", () => {
    expect(inferDoneWhen("Search for today's market news and catalysts")).toEqual({ kind: "tool_ok", tool: "search_news" });
  });
  it("wires both chat UI paths to visible provenance and offers masked provider keys", () => {
    const app = readFileSync(join(import.meta.dirname, "../../../apps/web/src/App.tsx"), "utf8");
    const worker = readFileSync(join(import.meta.dirname, "../../../apps/web/src/engine.worker.ts"), "utf8");
    const settings = readFileSync(join(import.meta.dirname, "SettingsPanel.tsx"), "utf8");
    expect(app.match(/text: searchResultSummary\(/g)).toHaveLength(2);
    expect(worker.match(/searchNews: \(q, options\)/g)).toHaveLength(5);
    expect(settings.includes('title="🌐 Internet search — web, news & images"')).toBe(true);
    expect(settings.includes('type="password" autoComplete="off" value={value.keys.brave')).toBe(true);
    expect(settings.includes('type="password" autoComplete="off" value={value.keys.tavily')).toBe(true);
  });
});
