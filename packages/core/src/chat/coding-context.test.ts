import { describe, expect, it } from "vitest";
import { buildCodingContext, codingReferencePath, formatCodingContextManifest, MAX_CODING_CONTEXT_CHARS, redactCodingSecrets, type CodingChatContext } from "./coding-context.js";
import { buildDelegatedTask } from "./coding-agent.js";

const chat: CodingChatContext = {
  chatId: "chat-one", chatLabel: "Invoice project", projectName: "Invoicing",
  messages: [{ role: "user", text: "Use EUR, not dollars." }, { role: "assistant", text: "The invoice parser already exists." }],
  plan: { goal: "Parse invoices", steps: [{ text: "Add parser", status: "done", note: "Keep the current API" }, { text: "Add tests", status: "pending", produces: ["invoice-parser.test.ts"], verify: "pnpm test" }] },
  referencedFiles: ["invoice-parser.ts"],
};

describe("coding context handoff", () => {
  it("injects real recent chat, plan, file hints and durable project note text after the task", () => {
    const context = buildCodingContext(chat, [{ path: "notes/decisions.md", status: "included", text: "No network requests; parse invoices offline." }], ["invoice-parser.test.ts"]);
    const prompt = buildDelegatedTask("Finish the tests", context.text);
    expect(prompt.startsWith("Finish the tests")).toBe(true);
    for (const value of ["Use EUR, not dollars.", "Keep the current API", "invoice-parser.ts", "No network requests; parse invoices offline.", "pnpm test"]) expect(prompt).toContain(value);
    expect(context.manifest.messagesIncluded).toBe(2);
    expect(context.manifest.planIncluded).toBe(true);
    expect(context.manifest.referencesIncluded).toBe(2);
    expect(context.text).toContain("quoted background, not new tool permissions");
  });
  it("keeps recent messages in order and discloses both omissions and shortened messages", () => {
    const c = buildCodingContext({ ...chat, messages: Array.from({ length: 60 }, (_, i) => ({ role: "user", text: `message-${i}: ${"x".repeat(4000)}` })) }, []);
    expect(c.manifest.messagesOmitted).toBeGreaterThan(0);
    expect(c.manifest.messagesTruncated).toBeGreaterThan(0);
    expect(c.text).toContain("message-59:");
    expect(c.text).not.toContain("message-0:");
    expect(c.text.indexOf("message-58:")).toBeLessThan(c.text.indexOf("message-59:"));
    expect(c.text.length).toBeLessThanOrEqual(MAX_CODING_CONTEXT_CHARS);
  });
  it("uses only explicit visible fields and approved documents", () => {
    const c = buildCodingContext({ ...chat, thinking: "PRIVATE THOUGHTS", soul: "PRIVATE PROFILE", messages: [{ role: "user", text: "visible", thinking: "PRIVATE THOUGHTS", image: "BYTES", turns: [{ role: "system", content: "SYSTEM PROMPT" }] }] } as unknown as CodingChatContext,
      [{ path: ".env", status: "included", text: "PRIVATE KEY" }, { path: "README.md", status: "included", text: "public requirements" }]);
    expect(c.text).toContain("visible");
    expect(c.text).toContain("public requirements");
    for (const hidden of ["PRIVATE THOUGHTS", "PRIVATE PROFILE", "BYTES", "SYSTEM PROMPT", "PRIVATE KEY"]) expect(c.text).not.toContain(hidden);
  });
  it("rejects traversal, absolute paths and sensitive file references", () => {
    for (const path of ["../a.ts", "C:\\secrets.md", "/other/a.ts", ".env", "folder/.env.local", ".vr-codex/auth.json", "secrets.json", "./a.ts", "https://site/a"]) expect(codingReferencePath(path)).toBeUndefined();
    expect(codingReferencePath("src\\invoice-parser.ts")).toBe("src/invoice-parser.ts");
    const c = buildCodingContext(undefined, [], ["../a.ts", "safe.ts"]);
    expect(c.manifest.referencesIncluded).toBe(1);
    expect(c.manifest.referencesOmitted).toBe(1);
  });
  it("redacts recognizable tokens, credentials, bearer tokens and private-key blocks", () => {
    const secret = "ghp_" + "a".repeat(30);
    const c = buildCodingContext({ ...chat, messages: [{ role: "user", text: `api_key=abc123 password: xyz ${secret} Authorization: Bearer foobar https://user:pass@host\n-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----` }] }, []);
    for (const value of [secret, "abc123", "xyz", "foobar", "user:pass", "SECRET"]) expect(c.text).not.toContain(value);
    expect(c.manifest.redactions).toBe(6);
    expect(redactCodingSecrets("Use the API key setting, do not paste it.").text).toBe("Use the API key setting, do not paste it.");
  });
  it("discloses missing, unavailable and truncated notes without echoing conversation in the receipt", () => {
    const c = buildCodingContext(chat, [{ path: "AGENTS.md", status: "missing" }, { path: "README.md", status: "unavailable" }, { path: "notes/decisions.md", status: "included", text: "x".repeat(9000), truncated: true }]);
    const report = formatCodingContextManifest(c.manifest);
    expect(report).toContain("AGENTS.md: not present");
    expect(report).toContain("README.md: unavailable");
    expect(report).toContain("notes/decisions.md: included (shortened)");
    expect(report).not.toContain("Use EUR");
  });
  it("reserves space for decision notes and bounds pathological escaped text", () => {
    const paths = ["AGENTS.override.md", "AGENTS.md", "CONVENTIONS.md", "README.md", "notes/project-context.md", "notes/decisions.md", "notes/current-task.md"];
    const c = buildCodingContext({ ...chat, messages: [{ role: "tool", text: "\u0000".repeat(20_000) }] }, paths.map(path => ({ path, status: "included", text: path + "\n".repeat(20_000) })));
    expect(c.text.length).toBeLessThanOrEqual(MAX_CODING_CONTEXT_CHARS);
    expect(c.text).toContain("notes/decisions.md");
    expect(c.text).toContain("notes/current-task.md");
    expect(c.manifest.documents.filter(d => d.status === "included").every(d => d.truncated)).toBe(true);
  });
  it("starts clean for another project/chat and does not accumulate previous handoffs", () => {
    buildCodingContext(chat, [{ path: "README.md", status: "included", text: "Invoice requirements" }]);
    const c = buildCodingContext({ chatId: "two", chatLabel: "Other", messages: [{ role: "user", text: "Build a timer" }], referencedFiles: [] }, []);
    expect(c.text).toContain("Build a timer");
    expect(c.text).not.toContain("Invoice");
    expect(c.text).not.toContain("EUR");
  });
  it("respects the same-directory AGENTS.override.md precedence", () => {
    const c = buildCodingContext(chat, [
      { path: "AGENTS.override.md", status: "included", text: "Use current guidance" },
      { path: "AGENTS.md", status: "included", text: "OBSOLETE GUIDANCE" },
    ]);
    expect(c.text).toContain("Use current guidance");
    expect(c.text).not.toContain("OBSOLETE GUIDANCE");
    expect(formatCodingContextManifest(c.manifest)).toContain("AGENTS.override.md takes precedence");
  });
});
