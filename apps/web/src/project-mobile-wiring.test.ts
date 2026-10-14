import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const mirror = readFileSync(new URL("./useRemoteMirror.ts", import.meta.url), "utf8");
describe("mobile project wiring", () => {
  it("exposes project management on the linked phone and keeps the native picker desktop-only", () => {
    const props = app.slice(app.indexOf("projectWorkspace: {"), app.indexOf("activeSessionId={activeBuddyId}"));
    expect(props).toContain("onAssign: onAssignChatProject"); expect(props).toContain("await onCreateChatProject(name, folder)");
    expect(props).toContain("onRename: onRenameChatProject");
    expect(props).toContain("managementDisabled: !chatSynced || !remoteProjectManagement");
    expect(props).toContain("isDesktop && !isRemoteClient ? { onPickFolder: pickFolder }");
  });
  it("relays and acknowledges project actions without writing phone-local project data", () => {
    expect(app).toContain('request => sendAppSync({ type: "vrcmd:project", ...request })');
    expect(mirror).toContain('case "vrcmd:project":'); expect(mirror).toContain('case "vrsync:projectResult":');
    expect(app).toContain('sendAppSync({ type: "vrsync:projectResult", ...result })');
    const create = app.slice(app.indexOf("const onCreateChatProject ="), app.indexOf("const onRenameChatProject ="));
    expect(create.indexOf("return reply.project")).toBeLessThan(create.indexOf("createChatProject(name, id"));
  });
  it("mirrors desktop capability/errors and treats older hosts as read-only managers", () => {
    expect(app).toContain("canManageProjects: isDesktop && projectsReady && !projectLoadError");
    expect(app).toContain("setRemoteProjectManagement(c.canManageProjects === true)");
    expect(app).toContain('setProjectLoadError(c.projectError ?? "")');
  });
  it("persists chat membership before confirming and does not relocate history/files", () => {
    const assign = app.slice(app.indexOf("const onAssignChatProject ="), app.indexOf("const saveChatProjects ="));
    expect(assign).toContain('await libraryStore.putMemo("buddy-sessions", JSON.stringify(next))');
    expect(assign.indexOf('await libraryStore.putMemo')).toBeLessThan(assign.indexOf("setBuddySessions(next)"));
    expect(assign).toContain("assignSessionProject"); expect(assign).not.toContain("writeWorkspaceFile");
  });
  it("waits for acknowledged moves and prevents chat work during workspace changes", () => {
    const panel = readFileSync(new URL("../../../packages/ui/src/ProjectWorkspaceBar.tsx", import.meta.url), "utf8");
    expect(panel).toContain('await props.onAssign?.(target || undefined)');
    expect(panel).toContain('catch (e) { setError');
    expect(app).toContain("if (projectMutationRef.current)");
    expect(app).toContain("busy={buddyBusy || projectMutationPending}");
  });
});
