import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatCodingTaskReceipt } from "@visual-reader/core";
import { MessageBubble } from "./ChatPanel.js";

describe("coding receipts in persisted tool messages", () => {
  it("renders workspace, file categories and measured line counts in the actual chat bubble", () => {
    const text = formatCodingTaskReceipt({ agent: "Codex", model: "local-model", workspace: "C:/Projects/Alpha", exitCode: 0, timedOut: false, trackingComplete: true,
      changes: [{ path: "src/new.ts", kind: "created", added: 12, removed: 0, binary: false }], verify: { status: "not_requested" }, agentOutput: "Done." });
    const html = renderToStaticMarkup(createElement(MessageBubble, { message: { role: "tool", text } }));
    expect(html).toContain("C:/Projects/Alpha");
    expect(html).toContain("1 created, 0 modified, 0 deleted");
    expect(html).toContain("Lines: +12 added / -0 removed");
    expect(html).toContain("src/new.ts");
    expect(html).toContain("Agent report (self-reported)");
  });
});
