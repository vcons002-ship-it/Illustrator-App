import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const mirror = readFileSync(new URL("./useRemoteMirror.ts", import.meta.url), "utf8");
describe("original upload entry points and scope", () => {
  it("lets the chat picker select source and binary files, not only documents/images", () => {
    const panel = readFileSync(new URL("../../../packages/ui/src/ChatBuddyPanel.tsx", import.meta.url), "utf8");
    const input = panel.slice(panel.indexOf("ref={fileInputRef}"), panel.indexOf("onChange={pickFile}") + 25);
    expect(input).not.toContain("accept=");
    expect(panel).toContain("save the unchanged original in the workspace");
  });
  it("saves library imports and images through the same original-byte saver", () => {
    const upload = app.slice(app.indexOf("const onUpload ="), app.indexOf("// Map the active paragraph"));
    expect(upload).toContain("await originalUpload(file)");
    expect(upload).toContain("saveOriginalInWorkspace(original, extractedUploadText(imported), target)");
    expect(upload).toContain("saveOriginalInWorkspace(original, undefined, target)");
    expect(upload.indexOf("saveOriginalInWorkspace(original, extractedUploadText(imported), target)")).toBeLessThan(upload.indexOf('imported.kind === "image"'));
    expect(upload).not.toContain("writeWorkspaceFile(wsPath, imported.text");
    expect(upload).toContain("onlyIfMissing: true");
  });
  it("saves originals for both image and document chat attachments before vision or dispatch", () => {
    const run = app.slice(app.indexOf("const runBuddyTurnWithAttachments ="), app.indexOf("const onBuddySendWithAttachments ="));
    expect(run.indexOf("saveAttachmentToWorkspace(att, uploadTarget)")).toBeLessThan(run.indexOf('att.kind === "image"'));
    expect(run.indexOf("saveAttachmentToWorkspace(att, uploadTarget)")).toBeLessThan(run.indexOf("await assessImage"));
    expect(run).toContain("Original NOT saved:");
    expect(run).toContain("saved.extractedPath ?? saved.path");
    expect(run).toContain("path: saved.absolutePath");
  });
  it("freezes a specific chat/project/workspace and never silently uses the default folder", () => {
    const save = app.slice(app.indexOf("const captureUploadTarget ="), app.indexOf("const onUpload ="));
    expect(save).toContain("await workspaceForWrite()");
    expect(save).toContain("activeBuddyIdRef.current !== target.chatId");
    expect(save).toContain("(selected?.projectId ?? null) !== target.projectId");
    expect(save).toContain('sameWorkspacePath(workspaceDirNow() ?? "", target.cwd)');
    expect(save).toContain("saveWorkspaceUpload(original.name, original.bytes, target.cwd, extractedText)");
  });
  it("never drops originals or full text to squeeze into a phone frame, and keeps rejected attachments", () => {
    const send = app.slice(app.indexOf("const onBuddySendWithAttachments ="), app.indexOf("// Persona is part"));
    expect(send).toContain("...(a.original ? { original: a.original } : {})");
    expect(send).toContain("...relayTarget");
    expect(send).toContain("faithfulUploadFitsRelay(frame(relayAtts))");
    expect(send).not.toContain("full: _full");
    expect(send).not.toContain("original: _original");
    expect(send.indexOf("Your attachments are still here")).toBeLessThan(send.indexOf("sendAppSync(frame(relayAtts)); consumeReady()"));
  });
  it("round-trips phone save acknowledgments and rejects stale phone scopes", () => {
    expect(mirror).toContain('case "vrsync:uploadSaved":');
    expect(mirror).toContain('case "vrcmd:saveUpload":');
    expect(app).toContain('sendAppSync({ type: "vrsync:uploadSaved", requestId: c.requestId, result })');
    expect(app).toContain("c.projectId !== target.projectId");
    expect(app).toContain("sameWorkspacePath(c.cwd, target.cwd)");
  });
});
