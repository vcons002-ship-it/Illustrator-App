import { describe, expect, it } from "vitest";
import { agentBranchName, parseGitConflicts, mergeHadConflicts, countChangedFiles } from "./coding-agents.js";
import { buildCodingAgentPrompt } from "./subagent.js";
import { parseBuddyToolCall } from "./buddy-tools.js";

describe("buildCodingAgentPrompt", () => {
  it("scopes the agent to its worktree and forbids fan-out / branch work", () => {
    const p = buildCodingAgentPrompt({ title: "API layer", instructions: "add the /users route" }, "/tmp/vr-agents/vr-agent-1");
    expect(p).toContain("/tmp/vr-agents/vr-agent-1");
    expect(p).toContain("API layer");
    expect(p).toContain("add the /users route");
    expect(p).toMatch(/do NOT spawn more agents/i);
    expect(p).toMatch(/verify with run_command/i);
  });
});

describe("parseBuddyToolCall: spawn_coding_agents", () => {
  it("requires 2+ tasks each with title + instructions", () => {
    expect(
      parseBuddyToolCall(
        '{"tool":"spawn_coding_agents","tasks":[{"title":"api","instructions":"do A"},{"title":"ui","instructions":"do B"}]}',
      ),
    ).toEqual({
      tool: "spawn_coding_agents",
      tasks: [
        { title: "api", instructions: "do A" },
        { title: "ui", instructions: "do B" },
      ],
    });
    // 1 task → undefined (use a single write loop); missing instructions → dropped.
    expect(parseBuddyToolCall('{"tool":"spawn_coding_agents","tasks":[{"title":"only","instructions":"x"}]}')).toBeUndefined();
    expect(parseBuddyToolCall('{"tool":"spawn_coding_agents","tasks":[{"title":"a"},{"title":"b"}]}')).toBeUndefined();
  });
});

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

describe("countChangedFiles", () => {
  it("counts diff --git headers, else falls back to the summary line", () => {
    const diff = "diff --git a/x.ts b/x.ts\n@@\n+a\ndiff --git a/y.ts b/y.ts\n@@\n+b\n";
    expect(countChangedFiles(diff)).toBe(2);
    expect(countChangedFiles(" 3 files changed, 9 insertions(+)")).toBe(3);
    expect(countChangedFiles("")).toBe(0);
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
