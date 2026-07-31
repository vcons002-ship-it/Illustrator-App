import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SOUL_ESSENCE_SCHEMA_VERSION,
  soulSourceFingerprint,
  type SoulEssence,
} from "@visual-reader/core";
import { SoulPanel, type SoulPanelProps } from "./SoulPanel.js";

const DEFAULT_NOTES = [{ text: "Warm and curious", at: 1 }];

const ESSENCE = {
  schemaVersion: SOUL_ESSENCE_SCHEMA_VERSION,
  kind: "self",
  sourceFingerprint: soulSourceFingerprint(DEFAULT_NOTES),
  generatedAt: 123,
  generalizedEssence: {
    text: "Intellectually curious, warm, and quietly playful.",
    sourceIds: ["source-1"],
  },
  facets: {
    coreDisposition: {
      text: "Grounding support that should remain secondary.",
      sourceIds: ["source-1"],
    },
    conversationalVoice: { text: "Direct and warm.", sourceIds: ["source-1"] },
    thinkingStyle: { text: "Reflective.", sourceIds: ["source-1"] },
    valuesAndMotivations: { text: "Values understanding.", sourceIds: ["source-1"] },
    relationalStyle: { text: "Attentive.", sourceIds: ["source-1"] },
    personalityDirections: { text: "Stay grounded.", sourceIds: ["source-1"] },
    tensionsAndNuance: { text: "Playful but precise.", sourceIds: ["source-1"] },
  },
  exactAppearance: [
    { text: "silver hair", sourceIds: ["source-1"] },
    { text: "green", sourceIds: ["source-1"], slot: "eyes.color" },
  ],
  exactPersonalityDirections: [{ text: "Never be fawning.", sourceIds: ["source-1"] }],
} satisfies SoulEssence;

function renderPanel(overrides: Partial<SoulPanelProps> = {}): string {
  const props: SoulPanelProps = {
    variant: "self",
    name: "Sage",
    notes: DEFAULT_NOTES,
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

describe("SoulPanel everyday essence presentation", () => {
  it("promotes the generalized essence and keeps support facets in collapsed grounding details", () => {
    const html = renderPanel({ essence: ESSENCE });
    const detailsStart = html.indexOf("<details");
    const detailsEnd = html.indexOf("</details>");
    const supportStart = html.indexOf("Grounding support that should remain secondary.");
    const directionStart = html.indexOf("Never be fawning.");
    const appearanceStart = html.indexOf("silver hair");

    expect(html).toContain('aria-label="Generalized everyday essence"');
    expect(html).toContain("Intellectually curious, warm, and quietly playful.");
    expect(html).toContain("<summary");
    expect(html).toContain("Grounding details</summary>");
    expect(detailsStart).toBeGreaterThan(-1);
    expect(detailsEnd).toBeGreaterThan(detailsStart);
    expect(supportStart).toBeGreaterThan(detailsStart);
    expect(supportStart).toBeLessThan(detailsEnd);
    expect(html.slice(detailsStart, html.indexOf(">", detailsStart) + 1)).not.toContain("open");
    expect(directionStart).toBeGreaterThan(-1);
    expect(directionStart).toBeLessThan(detailsStart);
    expect(appearanceStart).toBeGreaterThan(-1);
    expect(appearanceStart).toBeLessThan(detailsStart);
    expect(html).toContain("eye color: green");
    expect(html).toContain(
      "Stories use it as a subtle baseline alongside the character&#x27;s exact visual identity.",
    );
    expect(html).toContain(
      "The Creative window and explicit identity questions may consult the authoritative originals.",
    );
  });

  it("keeps a stale synthesis visible while showing exact identity from the current notes", () => {
    const html = renderPanel({
      notes: [
        { text: "Physical description: auburn hair and deep green eyes.", at: 2 },
        { text: "Never flatter the reader reflexively.", at: 3 },
      ],
      essence: {
        ...ESSENCE,
        sourceFingerprint: `soul-v${SOUL_ESSENCE_SCHEMA_VERSION}-previous`,
      },
    });
    const essenceSection = html.slice(
      html.indexOf('<section aria-labelledby="self-soul-essence-heading"'),
      html.indexOf("</section>"),
    );

    expect(essenceSection).toContain("Intellectually curious, warm, and quietly playful.");
    expect(essenceSection).toContain("Grounding support that should remain secondary.");
    expect(essenceSection).toContain(
      "Previous Essence remains active and will refresh automatically when the text model is idle.",
    );
    expect(essenceSection).toContain(">Refresh</button>");
    expect(essenceSection).toContain("auburn hair");
    expect(essenceSection).toContain("deep green eyes");
    expect(essenceSection).toContain("Never flatter the reader reflexively.");
    expect(essenceSection).not.toContain("silver hair");
    expect(essenceSection).not.toContain("eye color: green");
  });

  it("keeps the previous synthesis visible during an active automatic refresh", () => {
    const html = renderPanel({
      notes: [{ text: "Physical description: auburn hair.", at: 2 }],
      essence: {
        ...ESSENCE,
        sourceFingerprint: `soul-v${SOUL_ESSENCE_SCHEMA_VERSION}-previous`,
      },
      essenceProgress: {
        active: true,
        phase: "analyzing",
        message: "Refreshing the updated Soul Essence…",
      },
    });
    const essenceSection = html.slice(
      html.indexOf('<section aria-labelledby="self-soul-essence-heading"'),
      html.indexOf("</section>"),
    );

    expect(essenceSection).toContain("Intellectually curious, warm, and quietly playful.");
    expect(essenceSection).toContain("auburn hair");
    expect(essenceSection).toContain("Refreshing the updated Soul Essence");
    expect(essenceSection).toContain("Generating…");
    expect(essenceSection).not.toContain("silver hair");
  });
});
