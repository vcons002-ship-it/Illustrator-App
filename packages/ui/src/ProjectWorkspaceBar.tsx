import { useEffect, useState } from "react";
import { sameWorkspacePath, type ChatProject } from "@visual-reader/core";
import { cx } from "./design/classes.js";
import { smallButtonStyle } from "./design/recipes.js";

export interface ProjectWorkspaceBarProps {
  projects: ChatProject[];
  activeProjectId?: string;
  disabled?: boolean;
  managementDisabled?: boolean;
  remote?: boolean;
  error?: string;
  onSelect: (id?: string) => void;
  onAssign?: (id?: string) => void | Promise<void>;
  onCreate?: (name: string, folder?: string) => Promise<void>;
  onRename?: (id: string, name: string) => Promise<void>;
  onPickFolder?: () => Promise<string | undefined>;
}

/** Navigation and explicit membership are separate: selecting a project never moves a chat. */
export function ProjectWorkspaceBar(props: ProjectWorkspaceBarProps) {
  const [mode, setMode] = useState<"create" | "rename" | "move" | undefined>();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [target, setTarget] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const project = props.projects.find(p => p.id === props.activeProjectId);
  const disabled = props.disabled || pending;
  const manageDisabled = disabled || props.managementDisabled;
  const actionStyle = { ...smallButtonStyle, ...(props.remote ? { minHeight: 44 } : {}) };
  useEffect(() => { setMode(undefined); setError(""); }, [props.activeProjectId]);
  const start = (next: typeof mode) => {
    setMode(next); setName(next === "rename" ? project?.name ?? "" : "");
    setFolder(""); setTarget(props.activeProjectId ?? ""); setError("");
  };
  const save = async () => {
    setPending(true); setError("");
    try {
      if (mode === "move") await props.onAssign?.(target || undefined);
      else if (mode === "create") await props.onCreate?.(name, folder.trim() || undefined);
      else if (mode === "rename" && project) await props.onRename?.(project.id, name);
      setMode(undefined);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  };
  return <section aria-label="Project workspace" style={{ padding: "6px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <label>Project: <select className={cx.input} aria-label="Select project" disabled={disabled}
        value={props.activeProjectId ?? ""} onChange={e => props.onSelect(e.target.value || undefined)}>
        <option value="">No project</option>
        {props.activeProjectId && !project && <option value={props.activeProjectId}>Unavailable project</option>}
        {props.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
      {props.onCreate && <button className={cx.btn} style={actionStyle} disabled={manageDisabled} onClick={() => start("create")}>New project</button>}
      {project && props.onRename && <button className={cx.btn} style={actionStyle} disabled={manageDisabled} onClick={() => start("rename")}>Rename project</button>}
      {project && props.onPickFolder && <button className={cx.btn} style={actionStyle} disabled={disabled} onClick={() => {
        void props.onPickFolder!().then(p => {
          if (p && !sameWorkspacePath(p, project.workspaceDir)) setError("This project still uses its saved folder. Pick that folder to approve it, or create a new project for the different folder.");
          else setError("");
        }).catch(e => setError(String(e)));
      }}>Approve folder…</button>}
      {props.onAssign && <button className={cx.btn} style={actionStyle} disabled={manageDisabled} onClick={() => start("move")}>Move chat to…</button>}
    </div>
    {project && <small title={project.workspaceDir} style={{ overflowWrap: "anywhere" }}>Workspace: {project.workspaceDir}</small>}
    {props.remote && <small>{props.managementDisabled ? "Update/reconnect the linked desktop to enable mobile project changes." : "Project folders are on your linked desktop. Leave the folder blank for a new workspace; existing PC folders must already be approved there."}</small>}
    {mode && <form onSubmit={e => { e.preventDefault(); void save(); }} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      {mode === "move" ? <label>Destination: <select className={cx.input} aria-label="Chat project destination" value={target} disabled={disabled} onChange={e => setTarget(e.target.value)}>
        <option value="">No project (restore this chat's own folder)</option>
        {props.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label> : <input className={cx.input} aria-label="Project name" placeholder="Project name" autoFocus required maxLength={60} value={name} disabled={disabled} onChange={e => setName(e.target.value)} />}
      {mode === "create" && <>
        <input className={cx.input} aria-label="Existing project folder" placeholder="Existing folder (optional)" value={folder} disabled={disabled} onChange={e => setFolder(e.target.value)} />
        {props.onPickFolder && <button className={cx.btn} style={actionStyle} type="button" disabled={disabled} onClick={() => {
          void props.onPickFolder!().then(p => { if (p) setFolder(p); }).catch(e => setError(String(e)));
        }}>Browse…</button>}
        <small>Leave the folder blank to create a separate workspace.</small>
      </>}
      <button className={cx.btn} style={actionStyle} type="submit" disabled={manageDisabled}>{pending ? "Saving…" : "Save"}</button>
      <button className={cx.btn} style={actionStyle} type="button" disabled={pending} onClick={() => setMode(undefined)}>Cancel</button>
      <small>{mode === "move" ? "Changes membership only; existing files are not moved." : mode === "rename" ? "Renaming does not move the workspace." : "New projects start with a new chat; existing chats are preserved."}</small>
    </form>}
    {pending && !mode && <small role="status">Waiting for the desktop to confirm the project change…</small>}
    {(error || props.error) && <div role="alert">{error || props.error}</div>}
  </section>;
}
