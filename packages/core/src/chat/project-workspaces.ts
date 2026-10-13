/** Projects group conversations around one durable workspace. Membership never moves files. */
export interface ChatProject {
  id: string;
  name: string;
  workspaceDir: string;
}

export interface ProjectSession {
  id: string;
  workingDir: string;
  chatDir?: string;
  projectId?: string;
}

export const PROJECTS_MEMO_KEY = "buddy-projects";

/** Reject corrupt stores rather than dropping entries and overwriting someone's project metadata. */
export function parseChatProjects(raw: string | undefined): ChatProject[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("The saved project list is not an array.");
  const ids = new Set<string>();
  return parsed.map(p => {
    if (!p || typeof p !== "object") throw new Error("A saved project is invalid.");
    const v = p as Partial<ChatProject>;
    if (typeof v.id !== "string" || !v.id || ids.has(v.id) ||
        typeof v.name !== "string" || !v.name.trim() ||
        typeof v.workspaceDir !== "string" || !v.workspaceDir.trim()) throw new Error("A saved project is invalid or duplicated.");
    ids.add(v.id);
    return { id: v.id, name: v.name, workspaceDir: v.workspaceDir };
  });
}

/** A stable, Windows-safe name. The full id avoids collisions even for identical display names. */
export function projectFolderPath(name: string, id: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  const safeId = id.replace(/[^a-zA-Z0-9-]/g, "");
  if (!safeId) throw new Error("A project needs a unique id.");
  return `projects/project-${slug}-${safeId}`;
}

export function sameWorkspacePath(a: string, b: string): boolean {
  return a.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ===
    b.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Project roots win over remembered chat-specific folders. Missing metadata fails closed. */
export function sessionWorkspaceDir(
  session: ProjectSession | undefined,
  projects: readonly ChatProject[],
  rememberedChatDir?: string,
): string | undefined {
  if (session?.projectId) {
    const project = projects.find(p => p.id === session.projectId);
    if (!project) throw new Error("This chat's project is unavailable. Reassign the chat before using file or coding tools.");
    return project.workspaceDir;
  }
  return session?.workingDir || session?.chatDir || rememberedChatDir || undefined;
}

/** Only membership changes. Personal folders and all history keys remain recoverable. */
export function assignSessionProject<T extends ProjectSession>(sessions: readonly T[], id: string, projectId?: string): T[] {
  return sessions.map(s => {
    if (s.id !== id) return s;
    const { projectId: _old, ...rest } = s;
    return { ...rest, ...(projectId ? { projectId } : {}) } as T;
  });
}
