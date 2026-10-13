import { useEffect, useState } from "react";
import { sameWorkspacePath, type ChatProject } from "@visual-reader/core";
import { cx } from "./design/classes.js";
import { smallButtonStyle } from "./design/recipes.js";

export interface ProjectWorkspaceBarProps {
  projects: ChatProject[];
  activeProjectId?: string;
  disabled?: boolean;
  error?: string;
  onSelect: (id?: string) => void;
  onAssign?: (id?: string) => void;
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
  useEffect(() => { setMode(undefined); setError(""); }, [props.activeProjectId]);
  const start = (next: typeof mode) => {
    setMode(next); setName(next === "rename" ? project?.name ?? "" : "");
    setFolder(""); setTarget(props.activeProjectId ?? ""); setError("");
  };
  const save = async () => {
    setPending(true); setError("");
    try {
      if (mode === "move") props.onAssign?.(target || undefined);
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
      {props.onCreate && <button className={cx.btn} style={smallButtonStyle} disabled={disabled} onClick={() => start("create")}>New project</button>}
      {project && props.onRename && <button className={cx.btn} style={smallButtonStyle} disabled={disabled} onClick={() => start("rename")}>Rename project</button>}
      {project && props.onPickFolder && <button className={cx.btn} style={smallButtonStyle} disabled={disabled} onClick={() => {
        void props.onPickFolder!().then(p => {
          if (p && !sameWorkspacePath(p, project.workspaceDir)) setError("This project still uses its saved folder. Pick that folder to approve it, or create a new project for the different folder.");
          else setError("");
        }).catch(e => setError(String(e)));
      }}>Approve folder…</button>}
      {props.onAssign && <button className={cx.btn} style={smallButtonStyle} disabled={disabled} onClick={() => start("move")}>Move chat to…</button>}
    </div>
    {project && <small title={project.workspaceDir} style={{ overflowWrap: "anywhere" }}>Workspace: {project.workspaceDir}</small>}
    {mode && <form onSubmit={e => { e.preventDefault(); void save(); }} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      {mode === "move" ? <label>Destination: <select className={cx.input} aria-label="Chat project destination" value={target} disabled={disabled} onChange={e => setTarget(e.target.value)}>
        <option value="">No project (restore this chat's own folder)</option>
        {props.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label> : <input className={cx.input} aria-label="Project name" placeholder="Project name" autoFocus required maxLength={60} value={name} disabled={disabled} onChange={e => setName(e.target.value)} />}
      {mode === "create" && <>
        <input className={cx.input} aria-label="Existing project folder" placeholder="Existing folder (optional)" value={folder} disabled={disabled} onChange={e => setFolder(e.target.value)} />
        {props.onPickFolder && <button className={cx.btn} style={smallButtonStyle} type="button" disabled={disabled} onClick={() => {
          void props.onPickFolder!().then(p => { if (p) setFolder(p); }).catch(e => setError(String(e)));
        }}>Browse…</button>}
        <small>Leave the folder blank to create a separate workspace.</small>
      </>}
      <button className={cx.btn} style={smallButtonStyle} type="submit" disabled={disabled}>{pending ? "Saving…" : "Save"}</button>
      <button className={cx.btn} style={smallButtonStyle} type="button" disabled={pending} onClick={() => setMode(undefined)}>Cancel</button>
      <small>{mode === "move" ? "Changes membership only; existing files are not moved." : mode === "rename" ? "Renaming does not move the workspace." : "New projects start with a new chat; existing chats are preserved."}</small>
    </form>}
    {(error || props.error) && <div role="alert">{error || props.error}</div>}
  </section>;
}
