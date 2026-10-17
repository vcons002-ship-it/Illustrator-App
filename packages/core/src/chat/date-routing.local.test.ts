import { expect, it } from "vitest";
import { LocalServerLLMProvider } from "../providers/llm/local-server-provider.js";
import { buildBuddySystemPrompt, ollamaToolSchemas } from "./buddy-tools.js";
import { runBuddyTurn, type BuddyDeps } from "./buddy-session.js";
import { CHAT_TOOLS_SYSTEM } from "./chat-tools.js";
import { runChatTurn } from "./chat-session.js";

// Opt-in real inference. No files, user chats, schedules, Google events, or other external writes.
it.skipIf(!process.env.DATE_TEST_MODEL).each(["main", "creative", "book"] as const)(
  "resolves an anchored day count through the real local %s tool loop", async (mode) => {
    const now = new Date(2026, 9, 17, 23, 58);
    const llm = new LocalServerLLMProvider({ baseUrl: "http://127.0.0.1:11434/v1", model: process.env.DATE_TEST_MODEL!, serverType: "ollama", numCtx: 50_000 });
    const common = {
      llm, now, history: [{ role: "user" as const, content: "Calculate tomorrow's day number relative to June 30, 2026 being Day 1. Give the exact number." }],
      signal: AbortSignal.timeout(90_000), maxTokens: 1_024, reasoningEffort: "none" as const, onEvent: () => {},
    };
    const outcome = mode === "book"
      ? await runChatTurn({ ...common, system: CHAT_TOOLS_SYSTEM, tools: {} })
      : await runBuddyTurn({ ...common,
        system: buildBuddySystemPrompt({ persona: "assistant", library: [], now: "2026-10-17 23:58 (America/New_York)", loadedToolsets: [] }),
        loadedToolsets: [], tools: ollamaToolSchemas({ loadedToolsets: [] }).filter((s) => ["date_math", "calculate"].includes(s.function.name)),
        creativeIdle: mode === "creative", deps: {} as BuddyDeps,
      });
    const calculation = outcome.toolResults.find((r) => r.call.tool === "date_math" && r.result.dateMath?.ok)?.result.dateMath;
    expect(calculation, "must execute date_math, not merely claim a number").toMatchObject({ days: 110, dayNumber: 111 });
    expect(outcome.text).toMatch(/111/);
  }, 100_000,
);
