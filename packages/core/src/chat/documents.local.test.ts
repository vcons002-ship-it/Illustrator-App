import { expect, it } from "vitest";
import { LocalServerLLMProvider } from "../providers/llm/local-server-provider.js";
import { ollamaToolSchemas, toolsetDoc } from "./buddy-tools.js";
import { runBuddyTurn } from "./buddy-session.js";

// Opt-in local inference only. Saves are captured in memory: no user chat, document or workspace
// is modified. Exercises the real streaming provider, schema handoff, parser and executor together.
it.skipIf(!process.env.DOCUMENT_TEST_MODEL)("loads documents and creates one through the local native tool loop", async () => {
  const schemaRounds: string[][] = [];
  const saved: { title: string; content: string }[] = [];
  const llm = new LocalServerLLMProvider({
    baseUrl: "http://127.0.0.1:11434/v1", model: process.env.DOCUMENT_TEST_MODEL!,
    serverType: "ollama", numCtx: 50_000,
    fetchImpl: async (input, init) => {
      if (init?.body) {
        const body = JSON.parse(String(init.body)) as { tools?: { function: { name: string } }[] };
        if (body.tools) schemaRounds.push(body.tools.map((t) => t.function.name));
      }
      return fetch(input, init);
    },
  });
  const outcome = await runBuddyTurn({
    llm,
    system: 'You are testing document tools. First call load_toolset with name documents. Then call create_document with the complete Markdown content requested by the user. Do not search, plan, or narrate your intentions. After its successful result, briefly confirm.',
    history: [{ role: "user", content: 'Create a document titled "Creative tool regression" with a heading and exactly these three lines: alpha, beta, gamma. Save as md.' }],
    loadedToolsets: [],
    toolsetDoc: (id) => toolsetDoc(id, { persona: "assistant", library: [], canDocuments: true }),
    tools: (loaded) => ollamaToolSchemas({ canDocuments: true, loadedToolsets: loaded }),
    signal: AbortSignal.timeout(150_000), maxTokens: 1_024,
    reasoningEffort: "none", onEvent: () => {},
    deps: {
      openLibraryBook: async () => { throw new Error("Not part of this test"); },
      openWebText: async () => { throw new Error("Not part of this test"); },
      openPastedText: async () => { throw new Error("Not part of this test"); },
      removeLibraryBook: async () => ({ removed: "unused" }), setVisualStyle: async () => ({}),
      createDocument: async (call) => {
        saved.push({ title: call.title, content: call.content });
        return { ok: true, id: "synthetic-document", title: call.title, words: call.content.split(/\s+/).length };
      },
    },
  });
  expect(schemaRounds[0]).not.toContain("create_document");
  expect(schemaRounds.slice(1).some((s) => s.includes("create_document"))).toBe(true);
  expect(outcome.toolResults.some((t) => t.result.toolsetLoaded?.id === "documents")).toBe(true);
  expect(saved).toHaveLength(1);
  expect(saved[0]?.content).toMatch(/alpha[\s\S]*beta[\s\S]*gamma/);
  expect(outcome.toolResults.some((t) => t.result.document?.ok)).toBe(true);
}, 160_000);
