import { describe, expect, it } from "vitest";
import {
  durableCharacterDetails,
  isTransientCharacterDetail,
  sanitizeAppearanceDetails,
  stripTransientCharacterDetails,
  stripTransientCharacterDetailsExact,
} from "./character-details.js";

describe("transient character details", () => {
  it("recognises momentary expressions, gestures, and emotional states", () => {
    for (const detail of [
      "a broad grin",
      "smiling warmly",
      "her brow furrowed",
      "eyes narrowed",
      "arms crossed",
      "clenched fists",
      "tearful and flushed",
    ]) {
      expect(isTransientCharacterDetail(detail), detail).toBe(true);
    }
  });

  it("keeps explicitly durable expressions and expression-shaped marks", () => {
    expect(isTransientCharacterDetail("a habitual crooked grin")).toBe(false);
    expect(isTransientCharacterDetail("a permanently fixed scowl")).toBe(false);
    expect(isTransientCharacterDetail("a smile-shaped scar")).toBe(false);
    expect(isTransientCharacterDetail("auburn hair and a scar over one eyebrow")).toBe(false);
  });

  it("distinguishes a durable body silhouette from scene silhouette lighting", () => {
    const bodyShape = "I have a thin body with pronounced hourglass silhouette.";

    expect(isTransientCharacterDetail(bodyShape)).toBe(false);
    expect(stripTransientCharacterDetailsExact(bodyShape)).toBe(bodyShape);
    expect(isTransientCharacterDetail("silhouetted against moonlight")).toBe(true);
    expect(isTransientCharacterDetail("Her silhouette is highlighted by neon light")).toBe(true);
    expect(isTransientCharacterDetail("a silhouette in front of the firelight")).toBe(true);
  });

  it("removes only the transient clauses from mixed extracted prose", () => {
    expect(stripTransientCharacterDetails("auburn hair; a broad grin")).toBe("auburn hair");
    expect(stripTransientCharacterDetails("green eyes, smiling warmly, freckled skin")).toBe(
      "green eyes, freckled skin",
    );
    expect(stripTransientCharacterDetails("always wears a charcoal coat; grinning")).toBe(
      "always wears a charcoal coat",
    );
    expect(stripTransientCharacterDetails("usual glasses, smiling now")).toBe("usual glasses");
    expect(stripTransientCharacterDetails("usual glasses and smiling now")).toBe("usual glasses");
    expect(stripTransientCharacterDetails("auburn hair while grinning")).toBe("auburn hair");
    expect(stripTransientCharacterDetails("green eyes and eyes narrowed")).toBe("green eyes");
    expect(stripTransientCharacterDetails("smiling and always wears a charcoal coat")).toBe(
      "always wears a charcoal coat",
    );
    expect(stripTransientCharacterDetails("grinning and blue-eyed")).toBe("blue-eyed");
    expect(stripTransientCharacterDetailsExact("She is Black.")).toBe("She is Black.");
    expect(stripTransientCharacterDetailsExact("Androgynous person.")).toBe("Androgynous person.");
    expect(stripTransientCharacterDetailsExact("silver hair; grinning")).toBe("silver hair");
    expect(durableCharacterDetails(["wiry", "grinning", "one-eyed"])).toEqual([
      "wiry",
      "one-eyed",
    ]);
    expect(
      sanitizeAppearanceDetails({
        hair: "black",
        notes: "scar over her eyebrow; arms crossed",
      }),
    ).toEqual({ hair: "black", notes: "scar over her eyebrow" });
  });
});
