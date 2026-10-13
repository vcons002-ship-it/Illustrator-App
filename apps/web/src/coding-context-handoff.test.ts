import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CODING_CONTEXT_FILES } from "../../../packages/core/src/chat/coding-context.js";

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const native = readFileSync(new URL("../../desktop/src-tauri/src/coding_context.rs", import.meta.url), "utf8");
describe("coding context call sites", () => {
  it("uses the same native and renderer note allowlist", () => {
    const names = Array.from(native.slice(native.indexOf("const NOTES:"), native.indexOf("const MAX_CONTEXT_BYTES")).matchAll(/"([^"]+)"/g), m => m[1]);
    expect(names).toEqual([...CODING_CONTEXT_FILES]);
  });
  it("takes a visible active-chat snapshot for both /code and normal delegation", () => {
    const delegate = app.slice(app.indexOf("const runDelegateCodingTask ="), app.indexOf("// Approve a buddy-requested screenshot"));
    expect(delegate).toContain("snapshotCodingChatContext(pre)");
    expect(delegate).toContain("codingWorkspace = await workspaceForWrite()");
    expect(delegate).toContain("activeBuddyIdRef.current !== chatContext.chatId");
    expect(delegate).toContain("chatContext,");
    expect(app).toContain('await runDelegateCodingTask({ tool: "delegate_coding_task", task: code[1]!.trim() }, true)');
  });
  it("does not attach the desktop chat to a phone's unrelated workspace", () => {
    const remote = app.slice(app.indexOf("const runHostToolForRemote ="), app.indexOf("runHostToolForRemoteRef.current ="));
    expect(remote).toContain("sameWorkspacePath(dir ?? \"\", selectedDir)");
    expect(remote).toContain("? snapshotCodingChatContext() : undefined");
    expect(remote).toContain("cwd: codingDir");
  });
  it("selects text fields instead of serializing the full stored messages/settings", () => {
    const snapshot = app.slice(app.indexOf("const snapshotCodingChatContext ="), app.indexOf("const runDelegateCodingTask ="));
    expect(snapshot).toContain("({ role: m.role, text: m.text })");
    for (const forbidden of ["m.thinking", "m.turns", "m.image", "settings.keys", "loadSoul", "loadMemory"]) expect(snapshot).not.toContain(forbidden);
  });
});
