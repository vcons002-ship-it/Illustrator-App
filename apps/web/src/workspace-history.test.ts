import { readFileSync } from "node:fs";
import ts from "typescript";
import { InMemoryStore, type StoredChatMessage, type BuddyPlan, type Workflow } from "@visual-reader/core";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceHistoryGuard, readWorkspaceHistory, restoreWorkspaceHistory } from "./workspace-history.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const saved: StoredChatMessage[] = [
  { role: "user", text: "Write the scheduled report", at: 100 },
  { role: "assistant", text: "The report is saved.", at: 101 },
];
const readersFor = (store: InMemoryStore) => ({
  history: (id: string) => store.getChatHistory(id),
  plan: async (): Promise<BuddyPlan | undefined> => undefined,
  workflow: async (): Promise<Workflow | undefined> => undefined,
  files: async () => [] as { path: string; lines: number }[],
});

describe("scheduled workspace history restoration", () => {
  it("reopens the same persisted transcript repeatedly without writing or running anything", async () => {
    const store = new InMemoryStore();
    const id = "__buddy__-sch-example";
    await store.putChatHistory(id, saved);
    const write = vi.spyOn(store, "putChatHistory");
    const guard = createWorkspaceHistoryGuard();
    const apply = vi.fn();
    for (let n = 0; n < 2; n++) {
      const ticket = guard.begin();
      expect(guard.blocked).toBe(true);
      expect(await restoreWorkspaceHistory({ id, ticket, guard, readers: readersFor(store), isCurrent: () => true, apply })).toBe(true);
      expect(apply.mock.lastCall?.[0].messages).toEqual(saved);
      expect(guard.blocked).toBe(false);
      guard.invalidate(); // leave the workspace, then return
    }
    expect(write).not.toHaveBeenCalled();
    expect(await store.getChatHistory(id)).toEqual(saved);
  });

  it("waits for messages, checklist, workflow and file ledger before committing one snapshot", async () => {
    const guard = createWorkspaceHistoryGuard();
    const history = deferred<StoredChatMessage[]>();
    const files = deferred<{ path: string; lines: number }[]>();
    const plan: BuddyPlan = { goal: "Report", steps: [{ text: "Save report", status: "done" }] };
    const workflow: Workflow = { goal: "Report", steps: [] };
    const apply = vi.fn();
    const readers = {
      history: vi.fn(() => history.promise), plan: vi.fn(async () => plan),
      workflow: vi.fn(async () => workflow), files: vi.fn(() => files.promise),
    };
    const pending = restoreWorkspaceHistory({ id: "scheduled-chat", ticket: guard.begin(), guard, readers, isCurrent: () => true, apply });
    history.resolve(saved);
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();
    expect(guard.blocked).toBe(true);
    files.resolve([{ path: "documents/report.md", lines: 12 }]);
    expect(await pending).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ messages: saved, plan, workflow, files: [{ path: "documents/report.md", lines: 12 }] });
    for (const reader of Object.values(readers)) expect(reader).toHaveBeenCalledWith("scheduled-chat");
  });

  it("leaves a genuinely new workspace empty without creating or overwriting stored history", async () => {
    const store = new InMemoryStore();
    const write = vi.spyOn(store, "putChatHistory");
    const guard = createWorkspaceHistoryGuard();
    const apply = vi.fn();
    expect(await restoreWorkspaceHistory({ id: "new", ticket: guard.begin(), guard, readers: readersFor(store), isCurrent: () => true, apply })).toBe(true);
    expect(apply.mock.lastCall?.[0].messages).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    expect(await store.getChatHistory("new")).toBeUndefined();
  });

  it("fails closed on a read error, preserves persisted messages, and permits a successful retry", async () => {
    const store = new InMemoryStore();
    await store.putChatHistory("saved", saved);
    const guard = createWorkspaceHistoryGuard();
    const apply = vi.fn();
    const readers = readersFor(store);
    await expect(restoreWorkspaceHistory({ id: "saved", ticket: guard.begin(), guard,
      readers: { ...readers, history: async () => { throw Error("IndexedDB unavailable"); } }, isCurrent: () => true, apply,
    })).rejects.toThrow("IndexedDB unavailable");
    expect(guard.blocked).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    expect(await store.getChatHistory("saved")).toEqual(saved);
    expect(await restoreWorkspaceHistory({ id: "saved", ticket: guard.begin(), guard, readers, isCurrent: () => true, apply })).toBe(true);
    expect(guard.blocked).toBe(false);
    expect(apply.mock.lastCall?.[0].messages).toEqual(saved);
  });

  it("rejects malformed history rather than treating it as an empty conversation", async () => {
    const store = new InMemoryStore();
    await expect(readWorkspaceHistory("bad", {
      ...readersFor(store), history: async () => ({ unexpected: true }) as unknown as StoredChatMessage[],
    })).rejects.toThrow("Saved chat history is invalid");
  });

  it("does not let a late read replace another workspace or unblock its newer read", async () => {
    const guard = createWorkspaceHistoryGuard();
    const slow = deferred<StoredChatMessage[]>();
    const store = new InMemoryStore();
    const apply = vi.fn();
    const old = restoreWorkspaceHistory({ id: "old", ticket: guard.begin(), guard,
      readers: { ...readersFor(store), history: () => slow.promise }, isCurrent: () => true, apply,
    });
    guard.invalidate();
    const newer = guard.begin();
    slow.resolve(saved);
    expect(await old).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(guard.current(newer)).toBe(true);
    expect(guard.blocked).toBe(true);
  });

  it("discards a snapshot if the active ID or turn epoch changed during the load", async () => {
    const guard = createWorkspaceHistoryGuard();
    const store = new InMemoryStore();
    const apply = vi.fn();
    expect(await restoreWorkspaceHistory({ id: "old", ticket: guard.begin(), guard, readers: readersFor(store), isCurrent: () => false, apply })).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(guard.blocked).toBe(false);
  });

  it("leaving or clearing a failed workspace releases the block without reviving a stale ticket", () => {
    const guard = createWorkspaceHistoryGuard();
    const ticket = guard.begin();
    guard.invalidate();
    expect(guard.current(ticket)).toBe(false);
    expect(guard.blocked).toBe(false);
    const next = guard.begin();
    guard.finish(ticket);
    expect(guard.current(next)).toBe(true);
  });
});

describe("App scheduled-history wiring (source-level integration guards)", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const between = (start: string, end: string) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));

  it("keeps mobile opening as a relay command and restores real desktop storage before displaying messages", () => {
    const open = between("const onOpenScheduledWorkspace =", "const planScheduledSteps =");
    expect(open).toContain('action: "openWorkspace"');
    expect(open.indexOf("if (isRemoteClient)")).toBeLessThan(open.indexOf("restoreWorkspaceHistory"));
    expect(open).toContain("history: (id) => libraryStore.getChatHistory!(id)");
    expect(open).toContain("plan: loadBuddyPlan");
    expect(open).toContain("workflow: loadBuddyWorkflow");
    expect(open).toContain("files: loadFileLedger");
    expect(open).toContain("setBuddyMessages(restored.messages)");
    expect(open).toContain("buddyTurnSeq.current === epoch && activeBuddyIdRef.current === sessionId");
    expect(open).toContain("reopen it to retry");
    // Reopening an already selected but blank workspace must reload it, not return just on its ID.
    expect(open).toContain("buddyBusyRef.current || buddyMessagesRef.current.length > 0");
  });

  it("blocks new turns, persistence and schedule advancement while the history is unread", () => {
    expect(between("const onBuddySend =", "const onBuddySendText =")).toContain("if (workspaceHistoryGuard.blocked)");
    expect(between("const dispatchBuddyTurn =", "const onBuddySend =")).toContain("if (workspaceHistoryGuard.blocked)");
    expect(app).toContain("if (!workspaceHistoryGuard.blocked) await libraryStore.putChatHistory?.(id, stored)");
    const sweep = between("const sweepScheduled =", "const sweepScheduledRef =");
    expect(sweep).toContain("if (workspaceHistoryGuard.blocked) return;");
    expect(sweep.lastIndexOf("if (workspaceHistoryGuard.blocked) return;")).toBeLessThan(sweep.indexOf("advanceSchedule("));
    expect(between("const planScheduledSteps =", "const onOpenScheduledWorkspaceRef =")).toContain("if (!await onOpenScheduledWorkspace(taskId)) return;");
    expect(between("const resetBuddyView =", "const onSwitchBuddySession =")).toContain("workspaceHistoryGuard.invalidate()");
    expect(between("const onClearBuddy =", "const stopBuddyRun =")).toContain("workspaceHistoryGuard.invalidate()");
  });
});

// Execute App's real callbacks, following the existing image-request callback harness. No worker,
// network, actual scheduled action, or user profile is started by these tests.
function appCallback<T>(name: string, bindings: Record<string, unknown>): T {
  const source = ts.createSourceFile("App.tsx", readFileSync(new URL("./App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.Node | undefined;
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
      found = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw Error(`Missing App callback: ${name}`);
  const { outputText } = ts.transpileModule(`const extracted = ${found.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  return new Function(...Object.keys(bindings), `${outputText}\nreturn extracted;`)(...Object.values(bindings)) as T;
}

function openingHarness() {
  const store = new InMemoryStore();
  const workspaceHistoryGuard = createWorkspaceHistoryGuard();
  const activeBuddyIdRef = { current: "other-chat" };
  const buddyMessagesRef = { current: [] as StoredChatMessage[] };
  const buddyTurnSeq = { current: 0 };
  const bindings = {
    isRemoteClient: false, sendAppSync: vi.fn(), setShowScheduled: vi.fn(),
    scheduledRef: { current: [{ id: "job", sessionId: "saved-chat" }] },
    activeBuddyIdRef, buddyMessagesRef, buddyTurnSeq, workspaceHistoryGuard,
    buddyBusyRef: { current: false },
    openScheduledWorkspace: vi.fn(async () => "saved-chat"),
    resetBuddyView: () => { workspaceHistoryGuard.invalidate(); buddyTurnSeq.current++; buddyMessagesRef.current = []; },
    libraryStore: store, setActiveBuddyId: vi.fn(), setBuddyActivity: vi.fn(),
    loadBuddyPlan: vi.fn(async (): Promise<BuddyPlan | undefined> => undefined),
    loadBuddyWorkflow: vi.fn(async (): Promise<Workflow | undefined> => undefined),
    loadFileLedger: vi.fn(async () => [{ path: "documents/report.md", lines: 12 }]),
    restoreWorkspaceHistory, buddyPlanRef: { current: undefined }, setBuddyPlan: vi.fn(),
    buddyWorkflowRef: { current: undefined }, setBuddyWorkflow: vi.fn(),
    createdFilesRef: { current: [] }, setFileLedger: vi.fn(), setBuddyMessages: vi.fn(), pushToast: vi.fn(),
  };
  return { store, bindings, open: () => appCallback<(id: string) => Promise<boolean | undefined>>("onOpenScheduledWorkspace", bindings)("job") };
}

describe("App scheduled workspace callbacks (executed)", () => {
  it("loads stored messages on Open, including when that workspace is already active but blank", async () => {
    const { store, bindings, open } = openingHarness();
    await store.putChatHistory("saved-chat", saved);
    bindings.activeBuddyIdRef.current = "saved-chat"; // reproduces the reported empty-open case
    expect(await open()).toBe(true);
    expect(bindings.setBuddyMessages).toHaveBeenCalledWith(saved);
    expect(bindings.buddyMessagesRef.current).toEqual(saved);
    expect(bindings.setFileLedger).toHaveBeenCalledWith([{ path: "documents/report.md", lines: 12 }]);
    expect(bindings.workspaceHistoryGuard.blocked).toBe(false);
    expect(bindings.activeBuddyIdRef.current).toBe("saved-chat");
    expect(bindings.sendAppSync).not.toHaveBeenCalled();
  });

  it("shows a retry error and blocks sends after a failed history load, without appending an empty fallback", async () => {
    const { store, bindings, open } = openingHarness();
    await store.putChatHistory("saved-chat", saved);
    vi.spyOn(store, "getChatHistory").mockRejectedValueOnce(Error("read failed"));
    expect(await open()).toBe(false);
    expect(bindings.workspaceHistoryGuard.blocked).toBe(true);
    expect(bindings.setBuddyMessages).not.toHaveBeenCalled();
    expect(bindings.pushToast).toHaveBeenCalledWith(expect.stringContaining("Nothing was overwritten"), "error");
    const blocked = { workspaceHistoryGuard: bindings.workspaceHistoryGuard, pushToast: bindings.pushToast,
      projectMutationRef: { current: false }, isRemoteClient: false };
    await appCallback<(text: string) => Promise<void>>("onBuddySend", blocked)("New prompt");
    await appCallback<(history: unknown[], text: string) => Promise<void>>("dispatchBuddyTurn", blocked)([], "Continue");
    // Undefined later dependencies deliberately prove these callbacks stop before any dispatch/mutation.
    appCallback<() => void>("sweepScheduled", blocked)();
    expect(bindings.pushToast).toHaveBeenCalledTimes(3);
    expect(await store.getChatHistory("saved-chat")).toEqual(saved);
    expect(await open()).toBe(true);
    expect(bindings.setBuddyMessages).toHaveBeenCalledWith(saved);
  });

  it("does not replace a different active chat when the persisted read arrives late", async () => {
    const { store, bindings, open } = openingHarness();
    const slow = deferred<StoredChatMessage[]>();
    vi.spyOn(store, "getChatHistory").mockImplementation(() => slow.promise);
    const pending = open();
    await vi.waitFor(() => expect(store.getChatHistory).toHaveBeenCalled());
    bindings.activeBuddyIdRef.current = "new-selection";
    bindings.buddyTurnSeq.current++;
    bindings.workspaceHistoryGuard.invalidate();
    slow.resolve(saved);
    expect(await pending).toBe(false);
    expect(bindings.setBuddyMessages).not.toHaveBeenCalled();
  });

  it("relays mobile Open without reading or changing phone storage", async () => {
    const { store, bindings, open } = openingHarness();
    bindings.isRemoteClient = true;
    const read = vi.spyOn(store, "getChatHistory");
    await open();
    expect(bindings.sendAppSync).toHaveBeenCalledWith({ type: "vrcmd:scheduled", command: { action: "openWorkspace", id: "job" } });
    expect(bindings.openScheduledWorkspace).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(bindings.workspaceHistoryGuard.blocked).toBe(false);
  });
});
