import { projectFolderPath, sameWorkspacePath, type ChatProject } from "@visual-reader/core";
import { readWorkspaceFile, writeWorkspaceFile } from "./runtime.js";

/** Linking a real repository is read-only. Only newly generated project folders get metadata. */
export async function createChatProject(name: string, id: string, projects: readonly ChatProject[], folder?: string): Promise<ChatProject> {
  const title = name.trim().slice(0, 60);
  if (!title) throw new Error("Enter a project name.");
  let workspaceDir: string;
  if (folder?.trim()) {
    if (/^[a-z]:[/\\]*$/i.test(folder.trim()) || /^[/\\]+$/.test(folder.trim())) throw new Error("Choose a project directory, not a filesystem root.");
    const probe = await readWorkspaceFile("README.md", folder.trim());
    workspaceDir = probe.path.slice(0, Math.max(probe.path.lastIndexOf("/"), probe.path.lastIndexOf("\\")));
    if (!sameWorkspacePath(workspaceDir, folder)) throw new Error("The selected folder could not be resolved. Choose an existing workspace folder.");
    if (projects.some(p => sameWorkspacePath(p.workspaceDir, workspaceDir))) throw new Error("That folder already belongs to a project. Select that project instead.");
  } else {
    const saved = await writeWorkspaceFile(`${projectFolderPath(title, id)}/.visual-reader-project.json`, JSON.stringify({ id, name: title }, null, 2));
    workspaceDir = saved.slice(0, Math.max(saved.lastIndexOf("/"), saved.lastIndexOf("\\")));
  }
  if (!workspaceDir) throw new Error("Couldn't resolve the project's workspace folder.");
  return { id, name: title, workspaceDir };
}
