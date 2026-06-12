import { describe, it, expect } from "vitest";
import {
  buildReferenceBlock,
  describeCharacterIdentity,
  displayCaption,
  expandPrompt,
  findBibleTermsInText,
  injectBibleTerms,
  type SceneTerm,
} from "./bible-injection.js";
import { createEmptyBible } from "../../visual-bible/bible.js";
import { emptyAppearance } from "../../types/bible.js";
import type { Character, Creature, VisualBible } from "../../types/bible.js";

function character(over: Partial<Character> & { name: string }): Character {
  return {
    id: `char-${over.name.toLowerCase()}`,
    aliases: [],
    appearance: emptyAppearance(),
    persistentTraits: [],
    clothing: [],
    outfits: [],
    anchor: { seed: 1 },
    firstSeenChapter: 0,
    ...over,
  };
}

function creature(over: Partial<Creature> & { name: string }): Creature {
  return {
    id: `creature-${over.name.toLowerCase()}`,
    aliases: [],
    kind: "dragon",
    description: [],
    anchor: { seed: 2 },
    firstSeenChapter: 0,
    ...over,
  };
}

function bibleWith(partial: Partial<VisualBible>): VisualBible {
  return { ...createEmptyBible("b"), ...partial };
}

describe("injectBibleTerms", () => {
  const violet: SceneTerm = {
    names: ["Violet Sorrengail", "Violet"],
    descriptor: "woman, brown hair with silver tips",
    kind: "character",
  };
  const tairn: SceneTerm = { names: ["Tairn"], descriptor: "dragon, massive, black", kind: "creature" };

  it("replaces a name in place with its (descriptor)", () => {
    expect(injectBibleTerms("Violet rides Tairn", [violet, tairn])).toBe(
      "(woman, brown hair with silver tips) rides (dragon, massive, black)",
    );
  });

  it("matches the longest surface form first (full name over first name)", () => {
    const out = injectBibleTerms("Violet Sorrengail fought.", [violet]);
    expect(out).toBe("(woman, brown hair with silver tips) fought.");
    expect(out).not.toContain("Sorrengail");
  });

  it("preserves possessives", () => {
    expect(injectBibleTerms("Violet's blade", [violet])).toBe(
      "(woman, brown hair with silver tips)'s blade",
    );
  });

  it("is case-insensitive and whole-word (won't split inside another word)", () => {
    expect(injectBibleTerms("tairn roared in Tairnton", [tairn])).toBe(
      "(dragon, massive, black) roared in Tairnton",
    );
  });

  it("does not re-wrap text it just inserted", () => {
    // "black" appears in Tairn's descriptor; a stray term named "black" must not re-match it.
    const black: SceneTerm = { names: ["black"], descriptor: "X", kind: "outfit" };
    const out = injectBibleTerms("Tairn", [tairn, black]);
    expect(out).toBe("(dragon, massive, black)");
  });
});

describe("findBibleTermsInText", () => {
  it("finds named characters, creatures and locations; outfits only when the owner is named", () => {
    const bible = bibleWith({
      characters: [
        character({
          name: "Violet",
          appearance: { ...emptyAppearance(), hair: "brown", gender: "woman" },
          outfits: [{ label: "flight leathers", description: "black fitted hide", context: "flying" }],
        }),
      ],
      creatures: [creature({ name: "Tairn", description: ["massive"] })],
      environments: [{ id: "env-basgiath", name: "Basgiath", description: ["dark fortress"], firstSeenChapter: 0 }],
    });
    const terms = findBibleTermsInText("Violet buckles her flight leathers and mounts Tairn at Basgiath", bible);
    const kinds = terms.map((t) => t.kind).sort();
    expect(kinds).toEqual(["character", "creature", "location", "outfit"]);
  });

  it("does NOT expand an outfit label when its owning character is absent from the prompt", () => {
    const bible = bibleWith({
      characters: [
        character({
          name: "Violet",
          outfits: [{ label: "cloak", description: "grey wool", context: "" }],
        }),
      ],
    });
    // "cloak" appears but "Violet" does not → not treated as her specific outfit.
    const terms = findBibleTermsInText("A cloak hung by the door.", bible);
    expect(terms.find((t) => t.kind === "outfit")).toBeUndefined();
  });
});

describe("describeCharacterIdentity", () => {
  it("uses identity fields (no outfit) and falls back to persistentTraits", () => {
    const c = character({
      name: "Ana",
      appearance: { ...emptyAppearance(), gender: "woman", hair: "silver" },
    });
    expect(describeCharacterIdentity(c)).toContain("woman");
    expect(describeCharacterIdentity(c)).toContain("silver");
    const bare = character({ name: "Bo", persistentTraits: ["wiry", "one-eyed"] });
    expect(describeCharacterIdentity(bare)).toBe("wiry, one-eyed");
  });
});

describe("expandPrompt", () => {
  const terms: SceneTerm[] = [
    { names: ["Violet"], descriptor: "woman, brown hair", kind: "character" },
  ];

  it("inject mode: replaces names + appends a world-style clause", () => {
    const out = expandPrompt("Violet flies", terms, "inject", "dark fantasy, painterly");
    expect(out).toContain("(woman, brown hair) flies");
    expect(out).toContain("Style: dark fantasy, painterly");
  });

  it("reference mode: keeps the name + prepends a reference block with style + title", () => {
    const out = expandPrompt("Violet flies", terms, "reference", "dark fantasy", "The Empyrean");
    expect(out).toContain("Violet flies"); // name kept
    expect(out).toContain("Title: The Empyrean.");
    expect(out).toContain("Style: dark fantasy.");
    expect(out).toContain("Violet = woman, brown hair");
  });
});

describe("buildReferenceBlock", () => {
  it("returns empty when there are no terms and no world style (a title alone isn't worth it)", () => {
    expect(buildReferenceBlock([], undefined, "Some Book")).toBe("");
  });
});

describe("displayCaption", () => {
  it("strips the leading reference block and trailing Style/Layout paragraphs", () => {
    const full =
      "Title: The Empyrean. Style: dark fantasy. Characters: Violet = woman, brown hair.\n\n" +
      "Violet rides Tairn across the valley.\n\n" +
      "Style: painterly, epic landscape\n\n" +
      "Layout: a single comic page composed of 4–6 sequential panels.";
    expect(displayCaption(full)).toBe("Violet rides Tairn across the valley.");
  });

  it("keeps a plain scene prompt unchanged (incl. Setting sentences inside the paragraph)", () => {
    const plain = "Blades crossed at dawn. Setting: the Courtyard.";
    expect(displayCaption(plain)).toBe(plain);
  });

  it("keeps multi-paragraph scene prose, dropping only scaffolding", () => {
    const full = "First beat.\n\nSecond beat.\n\nStyle: watercolor";
    expect(displayCaption(full)).toBe("First beat.\n\nSecond beat.");
  });

  it("falls back to the input when stripping would leave nothing", () => {
    const onlyBlock = "Style: dark fantasy.";
    expect(displayCaption(onlyBlock)).toBe(onlyBlock);
  });
});
