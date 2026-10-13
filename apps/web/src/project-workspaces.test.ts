import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatProject } from "./project-workspaces.js";

const host = vi.hoisted(() => ({ readWorkspaceFile: vi.fn(), writeWorkspaceFile: vi.fn() }));
vi.mock("./runtime.js", () => host);
afterEach(() => vi.resetAllMocks());

describe("project creation bridge", () => {
  it("creates one isolated project folder through the real workspace writer", async () => {
    host.writeWorkspaceFile.mockImplementation(async (path: string) => `C:/VisualReader/workspace/${path}`);
    const p = await createChatProject(" Alpha ", "id-1", []);
    expect(p).toEqual({ id: "id-1", name: "Alpha", workspaceDir: "C:/VisualReader/workspace/projects/project-alpha-id-1" });
    expect(host.writeWorkspaceFile).toHaveBeenCalledOnce();
    expect(host.writeWorkspaceFile.mock.calls[0]![0]).toContain("/.visual-reader-project.json");
    expect(host.readWorkspaceFile).not.toHaveBeenCalled();
  });
  it("links existing folders without modifying their README or repository", async () => {
    host.readWorkspaceFile.mockResolvedValue({ exists: false, path: "C:\\Projects\\Alpha\\README.md" });
    expect((await createChatProject("Alpha", "id-1", [], "C:/Projects/Alpha")).workspaceDir).toBe("C:\\Projects\\Alpha");
    expect(host.writeWorkspaceFile).not.toHaveBeenCalled();
  });
  it("refuses duplicate roots", async () => {
    host.readWorkspaceFile.mockResolvedValue({ exists: true, path: "C:/Projects/Alpha/README.md" });
    await expect(createChatProject("Other", "id-2", [{ id: "id-1", name: "Alpha", workspaceDir: "c:\\projects\\alpha\\" }], "C:/Projects/Alpha")).rejects.toThrow("already belongs");
    expect(host.writeWorkspaceFile).not.toHaveBeenCalled();
  });
  it("refuses a host silently resolving to the wrong folder", async () => {
    host.readWorkspaceFile.mockResolvedValue({ exists: false, path: "C:/VisualReader/workspace/README.md" });
    await expect(createChatProject("Alpha", "id-1", [], "C:/missing")).rejects.toThrow("could not be resolved");
  });
  it("propagates approval and disk errors rather than choosing another folder", async () => {
    host.readWorkspaceFile.mockRejectedValue(new Error("outside approved roots"));
    await expect(createChatProject("Alpha", "id-1", [], "C:/private")).rejects.toThrow("outside approved roots");
    host.writeWorkspaceFile.mockRejectedValue(new Error("disk full"));
    await expect(createChatProject("Alpha", "id-1", [])).rejects.toThrow("disk full");
  });
  it("rejects empty names before calling the host", async () => {
    await expect(createChatProject("  ", "id-1", [])).rejects.toThrow("project name");
    expect(host.writeWorkspaceFile).not.toHaveBeenCalled();
  });
  it("does not turn a drive root into a drive-relative working folder", async () => {
    await expect(createChatProject("Alpha", "id-1", [], "C:\\")).rejects.toThrow("filesystem root");
    expect(host.readWorkspaceFile).not.toHaveBeenCalled();
  });
});

describe("app project wiring regression guards", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  it("restores project membership AND legacy personal folders on reload", () => {
    const load = source.slice(source.indexOf('const rawSessions ='), source.indexOf('// Persist the ACTIVE session'));
    expect(load).toContain('typeof s.projectId === "string"');
    expect(load).toContain('typeof s.chatDir === "string"');
  });
  it("mirrors the project roots and membership to linked phones", () => {
    const mirror = source.slice(source.indexOf('const chatMirror ='), source.indexOf('const sameSession ='));
    expect(mirror).toContain('projects: chatProjects');
    expect(mirror.match(/projectId: s.projectId/g)).toHaveLength(2);
    expect(mirror).toContain('setChatProjects(c.projects ?? [])');
  });
  it("uses the project resolver for writes, reads, commands and delegation", () => {
    expect(source).toMatch(/const workspaceForWrite[\s\S]*?sessionWorkspaceDir\(/);
    expect(source).toMatch(/const workspaceDirNow[\s\S]*?sessionWorkspaceDir\(/);
    expect(source).toContain('cwd: d');
    expect(source).toContain('searchLocalFiles(query, workspaceDirNow())');
  });
  it("never regenerates a shared project's README from a single chat", () => {
    expect(source).toMatch(/const refreshWorkspaceReadme[\s\S]*?projectId\) return/);
  });
});
