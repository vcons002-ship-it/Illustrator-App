import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectWorkspaceBar, type ProjectWorkspaceBarProps } from "./ProjectWorkspaceBar.js";

const projects = [{ id: "alpha", name: "Alpha project", workspaceDir: "C:/Projects/Alpha" }];
const render = (extra: Partial<ProjectWorkspaceBarProps> = {}) => renderToStaticMarkup(createElement(ProjectWorkspaceBar, {
  projects, onSelect: () => {}, ...extra,
}));

describe("project workspace controls", () => {
  it("shows the selected project's real root", () => {
    const html = render({ activeProjectId: "alpha" });
    expect(html).toContain('value="alpha" selected=""');
    expect(html).toContain("C:/Projects/Alpha");
    expect(html).toContain("No project");
  });
  it("offers explicit create, rename and move actions on the desktop", () => {
    const html = render({ activeProjectId: "alpha", onCreate: async () => {}, onRename: async () => {}, onAssign: () => {} });
    expect(html).toContain("New project");
    expect(html).toContain("Rename project");
    expect(html).toContain("Move chat to");
  });
  it("does not offer filesystem mutations to a read-only linked client", () => {
    const html = render({ activeProjectId: "alpha" });
    expect(html).not.toContain("New project");
    expect(html).not.toContain("Rename project");
    expect(html).not.toContain("Move chat to");
  });
  it("makes unavailable project metadata visible instead of claiming a default root", () => {
    const html = render({ activeProjectId: "missing", error: "Couldn't load projects" });
    expect(html).toContain("Unavailable project");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Workspace:");
  });
  it("disables navigation while a coding task is active", () => expect(render({ disabled: true })).toContain('disabled=""'));
});
