import { expect, it } from "vitest";
import { LocalServerLLMProvider } from "../providers/llm/local-server-provider.js";
import { buildBuddySystemPrompt, ollamaToolSchemas } from "./buddy-tools.js";
import { runBuddyTurn } from "./buddy-session.js";
import type { WebSearchOptions } from "../providers/image/image-search.js";

// Real local inference, synthetic search responses. No external search request, key, user chat,
// memory or workspace write. This verifies routing, not a live provider's quality or entitlement.
it.skipIf(!process.env.RESEARCH_TEST_MODEL)("routes today's news to search_news with the installed local model", async () => {
  const llm = new LocalServerLLMProvider({ baseUrl: "http://127.0.0.1:11434/v1", serverType: "ollama", numCtx: 50_000, model: process.env.RESEARCH_TEST_MODEL! });
  const searches: WebSearchOptions[] = [];
  const outcome = await runBuddyTurn({
    llm,
    system: buildBuddySystemPrompt({ persona: "assistant", library: [], loadedToolsets: [], now: new Date().toISOString() }),
    history: [{ role: "user", content: "Synthetic tool-routing test: find today's ACME earnings news with a day freshness filter. Use current news search, not Wikipedia or general web search. Then summarize the returned synthetic fixture in one sentence, explicitly calling it test data. Do not plan, write files, change memories or make trading recommendations." }],
    loadedToolsets: [], tools: (loaded) => ollamaToolSchemas({ loadedToolsets: loaded }),
    reasoningEffort: "none", onEvent: () => {}, maxTokens: 768, signal: AbortSignal.timeout(90_000),
    deps: {
      searchNews: async (_q, options) => {
        searches.push(options ?? {});
        return [{ link: "https://example.com/synthetic-news", title: "Synthetic ACME earnings fixture", snippet: "TEST DATA ONLY: ACME announced earnings. No real company or market facts are represented.", provider: "test fixture", sourceType: "news", publishedAt: new Date().toISOString() }];
      },
      searchWeb: async () => { throw new Error("Use search_news for this current-news test."); },
      openLibraryBook: async () => { throw new Error("unused"); }, openWebText: async () => { throw new Error("unused"); },
      openPastedText: async () => { throw new Error("unused"); }, removeLibraryBook: async () => ({ removed: "unused" }), setVisualStyle: async () => ({}),
    },
  });
  expect(searches.length).toBeGreaterThan(0);
  expect(searches[0]?.freshness).toBe("day");
  expect(outcome.toolResults.some((r) => r.call.tool === "search_news" && r.result.hits?.length)).toBe(true);
  expect(outcome.toolResults.some((r) => r.call.tool === "search_web")).toBe(false);
}, 100_000);
