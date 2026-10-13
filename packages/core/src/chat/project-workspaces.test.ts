import { describe, expect, it } from "vitest";
import { assignSessionProject, parseChatProjects, projectFolderPath, sameWorkspacePath, sessionWorkspaceDir } from "./project-workspaces.js";

const projects = [
  { id: "alpha", name: "Alpha", workspaceDir: "C:/workspace/alpha" },
  { id: "beta", name: "Beta", workspaceDir: "C:/workspace/beta" },
];
describe("project workspace ownership", () => {
  it("uses one root for all chats in a project, not their old personal folders", () => {
    for (const id of ["one", "two"]) expect(sessionWorkspaceDir({ id, projectId: "alpha", workingDir: "C:/old", chatDir: "C:/personal" }, projects)).toBe("C:/workspace/alpha");
  });
  it("keeps different projects separate", () => {
    expect(sessionWorkspaceDir({ id: "one", projectId: "beta", workingDir: "" }, projects)).toBe("C:/workspace/beta");
  });
  it("does not silently fall back when project metadata is missing", () => {
    expect(() => sessionWorkspaceDir({ id: "one", projectId: "missing", workingDir: "C:/old" }, projects, "C:/personal")).toThrow("unavailable");
  });
  it("leaves legacy folders unchanged", () => {
    expect(sessionWorkspaceDir({ id: "one", workingDir: "C:/chosen", chatDir: "C:/personal" }, projects)).toBe("C:/chosen");
    expect(sessionWorkspaceDir({ id: "one", workingDir: "", chatDir: "C:/personal" }, projects)).toBe("C:/personal");
    expect(sessionWorkspaceDir({ id: "one", workingDir: "" }, projects, "C:/remembered")).toBe("C:/remembered");
    expect(sessionWorkspaceDir(undefined, projects)).toBeUndefined();
  });
  it("changes membership only, and detaching restores the personal workspace", () => {
    const original = [{ id: "one", workingDir: "C:/chosen", chatDir: "C:/personal", label: "Keep me", closed: true }, { id: "two", workingDir: "" }];
    const moved = assignSessionProject(original, "one", "alpha");
    expect(moved[0]).toEqual({ ...original[0], projectId: "alpha" });
    expect(moved[1]).toBe(original[1]);
    expect(assignSessionProject(moved, "one")).toEqual(original);
    expect(original[0]).not.toHaveProperty("projectId");
  });
  it("keeps roots stable when names change or projects round-trip through storage", () => {
    const renamed = projects.map(p => ({ ...p, name: "Renamed" }));
    expect(parseChatProjects(JSON.stringify(renamed))).toEqual(renamed);
    expect(sessionWorkspaceDir({ id: "one", projectId: "alpha", workingDir: "" }, renamed)).toBe(projects[0]!.workspaceDir);
  });
  it("treats old installs as having no projects", () => expect(parseChatProjects(undefined)).toEqual([]));
  it("rejects corrupt or duplicate metadata rather than silently dropping saved entries", () => {
    expect(() => parseChatProjects("broken")).toThrow();
    expect(() => parseChatProjects("{}")).toThrow("not an array");
    expect(() => parseChatProjects(JSON.stringify([null, projects[0]]))).toThrow("invalid");
    expect(() => parseChatProjects(JSON.stringify([projects[0], projects[0]]))).toThrow("duplicated");
    expect(() => parseChatProjects(JSON.stringify([{ id: "bad", name: "Bad", workspaceDir: "" }]))).toThrow("invalid");
  });
  it("creates distinct Windows-safe folder names for duplicate labels", () => {
    expect(projectFolderPath("CON ../ <> title", "id-1")).toBe("projects/project-con-title-id-1");
    expect(projectFolderPath("Same", "id-1")).not.toBe(projectFolderPath("Same", "id-2"));
    expect(() => projectFolderPath("Same", "!/")).toThrow("unique id");
  });
  it("compares Windows path separators, case, and trailing separators", () => {
    expect(sameWorkspacePath("C:\\Projects\\Example\\", "c:/projects/example")).toBe(true);
    expect(sameWorkspacePath("C:/one", "C:/two")).toBe(false);
  });
});
