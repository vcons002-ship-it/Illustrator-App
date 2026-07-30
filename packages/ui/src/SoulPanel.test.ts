import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SoulPanel, type SoulPanelProps } from "./SoulPanel.js";

function renderPanel(overrides: Partial<SoulPanelProps> = {}): string {
  const props: SoulPanelProps = {
    variant: "self",
    name: "Sage",
    notes: [{ text: "Warm and curious", at: 1 }],
    onRefreshEssence: async () => undefined,
    onSaveNotes: async () => undefined,
    onSaveName: async () => undefined,
    images: [],
    onClose: () => undefined,
    limits: { note: 500, max: 100, name: 80 },
    ...overrides,
  };
  return renderToStaticMarkup(createElement(SoulPanel, props));
}

describe("SoulPanel essence generation progress", () => {
  it("shows active model progress and cancellation without claiming notes are saving", () => {
    const html = renderPanel({
      essenceProgress: {
        active: true,
        phase: "analyzing",
        message: "Analyzing source chunk 2 of 5",
        pass: 2,
        total: 5,
        tokens: 1_234,
      },
      onCancelEssence: () => undefined,
    });

    expect(html).toContain("Generating\u2026");
    expect(html).toContain("Analyzing source chunk 2 of 5");
    expect(html).toContain("Pass 2 of 5");
    expect(html).toContain("1,234 tokens");
    expect(html).toContain(">Cancel</button>");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Soul integration progress"');
    expect(html).not.toContain("Saving\u2026");
  });

  it("does not offer cancellation after the validated essence enters its save commit", () => {
    const html = renderPanel({
      essenceProgress: {
        active: true,
        phase: "saving",
        message: "Saving the validated Soul Essence\u2026",
        tokens: 1_234,
      },
      onCancelEssence: () => undefined,
    });

    expect(html).toContain("Saving the validated Soul Essence");
    expect(html).not.toContain(">Cancel</button>");
  });
});
