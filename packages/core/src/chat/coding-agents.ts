/**
 * Pure helpers for the write-capable parallel CODING AGENTS feature — the buddy splits a coding
 * job into file-disjoint subtasks, each agent works in its own app-managed git worktree, and the
 * host merges the branches back. These are the side-effect-free pieces (branch naming, parsing
 * git's merge output for conflicts); the worktree lifecycle + agent loop live in the host/worker.
 */

/** A stable, filesystem-safe branch/worktree name for the i-th agent (0-based) of a run. */
export function agentBranchName(index: number, runId?: string): string {
  const tag = (runId ?? "").replace(/[^a-z0-9]+/gi, "").slice(0, 8);
  return `vr-agent-${index + 1}${tag ? `-${tag}` : ""}`;
}

/**
 * Parse `git merge` output for the files that conflicted. Git prints one line per conflicted
 * path: "CONFLICT (content): Merge conflict in <path>" for the common case, and
 * "CONFLICT (modify/delete): <path> deleted in …" / "(rename/…)" variants. Returns the unique
 * paths (empty when the merge was clean). Pure — unit-tested.
 */
export function parseGitConflicts(gitOutput: string): string[] {
  const files = new Set<string>();
  for (const line of gitOutput.split(/\r?\n/)) {
    const content = /Merge conflict in (.+?)\s*$/.exec(line);
    if (content) {
      files.add(content[1]!.trim());
      continue;
    }
    const variant = /^CONFLICT \([^)]*\):\s+(.+?)\s+(?:deleted|added|renamed)\b/.exec(line);
    if (variant) files.add(variant[1]!.trim());
  }
  return [...files];
}

/** Whether a merge result indicates conflicts (non-zero exit AND/OR conflict lines). */
export function mergeHadConflicts(result: { code: number; stdout: string; stderr: string }): boolean {
  if (result.code === 0) return false;
  return parseGitConflicts(`${result.stdout}\n${result.stderr}`).length > 0 || result.code !== 0;
}
