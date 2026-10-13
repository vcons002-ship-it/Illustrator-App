import { sameWorkspacePath, type ChatProject } from "@visual-reader/core";

export type ProjectOperation =
  | { action: "create"; name: string; folder?: string }
  | { action: "rename"; id: string; name: string }
  | { action: "assign"; chatId: string; projectId?: string };
export type ProjectAction = ProjectOperation & { projectIdForCreate?: string };
export interface ProjectRequest { requestId: string; expectedChatId: string; operation: ProjectAction }
export interface ProjectReply { requestId: string; ok: boolean; project?: ChatProject; error?: string }

/** Phone-side acknowledged requests. An unconfirmed retry reuses the SAME create id/request. */
export class ProjectRequestClient {
  private records = new Map<string, { request: ProjectRequest; key: string; pending?: { resolve: (r: ProjectReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } }>();
  constructor(private send: (request: ProjectRequest) => void, private activeChatId: () => string,
    private timeoutMs = 30_000, private uuid = () => crypto.randomUUID()) {}
  run(operation: ProjectOperation): Promise<ProjectReply> {
    const key = JSON.stringify(operation);
    let record = Array.from(this.records.values()).find(r => r.key === key);
    if (record?.pending) return Promise.reject(new Error("This project change is already being saved."));
    if (!record) {
      if (this.records.size >= 32) return Promise.reject(new Error("Several project changes are unconfirmed. Reconnect and check the desktop project list before trying again."));
      record = { key, request: { requestId: this.uuid(), expectedChatId: this.activeChatId(), operation: { ...operation, ...(operation.action === "create" ? { projectIdForCreate: this.uuid() } : {}) } } };
      this.records.set(record.request.requestId, record);
    }
    const current = record;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        delete current.pending;
        reject(new Error("The desktop did not confirm the project change. Check the project list before retrying; it may have been saved. Retrying the same change will reuse its request."));
      }, this.timeoutMs);
      current.pending = { resolve, reject, timer };
      try { this.send(current.request); }
      catch (error) {
        clearTimeout(timer); delete current.pending;
        reject(new Error(`Could not confirm the project request: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }
  receive(reply: ProjectReply): void {
    const record = this.records.get(reply.requestId);
    if (!record) return;
    this.records.delete(reply.requestId);
    const pending = record.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    if (reply.ok) pending.resolve(reply);
    else pending.reject(new Error(reply.error || "The desktop could not save this project change."));
  }
  dispose(): void {
    for (const record of this.records.values()) if (record.pending) {
      clearTimeout(record.pending.timer); record.pending.reject(new Error("The project connection was closed. Check the desktop project list before retrying."));
    }
    this.records.clear();
  }
}

export interface ProjectHost {
  context(): { desktop: boolean; ready: boolean; idle: boolean; chatId: string; projects: readonly ChatProject[] };
  create(name: string, folder: string | undefined, id: string): Promise<ChatProject>;
  rename(id: string, name: string): Promise<void>;
  assign(chatId: string, projectId?: string): Promise<void>;
}

/** Desktop serializes project changes and deduplicates relay retries without opening OS dialogs. */
export class ProjectCommandHost {
  private completed = new Map<string, { signature: string; reply: Promise<ProjectReply> }>();
  private working = false;
  handle(request: ProjectRequest, host: ProjectHost): Promise<ProjectReply> {
    const signature = JSON.stringify(request);
    const existing = this.completed.get(request.requestId);
    if (existing) return existing.signature === signature ? existing.reply
      : Promise.resolve({ requestId: request.requestId, ok: false, error: "The project request id was reused for a different change." });
    if (this.working) return Promise.resolve({ requestId: request.requestId, ok: false, error: "Another project change is being saved. Try again when it finishes." });
    this.working = true;
    const reply = this.execute(request, host).finally(() => { this.working = false; });
    this.completed.set(request.requestId, { signature, reply });
    if (this.completed.size > 128) this.completed.delete(this.completed.keys().next().value!);
    return reply;
  }
  private async execute(request: ProjectRequest, host: ProjectHost): Promise<ProjectReply> {
    try {
      const context = host.context();
      if (!context.desktop || !context.ready) throw new Error("The desktop project list is unavailable. Reconnect or reload it first.");
      const op = request.operation;
      // A committed create id survives a restart even when the request cache no longer does.
      if (op.action === "create" && op.projectIdForCreate) {
        const project = context.projects.find(p => p.id === op.projectIdForCreate);
        if (project) {
          if (project.name !== op.name.trim().slice(0, 60) || (op.folder?.trim() && !sameWorkspacePath(project.workspaceDir, op.folder))) throw new Error("This project id already belongs to a different project.");
          return { requestId: request.requestId, ok: true, project };
        }
      }
      if (!context.idle) throw new Error("Wait for the desktop's current task or approval to finish before changing projects.");
      if (!request.requestId || request.requestId.length > 100) throw new Error("Invalid project request id.");
      if (request.expectedChatId !== context.chatId) throw new Error("The desktop is showing another chat. Let the phone sync, then retry the project change.");
      if (!["create", "rename", "assign"].includes(op.action)) throw new Error("Unknown project action.");
      let project: ChatProject | undefined;
      if (op.action === "create") {
        const id = op.projectIdForCreate ?? "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid new project id.");
        const name = op.name.trim().slice(0, 60);
        if (!name) throw new Error("Enter a project name.");
        project = context.projects.find(p => p.id === id);
        if (project) {
          if (project.name !== name || (op.folder?.trim() && !sameWorkspacePath(project.workspaceDir, op.folder))) throw new Error("This project id already belongs to a different project.");
        } else project = await host.create(name, op.folder?.trim() || undefined, id);
      } else if (op.action === "rename") {
        if (!context.projects.some(p => p.id === op.id)) throw new Error("That project is unavailable. Refresh the project list.");
        if (!op.name.trim()) throw new Error("Enter a project name.");
        await host.rename(op.id, op.name.trim().slice(0, 60));
      } else {
        if (op.chatId !== context.chatId) throw new Error("This move belongs to another chat. Let the phone sync first.");
        if (op.projectId && !context.projects.some(p => p.id === op.projectId)) throw new Error("Choose an available project.");
        await host.assign(op.chatId, op.projectId);
      }
      return { requestId: request.requestId, ok: true, ...(project ? { project } : {}) };
    } catch (error) { return { requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}
