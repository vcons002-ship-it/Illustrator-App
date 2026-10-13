# Projects and shared workspaces

The desktop chat's Project selector groups multiple conversations around one working folder.
Chat histories, plans, and Soul/profile data remain separate from project membership.

- **New project** creates a new chat and a unique folder under `~/VisualReader/workspace/projects/`.
  An optional existing folder can be selected instead. Linking a folder does not modify its files.
- **Select project** opens an existing open chat in that project, or creates one if none is open.
  It does not move the current conversation into the project.
- **New chat** inherits the current conversation's project.
- **Move chat to…** explicitly changes the current conversation's membership. Existing files are
  not copied, moved, or deleted. Choosing No project restores that chat's previous personal folder.
- **Rename project** changes the display name only. The stored folder and project id do not change.

All ordinary file tools and Codex delegation use the project's stored workspace root. This is
folder organization, not automatic branch isolation or a per-file editing permission system.
Coding still changes the working tree; commits, review, pull requests, and merges are separate.

Projects are stored in the existing library's `buddy-projects` memo. Sessions store only a
`projectId`, retaining their original `workingDir` and `chatDir`. Existing installations start
with no projects and their chats keep the same folders. No history or Soul store is migrated.

The desktop mirrors project names, paths and chat membership to linked clients. Linked clients
can navigate projects and create chats in them; creating/renaming projects and reassigning chats
are desktop controls. Project selection/membership controls are disabled while a task or approval
is active. Missing project metadata or missing selected folders fail instead of silently using
the default workspace. If a chosen external folder needs approval after restart, use **Approve
folder…** and select that same folder. This does not change the project's stored root.

The automatic per-chat README and edit checkpoint helpers do not rewrite or checkpoint a shared
project using one conversation's file ledger. Codex's existing Git change reporting is unchanged.
