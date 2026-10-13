import { describe, expect, it } from "vitest";
import { formatCodingTaskReceipt, type CodingTaskReceipt } from "./coding-receipt.js";

const baseline: CodingTaskReceipt = {
  agent: "Codex", model: "local-model", workspace: "C:/Projects/Alpha", exitCode: 0, timedOut: false,
  changes: [], trackingComplete: true, verify: { status: "not_requested" }, agentOutput: "",
};
describe("coding call receipts", () => {
  it("shows the exact workspace, categories, per-file counts and totals", () => {
    const report = formatCodingTaskReceipt({ ...baseline, changes: [
      { path: "src/new.ts", kind: "created", added: 12, removed: 0, binary: false },
      { path: "src/old.ts", kind: "modified", added: 3, removed: 2, binary: false },
      { path: "obsolete.ts", kind: "deleted", added: 0, removed: 4, binary: false },
    ] });
    expect(report).toContain("C:/Projects/Alpha");
    expect(report).toContain("Files: 3 — 1 created, 1 modified, 1 deleted");
    expect(report).toContain("Lines: +15 added / -6 removed");
    expect(report).toContain("Created:\n- `src/new.ts` — +12 / -0");
    expect(report).toContain("Modified:\n- `src/old.ts` — +3 / -2");
    expect(report).toContain("Deleted:\n- `obsolete.ts` — +0 / -4");
  });
  it("never labels partial edits as success after a failed process", () => {
    const report = formatCodingTaskReceipt({ ...baseline, exitCode: 1, changes: [{ path: "partial.ts", kind: "created", added: 2, removed: 0, binary: false }] });
    expect(report).toContain("Codex: FAILED (exit 1)");
    expect(report).toContain("partial.ts");
  });
  it("keeps timeout and independent verification failures explicit", () => {
    expect(formatCodingTaskReceipt({ ...baseline, timedOut: true })).toContain("TIMED OUT");
    const report = formatCodingTaskReceipt({ ...baseline, verify: { status: "failed", command: "npm test", output: "1 assertion failed" } });
    expect(report).toContain("VERIFICATION FAILED");
    expect(report).toContain("Verification: FAILED");
    expect(report).toContain("1 assertion failed");
  });
  it("separates agent claims from measured changes and verification", () => {
    const report = formatCodingTaskReceipt({ ...baseline, agentOutput: "I changed 500 files and all tests passed." });
    expect(report).toContain("Files: 0");
    expect(report).toContain("No net file changes during this call.");
    expect(report).toContain("No separate build/test command requested");
    expect(report).toContain("Agent report (self-reported):\nI changed 500 files");
  });
  it("labels binary files without inventing line counts", () => {
    const report = formatCodingTaskReceipt({ ...baseline, changes: [{ path: "image.png", kind: "created", added: null, removed: null, binary: true }] });
    expect(report).toContain("text files only; 1 binary");
    expect(report).toContain("binary; line counts not applicable");
  });
  it("does not claim zero lines if detailed tracking failed", () => {
    const report = formatCodingTaskReceipt({ ...baseline, trackingComplete: false, trackingNote: "snapshot unavailable", changes: [{ path: "changed.ts", kind: "unknown", added: null, removed: null, binary: false }] });
    expect(report).toContain("best effort");
    expect(report).toContain("Line counts unavailable");
    expect(report).not.toContain("Lines: +0");
    expect(report).not.toContain("No net file changes");
    expect(report).toContain("snapshot unavailable");
  });
  it("escapes embedded newlines and backticks in filenames", () => {
    const report = formatCodingTaskReceipt({ ...baseline, changes: [{ path: "weird`name\nfile.ts", kind: "created", added: 1, removed: 0, binary: false }] });
    expect(report).toContain("``weird`name\\nfile.ts``");
  });
  it("keeps independently passed verification separate from the agent's output", () => {
    expect(formatCodingTaskReceipt({ ...baseline, verify: { status: "passed", command: "node --test" } })).toContain("Verification: PASSED");
  });
});
