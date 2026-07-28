import { describe, it, expect } from "vitest";
import {
  appendSceneWardrobe,
  buildReferenceBlock,
  describeCharacterIdentity,
  displayCaption,
  expandPrompt,
  findBibleTermsInText,
  injectBibleTerms,
  sanitizeWorldStyle,
  worldStyleClause,
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

describe("appendSceneWardrobe (deterministic per-scene outfit)", () => {
  const violet = character({
    name: "Violet",
    aliases: ["Sorrengail"],
    outfits: [
      { label: "flight leathers", description: "fitted black hide with buckled straps", context: "" },
      { label: "ball gown", description: "emerald silk with silver embroidery", context: "" },
    ],
  });
  const bible = bibleWith({ characters: [violet] });

  it("appends the tagged outfit label so it injects regardless of the LLM's wording", () => {
    const out = appendSceneWardrobe("A woman descends the grand staircase.", [{ name: "Violet", outfit: "ball gown" }], bible);
    expect(out).toContain("Wardrobe: Violet in ball gown");
    // …and now findBibleTermsInText picks up both the character and the outfit.
    const terms = findBibleTermsInText(out, bible);
    expect(terms.some((t) => t.kind === "outfit" && t.descriptor.includes("emerald silk"))).toBe(true);
  });

  it("resolves the character by alias and is a no-op when already named with the label", () => {
    expect(appendSceneWardrobe("x", [{ name: "Sorrengail", outfit: "flight leathers" }], bible)).toContain(
      "Violet in flight leathers",
    );
    expect(appendSceneWardrobe("Violet buckles her flight leathers", [{ name: "Violet", outfit: "flight leathers" }], bible)).toBe(
      "Violet buckles her flight leathers",
    );
  });

  it("ignores unknown characters, unknown labels, and blank outfits", () => {
    expect(appendSceneWardrobe("x", [{ name: "Nobody", outfit: "cloak" }], bible)).toBe("x");
    expect(appendSceneWardrobe("x", [{ name: "Violet", outfit: "spacesuit" }], bible)).toBe("x");
    expect(appendSceneWardrobe("x", [{ name: "Violet" }], bible)).toBe("x");
  });
});

describe("findBibleTermsInText outfit fallback (older Bibles)", () => {
  it("injects a character's single known outfit when the label wasn't written", () => {
    const c = character({ name: "Mara", outfits: [{ label: "red gown", description: "crimson silk gown", context: "" }] });
    const terms = findBibleTermsInText("Mara enters the hall.", bibleWith({ characters: [c] }));
    expect(terms.some((t) => t.kind === "outfit" && t.descriptor.includes("crimson silk"))).toBe(true);
  });

  it("matches a paraphrased outfit by a distinctive description phrase", () => {
    const c = character({
      name: "Mara",
      outfits: [
        { label: "red gown", description: "crimson silk gown", context: "" },
        { label: "travel cloak", description: "grey wool hooded cloak", context: "" },
      ],
    });
    const terms = findBibleTermsInText("Mara sweeps in wearing a crimson silk gown.", bibleWith({ characters: [c] }));
    const outfits = terms.filter((t) => t.kind === "outfit");
    expect(outfits).toHaveLength(1);
    expect(outfits[0]!.descriptor).toContain("crimson silk");
  });

  it("does not inject an outfit when the character isn't named", () => {
    const c = character({ name: "Mara", outfits: [{ label: "red gown", description: "crimson silk gown", context: "" }] });
    const terms = findBibleTermsInText("A woman in a gown enters.", bibleWith({ characters: [c] }));
    expect(terms.some((t) => t.kind === "outfit")).toBe(false);
  });
});

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

  it("matches a location by alias and carries every form for replacement", () => {
    const bible = bibleWith({
      environments: [
        {
          id: "env-basgiliath",
          name: "Basgiliath",
          aliases: ["the fortress", "the black keep"],
          description: ["dark basalt fortress", "torch-lit walls"],
          firstSeenChapter: 0,
        },
      ],
    });
    // The prompt never names Basgiliath — the alias alone must resolve it.
    const terms = findBibleTermsInText("Soldiers march toward the fortress at dawn", bible);
    const loc = terms.find((t) => t.kind === "location");
    expect(loc).toBeDefined();
    expect(loc!.names).toEqual(["Basgiliath", "the fortress", "the black keep"]);
    expect(loc!.descriptor).toContain("basalt");
    // And the CLIP-path replacement swaps the alias text for the visual details.
    const out = injectBibleTerms("Soldiers march toward the fortress at dawn", [loc!]);
    expect(out).toContain("basalt");
    expect(out).not.toContain("the fortress");
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

describe("sanitizeWorldStyle", () => {
  it("keeps a real art-direction line untouched", () => {
    expect(sanitizeWorldStyle("moody cinematic sci-fi, painterly")).toBe("moody cinematic sci-fi, painterly");
  });
  it("strips a bare base-model id (the reported bug)", () => {
    expect(sanitizeWorldStyle("SD_XL_Base_1_0")).toBe("");
    expect(sanitizeWorldStyle("sd_xl_base_1.0")).toBe("");
  });
  it("strips a model filename but keeps surrounding style words", () => {
    expect(sanitizeWorldStyle("painterly, flux1-dev.safetensors")).toBe("painterly");
    expect(sanitizeWorldStyle("juggernautXL, dramatic lighting")).toBe("dramatic lighting");
  });
  it("handles empty / undefined", () => {
    expect(sanitizeWorldStyle(undefined)).toBe("");
    expect(sanitizeWorldStyle("")).toBe("");
  });
  it("worldStyleClause runs the sanitizer (existing books are fixed at read time)", () => {
    expect(worldStyleClause("SD_XL_Base_1_0")).toBe("");
    expect(worldStyleClause("watercolor")).toBe("watercolor");
  });
  it("buildReferenceBlock (Flux path) drops a contaminated style", () => {
    const block = buildReferenceBlock([], "SD_XL_Base_1_0", "My Book");
    expect(block).not.toContain("SD_XL_Base_1_0");
    expect(block).not.toContain("Style:");
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

/**
 * "Only two characters in the prompt, but a THIRD one's features are fused into one of them."
 *
 * Models hand out aliases freely and they collide with real names: a character called "Rell" picks up
 * the alias "the Captain" while another character IS "The Captain". Every surface form used to be
 * claimable by anyone holding it as an alias, and collisions were resolved by string LENGTH — so the
 * Captain's own name could resolve to Rell's descriptor, and Rell joined a scene he isn't in.
 */
describe("a name belongs to the character whose name it IS", () => {
  const bible = (): VisualBible => ({
    ...createEmptyBible("b"),
    characters: [
      // Listed FIRST, so anything order-dependent picks the wrong one.
      character({ name: "Rell", aliases: ["the Captain"], appearance: { ...emptyAppearance(), hair: "shaved head" } }),
      character({ name: "Mara", appearance: { ...emptyAppearance(), hair: "red braid" } }),
      character({ name: "The Captain", appearance: { ...emptyAppearance(), hair: "white beard" } }),
    ],
  });

  it("doesn't pull in a character matched only by an alias that is someone else's name", () => {
    const terms = findBibleTermsInText("Mara and The Captain stand on the deck.", bible());
    expect(terms.map((t) => t.names[0])).toEqual(["Mara", "The Captain"]);
  });

  it("injects each named character's OWN descriptor", () => {
    const prompt = "Mara and The Captain stand on the deck.";
    const out = injectBibleTerms(prompt, findBibleTermsInText(prompt, bible()));
    expect(out).toBe("(red braid) and (white beard) stand on the deck.");
    expect(out).not.toContain("shaved head"); // Rell isn't in this scene at all
  });

  it("keeps the absent character out of the reference block too", () => {
    const prompt = "Mara and The Captain stand on the deck.";
    const block = buildReferenceBlock(findBibleTermsInText(prompt, bible()));
    expect(block).toContain("Mara = red braid");
    expect(block).toContain("The Captain = white beard");
    expect(block).not.toContain("Rell");
  });

  it("still resolves an alias that collides with nobody", () => {
    const b: VisualBible = {
      ...createEmptyBible("b"),
      characters: [character({ name: "Rell", aliases: ["the quartermaster"], appearance: { ...emptyAppearance(), hair: "shaved head" } })],
    };
    const prompt = "The quartermaster counts the crates.";
    expect(injectBibleTerms(prompt, findBibleTermsInText(prompt, b))).toBe("(shaved head) counts the crates.");
  });

  it("a shared alias held by two characters (nobody's real name) still matches both — no information to choose", () => {
    const b: VisualBible = {
      ...createEmptyBible("b"),
      characters: [
        character({ name: "Rell", aliases: ["the rider"] }),
        character({ name: "Mara", aliases: ["the rider"] }),
      ],
    };
    expect(findBibleTermsInText("The rider approaches.", b).map((t) => t.names[0])).toEqual(["Rell", "Mara"]);
  });
});
