import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Exercise the actual UI callbacks without booting the app's worker, IndexedDB, or desktop bridge.
// Unlike the feature inventory, these tests run their code and inspect the worker request payload.
const source = ts.createSourceFile(
  "App.tsx",
  readFileSync(join(__dirname, "App.tsx"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function callback<T>(name: string, bindings: Record<string, unknown> = {}): T {
  let found: ts.Node | undefined;
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
      found = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw new Error(`Missing App callback: ${name}`);
  const { outputText } = ts.transpileModule(`const extracted = ${found.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  return new Function(...Object.keys(bindings), `${outputText}\nreturn extracted;`)(...Object.values(bindings)) as T;
}

const imageRequestForTurn = callback<(previous: string, request?: string) => string>("imageRequestForTurn");
const call = { tool: "generate_image", prompt: "A portrait combining the reader and assistant descriptions" } as const;
const noop = () => {};

describe("image request identity survives UI approval and continuation", () => {
  it.each([undefined, "continue", "Resume!", "retry", "  try again.  "])(
    "keeps the reader's original subject and photo intent on %s",
    (continuation) => {
      const original = "Draw yourself using this attached photo for the pose";
      expect(imageRequestForTurn(original, continuation)).toBe(original);
    },
  );

  it("replaces the subject for a new request, including a request to switch subjects", () => {
    expect(imageRequestForTurn("Draw yourself", "Draw me instead")).toBe("Draw me instead");
    expect(imageRequestForTurn("Draw me", "Try again, but draw yourself this time")).toBe("Try again, but draw yourself this time");
    expect(imageRequestForTurn("", "continue")).toBe("continue");
  });

  it("preserves the original request when buddy dispatch resumes, but accepts a new subject", async () => {
    const original = "Draw yourself using this attached photo for the pose";
    const turnUserTextRef = { current: original };
    const stopBeforeWorker = new Error("Stop before unrelated worker setup");
    const dispatch = callback<(history: unknown[], text: string, bubble?: string) => Promise<void>>("dispatchBuddyTurn", {
      buddyTurnSeq: { current: 1 },
      planCompiledThisTurn: { current: false },
      turnUserTextRef,
      imageRequestForTurn,
      creativeIdleRef: { current: false },
      createdFilesRef: { current: [] },
      setFileLedger: () => { throw stopBeforeWorker; },
    });
    for (const bubble of [undefined, "continue", "try again"]) {
      await expect(dispatch([], "[Tool feedback or continuation]", bubble)).rejects.toThrow(stopBeforeWorker);
      expect(turnUserTextRef.current).toBe(original);
    }
    await expect(dispatch([], "Draw me instead", "Draw me instead")).rejects.toThrow(stopBeforeWorker);
    expect(turnUserTextRef.current).toBe("Draw me instead");
  });

  it("binds a book image approval and its retry to the original reader request", async () => {
    const book = { id: "book-1" };
    const chatUserTextRef = { current: "" };
    const pendingTranscript = { current: [] };
    const setChatPendingTool = vi.fn();
    const chatTool = vi.fn().mockResolvedValue({ error: "Render unavailable" });
    const send = callback<(text: string) => Promise<void>>("onChatSend", {
      book,
      markUserRequest: noop,
      pastedImageUrl: () => undefined,
      chatTurnSeq: { current: 0 },
      chatUserTextRef,
      imageRequestForTurn,
      chatTurnsOf: () => [],
      chatMessages: [],
      appendChat: noop,
      setChatBusy: noop,
      setChatStreaming: noop,
      setChatThinking: noop,
      setChatActivity: noop,
      setChatPendingTool,
      paragraphIndexFromId: () => undefined,
      activeParagraphId: undefined,
      activePageIndex: 0,
      chat: async () => ({ pendingTool: call, transcript: [] }),
      isTechnical: false,
      allowSpoilers: false,
      chatBookRef: { current: book },
      pendingTranscript,
    });

    const original = "Draw yourself in a garden";
    for (const request of [original, "try again"]) {
      await send(request);
      const pending = setChatPendingTool.mock.lastCall?.[0];
      expect(pending).toEqual({ call, userText: original });
      const approve = callback<() => Promise<void>>("onApproveChatTool", {
        chatPendingTool: pending,
        chatRenderingRef: { current: false },
        setChatPendingTool,
        setChatBusy: noop,
        setChatActivity: noop,
        chatTool,
        turnRefImagesRef: { current: [] },
        formatToolResult: () => "Image generation failed",
        appendChat: noop,
        pendingTranscript,
      });
      await approve();
      expect(chatTool).toHaveBeenLastCalledWith(call, expect.objectContaining({ userText: original }));
    }
    expect(chatTool).toHaveBeenCalledTimes(2);
  });

  it("captures buddy identity before asynchronous render-engine startup", async () => {
    const original = "Draw yourself using this attached photo for the pose";
    const turnUserTextRef = { current: original };
    const buddyRenderingRef = { current: false };
    const renderFailure = new Error("Controlled render failure");
    const chatTool = vi.fn().mockRejectedValue(renderFailure);
    const approve = callback<(imageCall: typeof call) => Promise<void>>("approveGenerateImage", {
      buddyRenderingRef,
      turnUserTextRef,
      setBuddyPendingTool: noop,
      buddyTurnSeq: { current: 1 },
      ensureRenderEngineReady: async () => { turnUserTextRef.current = "Draw me instead"; },
      pendingBuddyTranscript: { current: [] },
      pendingBuddyHistory: { current: [] },
      setBuddyBusy: noop,
      setBuddyActivity: noop,
      chatTool,
      turnRefImagesRef: { current: [] },
    });
    await expect(approve(call)).rejects.toThrow(renderFailure);
    expect(chatTool).toHaveBeenCalledWith(call, expect.objectContaining({ userText: original }));
    expect(buddyRenderingRef.current).toBe(false);
  });
});
