import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentChangedFiles,
  buildAiderArgs,
  buildCodexArgs,
  buildCodexConfigToml,
  codexBaseUrl,
  parsePorcelainPaths,
  quotePosixCommand,
  ollamaApiBase,
  MAX_DELEGATE_FILES,
} from "./coding-agent.js";

describe("buildAiderArgs", () => {
  it("pins a single model to Ollama and reads the task from a file", () => {
    const args = buildAiderArgs({ messageFile: ".vr-task.txt", model: "qwen2.5-coder:32b" });
    expect(args).toContain("--yes-always");
    expect(args).toContain("--no-stream");
    expect(args).toEqual(expect.arrayContaining(["--model", "ollama/qwen2.5-coder:32b"]));
    expect(args).not.toContain("--architect");
    // task is handed over as a file, last
    expect(args.slice(-2)).toEqual(["--message-file", ".vr-task.txt"]);
  });

  it("uses architect/editor split when an editor model is given", () => {
    const args = buildAiderArgs({ messageFile: "t.txt", model: "qwen2.5-coder:32b", editorModel: "qwen2.5-coder:7b" });
    expect(args).toContain("--architect");
    expect(args).toEqual(expect.arrayContaining(["--model", "ollama/qwen2.5-coder:32b"]));
    expect(args).toEqual(expect.arrayContaining(["--editor-model", "ollama/qwen2.5-coder:7b"]));
  });

  it("seeds named files, dropping blanks and capping the count", () => {
    const files = ["a.py", "  ", "b.py", ...Array.from({ length: 50 }, (_, i) => `f${i}.py`)];
    const args = buildAiderArgs({ messageFile: "t.txt", model: "m", files });
    expect(args).toContain("a.py");
    expect(args).toContain("b.py");
    expect(args).not.toContain("  ");
    const fileArgs = args.filter((a) => a.endsWith(".py"));
    expect(fileArgs.length).toBeLessThanOrEqual(MAX_DELEGATE_FILES);
  });
});

describe("buildCodexArgs", () => {
  // This test used to assert `--oss --local-provider ollama`, and asserting it is how a flag Codex
  // has never had survived: the argv was checked against itself and never against the CLI. Changed
  // deliberately — the model is pinned by config now (buildCodexConfigToml), not by these flags.
  it("runs exec non-interactive, reading the prompt from stdin", () => {
    const args = buildCodexArgs({ model: "gpt-oss:20b" });
    expect(args[0]).toBe("exec");
    expect(args).toEqual(expect.arrayContaining(["-m", "gpt-oss:20b", "--full-auto", "--skip-git-repo-check"]));
    expect(args[args.length - 1]).toBe("-"); // prompt comes from stdin
  });
});

describe("quotePosixCommand", () => {
  it("leaves safe tokens bare and quotes the rest", () => {
    expect(quotePosixCommand(["aider", "--model", "ollama/m:32b"])).toBe("aider --model ollama/m:32b");
    expect(quotePosixCommand(["aider", "my file.txt"])).toBe("aider 'my file.txt'");
  });

  it("escapes embedded single quotes safely", () => {
    expect(quotePosixCommand(["echo", "it's"])).toBe("echo 'it'\\''s'");
  });
});

describe("ollamaApiBase", () => {
  it("strips a trailing /v1 and slashes to Aider's expected root", () => {
    expect(ollamaApiBase("http://localhost:11434/v1")).toBe("http://localhost:11434");
    expect(ollamaApiBase("http://localhost:11434/v1/")).toBe("http://localhost:11434");
    expect(ollamaApiBase("http://host:11434")).toBe("http://host:11434");
  });
});

/**
 * THREE REASONS A DELEGATED RUN REPORTED FAILURE WHEN IT HAD WORKED.
 *
 * The pure argv builders above were always right; every fault was in the runtime around them, and
 * all three produced the same misleading sentence — "ran but changed no files" — which reads as
 * "your task was wrong, rewrite it" when the truth was the opposite each time.
 *
 * Read as text: the runtime talks to a shell and a Tauri host, neither of which exists here.
 */
describe("the delegation runtime's failure modes", () => {
  const RUNTIME = readFileSync(join(import.meta.dirname, "../../../../apps/web/src/runtime.ts"), "utf8");
  const HOST = readFileSync(join(import.meta.dirname, "../../../../apps/desktop/src-tauri/src/main.rs"), "utf8");

  it("gives the agent a deadline it can actually finish inside", () => {
    // An external agent editing several files against a local model runs for tens of minutes; the
    // ordinary four-minute command ceiling killed it mid-edit, leaving a half-applied change AND a
    // report that nothing happened.
    expect(RUNTIME).toContain("const AGENT_TIMEOUT_SECS = 90 * 60;");
    expect(RUNTIME).toContain("opts.shell, false, AGENT_TIMEOUT_SECS)");
    // Only that one call: the version probe and the git plumbing keep the normal ceiling.
    expect(RUNTIME).toContain("runCommand(command, opts.githubToken, opts.cwd, opts.shell, false, undefined)");
  });

  it("bounds what a caller may ask for, in both directions", () => {
    expect(HOST).toContain("timeout_secs: Option<u64>,");
    expect(HOST).toContain(".clamp(COMMAND_TIMEOUT_SECS, COMMAND_MAX_TIMEOUT_SECS)");
    expect(HOST).toContain("let deadline = Instant::now() + Duration::from_secs(timeout);");
    // The floor is what keeps this from becoming a way to SHORTEN a command's life; the ceiling is
    // what keeps "no timeout" impossible.
    expect(HOST).toMatch(/const COMMAND_MAX_TIMEOUT_SECS: u64 = 3 \* 60 \* 60;/);
  });

  it("lists untracked files individually, so they can be excluded and shown", () => {
    expect(RUNTIME).toContain('git status --porcelain -uall -- .');
    expect(RUNTIME).toContain("excludeDirs: [CODEX_HOME_DIR]");
  });

  it("names the changed files instead of only counting them", () => {
    // "changed 1 file(s)" is a claim with nothing behind it; a list can be checked, a number cannot.
    expect(RUNTIME).toContain("const fileList = names.length ? `\\nFiles: ${names.join(\", \")}` : \"\";");
    // And the agent's own output is shown whenever the run did not cleanly succeed.
    expect(RUNTIME).toContain("const tailLine = ok || !tail ?");
  });

  it("reports what changed WITHOUT staging or committing anything", () => {
    // `git diff <sha> HEAD` compared two COMMITS, so it saw nothing unless the agent committed — and
    // Codex, unlike Aider, edits the working tree and leaves committing to you. The obvious repair,
    // staging first, is worse than the bug: `git add -A` reaches the whole repository from any
    // subdirectory, so a workspace inside the reader's own project would sweep up unrelated work.
    expect(RUNTIME).not.toMatch(/\$\{beforeSha\} HEAD/);
    expect(RUNTIME, "the delegation runner must never stage").not.toMatch(/run\("git add -A"\)/);
    expect(RUNTIME, "the delegation runner must never commit").not.toMatch(/git commit -m "before delegate/);
    expect(RUNTIME).toContain('await run("git status --porcelain -uall -- .")');
    expect(RUNTIME).toContain("names = agentChangedFiles({");
    // Our own scaffolding is not the agent's work.
    expect(RUNTIME).toContain("exclude: [CODING_TASK_FILE],");
  });

  it("pins Codex to the reader's own Ollama server through a config file it owns", () => {
    // A real run answered from gpt-5.6 on a local-only box: Codex read the reader's ~/.codex config,
    // and `OLLAMA_HOST` — which this used to set — is not a variable Codex reads.
    expect(RUNTIME).not.toContain("OLLAMA_HOST=");
    expect(RUNTIME).toContain('const CODEX_HOME_DIR = ".vr-codex";');
    expect(RUNTIME).toContain("buildCodexConfigToml({ model: opts.model, baseUrl: codexBaseUrl(opts.textServerUrl) })");
    expect(RUNTIME).toMatch(/CODEX_HOME=/);
  });

  it("makes the folder a repo first, since the whole report is a git diff", () => {
    // The default workspace is a plain directory, so every delegated run in it came back empty.
    expect(RUNTIME).toContain('const probe = await run("git rev-parse --show-toplevel");');
    // The folder the command ACTUALLY ran in — opts.cwd is optional and the host resolves its own.
    expect(RUNTIME).toContain("workDir = probe.cwd || workDir;");
    expect(RUNTIME).toContain("if (workDir) await gitEnsureRepo(workDir);");
  });

  it("says when it was stopped at the deadline instead of calling it a no-op", () => {
    // "Changed no files" means rewrite the task; being stopped means the opposite — split it.
    expect(RUNTIME).toContain("agent.timedOut");
    expect(RUNTIME).toContain("const timedOutLine = agent.timedOut");
    expect(RUNTIME).toContain("verifyOk && !agent.timedOut");
  });
});

/**
 * A REAL RUN ON A REAL BOX ANSWERED FROM `gpt-5.6`, on a machine set up to be local-only. Two causes,
 * both here: an argv that named a flag Codex does not have, and no configuration pinning the model —
 * so Codex fell back to whatever `~/.codex/config.toml` said, which for anyone who has run it
 * normally is an OpenAI model.
 */
describe("buildCodexArgs", () => {
  it("does not pass flags Codex has no idea about", () => {
    const args = buildCodexArgs({ model: "qwen2.5-coder:32b" });
    // `--local-provider` is not a Codex flag. An unknown flag makes `codex exec` exit on its own
    // usage error before doing any work — so delegation could only ever have failed.
    expect(args).not.toContain("--local-provider");
    expect(args).not.toContain("ollama");
  });

  it("still names the model on the command line, as a belt to the config's braces", () => {
    expect(buildCodexArgs({ model: "qwen2.5-coder:32b" })).toEqual(
      expect.arrayContaining(["-m", "qwen2.5-coder:32b"]),
    );
  });

  it("reads the task from stdin and applies without prompting", () => {
    const args = buildCodexArgs({ model: "m" });
    expect(args[0]).toBe("exec");
    expect(args).toContain("--full-auto");
    expect(args.at(-1)).toBe("-");
  });
});

describe("buildCodexConfigToml", () => {
  const toml = buildCodexConfigToml({ model: "qwen2.5-coder:32b", baseUrl: "http://localhost:11434/v1" });

  it("selects our own provider, so the reader's ~/.codex default cannot win", () => {
    expect(toml).toContain('model_provider = "vr-ollama"');
    expect(toml).toContain("[model_providers.vr-ollama]");
    expect(toml).toContain('model = "qwen2.5-coder:32b"');
    expect(toml).toContain('base_url = "http://localhost:11434/v1"');
    expect(toml).toContain('wire_api = "responses"');
  });

  it("asks for no API key, so a local run never needs one", () => {
    expect(toml).not.toContain("env_key");
  });

  it("quotes values as TOML, whatever the model id contains", () => {
    expect(buildCodexConfigToml({ model: 'we"ird', baseUrl: "http://h/v1" })).toContain('model = "we\\"ird"');
  });
});

describe("codexBaseUrl", () => {
  it("KEEPS /v1 — the opposite of what Aider wants from the same setting", () => {
    // Aider is given the server root and appends the OpenAI path itself; Codex is given the
    // OpenAI-compatible endpoint whole. One setting, two shapes.
    expect(codexBaseUrl("http://localhost:11434")).toBe("http://localhost:11434/v1");
    expect(ollamaApiBase("http://localhost:11434/v1")).toBe("http://localhost:11434");
  });

  it("does not double a /v1 that is already there", () => {
    expect(codexBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(codexBaseUrl("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
  });
});

describe("parsePorcelainPaths", () => {
  it("reads the path out of each status line", () => {
    expect(parsePorcelainPaths(" M src/a.ts\n?? new.txt\nA  b.md")).toEqual(["src/a.ts", "new.txt", "b.md"]);
  });

  it("takes the NEW name of a rename — the old one no longer exists", () => {
    expect(parsePorcelainPaths("R  old.ts -> new.ts")).toEqual(["new.ts"]);
  });

  it("unwraps a path git quoted because of unusual characters", () => {
    expect(parsePorcelainPaths('?? "odd name.txt"')).toEqual(["odd name.txt"]);
  });

  it("ignores blank and truncated lines", () => {
    expect(parsePorcelainPaths("\n \n M x")).toEqual(["x"]);
  });
});

describe("agentChangedFiles", () => {
  it("sees work the agent COMMITTED (what Aider does)", () => {
    expect(agentChangedFiles({ dirtyBefore: "", dirtyAfter: "", committed: "src/a.ts\nsrc/b.ts" })).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("sees work the agent left UNCOMMITTED (what Codex does)", () => {
    // `git diff <sha> HEAD` compares two commits and reported nothing at all for this case.
    expect(agentChangedFiles({ dirtyBefore: "", dirtyAfter: " M src/a.ts", committed: "" })).toEqual(["src/a.ts"]);
  });

  it("sees a brand-new file, which a plain diff misses either way", () => {
    expect(agentChangedFiles({ dirtyBefore: "", dirtyAfter: "?? page.html", committed: "" })).toEqual(["page.html"]);
  });

  it("does not blame the agent for a mess that was already there", () => {
    expect(
      agentChangedFiles({ dirtyBefore: " M notes.md", dirtyAfter: " M notes.md\n?? page.html", committed: "" }),
    ).toEqual(["page.html"]);
  });

  it("excludes a whole directory of ours, including git's COLLAPSED form of it", () => {
    // git reports an untracked DIRECTORY as one `?? dir/` entry rather than listing what is inside,
    // so an exact-path exclusion of `dir/file` never matched — and our own generated Codex config
    // was counted as the agent's one changed file. One leaked entry was enough to make the assistant
    // believe a run had produced a project and go hunting for files that were never written.
    expect(
      agentChangedFiles({ dirtyBefore: "", dirtyAfter: "?? .vr-codex/", committed: "", excludeDirs: [".vr-codex"] }),
    ).toEqual([]);
    // …and the expanded form `-uall` produces.
    expect(
      agentChangedFiles({
        dirtyBefore: "",
        dirtyAfter: "?? .vr-codex/config.toml\n?? main.py",
        committed: "",
        excludeDirs: [".vr-codex"],
      }),
    ).toEqual(["main.py"]);
  });

  it("does not mistake a similarly-named file for the excluded directory", () => {
    expect(
      agentChangedFiles({ dirtyBefore: "", dirtyAfter: "?? .vr-codex-notes.md", committed: "", excludeDirs: [".vr-codex"] }),
    ).toEqual([".vr-codex-notes.md"]);
  });

  it("never reports our own scaffolding as the agent's work", () => {
    expect(
      agentChangedFiles({
        dirtyBefore: "",
        dirtyAfter: "?? .vr-coding-task.md\n?? page.html",
        committed: "",
        exclude: [".vr-coding-task.md"],
      }),
    ).toEqual(["page.html"]);
  });

  it("reports a file once when it is both committed and dirty", () => {
    expect(agentChangedFiles({ dirtyBefore: "", dirtyAfter: " M a.ts", committed: "a.ts" })).toEqual(["a.ts"]);
  });
});

describe("what the delegated agent is told besides the job", () => {
  /**
   * The agent runs headless and, as the tool's own description says, "doesn't see this chat" — so no
   * workspace convention reaches it, and it names things the way an agent with no context does:
   * main.py, test_main.py, app.js. Reported as everything being called something generic and the
   * workspace becoming hard to look through. The task file is the only channel there is.
   */
  it("carries the naming convention the agent cannot otherwise see", async () => {
    const { buildDelegatedTask, DELEGATED_CONVENTIONS } = await import("./coding-agent.js");
    const out = buildDelegatedTask("Add a retry to the fetch helper.");
    expect(out.startsWith("Add a retry to the fetch helper.")).toBe(true); // the job leads
    expect(out).toContain(DELEGATED_CONVENTIONS);
    expect(out).toContain("NAME FILES FOR WHAT THEY DO");
    expect(out).toContain("`main.py`, `app.js`, `index.js`, `script.py` and `code.html` are NOT names");
    // A revision is not a new file, and an unasked-for scaffold is not the job.
    expect(out).toContain("revise a file IN PLACE");
    expect(out).toContain("Do not add a project scaffold");
  });

  it("still says something when the spec is empty", async () => {
    const { buildDelegatedTask } = await import("./coding-agent.js");
    expect(buildDelegatedTask("   ")).toContain("NAME FILES FOR WHAT THEY DO");
  });
});
