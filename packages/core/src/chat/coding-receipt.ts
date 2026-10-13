export interface CodingFileChange {
  /** Relative to the workspace shown in the receipt, not the enclosing repository. */
  path: string;
  kind: "created" | "modified" | "deleted" | "unknown";
  added: number | null;
  removed: number | null;
  binary: boolean;
}

export interface CodingTaskReceipt {
  agent: "Codex" | "Aider";
  model: string;
  workspace: string;
  exitCode: number;
  timedOut: boolean;
  changes: CodingFileChange[];
  trackingComplete: boolean;
  trackingNote?: string;
  verify: { status: "passed" | "failed" | "not_requested"; command?: string; output?: string };
  agentOutput: string;
}

/** Render a path as a single safe code span, even if it contains Markdown/control characters. */
function code(value: string): string {
  const safe = value.replace(/[\r\n\t]/g, c => c === "\n" ? "\\n" : c === "\r" ? "\\r" : "\\t");
  const delimiter = "`".repeat(Math.max(0, ...Array.from(safe.matchAll(/`+/g), m => m[0].length)) + 1);
  const padded = safe.startsWith("`") || safe.endsWith("`") ? ` ${safe} ` : safe;
  return `${delimiter}${padded}${delimiter}`;
}

/** User-facing, host-measured facts first; the model's own claims are separate and labeled. */
export function formatCodingTaskReceipt(receipt: CodingTaskReceipt): string {
  const status = receipt.timedOut ? "TIMED OUT" : receipt.exitCode !== 0 ? "FAILED" : receipt.verify.status === "failed" ? "VERIFICATION FAILED" : "Finished";
  const lines = [`${receipt.agent}: ${status} (exit ${receipt.exitCode})`, `Workspace: ${code(receipt.workspace || "Unavailable")}`, `Model: ${code(receipt.model)}`];
  const groups = ["created", "modified", "deleted", "unknown"] as const;
  const counts = groups.map(kind => receipt.changes.filter(f => f.kind === kind).length);
  lines.push(receipt.trackingComplete
    ? `Files: ${receipt.changes.length} — ${counts[0]} created, ${counts[1]} modified, ${counts[2]} deleted${counts[3] ? `, ${counts[3]} unclassified` : ""}`
    : `Files: ${receipt.changes.length} detected (best effort); creation/modification/deletion classification unavailable.`);
  if (receipt.trackingComplete) {
    const text = receipt.changes.filter(f => !f.binary && f.added !== null && f.removed !== null);
    const added = text.reduce((n, f) => n + (f.added ?? 0), 0);
    const removed = text.reduce((n, f) => n + (f.removed ?? 0), 0);
    const binary = receipt.changes.filter(f => f.binary).length;
    lines.push(`Lines: +${added} added / -${removed} removed${binary ? ` (text files only; ${binary} binary file(s))` : ""}`);
    if (!receipt.changes.length) lines.push("No net file changes during this call.");
  } else lines.push("Line counts unavailable — do not interpret this as zero changes.");
  for (const kind of groups) {
    const files = receipt.changes.filter(f => f.kind === kind);
    if (!files.length) continue;
    lines.push("", `${kind === "unknown" ? "Changed (classification unavailable)" : kind.charAt(0).toUpperCase() + kind.slice(1)}:`);
    for (const f of files) lines.push(`- ${code(f.path)} — ${f.binary ? "binary; line counts not applicable" : f.added === null || f.removed === null ? "line counts unavailable" : `+${f.added} / -${f.removed}`}`);
  }
  lines.push("", "Scope: Git-tracked and non-ignored workspace files; app prompt/config/cache files excluded. Renames appear as a deletion and a creation.");
  if (receipt.trackingNote) lines.push(`Tracking: ${receipt.trackingNote}`);
  lines.push(receipt.verify.status === "not_requested"
    ? "Verification: No separate build/test command requested."
    : `Verification: ${receipt.verify.status === "passed" ? "PASSED" : "FAILED"}${receipt.verify.command ? ` — ${code(receipt.verify.command)}` : ""}`);
  if (receipt.verify.output) lines.push(receipt.verify.output);
  if (receipt.agentOutput) lines.push("", "Agent report (self-reported):", receipt.agentOutput);
  return lines.join("\n");
}
