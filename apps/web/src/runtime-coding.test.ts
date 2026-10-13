import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@visual-reader/core", async () => ({
  ...(await import("../../../packages/core/src/chat/coding-agent.js")),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function delegateFixture(agentExit: number, changed: boolean, listingExit = 0, cacheFlood = false) {
  const writes = new Map<string, string>();
  const commands: { command: string; shell: string | undefined }[] = [];
  let statusCalls = 0;
  const invoke = vi.fn(async (name: string, args: Record<string, unknown>) => {
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
    else if (command.startsWith("git status")) {
      statusCalls++;
      if (statusCalls > 1) {
        const cache = cacheFlood ? "?? .vr-codex/cache/plugin.json\n".repeat(3000) : "?? .vr-codex/config.toml\n?? .vr-coding-task.md\n";
        stdout = ((command.includes('":(exclude).vr-codex/**"') ? "" : cache) + (changed ? "?? normalize-title.mjs\n" : "")).slice(0, 24000);
      }
    } else if (command.startsWith("set ")) { code = agentExit; stderr = agentExit ? "unexpected argument --full-auto" : ""; }
    else if (command === "dir /b") { code = listingExit; stdout = listingExit ? "" : "invoice-total.mjs\ninvoice-total.test.mjs"; stderr = listingExit ? "directory query failed" : ""; }
    else if (!command.startsWith("git diff")) throw new Error(`Unexpected command: ${command}`);
    return { stdout, stderr, code, timedOut: false, cwd: "C:/evaluation" };
  });
  vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
  vi.stubGlobal("navigator", { platform: "Win32" });
  const { delegateCodingTask } = await import("./runtime.js");
  const result = await delegateCodingTask({ task: "Create a utility", backend: "codex", model: "local-model", textServerUrl: "http://localhost:11434", cwd: "C:/evaluation" });
  return { result, writes, commands };
}

describe("live delegation bridge behavior", () => {
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
});
