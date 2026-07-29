import { describe, expect, it } from "vitest";
import { MAX_REGIONS, castRegions, describeRegions, regionPixels } from "./regional-conditioning.js";

const person = (name: string, descriptor: string) => ({ name, descriptor });

describe("castRegions", () => {
  it("splits the canvas into a column per character, left to right in cast order", () => {
    const r = castRegions([person("Sato", "wire glasses"), person("Mara", "red braid")]);
    expect(r.map((x) => x.name)).toEqual(["Sato", "Mara"]);
    expect(r[0]!.x).toBe(0);
    expect(r[1]!.x).toBe(0.5);
    // Full height, and the pair spans the whole canvas.
    expect(r.every((x) => x.y === 0 && x.height === 1)).toBe(true);
    expect(r[1]!.x + r[1]!.width).toBe(1);
  });

  it("tiles the canvas with NO overlap — a shared band carries both people at once", () => {
    // The failure this replaced: neighbouring columns used to overlap by 6% of the canvas, and in
    // that band both characters' conditioning applied to the same pixels — fusing masculine and
    // feminine features exactly where two figures meet.
    const r = castRegions([person("A", "a"), person("B", "b"), person("C", "c")]);
    expect(r[0]!.x).toBe(0);
    expect(r[2]!.x + r[2]!.width).toBe(1);
    // Each column ends precisely where the next begins.
    expect(r[0]!.x + r[0]!.width).toBe(r[1]!.x);
    expect(r[1]!.x + r[1]!.width).toBe(r[2]!.x);
  });

  it("names the character inside their own region, so the description has an owner", () => {
    const r = castRegions([person("Sato", "close-cropped hair, wire glasses"), person("Mara", "red braid")]);
    expect(r[0]!.text).toBe("Sato, close-cropped hair, wire glasses");
    expect(r[1]!.text).toBe("Mara, red braid");
  });

  it("carries the world style into each region, or the patch under a character drifts off-look", () => {
    const r = castRegions([person("Sato", "wire glasses"), person("Mara", "red braid")], {
      style: "moody cinematic sci-fi",
    });
    expect(r[0]!.text).toBe("Sato, wire glasses. moody cinematic sci-fi");
    expect(r[1]!.text).toBe("Mara, red braid. moody cinematic sci-fi");
  });

  it("declines with fewer than two described characters — there's nothing to separate", () => {
    expect(castRegions([])).toEqual([]);
    expect(castRegions([person("Sato", "wire glasses")])).toEqual([]);
    // A second character with no description gives nothing to put in their region.
    expect(castRegions([person("Sato", "wire glasses"), person("Mara", "")])).toEqual([]);
  });

  it("declines for a crowd — narrow slivers hurt more than the bleed they'd prevent", () => {
    const crowd = Array.from({ length: MAX_REGIONS + 1 }, (_, i) => person(`P${i}`, "someone"));
    expect(castRegions(crowd)).toEqual([]);
    expect(castRegions(crowd.slice(0, MAX_REGIONS))).toHaveLength(MAX_REGIONS);
  });

  it("ignores blank names/descriptions rather than emitting an empty region", () => {
    const r = castRegions([person("  ", "wire glasses"), person("Mara", "red braid"), person("Cass", "grey beard")]);
    expect(r.map((x) => x.name)).toEqual(["Mara", "Cass"]);
  });
});

describe("regionPixels", () => {
  it("tiles exactly in pixels too — every pixel belongs to one region or none", () => {
    // Rounding each width on its own is how a one-pixel overlap creeps back in; taking the
    // difference of the rounded edges can't. Odd counts and odd canvases are the risky cases.
    for (const count of [2, 3, 4]) {
      for (const width of [1024, 1280, 831, 1000]) {
        const regions = castRegions(
          Array.from({ length: count }, (_, i) => person(`P${i}`, "someone")),
        );
        const cols = regions.map((r) => regionPixels(r, width));
        expect(cols[0]!.x).toBe(0);
        for (let i = 1; i < cols.length; i++) {
          expect(cols[i]!.x).toBe(cols[i - 1]!.x + cols[i - 1]!.width);
        }
        const last = cols[cols.length - 1]!;
        expect(last.x + last.width).toBe(width);
      }
    }
  });

  it("never emits a zero-width column, whatever the rounding", () => {
    const regions = castRegions([person("A", "a"), person("B", "b"), person("C", "c"), person("D", "d")]);
    for (const r of regions) expect(regionPixels(r, 64).width).toBeGreaterThan(0);
  });
});

describe("describeRegions", () => {
  it("says who was placed where, for the caption", () => {
    expect(describeRegions(castRegions([person("Sato", "a"), person("Mara", "b")]))).toBe(
      "Placed left to right: Sato, Mara.",
    );
  });

  it("is empty when nothing was placed", () => {
    expect(describeRegions([])).toBe("");
  });
});
