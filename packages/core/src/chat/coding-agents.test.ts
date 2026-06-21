import { describe, expect, it } from "vitest";
import { agentBranchName, parseGitConflicts, mergeHadConflicts } from "./coding-agents.js";

describe("agentBranchName", () => {
  it("is 1-based, filesystem-safe, and run-scoped when given a runId", () => {
    expect(agentBranchName(0)).toBe("vr-agent-1");
    expect(agentBranchName(2)).toBe("vr-agent-3");
    expect(agentBranchName(0, "run_12:34")).toBe("vr-agent-1-run1234");
  });
});

describe("parseGitConflicts", () => {
  it("extracts files from the standard content-conflict lines", () => {
    const out =
      "Auto-merging src/a.ts\n" +
      "CONFLICT (content): Merge conflict in src/a.ts\n" +
      "CONFLICT (add/add): Merge conflict in README.md\n" +
      "Automatic merge failed; fix conflicts and then commit the result.";
    expect(parseGitConflicts(out)).toEqual(["src/a.ts", "README.md"]);
  });

  it("handles modify/delete and rename variants, dedupes", () => {
    const out =
      "CONFLICT (modify/delete): old.txt deleted in HEAD and modified in vr-agent-2\n" +
      "CONFLICT (rename/rename): a.txt renamed to b.txt in HEAD\n" +
      "CONFLICT (content): Merge conflict in src/a.ts\n" +
      "CONFLICT (content): Merge conflict in src/a.ts"; // duplicate
    expect(parseGitConflicts(out)).toEqual(["old.txt", "a.txt", "src/a.ts"]);
  });

  it("returns [] for a clean merge", () => {
    expect(parseGitConflicts("Merge made by the 'ort' strategy.\n 1 file changed")).toEqual([]);
  });
});

describe("mergeHadConflicts", () => {
  it("is false on a clean (code 0) merge, true on a conflicted one", () => {
    expect(mergeHadConflicts({ code: 0, stdout: "Merge made", stderr: "" })).toBe(false);
    expect(
      mergeHadConflicts({ code: 1, stdout: "CONFLICT (content): Merge conflict in a.ts", stderr: "" }),
    ).toBe(true);
  });
});
