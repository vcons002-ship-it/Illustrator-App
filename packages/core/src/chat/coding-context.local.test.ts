/** Opt-in real Codex/Ollama evaluation. Never opens or alters the user's app workspace/profile. */
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildCodingContext } from "./coding-context.js";
import { buildCodexArgs, buildCodexConfigToml, buildDelegatedTask } from "./coding-agent.js";

const live = process.env.VR_CODING_CONTEXT_LIVE === "1";
describe.skipIf(!live)("real local coding context evaluation", () => {
  it("uses requirements supplied only through the ongoing chat and project notes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vr-coding-context-eval-"));
    const home = join(dir, ".vr-codex");
    await mkdir(home);
    const model = process.env.VR_CODING_CONTEXT_MODEL ?? "qwen3.8:27b-q4_K_M";
    await writeFile(join(home, "config.toml"), buildCodexConfigToml({ model, baseUrl: "http://localhost:11434/v1", windows: process.platform === "win32" }));
    const context = buildCodingContext({
      chatId: "eval", chatLabel: "Invoice evaluation", projectName: "Billing test",
      messages: [
        { role: "user", text: "Our public API must be an ES module invoice-label.mjs exporting formatInvoiceLabel(cents). Its input is integer cents. Format EUR amounts with exactly two decimals. No packages or network calls." },
        { role: "assistant", text: "I will preserve that API and use Node's built-in test runner." },
      ],
      plan: { goal: "Invoice labels", steps: [{ text: "Implement formatter and boundary tests", status: "pending" }] },
      referencedFiles: [],
    }, [{ path: "notes/decisions.md", status: "included", text: "Invoice labels must begin with the literal prefix [Invoice] followed by one space. Expected example: [Invoice] EUR 12.34. Zero cents: [Invoice] EUR 0.00." }]);
    const prompt = buildDelegatedTask("Implement the invoice formatter we agreed on. Add tests and run them. Use the agreed API and project decisions.", context.text);
    await writeFile(join(dir, ".vr-coding-task.md"), prompt);
    const cli = process.env.VR_CODEX_CLI ?? join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    let output = "";
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...buildCodexArgs({ model })], { cwd: dir, env: { ...process.env, CODEX_HOME: home }, windowsHide: true });
      const timer = setTimeout(() => {
        if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill("SIGKILL");
      }, 180_000);
      child.stdout.on("data", b => { output = (output + String(b)).slice(-16_000); });
      child.stderr.on("data", b => { output = (output + String(b)).slice(-16_000); });
      child.on("error", e => { clearTimeout(timer); reject(e); });
      child.on("close", exit => { clearTimeout(timer); resolve(exit); });
      child.stdin.end(prompt);
    });
    const readable = output.split("\n").filter(line => !line.includes("codex_otel") && !line.startsWith(":session_telemetry:")).slice(-35).join("\n");
    console.log(`Local context evaluation retained at: ${dir}\n${readable}`);
    expect(code).toBe(0);
    expect(await readFile(join(dir, "invoice-label.mjs"), "utf8")).toContain("formatInvoiceLabel");
    const verification = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", "import {formatInvoiceLabel} from './invoice-label.mjs'; import assert from 'node:assert/strict'; assert.equal(formatInvoiceLabel(1234),'[Invoice] EUR 12.34'); assert.equal(formatInvoiceLabel(0),'[Invoice] EUR 0.00'); console.log('Independent API/context assertions passed');"], { cwd: dir, windowsHide: true });
      let text = "";
      child.stdout.on("data", b => { text += String(b); });
      child.stderr.on("data", b => { text += String(b); });
      child.on("error", reject);
      child.on("close", exit => resolve({ code: exit, output: text }));
    });
    console.log(verification.output);
    expect(verification.code).toBe(0);
  }, 200_000);
});
