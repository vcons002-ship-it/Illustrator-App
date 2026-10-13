import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@visual-reader/core", async () => ({
  ...(await import("../../../packages/core/src/chat/coding-agent.js")),
  ...(await import("../../../packages/core/src/chat/coding-receipt.js")),
  ...(await import("../../../packages/core/src/chat/coding-context.js")),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function delegateFixture(agentExit: number, changed: boolean, listingExit = 0, cacheFlood = false, priorEdit?: "tracked-unchanged" | "untracked-changed", measured?: import("../../../packages/core/src/chat/coding-receipt.js").CodingFileChange[], compareFails = false, verifyMode?: "passed" | "failed" | "timedout", withContext = false) {
  const writes = new Map<string, string>();
  const commands: { command: string; shell: string | undefined }[] = [];
  let statusCalls = 0;
  let reads = 0;
  const invoke = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "read_coding_context_file") {
      if (!withContext) throw new Error("Older host: context note reader unavailable");
      if (args.relPath === "CONVENTIONS.md") throw new Error("Note points outside selected workspace");
      return args.relPath === "notes/decisions.md"
        ? { exists: true, text: "Invoice totals must be rounded only at display time.", truncated: false }
        : { exists: false, text: "", truncated: false };
    }
    if (name === "coding_workspace_snapshot") {
      if (!measured) throw new Error("This older desktop does not support detailed tracking");
      return { tree: "a".repeat(40), workspace: "C:/evaluation" };
    }
    if (name === "coding_workspace_changes") {
      if (compareFails) throw new Error("comparison unavailable");
      return measured;
    }
    if (name === "read_workspace_file") {
      const bodyBase64 = priorEdit === "untracked-changed" && reads++ > 0 ? "YWZ0ZXI=" : "YmVmb3Jl";
      return { exists: true, path: `C:/evaluation/${args.relPath}`, bodyBase64 };
    }
    if (name === "write_workspace_file") {
      writes.set(String(args.relPath), String(args.contentBase64));
      return `C:/evaluation/${args.relPath}`;
    }
    if (name !== "run_command") throw new Error(`Unexpected bridge call: ${name}`);
    const command = String(args.command);
    commands.push({ command, shell: args.shell as string | undefined });
    let stdout = "";
    let stderr = "";
    let code = 0;
    if (command === "codex --version") stdout = "codex-cli 0.147.0";
    else if (command === "git rev-parse --show-toplevel") stdout = "C:/evaluation";
    else if (command === "git rev-parse HEAD") stdout = "abc123";
    else if (command === "git rev-parse --show-prefix") stdout = "";
    else if (command.startsWith("git status")) {
      statusCalls++;
      if (priorEdit) stdout = (priorEdit === "tracked-unchanged" ? " M " : "?? ") + "invoice-total.mjs\n";
      if (statusCalls > 1) {
        const cache = cacheFlood ? "?? .vr-codex/cache/plugin.json\n".repeat(3000) : "?? .vr-codex/config.toml\n?? .vr-coding-task.md\n";
        stdout += ((command.includes('":(exclude).vr-codex/**"') ? "" : cache) + (changed ? "?? normalize-title.mjs\n" : "")).slice(0, 24000);
      }
    } else if (command.startsWith("set ")) { code = agentExit; stderr = agentExit ? "unexpected argument --full-auto" : ""; }
    else if (command === "dir /b") { code = listingExit; stdout = listingExit ? "" : "invoice-total.mjs\ninvoice-total.test.mjs"; stderr = listingExit ? "directory query failed" : ""; }
    else if (command === "verify-coding-task") { code = verifyMode === "failed" ? 1 : 0; stdout = "verification output"; }
    else if (command.startsWith("git diff --name-only") && priorEdit === "tracked-unchanged") stdout = "invoice-total.mjs\n";
    else if (!command.startsWith("git diff")) throw new Error(`Unexpected command: ${command}`);
    return { stdout, stderr, code, timedOut: command === "verify-coding-task" && verifyMode === "timedout", cwd: "C:/evaluation" };
  });
  vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
  vi.stubGlobal("navigator", { platform: "Win32" });
  const { delegateCodingTask } = await import("./runtime.js");
  const result = await delegateCodingTask({ task: "Create a utility", backend: "codex", model: "local-model", textServerUrl: "http://localhost:11434", cwd: "C:/evaluation", ...(verifyMode ? { verify: "verify-coding-task" } : {}), ...(withContext ? { chatContext: {
    chatId: "invoice-chat", chatLabel: "Invoice chat", projectName: "Billing",
    messages: [{ role: "user" as const, text: "Use integer cents for money." }],
    plan: { goal: "Repair invoice totals", steps: [{ text: "Test rounding", status: "pending" as const }] },
    referencedFiles: ["invoice-total.mjs"],
  } } : {}) });
  return { result, writes, commands, invoke };
}

describe("live delegation bridge behavior", () => {
  it("stages actual chat, plan, file hints and project note contents before launch in the same workspace", async () => {
    const { writes, result, invoke } = await delegateFixture(0, false, 0, false, undefined, [], false, undefined, true);
    const prompt = Buffer.from(writes.get(".vr-coding-task.md")!, "base64").toString("utf8");
    expect(prompt.startsWith("Create a utility")).toBe(true);
    for (const text of ["Use integer cents for money.", "Test rounding", "invoice-total.mjs", "Invoice totals must be rounded only at display time."]) expect(prompt).toContain(text);
    expect(result.summary).toContain("Context sent to coding agent:");
    expect(result.summary).toContain("CONVENTIONS.md: unavailable");
    expect(result.receipt?.context?.messagesIncluded).toBe(1);
    const launch = invoke.mock.calls.findIndex(c => c[0] === "run_command" && String(c[1].command).startsWith("set "));
    invoke.mock.calls.forEach((c, index) => {
      if (c[0] === "read_coding_context_file") { expect(index).toBeLessThan(launch); expect(c[1].dir).toBe("C:/evaluation"); }
      if (c[0] === "write_workspace_file") expect(c[1].cwd).toBe("C:/evaluation");
    });
  });
  it("flags unavailable context notes on an older host instead of silently claiming they were loaded", async () => {
    const { writes, result } = await delegateFixture(0, false);
    expect(result.summary).toContain("AGENTS.md: unavailable");
    expect(result.receipt?.context?.documents.every(d => d.status === "unavailable")).toBe(true);
    const prompt = Buffer.from(writes.get(".vr-coding-task.md")!, "base64").toString("utf8");
    expect(prompt).toContain('"status":"unavailable"');
  });
  it("uses cmd for older Windows settings and passes the exact staged dotfile paths", async () => {
    const { result, writes, commands } = await delegateFixture(0, true);
    expect(result.ok).toBe(true);
    expect(result.files).toEqual(["normalize-title.mjs"]);
    expect(writes.has(".vr-coding-task.md")).toBe(true);
    expect(writes.has(".vr-codex/config.toml")).toBe(true);
    expect(commands.every(c => c.shell === "cmd")).toBe(true);
    const launch = commands.find(c => c.command.startsWith("set "))!.command;
    expect(launch).toContain('set "CODEX_HOME=C:/evaluation/.vr-codex"');
    expect(launch).toContain("--sandbox workspace-write");
    expect(launch).toContain("< .vr-coding-task.md");
    expect(launch).not.toContain("--full-auto");
  });
  it("does not turn a failed process or generated config into success", async () => {
    const { result } = await delegateFixture(1, false);
    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.summary).toContain("unexpected argument");
    expect(result.summary).toContain("invoice-total.mjs");
    expect(result.summary).not.toContain("EMPTY");
  });
  it("keeps partial work visible but reports a failed run as failure", async () => {
    const { result } = await delegateFixture(1, true);
    expect(result.ok).toBe(false);
    expect(result.files).toEqual(["normalize-title.mjs"]);
    expect(result.summary).toContain("unexpected argument");
  });
  it("never claims an empty directory when its listing command failed", async () => {
    const { result } = await delegateFixture(1, false, 1);
    expect(result.summary).toContain("Couldn't list the working folder");
    expect(result.summary).not.toContain("EMPTY");
  });
  it("reports project edits even when Codex's cache exceeds the host output cap", async () => {
    const { result } = await delegateFixture(0, true, 0, true);
    expect(result.files).toEqual(["normalize-title.mjs"]);
  });
  it("does not count an unchanged edit from an earlier job", async () => {
    const { result } = await delegateFixture(0, true, 0, false, "tracked-unchanged");
    expect(result.files).toEqual(["normalize-title.mjs"]);
  });
  it("detects edits to files that were already untracked", async () => {
    const { result } = await delegateFixture(0, false, 0, false, "untracked-changed");
    expect(result.files).toEqual(["invoice-total.mjs"]);
  });
  it("uses the native before/after result instead of a misleading legacy diff", async () => {
    const changes = [{ path: "src/new.ts", kind: "created" as const, added: 8, removed: 0, binary: false }, { path: "src/old.ts", kind: "modified" as const, added: 2, removed: 1, binary: false }];
    const { result, invoke } = await delegateFixture(0, true, 0, false, undefined, changes);
    expect(result.files).toEqual(["src/new.ts", "src/old.ts"]);
    expect(result.receipt?.workspace).toBe("C:/evaluation");
    expect(result.summary).toContain("Lines: +10 added / -1 removed");
    expect(result.summary).toContain("1 created, 1 modified, 0 deleted");
    expect(result.summary).not.toContain("normalize-title.mjs");
    const beforeCall = invoke.mock.calls.findIndex(c => c[0] === "coding_workspace_snapshot");
    const launchCall = invoke.mock.calls.findIndex(c => c[0] === "run_command" && String(c[1].command).startsWith("set "));
    const afterCall = invoke.mock.calls.findIndex(c => c[0] === "coding_workspace_changes");
    expect(beforeCall).toBeLessThan(launchCall);
    expect(afterCall).toBeGreaterThan(launchCall);
  });
  it("reports deleted files but does not add nonexistent paths to the file ledger", async () => {
    const { result } = await delegateFixture(0, false, 0, false, undefined, [{ path: "removed.ts", kind: "deleted", added: 0, removed: 7, binary: false }]);
    expect(result.files).toEqual([]);
    expect(result.receipt?.changes[0]?.kind).toBe("deleted");
    expect(result.summary).toContain("0 created, 0 modified, 1 deleted");
    expect(result.summary).toContain("Lines: +0 added / -7 removed");
  });
  it("warns when an older host cannot produce reliable line counts", async () => {
    const { result } = await delegateFixture(0, true);
    expect(result.receipt?.trackingComplete).toBe(false);
    expect(result.summary).toContain("Line counts unavailable");
    expect(result.summary).not.toContain("Lines: +0");
  });
  it("does not turn a failed after-snapshot into a zero-change success report", async () => {
    const { result } = await delegateFixture(0, true, 0, false, undefined, [], true);
    expect(result.receipt?.trackingComplete).toBe(false);
    expect(result.receipt?.trackingNote).toContain("comparison unavailable");
    expect(result.summary).toContain("best effort");
  });
  it("keeps partial changes and the failure exit together in the receipt", async () => {
    const { result } = await delegateFixture(1, false, 0, false, undefined, [{ path: "partial.ts", kind: "created", added: 3, removed: 0, binary: false }]);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("Codex: FAILED (exit 1)");
    expect(result.summary).toContain("partial.ts");
  });
  it("shows independently run verification and its output", async () => {
    const { result } = await delegateFixture(0, false, 0, false, undefined, [], false, "passed");
    expect(result.ok).toBe(true);
    expect(result.receipt?.verify.status).toBe("passed");
    expect(result.summary).toContain("Verification: PASSED");
    expect(result.summary).toContain("verification output");
  });
  it("does not report completed coding as verified when the test command failed or timed out", async () => {
    for (const mode of ["failed", "timedout"] as const) {
      const { result } = await delegateFixture(0, false, 0, false, undefined, [], false, mode);
      expect(result.ok).toBe(false);
      expect(result.summary).toContain("VERIFICATION FAILED");
      expect(result.receipt?.verify.status).toBe("failed");
    }
  });
});
