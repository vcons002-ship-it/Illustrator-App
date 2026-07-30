import { describe, it, expect } from "vitest";
import {
  appendSceneWardrobe,
  buildReferenceBlock,
  describeCharacterIdentity,
  describeLocation,
  describeOutfit,
  castSubjects,
  displayCaption,
  expandPrompt,
  findBibleTermsInText,
  injectBibleTerms,
  sanitizeWorldStyle,
  stripWeather,
  worldStyleClause,
  type SceneTerm,
  MAX_CHARACTER_DESCRIPTOR_CHARS,
} from "./bible-injection.js";
import { createEmptyBible } from "../../visual-bible/bible.js";
import { emptyAppearance } from "../../types/bible.js";
import type { Character, Creature, Environment, VisualBible } from "../../types/bible.js";

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

describe("castSubjects (who the beat says is in the shot)", () => {
  const bible = () =>
    bibleWith({
      characters: [
        character({ name: "Lyra", aliases: ["Ghost Broker"] }),
        character({ name: "Nico" }),
      ],
    });

  it("resolves a nickname and a real name to ONE person", () => {
    // Counting these as two is exactly the duplicate the subject count exists to prevent.
    const out = castSubjects([{ name: "Lyra" }, { name: "Ghost Broker" }, { name: "Nico" }], bible());
    expect(out.map((s) => s.name)).toEqual(["Lyra", "Nico"]);
  });

  it("keeps a name the bible doesn't know — the beat still says they're in the shot", () => {
    const out = castSubjects([{ name: "Nico" }, { name: "A bartender" }], bible());
    expect(out.map((s) => s.name)).toEqual(["Nico", "A bartender"]);
  });

  it("is empty when the beat declares no cast, so the caller falls back to who is present", () => {
    expect(castSubjects(undefined, bible())).toEqual([]);
    expect(castSubjects([], bible())).toEqual([]);
    expect(castSubjects([{ name: "  " }], bible())).toEqual([]);
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

  it("keeps imported You appearance notes after analysis adds structured details", () => {
    const c = character({
      name: "Alex",
      appearance: {
        ...emptyAppearance(),
        eyes: "green",
        height: "six feet tall",
        notes: "broad-shouldered, auburn hair, freckled olive skin, scar through the left eyebrow",
      },
    });
    const out = describeCharacterIdentity(c);
    expect(out).toContain("six feet tall");
    expect(out).toContain("green eyes");
    expect(out).toContain("broad-shouldered");
    expect(out).toContain("auburn hair");
  });

  it("keeps legacy imported persistent traits alongside newly extracted fields", () => {
    const c = character({
      name: "Alex",
      appearance: { ...emptyAppearance(), eyes: "green" },
      persistentTraits: ["tall, broad-shouldered, auburn hair, freckled olive skin"],
    });
    const out = describeCharacterIdentity(c);
    expect(out).toContain("green eyes");
    expect(out).toContain("broad-shouldered");
    expect(out).toContain("auburn hair");
  });

  it("keeps ONE answer for a single-attribute field, not every wording it accumulated", () => {
    // Each chapter that re-describes the eyes appends its own wording, so the field ends up as
    // three attempts at one pair of eyes. Injected whole, the prompt asks for three eye colours.
    const c = character({
      name: "Jack",
      appearance: {
        ...emptyAppearance(),
        hair: "spiky-blond; light-blond",
        eyes: "arctic blue; icy-blue; glacial blue",
        build: "stocky, monstrous frame; thick chest",
      },
    });
    const out = describeCharacterIdentity(c);
    expect(out).toBe("spiky-blond hair, arctic blue eyes, stocky, monstrous frame");
    expect(out).not.toContain("icy-blue");
    expect(out).not.toContain("thick chest");
  });

  it("keeps EVERY entry of a list field — two marks are two features, not two wordings", () => {
    const c = character({
      name: "Liam",
      appearance: {
        ...emptyAppearance(),
        distinguishingMarks: "sprawling rebellion relic beginning at his wrist; dimple",
      },
    });
    const out = describeCharacterIdentity(c);
    expect(out).toContain("rebellion relic");
    expect(out).toContain("dimple");
  });

  it("drops the extractor's placeholders instead of asking for them", () => {
    // "unspecified skin" is a thing a model will try to draw.
    const c = character({
      name: "Jack",
      appearance: { ...emptyAppearance(), hair: "blond", skinTone: "unspecified", notes: "unknown" },
      persistentTraits: ["not specified"],
    });
    expect(describeCharacterIdentity(c)).toBe("blond hair");
  });

  it("drops comparisons to other people — undrawable, and they smuggle in other names", () => {
    // A name inside a descriptor is a name the model will find a face for; this is the exact
    // mechanism behind the feature-bleed we keep chasing.
    const c = character({
      name: "Liam",
      appearance: {
        ...emptyAppearance(),
        height: "tall, a head taller than most others",
        build: "massive, as tall as Sawyer and built as Dain",
      },
    });
    const out = describeCharacterIdentity(c);
    expect(out).toBe("tall, massive");
    expect(out).not.toContain("Sawyer");
    expect(out).not.toContain("Dain");
  });

  it("keeps personality and biography OUT of the picture, and looks IN", () => {
    // The reported prompt: eleven personality adjectives and a biography, competing with one hair
    // colour for the model's attention. None of it can be drawn.
    const c = character({
      name: "Jack",
      appearance: { ...emptyAppearance(), gender: "male", hair: "blond" },
      persistentTraits: [
        "vicious",
        "bully",
        "cowardly",
        "sadistic",
        "top cadet of his year",
        "son of the disgraced Colonel Isaac Mairi",
        "a long scar across the jaw",
      ],
    });
    const out = describeCharacterIdentity(c);
    expect(out).toBe("male, blond hair, a long scar across the jaw");
    expect(out).not.toMatch(/vicious|bully|cowardly|sadistic|cadet|Colonel/i);
  });

  it("keeps the SCENE's lighting out of a permanent description — the reported Lyra case", () => {
    // "The purple broth reflects in her eyes" is a fact about one bowl in one room. Recorded as
    // identity it was dragged into every later picture of her, including a daylight street.
    const c = character({
      name: "Lyra",
      appearance: {
        ...emptyAppearance(),
        gender: "female",
        eyes: "wide, expectant",
        build: "petite",
        notes:
          "The iridescent purple of the broth reflects in her eyes.; possesses soft features and " +
          "pouty lips; Her silhouette is highlighted by neon light; moves with grace.; has a look of " +
          "quiet intensity and pouty lips",
      },
      persistentTraits: ["intense gaze", "intense hunger in her gaze"],
    });
    expect(describeCharacterIdentity(c)).toBe("female, wide, expectant eyes, petite, soft features and pouty lips");
  });

  it("says a feature ONCE even when two chapters worded it differently", () => {
    // Containment missed this pair, so the eye arrived at double weight — and a feature at double
    // weight in a crowded prompt is what put Sato's eye on Nico.
    const c = character({
      name: "Sato",
      appearance: {
        ...emptyAppearance(),
        gender: "male",
        distinguishingMarks: "cybernetic eye that whirs as it focuses",
        notes: "weathered man; has a whirring cybernetic eye",
      },
    });
    const out = describeCharacterIdentity(c);
    expect(out).toBe("male, cybernetic eye that whirs as it focuses");
    expect(out.match(/cybernetic/g)).toHaveLength(1);
  });

  it("does NOT merge two real facts that merely share a body part or an adjective", () => {
    // Both halves of the same-feature test matter: the part alone would fuse two different eyes,
    // the adjective alone would fuse hair with skin.
    const eyes = character({
      name: "A",
      appearance: { ...emptyAppearance(), eyes: "grey", distinguishingMarks: "one blind eye" },
    });
    expect(describeCharacterIdentity(eyes)).toContain("grey eyes");
    expect(describeCharacterIdentity(eyes)).toContain("one blind eye");
    const dark = character({ name: "B", appearance: { ...emptyAppearance(), hair: "dark", skinTone: "dark" } });
    expect(describeCharacterIdentity(dark)).toBe("dark hair, dark skin");
  });

  it("unwraps prose the extractor writes instead of a field value", () => {
    const c = character({
      name: "C",
      appearance: { ...emptyAppearance(), hair: "Her hair is auburn.", build: "possesses a lean frame" },
    });
    expect(describeCharacterIdentity(c)).toBe("auburn hair, lean frame");
  });

  it("does not inject legacy momentary expressions or poses into every image", () => {
    const c = character({
      name: "Alex",
      appearance: {
        ...emptyAppearance(),
        hair: "auburn",
        notes: "freckled skin; a broad grin",
      },
      persistentTraits: ["one-eyed", "arms crossed", "smiling warmly"],
    });
    const out = describeCharacterIdentity(c);
    expect(out).toContain("auburn hair");
    expect(out).toContain("freckled skin");
    expect(out).toContain("one-eyed");
    expect(out).not.toMatch(/\b(?:grin|smiling|arms crossed)\b/i);
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

  it("drops the inline directives too — the count, wardrobe, beat cue and continuity clause", () => {
    // These were the ones a paragraph filter couldn't reach, so the caption opened with a renderer
    // instruction. Safe to drop because the exact text sent to the model is one disclosure away.
    const full =
      "Exactly two people in focus. Jack stabs Liam mid-air. (Wardrobe: Jack in flight leathers.) " +
      "(Part 2 of this scene's sequence — depict a LATER beat of the same moment.) " +
      "Scene continuity: featuring Jack, Liam at Mountain Peaks.";
    expect(displayCaption(full)).toBe("Jack stabs Liam mid-air.");
  });

  it("capitalises what is left when the count sentence was the opening", () => {
    expect(displayCaption("A crowd of people in focus. the squad forms up on the ridge.")).toBe(
      "The squad forms up on the ridge.",
    );
  });

  it("leaves a scene that merely mentions focus alone", () => {
    // "in focus" is only a directive as the generated opening sentence, not as prose.
    const prose = "A shallow depth of field keeps her hands in focus. Rain outside.";
    expect(displayCaption(prose)).toBe(prose);
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

/**
 * The scene is a restaurant named after someone. "Mara sits alone in Rell's Tavern" mentions Mara and
 * the Tavern — it does NOT mention Rell, and Rell's face has no business in the picture. Each name
 * claims its span longest-first, so a name enclosed by a longer bible name never sees that text.
 */
describe("a place named after a character isn't a mention of the character", () => {
  const tavern = (over: Partial<VisualBible> = {}): VisualBible => ({
    ...createEmptyBible("b"),
    characters: [
      character({ name: "Rell", appearance: { ...emptyAppearance(), hair: "shaved head" } }),
      character({ name: "Mara", appearance: { ...emptyAppearance(), hair: "red braid" } }),
    ],
    environments: [
      { id: "env-tavern", name: "Rell's Tavern", aliases: [], description: ["low beams, copper lamps"], firstSeenChapter: 0 },
    ],
    ...over,
  });

  it("leaves the character out of the terms entirely", () => {
    const terms = findBibleTermsInText("Mara sits alone in Rell's Tavern.", tavern());
    expect(terms.map((t) => t.names[0])).toEqual(["Mara", "Rell's Tavern"]);
  });

  it("injects the PLACE for the place, not the character it's named after", () => {
    const prompt = "Mara sits alone in Rell's Tavern.";
    const out = injectBibleTerms(prompt, findBibleTermsInText(prompt, tavern()));
    expect(out).toBe("(red braid) sits alone in (low beams, copper lamps).");
    expect(out).not.toContain("shaved head");
  });

  it("keeps him out of the reference block, where he'd read as part of the cast", () => {
    const prompt = "Mara sits alone in Rell's Tavern.";
    expect(buildReferenceBlock(findBibleTermsInText(prompt, tavern()))).not.toContain("Rell =");
  });

  it("works when the enclosing name is an ALIAS of the place — length decides, not ownership", () => {
    const b = tavern({
      environments: [
        { id: "env-tavern", name: "The Tavern", aliases: ["Rell's old tavern"], description: ["low beams"], firstSeenChapter: 0 },
      ],
    });
    const prompt = "Mara sits alone in Rell's old tavern.";
    expect(injectBibleTerms(prompt, findBibleTermsInText(prompt, b))).toBe("(red braid) sits alone in (low beams).");
  });

  it("but a real mention of him in the SAME prompt still counts", () => {
    const prompt = "Rell watches as Mara sits alone in Rell's Tavern.";
    const terms = findBibleTermsInText(prompt, tavern());
    expect(terms.map((t) => t.names[0])).toEqual(["Rell", "Mara", "Rell's Tavern"]);
    expect(injectBibleTerms(prompt, terms)).toBe(
      "(shaved head) watches as (red braid) sits alone in (low beams, copper lamps).",
    );
  });
});

/**
 * The place is named after someone AND ISN'T IN THE BIBLE YET — the common case, not an edge one:
 * extraction runs in the background while the new beat's image is pushed to the front of the queue,
 * so the beat that first walks into Rell's Tavern renders before the Tavern exists as an entity.
 * Longest-first can't help there (there's no longer name to win), so the possessive-plus-proper-noun
 * SHAPE is what rules it out.
 */
describe("a place named after a character that the bible hasn't learned yet", () => {
  const b = (): VisualBible => ({
    ...createEmptyBible("b"),
    characters: [
      character({ name: "Rell", appearance: { ...emptyAppearance(), hair: "shaved head" } }),
      character({ name: "Mara", appearance: { ...emptyAppearance(), hair: "red braid" } }),
    ],
  });

  it("doesn't put him in the scene, and leaves the place's name alone", () => {
    const prompt = "Mara sits alone in Rell's Tavern.";
    expect(findBibleTermsInText(prompt, b()).map((t) => t.names[0])).toEqual(["Mara"]);
    expect(injectBibleTerms(prompt, findBibleTermsInText(prompt, b()))).toBe("(red braid) sits alone in Rell's Tavern.");
  });

  it("an ordinary possessive is still him — he's plainly there", () => {
    const prompt = "Mara grips Rell's hand.";
    expect(findBibleTermsInText(prompt, b()).map((t) => t.names[0])).toEqual(["Rell", "Mara"]);
    expect(injectBibleTerms(prompt, findBibleTermsInText(prompt, b()))).toBe("(red braid) grips (shaved head)'s hand.");
  });

  it("named anywhere else in the same prompt, he's present — and the place keeps its name", () => {
    const prompt = "Rell wipes the bar in Rell's Tavern.";
    expect(findBibleTermsInText(prompt, b()).map((t) => t.names[0])).toEqual(["Rell"]);
    expect(injectBibleTerms(prompt, findBibleTermsInText(prompt, b()))).toBe("(shaved head) wipes the bar in Rell's Tavern.");
  });

  it("a bare possessive followed by a new sentence is a mention, not a place", () => {
    const prompt = "They spoke of Rell's. The door opened.";
    expect(findBibleTermsInText(prompt, b()).map((t) => t.names[0])).toEqual(["Rell"]);
  });
});

/**
 * THREE characters in a place named after one of them — every combination, with and without the place
 * in the bible, and with and without the beat's location to hand. This is the shape that was reported
 * (a restaurant named after a character, whose features kept turning up on the others), so it's
 * pinned whole rather than by mechanism.
 */
describe("three characters in a place named after the third", () => {
  const cast = [
    character({ name: "Rell", appearance: { ...emptyAppearance(), hair: "shaved head" } }),
    character({ name: "Mara", appearance: { ...emptyAppearance(), hair: "red braid" } }),
    character({ name: "Cass", appearance: { ...emptyAppearance(), hair: "grey beard" } }),
  ];
  const known: VisualBible = {
    ...createEmptyBible("b"),
    characters: cast,
    environments: [
      { id: "env-tavern", name: "Rell's Tavern", aliases: [], description: ["low beams, copper lamps"], firstSeenChapter: 0 },
    ],
  };
  const unknown: VisualBible = { ...createEmptyBible("b"), characters: cast };
  const namesOf = (b: VisualBible, p: string, loc?: string): string[] =>
    findBibleTermsInText(p, b, loc).filter((t) => t.kind === "character").map((t) => t.names[0]!);

  it("all three present, place known: each gets their OWN face, the place gets its own look", () => {
    const p = "Rell pours for Mara and Cass in Rell's Tavern.";
    expect(namesOf(known, p)).toEqual(["Rell", "Mara", "Cass"]);
    expect(injectBibleTerms(p, findBibleTermsInText(p, known))).toBe(
      "(shaved head) pours for (red braid) and (grey beard) in (low beams, copper lamps).",
    );
  });

  it("all three present, place NOT in the bible yet: the place keeps its name, nobody is mangled", () => {
    const p = "Rell pours for Mara and Cass in Rell's Tavern.";
    expect(namesOf(unknown, p)).toEqual(["Rell", "Mara", "Cass"]);
    expect(injectBibleTerms(p, findBibleTermsInText(p, unknown))).toBe(
      "(shaved head) pours for (red braid) and (grey beard) in Rell's Tavern.",
    );
  });

  it("the third is ABSENT: two characters, and his face nowhere — place known or not", () => {
    const p = "Mara and Cass wait in Rell's Tavern.";
    expect(namesOf(known, p)).toEqual(["Mara", "Cass"]);
    expect(namesOf(unknown, p)).toEqual(["Mara", "Cass"]);
    expect(injectBibleTerms(p, findBibleTermsInText(p, unknown))).not.toContain("shaved head");
    expect(buildReferenceBlock(findBibleTermsInText(p, known))).not.toContain("Rell =");
  });

  it("absent at first, arriving later in the same beat: he's in it, the place still isn't him", () => {
    const p = "Mara and Cass wait in Rell's Tavern until Rell shoulders the door open.";
    expect(namesOf(unknown, p)).toEqual(["Rell", "Mara", "Cass"]);
    expect(injectBibleTerms(p, findBibleTermsInText(p, unknown))).toBe(
      "(red braid) and (grey beard) wait in Rell's Tavern until (shaved head) shoulders the door open.",
    );
  });

  /** Lower-case, or no possessive at all — the capitalisation rule can't see these, so the beat's
   * own location (from extraction) supplies the span instead. */
  it("a lower-case or unpossessed place name is still a place, given the beat's location", () => {
    const lower = "Mara and Cass wait in rell's tavern.";
    expect(namesOf(unknown, lower, "rell's tavern")).toEqual(["Mara", "Cass"]);
    expect(injectBibleTerms(lower, findBibleTermsInText(lower, unknown, "rell's tavern"), "rell's tavern")).toBe(
      "(red braid) and (grey beard) wait in rell's tavern.",
    );

    const bare = "Mara and Cass wait in the Rell Tavern.";
    expect(namesOf(unknown, bare, "the Rell Tavern")).toEqual(["Mara", "Cass"]);

    // And with him genuinely present, he's in the cast while the place keeps its name.
    const both = "Rell pours for Mara and Cass in the Rell Tavern.";
    expect(namesOf(unknown, both, "the Rell Tavern")).toEqual(["Rell", "Mara", "Cass"]);
    expect(injectBibleTerms(both, findBibleTermsInText(both, unknown, "the Rell Tavern"), "the Rell Tavern")).toBe(
      "(shaved head) pours for (red braid) and (grey beard) in the Rell Tavern.",
    );
  });
});

/** The exact shape reported: "Sato's Synthetic Noodles" with Sato himself in the scene, plus two
 * others. Three characters and a place whose name is one of them. */
describe("Sato's Synthetic Noodles", () => {
  const b: VisualBible = {
    ...createEmptyBible("b"),
    characters: [
      character({ name: "Sato", appearance: { ...emptyAppearance(), hair: "close-cropped, wire glasses" } }),
      character({ name: "Mara", appearance: { ...emptyAppearance(), hair: "red braid" } }),
      character({ name: "Cass", appearance: { ...emptyAppearance(), hair: "grey beard" } }),
    ],
  };
  const cast = (p: string, loc?: string): string[] =>
    findBibleTermsInText(p, b, loc).filter((t) => t.kind === "character").map((t) => t.names[0]!);

  it("Sato present with two others: three in the cast, the shop keeps its name", () => {
    const p = "Sato ladles broth for Mara and Cass at Sato's Synthetic Noodles.";
    expect(cast(p)).toEqual(["Sato", "Mara", "Cass"]);
    expect(injectBibleTerms(p, findBibleTermsInText(p, b))).toBe(
      "(close-cropped, wire glasses) ladles broth for (red braid) and (grey beard) at Sato's Synthetic Noodles.",
    );
  });

  it("Sato absent: two in the cast, and none of him anywhere in the prompt", () => {
    const p = "Mara and Cass slurp noodles at Sato's Synthetic Noodles.";
    expect(cast(p)).toEqual(["Mara", "Cass"]);
    const out = injectBibleTerms(p, findBibleTermsInText(p, b));
    expect(out).toBe("(red braid) and (grey beard) slurp noodles at Sato's Synthetic Noodles.");
    expect(out).not.toContain("wire glasses");
  });

  it("lower-cased in the prose, with the beat's location known", () => {
    const p = "Mara and Cass slurp noodles at sato's synthetic noodles.";
    expect(cast(p, "sato's synthetic noodles")).toEqual(["Mara", "Cass"]);
  });
});

/**
 * Attribute bleed between people is the failure the reader keeps hitting, and it worsens with each
 * person in frame. The obvious remedy — a negative prompt per character — is not available on the
 * natural-language families: Flux/Flux.2 run at CFG 1 with embedded guidance, so the negative branch
 * is never evaluated (`resolveNegative` returns "" for them). Naming the binding in the positive is
 * the lever that remains on an LLM-grade encoder.
 */
describe("the reference block binds each description to its own person", () => {
  const two: SceneTerm[] = [
    { names: ["Sato"], descriptor: "close-cropped hair, wire glasses", kind: "character" },
    { names: ["Mara"], descriptor: "red braid", kind: "character" },
  ];

  it("says the descriptions don't mix once there's more than one person", () => {
    const block = buildReferenceBlock(two);
    expect(block).toContain("Sato = close-cropped hair, wire glasses; Mara = red braid.");
    expect(block).toMatch(/Each description belongs to that person ONLY/);
    expect(block).toMatch(/do not give one person another's hair, age, build, clothing, or features/);
  });

  it("stays quiet with a single character — there's nothing to mix", () => {
    expect(buildReferenceBlock([two[0]!])).not.toMatch(/belongs to that person ONLY/);
  });

  it("doesn't say it about places or creatures", () => {
    const block = buildReferenceBlock([
      { names: ["The Deep"], descriptor: "black water", kind: "location" },
      { names: ["Hollow"], descriptor: "grey shallows", kind: "location" },
    ]);
    expect(block).not.toMatch(/belongs to that person/);
  });
});

/**
 * How much of a character's look reaches the picture.
 *
 * 160 characters — the cap every descriptor shared — is under two lines: "silver hair falling past
 * the shoulders, sharp grey eyes, late forties, lean, wears a long charcoal coat" is already at it,
 * before any scar or skin tone. So detail the Visual Bible had spent chapters accumulating was cut
 * off before it reached the image, with nothing to say so. People get their own, larger budget now;
 * places and outfits are phrases and keep the tighter one.
 */
describe("a character's descriptor has room for a person", () => {
  const long = character({
    name: "Wren",
    appearance: {
      ...emptyAppearance(),
      gender: "woman",
      age: "late forties",
      hair: "silver, falling past the shoulders, always slightly unkempt",
      distinguishingMarks: "a jagged scar through the left eyebrow and a burn across the right hand",
      eyes: "sharp grey, deep-set",
      build: "lean and rangy, stands very straight",
      skinTone: "weathered olive",
    },
  });

  it("keeps far more than the old 160 characters", () => {
    const d = describeCharacterIdentity(long);
    expect(d.length).toBeGreaterThan(160);
    expect(d).toContain("weathered olive"); // the LAST field — it used to be cut off entirely
  });

  it("is still bounded — a full cast injects one of these each", () => {
    expect(describeCharacterIdentity(long).length).toBeLessThanOrEqual(MAX_CHARACTER_DESCRIPTOR_CHARS);
  });

  it("never ends mid-word when it does have to cut", () => {
    const huge = character({
      name: "Wren",
      appearance: { ...emptyAppearance(), hair: "silver ".repeat(200) },
    });
    const d = describeCharacterIdentity(huge);
    expect(d.length).toBeLessThanOrEqual(MAX_CHARACTER_DESCRIPTOR_CHARS);
    expect(d.endsWith("silver")).toBe(true);
  });

  it("a place is still capped tighter — it's a phrase, not a person", () => {
    const wordy = { id: "e", name: "The Keep", aliases: [], description: ["cramped ".repeat(60)], firstSeenChapter: 0 };
    const b: VisualBible = { ...createEmptyBible("b"), environments: [wordy] };
    const term = findBibleTermsInText("They reach The Keep.", b)[0]!;
    expect(term.descriptor.length).toBeLessThanOrEqual(160);
  });
});

describe("weather belongs to places and the world, not to people", () => {
  it("KEEPS a place's weather — that's where a world's atmosphere lives", () => {
    // A place's description only reaches a picture when that place is in it, so this is scoped
    // already. Stripping it was an over-correction: a beat whose prose is all dialogue then has
    // nothing to say what the light and air are like, and consecutive pictures stop agreeing.
    const env: Environment = {
      id: "env-tavern",
      name: "the Bell",
      aliases: [],
      description: ["a low stone taproom, rain drumming on the roof, warm firelight", "long oak bar"],
      firstSeenChapter: 0,
    };
    const out = describeLocation(env);
    expect(out).toContain("rain drumming on the roof");
    expect(out).toContain("low stone taproom");
    expect(out).toContain("long oak bar");
  });

  it("keeps weather out of a PERSON's description too — the same accumulation happens to people", () => {
    // A character first described in a downpour would otherwise carry it into every later picture,
    // indoors included, because their descriptor is injected wherever they appear.
    const soaked: Character = {
      id: "char-mara",
      name: "Mara",
      aliases: [],
      appearance: { ...emptyAppearance(), gender: "woman", age: "30s", hair: "red braid, rain-plastered to her scalp" },
      persistentTraits: [],
      clothing: [],
      anchor: { seed: 1 },
      firstSeenChapter: 0,
    };
    const out = describeCharacterIdentity(soaked);
    expect(out).not.toMatch(/rain/i);
    expect(out).toContain("woman");
    expect(out).toContain("30s");
  });

  it("keeps weather out of an outfit", () => {
    expect(describeOutfit({ label: "courier coat", description: "oiled canvas coat, beaded with rain", context: "" })).toBe(
      "oiled canvas coat",
    );
  });

  it("drops a description line that was only weather", () => {
    expect(stripWeather("Rain lashes the windows.")).toBe("");
    expect(stripWeather("Snow is falling. The keep sits on a black crag.")).toBe(
      "The keep sits on a black crag.",
    );
  });

  it("keeps a book's art direction but not its weather", () => {
    expect(sanitizeWorldStyle("rain-slicked neon streets, moody cinematic sci-fi")).toBe(
      "moody cinematic sci-fi",
    );
    // Nothing to do when there's no weather in it.
    expect(sanitizeWorldStyle("moody cinematic sci-fi")).toBe("moody cinematic sci-fi");
  });

  it("leaves ordinary words that merely contain a weather word alone", () => {
    expect(stripWeather("a raincoat on a hook, stormlanterns above the bar")).toBe(
      "a raincoat on a hook, stormlanterns above the bar",
    );
  });

  it("returns nothing when a style was ONLY weather, rather than a stray comma", () => {
    expect(sanitizeWorldStyle("torrential rain, thunder")).toBe("");
  });
});

describe("appositive naming (names kept, description beside them)", () => {
  const terms: SceneTerm[] = [
    { names: ["Nico"], descriptor: "a man with a beard", kind: "character" },
    { names: ["Lyra"], descriptor: "a woman with red hair", kind: "character" },
  ];

  it("puts each description next to the person it belongs to, keeping the name", () => {
    expect(expandPrompt("Nico and Lyra sit at a bar.", terms, "appositive")).toBe(
      "Nico (a man with a beard) and Lyra (a woman with red hair) sit at a bar.",
    );
  });

  it("describes only the FIRST mention — repeating it reads as a second person", () => {
    const out = expandPrompt("Nico pours. Lyra laughs. Nico pours again.", terms, "appositive");
    expect(out.match(/a man with a beard/g)).toHaveLength(1);
    expect(out).toContain("Nico pours again.");
  });

  it("appends the world style like the inject mode, with no glossary block", () => {
    const out = expandPrompt("Nico waits.", terms, "appositive", "moody cinematic");
    expect(out).toContain("Nico (a man with a beard) waits.");
    expect(out).toContain("Style: moody cinematic");
    expect(out).not.toContain("Characters:");
  });

  it("still won't rename a place called after someone in the scene", () => {
    const out = expandPrompt("Nico waits in Nico's Bar.", terms, "appositive", undefined, undefined, "Nico's Bar");
    expect(out).toContain("Nico's Bar");
  });
});

describe("the book title is a permanent statement too", () => {
  const terms: SceneTerm[] = [{ names: ["Nico"], descriptor: "a man with a beard", kind: "character" }];

  it("strips weather from the title, which rides into every prompt of the book", () => {
    // A story titled from its opening premise carries that premise's weather into every later
    // picture — from a line nobody thinks of as a prompt at all.
    const out = expandPrompt("Nico waits.", terms, "reference", undefined, "A Rainy Night in Blackwater");
    expect(out).not.toMatch(/rain/i);
    // Word by word, not clause by clause: a title is one clause, so the ordinary strip would take
    // the whole thing — and the title is the line that says which world this is.
    expect(out).toContain("Title: A Night in Blackwater.");
  });

  it("leaves a title with no weather in it exactly as written", () => {
    const out = expandPrompt("Nico waits.", terms, "reference", undefined, "The Glass Harbour");
    expect(out).toContain("Title: The Glass Harbour.");
  });
});

describe("a descriptor says what each part of it describes, once", () => {
  const person = (a: Partial<ReturnType<typeof emptyAppearance>>): Character => ({
    id: "char-x",
    name: "X",
    aliases: [],
    appearance: { ...emptyAppearance(), ...a },
    persistentTraits: [],
    clothing: [],
    anchor: { seed: 1 },
    firstSeenChapter: 0,
  });

  it("says a feature ONCE, keeping the more specific wording", () => {
    // Real case: `distinguishingMarks` and `eyes` both held the eye, so "cybernetic eye" appeared
    // twice — doubling its weight in a prompt where two other people were competing for it, and it
    // landed on the wrong man.
    const sato = person({
      gender: "male",
      age: "older",
      distinguishingMarks: "cybernetic eye",
      eyes: "one cybernetic eye that whirs as it focuses",
      skinTone: "weathered",
    });
    const out = describeCharacterIdentity(sato);
    expect(out.match(/cybernetic eye/gi)).toHaveLength(1);
    expect(out).toContain("one cybernetic eye that whirs as it focuses"); // the specific wording won
    expect(out).toContain("older");
  });

  it("gives loose adjectives the noun they describe", () => {
    // "male, short brown, beard" is a bag of adjectives that name nothing. The one phrase carrying
    // its own noun is then the most bindable thing in the sentence — and it binds to whoever.
    const out = describeCharacterIdentity(person({ gender: "male", hair: "short brown", eyes: "wide, expectant" }));
    expect(out).toContain("short brown hair");
    expect(out).toContain("wide, expectant eyes");
  });

  it("doesn't repeat a noun the field already carries", () => {
    const out = describeCharacterIdentity(person({ hair: "shoulder-length black hair", eyes: "one glass eye" }));
    expect(out).toContain("shoulder-length black hair");
    expect(out).not.toMatch(/hair hair/i);
    expect(out).toContain("one glass eye");
    expect(out).not.toMatch(/eye eyes/i);
  });

  it("leaves the build phrase alone — it already reads as one", () => {
    const out = describeCharacterIdentity(person({ build: "petite but voluptuous, ample bust" }));
    expect(out).toBe("petite but voluptuous, ample bust");
  });

  it("puts an appositive BEFORE the possessive, not between owner and owned", () => {
    // "Nico's (a man with a beard) wrist" describes the WRIST.
    const terms: SceneTerm[] = [{ names: ["Nico"], descriptor: "a man with a beard", kind: "character" }];
    expect(expandPrompt("Lyra grips Nico's wrist.", terms, "appositive")).toBe(
      "Lyra grips Nico (a man with a beard)'s wrist.",
    );
  });
});

describe("an outfit label is not a name for the person wearing it", () => {
  /** Extraction recorded the costume identity BOTH as one of Lyra's outfits and as an alias. */
  function bibleWithCostumeAlias(): VisualBible {
    const lyra: Character = {
      id: "char-lyra",
      name: "Lyra",
      aliases: ["Ghost Broker"],
      appearance: { ...emptyAppearance(), gender: "female", hair: "long auburn" },
      persistentTraits: [],
      clothing: [],
      outfits: [{ label: "Ghost Broker", description: "a long grey coat, mirrored visor", context: "working" }],
      anchor: { seed: 1 },
      firstSeenChapter: 0,
    };
    return { ...createEmptyBible("b"), characters: [lyra] };
  }

  it("finds the OUTFIT at its label, not a second copy of the character", () => {
    // "Lyra wears her Ghost Broker outfit" was putting a complete head-to-toe description of Lyra
    // inside the clothing clause — a second whole woman in the sentence, which the model drew.
    const bible = bibleWithCostumeAlias();
    const prompt = "Lyra leans on the counter. Lyra wears her Ghost Broker outfit.";
    const terms = findBibleTermsInText(prompt, bible);
    const ghost = terms.find((t) => t.names.includes("Ghost Broker"));
    expect(ghost?.kind).toBe("outfit");
    expect(ghost?.descriptor).toContain("mirrored visor");
    // …and the character term no longer answers to it.
    const person = terms.find((t) => t.kind === "character");
    expect(person?.names).not.toContain("Ghost Broker");
  });

  it("injects the garments there, not the wearer", () => {
    const bible = bibleWithCostumeAlias();
    const prompt = "Lyra wears her Ghost Broker outfit.";
    const out = expandPrompt(prompt, findBibleTermsInText(prompt, bible), "appositive");
    expect(out).toContain("Ghost Broker (a long grey coat, mirrored visor)");
    expect(out).not.toMatch(/Ghost Broker \(female/);
  });

  it("leaves an ordinary alias alone", () => {
    const bible = bibleWithCostumeAlias();
    bible.characters[0]!.aliases = ["Vi"];
    const terms = findBibleTermsInText("Vi leans on the counter.", bible);
    expect(terms.find((t) => t.kind === "character")?.names).toContain("Vi");
  });
});

describe("one person is described once, whichever of their names is used", () => {
  const bible = (): VisualBible => {
    const rell: Character = {
      id: "char-rell",
      name: "Rell",
      aliases: ["the Captain"],
      appearance: { ...emptyAppearance(), gender: "male", hair: "grey beard" },
      persistentTraits: [],
      clothing: [],
      anchor: { seed: 1 },
      firstSeenChapter: 0,
    };
    return { ...createEmptyBible("b"), characters: [rell] };
  };

  it("describes them at the first mention and never again — by name then nickname", () => {
    // Keying this on the matched WORD meant a name plus a nickname described the same person twice,
    // which reads as two people and is drawn as two people.
    const prompt = "Rell pours a drink. The Captain wipes the bar.";
    const out = expandPrompt(prompt, findBibleTermsInText(prompt, bible()), "appositive");
    expect(out.match(/grey beard/g)).toHaveLength(1);
    expect(out).toContain("Rell (male, grey beard)");
    expect(out).toContain("The Captain wipes the bar.");
  });

  it("…and nickname first, then name", () => {
    const prompt = "The Captain pours a drink. Rell wipes the bar.";
    const out = expandPrompt(prompt, findBibleTermsInText(prompt, bible()), "appositive");
    expect(out.match(/grey beard/g)).toHaveLength(1);
    expect(out).toContain("The Captain (male, grey beard)");
    expect(out).toContain("Rell wipes the bar.");
  });

  it("still describes two DIFFERENT people", () => {
    const b = bible();
    b.characters.push({
      id: "char-mara",
      name: "Mara",
      aliases: [],
      appearance: { ...emptyAppearance(), gender: "female", hair: "red braid" },
      persistentTraits: [],
      clothing: [],
      anchor: { seed: 2 },
      firstSeenChapter: 0,
    });
    const prompt = "Rell pours for Mara.";
    const out = expandPrompt(prompt, findBibleTermsInText(prompt, b), "appositive");
    expect(out).toContain("Rell (male, grey beard)");
    expect(out).toContain("Mara (female, red braid)");
  });

  it("an outfit label can't be claimed by ANOTHER character's nickname either", () => {
    // Reserved globally: the collision doesn't have to be with the wearer.
    const b = bible();
    b.characters[0]!.aliases = ["Ghost Broker"];
    b.characters.push({
      id: "char-lyra",
      name: "Lyra",
      aliases: [],
      appearance: { ...emptyAppearance(), gender: "female" },
      persistentTraits: [],
      clothing: [],
      outfits: [{ label: "Ghost Broker", description: "a long grey coat", context: "" }],
      anchor: { seed: 3 },
      firstSeenChapter: 0,
    });
    const prompt = "Lyra wears her Ghost Broker outfit.";
    const terms = findBibleTermsInText(prompt, b);
    expect(terms.find((t) => t.names.includes("Ghost Broker"))?.kind).toBe("outfit");
    expect(terms.some((t) => t.kind === "character" && t.names.includes("Rell"))).toBe(false);
  });
});
