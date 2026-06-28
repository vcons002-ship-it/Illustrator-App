import { describe, expect, it } from "vitest";
import { buildAiderArgs, buildCodexArgs, quotePosixCommand, ollamaApiBase, MAX_DELEGATE_FILES } from "./coding-agent.js";

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
  it("runs exec non-interactive against the local Ollama model, reading the prompt from stdin", () => {
    const args = buildCodexArgs({ model: "gpt-oss:20b" });
    expect(args[0]).toBe("exec");
    expect(args).toEqual(expect.arrayContaining(["--oss", "--local-provider", "ollama", "-m", "gpt-oss:20b", "--full-auto"]));
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
