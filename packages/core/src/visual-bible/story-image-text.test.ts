import { describe, expect, it } from "vitest";
import { actionTextForImage } from "./story-image-text.js";

describe("actionTextForImage", () => {
  it("removes quoted dialogue but keeps the action/narration", () => {
    const out = actionTextForImage('She drew her sword. "Look at the dragon behind you!" she shouted, lunging forward.');
    expect(out).not.toMatch(/dragon/i);
    expect(out).toContain("She drew her sword.");
    expect(out).toContain("she shouted, lunging forward.");
  });

  it("handles smart quotes", () => {
    const out = actionTextForImage("He knelt by the fire. “I am a monster,” he whispered.");
    expect(out).not.toMatch(/monster/i);
    expect(out).toContain("He knelt by the fire.");
    expect(out).toContain("he whispered.");
  });

  it("keeps contractions (straight apostrophes are not treated as quotes)", () => {
    const out = actionTextForImage("It's dawn and she doesn't slow down as she climbs the ridge.");
    expect(out).toBe("It's dawn and she doesn't slow down as she climbs the ridge.");
  });

  it("strips an unterminated quote to the end", () => {
    const out = actionTextForImage('He turned and said "we have to run now');
    expect(out).toBe("He turned and said");
  });

  it("falls back to the original when the whole beat is dialogue", () => {
    const all = '"We should leave at once, before the storm hits."';
    expect(actionTextForImage(all)).toBe(all);
  });

  it("keeps narration between two quoted spans", () => {
    const out = actionTextForImage('"Run!" she said, shoving him toward the door, "now!"');
    expect(out).not.toMatch(/run|now/i);
    expect(out).toContain("she said, shoving him toward the door");
  });
});
