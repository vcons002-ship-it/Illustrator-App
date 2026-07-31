import { describe, expect, it } from "vitest";
import {
  SOUL_ESSENCE_SCHEMA_VERSION,
  type SoulEssence,
  type SoulKind,
} from "@visual-reader/core";
import { selectMirroredSoulEssence } from "../../../apps/web/src/remote-soul-essence.js";

function essence(
  kind: SoulKind,
  sourceFingerprint: string,
  generatedAt: number,
): SoulEssence {
  return {
    schemaVersion: SOUL_ESSENCE_SCHEMA_VERSION,
    kind,
    sourceFingerprint,
    generatedAt,
    generalizedEssence: { text: "Warm and curious", sourceIds: [] },
    facets: {
      coreDisposition: { text: "Warm", sourceIds: [] },
      conversationalVoice: { text: "Direct", sourceIds: [] },
      thinkingStyle: { text: "Reflective", sourceIds: [] },
      valuesAndMotivations: { text: "Curious", sourceIds: [] },
      relationalStyle: { text: "Attentive", sourceIds: [] },
      personalityDirections: { text: "Stay grounded", sourceIds: [] },
      tensionsAndNuance: { text: "Playful but precise", sourceIds: [] },
    },
    exactAppearance: [],
    exactPersonalityDirections: [],
  };
}

describe("linked-phone Soul Essence selection", () => {
  it("clears a phone-only Essence when the authoritative desktop frame omits it", () => {
    const phoneOnly = essence("self", "self-notes-v1", 200);

    expect(
      selectMirroredSoulEssence("self", "self-notes-v1", undefined, phoneOnly),
    ).toBeUndefined();
  });

  it("keeps a newer current Essence for the same incoming note revision", () => {
    const mirrored = essence("self", "self-notes-v2", 200);
    const freshlyReturned = essence("self", "self-notes-v2", 300);

    expect(
      selectMirroredSoulEssence(
        "self",
        "self-notes-v2",
        mirrored,
        freshlyReturned,
      ),
    ).toBe(freshlyReturned);
  });

  it("prefers an Essence current for the incoming notes over a newer stale copy", () => {
    const mirrored = essence("user", "user-notes-v2", 200);
    const newerButStale = essence("user", "user-notes-v1", 400);

    expect(
      selectMirroredSoulEssence(
        "user",
        "user-notes-v2",
        mirrored,
        newerButStale,
      ),
    ).toBe(mirrored);
  });

  it("retains the newest supplied snapshot when the desktop is rebuilding stale notes", () => {
    const mirroredStale = essence("self", "self-notes-v1", 200);
    const newerCurrentStale = essence("self", "self-notes-v0", 300);

    expect(
      selectMirroredSoulEssence(
        "self",
        "self-notes-v2",
        mirroredStale,
        newerCurrentStale,
      ),
    ).toBe(newerCurrentStale);
  });
});
