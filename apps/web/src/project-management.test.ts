import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectCommandHost, ProjectRequestClient, type ProjectHost, type ProjectRequest } from "./project-management.js";
const projectId = "11111111-1111-4111-8111-111111111111";
const project = { id: projectId, name: "Alpha", workspaceDir: "C:/workspace/projects/alpha" };
function hostFixture(): ProjectHost {
  return {
    context: vi.fn(() => ({ desktop: true, ready: true, idle: true, chatId: "chat-one", projects: [project] })),
    create: vi.fn(async (name, _folder, id) => ({ ...project, id, name })),
    rename: vi.fn(async () => {}), assign: vi.fn(async () => {}),
  };
}
const create = (): ProjectRequest => ({ requestId: "request-one", expectedChatId: "chat-one", operation: { action: "create", name: "Beta", projectIdForCreate: "22222222-2222-4222-8222-222222222222" } });
afterEach(() => { vi.useRealTimers(); });

describe("desktop project commands", () => {
  it("creates a named desktop workspace and returns confirmed metadata", async () => {
    const host = hostFixture(); const request = create();
    const result = await new ProjectCommandHost().handle(request, host);
    expect(result).toEqual({ requestId: request.requestId, ok: true, project: { ...project, id: request.operation.projectIdForCreate, name: "Beta" } });
    expect(host.create).toHaveBeenCalledWith("Beta", undefined, request.operation.projectIdForCreate);
  });
  it("renames and assigns only explicitly targeted existing project/chat ids", async () => {
    const host = hostFixture(); const server = new ProjectCommandHost();
    expect((await server.handle({ requestId: "rename", expectedChatId: "chat-one", operation: { action: "rename", id: projectId, name: "Renamed" } }, host)).ok).toBe(true);
    expect(host.rename).toHaveBeenCalledWith(projectId, "Renamed");
    expect((await server.handle({ requestId: "assign", expectedChatId: "chat-one", operation: { action: "assign", chatId: "chat-one", projectId } }, host)).ok).toBe(true);
    expect(host.assign).toHaveBeenCalledWith("chat-one", projectId);
    expect((await server.handle({ requestId: "detach", expectedChatId: "chat-one", operation: { action: "assign", chatId: "chat-one" } }, host)).ok).toBe(true);
    expect(host.assign).toHaveBeenLastCalledWith("chat-one", undefined);
  });
  it("rejects stale chat targets, busy tasks, corrupt/unready storage and non-desktop executors", async () => {
    for (const context of [
      { chatId: "different" }, { idle: false }, { ready: false }, { desktop: false },
    ]) {
      const host = hostFixture(); const base = host.context(); host.context = () => ({ ...base, ...context });
      expect((await new ProjectCommandHost().handle(create(), host)).ok).toBe(false);
      expect(host.create).not.toHaveBeenCalled();
    }
  });
  it("rejects unknown projects, invalid ids and empty names before filesystem work", async () => {
    for (const operation of [
      { action: "create" as const, name: "Beta", projectIdForCreate: "../../bad" },
      { action: "create" as const, name: " ", projectIdForCreate: projectId },
      { action: "rename" as const, id: "missing", name: "Renamed" },
      { action: "assign" as const, chatId: "chat-one", projectId: "missing" },
      { action: "assign" as const, chatId: "different", projectId },
    ]) {
      const host = hostFixture();
      expect((await new ProjectCommandHost().handle({ ...create(), operation }, host)).ok).toBe(false);
      expect(host.create).not.toHaveBeenCalled(); expect(host.rename).not.toHaveBeenCalled(); expect(host.assign).not.toHaveBeenCalled();
    }
  });
  it("deduplicates repeated frames and refuses a reused request id with another payload", async () => {
    const server = new ProjectCommandHost(); const host = hostFixture(); const request = create();
    const first = server.handle(request, host); const duplicate = server.handle(request, host);
    expect(await duplicate).toEqual(await first);
    expect(host.create).toHaveBeenCalledTimes(1);
    expect((await server.handle({ ...request, operation: { ...request.operation, name: "Other" } } as ProjectRequest, host)).ok).toBe(false);
  });
  it("recovers a committed create id after a restart without creating/switching another chat", async () => {
    const host = hostFixture(); host.context = () => ({ desktop: true, ready: true, idle: false, chatId: "another-chat", projects: [project] });
    const request: ProjectRequest = { ...create(), operation: { action: "create", name: "Alpha", projectIdForCreate: projectId } };
    expect(await new ProjectCommandHost().handle(request, host)).toEqual({ requestId: request.requestId, ok: true, project });
    expect(host.create).not.toHaveBeenCalled();
  });
  it("serializes mutations and surfaces disk, approval and persistence failures", async () => {
    const server = new ProjectCommandHost(); const host = hostFixture(); let finish!: (p: typeof project) => void;
    host.create = vi.fn(() => new Promise<typeof project>(resolve => { finish = resolve; }));
    const running = server.handle(create(), host);
    expect((await server.handle({ ...create(), requestId: "another-request" }, host)).error).toContain("Another project change");
    finish(project); await running;
    host.rename = vi.fn(async () => { throw new Error("disk full"); });
    expect((await server.handle({ requestId: "rename", expectedChatId: "chat-one", operation: { action: "rename", id: projectId, name: "Other" } }, host)).error).toContain("disk full");
    host.create = vi.fn(async () => { throw new Error("outside approved roots"); });
    expect((await server.handle({ ...create(), requestId: "approval" }, host)).error).toContain("approved roots");
  });
});

describe("phone project acknowledgments", () => {
  it("waits for the matching desktop result and ignores unrelated replies", async () => {
    const send = vi.fn(); const client = new ProjectRequestClient(send, () => "chat-one");
    const promise = client.run({ action: "create", name: "Alpha" }); const request = send.mock.calls[0]![0] as ProjectRequest;
    let done = false; promise.then(() => { done = true; });
    client.receive({ requestId: "another", ok: true }); await Promise.resolve(); expect(done).toBe(false);
    expect(request.operation.projectIdForCreate).toMatch(/^[0-9a-f-]{36}$/);
    client.receive({ requestId: request.requestId, ok: true, project }); expect((await promise).project).toEqual(project);
    client.dispose();
  });
  it("shows desktop errors and allows a corrected request", async () => {
    const send = vi.fn(); const client = new ProjectRequestClient(send, () => "chat-one");
    const promise = client.run({ action: "rename", id: projectId, name: "Renamed" });
    client.receive({ requestId: send.mock.calls[0]![0].requestId, ok: false, error: "outside approved roots" });
    await expect(promise).rejects.toThrow("approved roots"); client.dispose();
  });
  it("retains a timed-out create's exact request and project id on explicit retry", async () => {
    vi.useFakeTimers(); const send = vi.fn(); const client = new ProjectRequestClient(send, () => "chat-one", 100);
    const operation = { action: "create" as const, name: "Alpha" };
    const first = client.run(operation); const rejection = expect(first).rejects.toThrow("may have been saved");
    await vi.advanceTimersByTimeAsync(100); await rejection;
    const second = client.run(operation);
    expect(send.mock.calls[1]![0]).toEqual(send.mock.calls[0]![0]);
    client.receive({ requestId: send.mock.calls[1]![0].requestId, ok: true, project }); await second; client.dispose();
  });
  it("prevents duplicate in-flight sends and cancels timers on disposal", async () => {
    const send = vi.fn(); const client = new ProjectRequestClient(send, () => "chat-one");
    const operation = { action: "create" as const, name: "Alpha" };
    const running = client.run(operation);
    await expect(client.run(operation)).rejects.toThrow("already being saved");
    const failed = expect(running).rejects.toThrow("connection was closed"); client.dispose(); await failed;
    expect(send).toHaveBeenCalledTimes(1);
  });
});
