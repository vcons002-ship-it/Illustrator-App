import { describe, expect, it } from "vitest";
import { MAX_DOC_IMAGES, embedDocImages, hasDocImages, parseDocImages } from "./doc-images.js";

const DOC =
  `<h1>Dino Baby Shower</h1>` +
  `<img data-generate="a cute green T-rex with a balloon, pastel storybook style" alt="dino" width="320" height="240">` +
  `<p>Join us!</p>` +
  `<img src="/already-real.png" alt="real">` +
  `<img data-generate='a border of tiny dinosaur footprints' alt="border">`;

describe("hasDocImages / parseDocImages", () => {
  it("detects and extracts only the data-generate images, in order, with dims", () => {
    expect(hasDocImages(DOC)).toBe(true);
    expect(hasDocImages("<img src='x.png'>")).toBe(false);
    const imgs = parseDocImages(DOC);
    expect(imgs).toEqual([
      { id: "0", prompt: "a cute green T-rex with a balloon, pastel storybook style", alt: "dino", width: 320, height: 240 },
      { id: "1", prompt: "a border of tiny dinosaur footprints", alt: "border" },
    ]);
  });

  it("caps the number of generated images", () => {
    const many = Array.from({ length: MAX_DOC_IMAGES + 3 }, (_, i) => `<img data-generate="img ${i}">`).join("");
    expect(parseDocImages(many)).toHaveLength(MAX_DOC_IMAGES);
  });
});

describe("embedDocImages", () => {
  it("swaps data-generate for the generated src, preserving other attributes", () => {
    const out = embedDocImages(DOC, new Map([["0", "data:image/png;base64,AAA"]]));
    expect(out).toContain('<img src="data:image/png;base64,AAA" alt="dino" width="320" height="240">');
    expect(out).not.toContain("data-generate");
    expect(out).toContain('<img src="/already-real.png" alt="real">'); // untouched
  });

  it("drops the placeholder (leaving alt) when an image wasn't generated", () => {
    const out = embedDocImages(DOC, new Map()); // nothing generated
    expect(out).not.toContain("data-generate");
    expect(out).not.toContain("src=\"data:");
    expect(out).toContain('alt="dino"'); // the alt survives so it's not a broken icon
  });
});
