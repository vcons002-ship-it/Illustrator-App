import { describe, it, expect } from "vitest";
import {
  consolidateCharacters,
  EXTRACTION_SYSTEM,
  extractionSystemFor,
  extractionUserContent,
  mergeExtraction,
  promptSystemFor,
  promptUserContent,
  PROMPT_SYSTEM,
  stripThink,
  TECHNICAL_EXTRACTION_SYSTEM,
  CODE_EXTRACTION_SYSTEM,
  TECHNICAL_PROMPT_SYSTEM,
} from "./extraction.js";
import { createEmptyBible } from "../../visual-bible/bible.js";
import { emptyAppearance, type Character } from "../../types/bible.js";
import type { VisualRequest } from "../../types/content.js";

function char(name: string, over: Partial<Character> = {}): Character {
  return {
    id: `char-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    aliases: [],
    appearance: emptyAppearance(),
    persistentTraits: [],
    clothing: [],
    anchor: { seed: 1 },
    firstSeenChapter: 0,
    ...over,
  };
}

describe("stripThink", () => {
  it("removes a paired <think> block, keeping the answer", () => {
    expect(stripThink("<think>let me reason\nabout this</think>\nthe answer")).toBe("the answer");
  });
  it("handles <thinking> and an opener-omitted stray close tag", () => {
    expect(stripThink("<thinking>reasoning</thinking>X")).toBe("X");
    expect(stripThink("dangling reasoning</think>\n{\"a\":1}")).toBe('{"a":1}');
  });
  it("is a no-op for a non-thinking model's output", () => {
    expect(stripThink('{"characters":[]}')).toBe('{"characters":[]}');
    expect(stripThink("a vivid wide shot of a duel")).toBe("a vivid wide shot of a duel");
  });
});

describe("mergeExtraction keyEvents (folded prompts)", () => {
  it("maps ordered keyEvents onto the chapter's unit page ranges", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [],
        spoilers: [],
        keyEvents: [
          { subject: "Ana", action: "runs", environment: "hall", mood: "tense", composition: "wide", location: "the Hall" },
          { subject: "Bram", action: "waits", environment: "gate", mood: "calm", composition: "close", location: "the Gate" },
        ],
      },
      0,
      [
        [0, 2],
        [3, 4],
      ],
    );
    const ev = bible.storyboard[0]!.keyEvents!;
    expect(ev).toHaveLength(2);
    expect(ev[0]!.pageRange).toEqual([0, 2]);
    expect(ev[0]!.imagePrompt.subject).toBe("Ana");
    expect(ev[1]!.pageRange).toEqual([3, 4]);
    expect(ev[1]!.imagePrompt.composition).toBe("close");
    // Beat-level locations ride along, one per image, tracking the mid-chapter move.
    expect(ev[0]!.location).toBe("the Hall");
    expect(ev[1]!.location).toBe("the Gate");
  });

  it("omits a blank beat location (falls back to chapter-level at render)", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [],
        spoilers: [],
        keyEvents: [{ subject: "Ana", action: "runs", environment: "hall", mood: "", composition: "", location: "  " }],
      },
      0,
      [[0, 0]],
    );
    expect(bible.storyboard[0]!.keyEvents![0]!.location).toBeUndefined();
  });

  it("tolerates more scene prompts than units (uses the shorter count)", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [],
        spoilers: [],
        keyEvents: [
          { subject: "A", action: "", environment: "", mood: "", composition: "" },
          { subject: "B", action: "", environment: "", mood: "", composition: "" },
          { subject: "C", action: "", environment: "", mood: "", composition: "" },
        ],
      },
      0,
      [[0, 0]],
    );
    expect(bible.storyboard[0]!.keyEvents).toHaveLength(1);
  });

  it("drops a fully-empty scene so that unit falls back to the live LLM", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [],
        spoilers: [],
        keyEvents: [{ subject: "", action: "", environment: "", mood: "", composition: "" }],
      },
      0,
      [[0, 0]],
    );
    const scene = bible.storyboard.find((s) => s.chapterIndex === 0);
    expect(scene?.keyEvents ?? []).toHaveLength(0);
  });
});

describe("mergeExtraction storyboard", () => {
  it("upserts a chapter scene and re-running a chapter replaces (not duplicates) it", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      { characters: [], environments: [], spoilers: [], summary: "Ch0 happens", keyMoment: "A duel" },
      0,
    );
    expect(bible.storyboard).toEqual([
      { chapterIndex: 0, summary: "Ch0 happens", keyMoment: "A duel", location: "", locationChange: "" },
    ]);

    // Re-run chapter 0 → replaced, still length 1.
    bible = mergeExtraction(
      bible,
      { characters: [], environments: [], spoilers: [], summary: "Ch0 v2", keyMoment: "A storm" },
      0,
    );
    expect(bible.storyboard).toHaveLength(1);
    expect(bible.storyboard[0]!.keyMoment).toBe("A storm");
  });
});

describe("mergeExtraction delta (incremental) safety", () => {
  it("keeps a known entity when a later chapter OMITS it (nothing re-output)", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [{ name: "Ana", aliases: [], appearance: { hair: "silver" }, persistentTraits: [], clothing: [] }],
        environments: [{ name: "The Spire", description: ["black basalt"] }],
        creatures: [{ name: "Tairn", aliases: [], kind: "dragon", description: ["massive"] }],
        spoilers: [],
      },
      0,
    );
    // Chapter 1 adds nothing about them (delta: omitted entirely).
    bible = mergeExtraction(bible, { characters: [], environments: [], spoilers: [] }, 1);

    expect(bible.characters.find((c) => c.name === "Ana")?.appearance.hair).toBe("silver");
    expect(bible.environments.find((e) => e.name === "The Spire")?.description).toEqual(["black basalt"]);
    expect(bible.creatures.find((c) => c.name === "Tairn")?.description).toEqual(["massive"]);
  });

  it("re-emitting a known character with only NEW detail accumulates (no duplicate)", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [{ name: "Ana", aliases: [], appearance: { hair: "silver" }, persistentTraits: [], clothing: [], outfits: [{ label: "cloak", description: "grey wool" }] }],
        environments: [],
        spoilers: [],
      },
      0,
    );
    // Chapter 1: same character, only the NEW outfit (appearance left blank).
    bible = mergeExtraction(
      bible,
      {
        characters: [{ name: "Ana", aliases: [], appearance: {}, persistentTraits: [], clothing: [], outfits: [{ label: "armour", description: "steel plate" }] }],
        environments: [],
        spoilers: [],
      },
      1,
    );
    const ana = bible.characters.filter((c) => c.name === "Ana");
    expect(ana).toHaveLength(1); // not duplicated
    expect(ana[0]!.appearance.hair).toBe("silver"); // kept
    expect(ana[0]!.outfits?.map((o) => o.label)).toEqual(["cloak", "armour"]); // unioned
  });
});

describe("mergeExtraction glossary + appearance", () => {
  it("upserts glossary entries (deduped by term) and stores structured appearance", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [
          {
            name: "Ana",
            aliases: [],
            appearance: { hair: "silver", gender: "woman", build: "slender, athletic" },
            persistentTraits: [],
            clothing: [],
          },
        ],
        glossary: [{ term: "dragon riders", definition: "wear black flight leathers" }],
        environments: [],
        spoilers: [],
      },
      0,
    );
    expect(bible.glossary).toEqual([
      { term: "dragon riders", definition: "wear black flight leathers" },
    ]);
    const ana = bible.characters.find((c) => c.name === "Ana")!;
    expect(ana.appearance.hair).toBe("silver");
    expect(ana.appearance.gender).toBe("woman");
    expect(ana.appearance.eyes).toBe(""); // unspecified fields default to empty

    // A later chapter re-states the same term (case-insensitive) → not duplicated.
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        glossary: [{ term: "Dragon Riders", definition: "also fireproof gloves" }],
        environments: [],
        spoilers: [],
      },
      1,
    );
    expect(bible.glossary).toHaveLength(1);
  });
});

describe("promptUserContent", () => {
  it("leads with THIS passage, omits the chapter pivotal moment, keeps outfits + background", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [
          { name: "Ana", aliases: [], persistentTraits: ["tall"], clothing: ["red cloak"] },
        ],
        environments: [],
        spoilers: [],
        summary: "Ana arrives in the city.",
        keyMoment: "Ana enters the gates.",
      },
      0,
    );
    bible = mergeExtraction(
      bible,
      { characters: [], environments: [], spoilers: [], summary: "Ana fights.", keyMoment: "The duel." },
      1,
    );

    const req: VisualRequest = {
      kind: "scene_illustration",
      bookId: "b",
      pageId: "u-1",
      pageIndex: 1,
      chapterIndex: 1,
      sourceText: "swords clash",
      characterIds: ["char-ana"],
      environmentIds: [],
      creatureIds: [],
      spoilerIds: [],
    };
    const text = promptUserContent(req, bible);
    // The unit's own passage leads, and the chapter's pivotal moment is NOT injected
    // (that made every unit of a chapter converge on the same beat).
    expect(text).toContain("Passage:\nswords clash");
    expect(text).not.toContain("The duel.");
    expect(text).not.toContain("pivotal moment");
    // Name-anchored: the character is named, not described; prior chapters aren't dumped in.
    expect(text).toContain("Ana");
    expect(text).not.toContain("Ana arrives in the city."); // prior-chapter summary not dumped
    // This chapter's own summary is offered as continuity only.
    expect(text).toContain("Ana fights.");
  });

  it("gives two units of the same chapter different content (their own passages)", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      { characters: [], environments: [], spoilers: [], summary: "A long chase.", keyMoment: "The leap." },
      0,
    );
    const base = {
      kind: "scene_illustration" as const,
      bookId: "b",
      chapterIndex: 0,
      characterIds: [],
      environmentIds: [],
      creatureIds: [],
      spoilerIds: [],
    };
    const a = promptUserContent({ ...base, pageId: "u-0", pageIndex: 0, sourceText: "She vaulted the fence." }, bible);
    const c = promptUserContent({ ...base, pageId: "u-1", pageIndex: 1, sourceText: "He skidded to a halt." }, bible);
    expect(a).toContain("She vaulted the fence.");
    expect(c).toContain("He skidded to a halt.");
    expect(a).not.toEqual(c); // no shared chapter keyMoment forcing them together
    expect(a).not.toContain("The leap."); // chapter climax is not injected per unit
  });

  it("leads with the book title and keeps the prompt scoped to this passage", () => {
    const bible = createEmptyBible("b");
    const req: VisualRequest = {
      kind: "scene_illustration",
      bookId: "b",
      bookTitle: "The Empyrean",
      pageId: "u-0",
      pageIndex: 0,
      chapterIndex: 0,
      sourceText: "swords clash",
      chapterContext: "The whole chapter is a long duel in the rain.",
      characterIds: [],
      environmentIds: [],
      creatureIds: [],
      spoilerIds: [],
    };
    const text = promptUserContent(req, bible);
    expect(text).toContain("Book: The Empyrean.");
    expect(text).toContain("swords clash");
    // The broad chapter-context blob is no longer dumped in (kept the prompt tight).
    expect(text).not.toContain("long duel in the rain");
  });

  it("injects the world glossary as defaults but only NAMES characters (no appearance)", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [
          {
            name: "Ana",
            aliases: [],
            appearance: { hair: "silver", gender: "woman", build: "slender" },
            persistentTraits: [],
            clothing: [],
          },
        ],
        glossary: [{ term: "dragon riders", definition: "wear black flight leathers" }],
        environments: [],
        spoilers: [],
        summary: "Ana rides.",
        keyMoment: "Ana mounts her dragon.",
      },
      0,
    );

    const req: VisualRequest = {
      kind: "scene_illustration",
      bookId: "b",
      pageId: "u-0",
      pageIndex: 0,
      chapterIndex: 0,
      sourceText: "wings beat",
      characterIds: ["char-ana"],
      environmentIds: [],
      creatureIds: [],
      spoilerIds: [],
    };
    const text = promptUserContent(req, bible);
    expect(text).toContain("World facts");
    expect(text).toContain("dragon riders: wear black flight leathers");
    // Name-anchored: the character is named, but appearance is NOT described in the prompt
    // (the bible injects it at render time).
    expect(text).toContain("Ana");
    expect(text).not.toContain("hair: silver");
    expect(text).not.toContain("gender: woman");
  });
});

describe("environments + location tracking", () => {
  it("accumulates location descriptions across chapters (no loss, no dup)", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [{ name: "The Spire", description: ["black basalt tower", "tall"] }],
        spoilers: [],
      },
      0,
    );
    // A later chapter re-describes the same place, adding a detail (and repeating one).
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [{ name: "the spire", description: ["tall", "ringed by storm clouds"] }],
        spoilers: [],
      },
      3,
    );
    const spire = bible.environments.find((e) => e.name.toLowerCase() === "the spire")!;
    expect(bible.environments).toHaveLength(1); // not duplicated by case
    expect(spire.description).toEqual(["black basalt tower", "tall", "ringed by storm clouds"]);
  });

  it("merges environments by alias and accumulates newly-heard aliases", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [
          { name: "Basgiliath", aliases: ["the fortress"], description: ["dark basalt walls"] },
        ],
        spoilers: [],
      },
      0,
    );
    // A later chapter only knows the place by its epithet, with a new alias too.
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [
          { name: "the fortress", aliases: ["the black keep"], description: ["torch-lit gates"] },
        ],
        spoilers: [],
      },
      4,
    );
    expect(bible.environments).toHaveLength(1); // alias matched — no fork
    const env = bible.environments[0]!;
    expect(env.name).toBe("Basgiliath"); // canonical name wins
    expect(env.aliases).toEqual(["the fortress", "the black keep"]);
    expect(env.description).toEqual(["dark basalt walls", "torch-lit gates"]);
  });

  it("stores the chapter location and a single-location Setting line in the prompt", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [{ name: "the Great Hall", description: ["vaulted", "banners"] }],
        spoilers: [],
        summary: "A feast.",
        keyMoment: "The toast.",
        location: "the Great Hall",
        locationChange: "moves to the courtyard at the end",
      },
      0,
    );
    expect(bible.storyboard[0]!.location).toBe("the Great Hall");
    expect(bible.storyboard[0]!.locationChange).toContain("courtyard");

    const req: VisualRequest = {
      kind: "scene_illustration",
      bookId: "b",
      pageId: "u-0",
      pageIndex: 0,
      chapterIndex: 0,
      sourceText: "Goblets rose in the Great Hall.",
      characterIds: [],
      environmentIds: ["env-the-great-hall"],
      creatureIds: [],
      spoilerIds: [],
    };
    const text = promptUserContent(req, bible);
    expect(text).toContain("Setting for this image");
    expect(text).toContain("the Great Hall");
    expect(text).toContain("do not blend places");
  });

  it("prefers the unit's beat-level location over passage matches and the chapter location", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [
          { name: "the Great Hall", description: ["vaulted"] },
          { name: "the Courtyard", description: ["cobbled"] },
        ],
        spoilers: [],
        summary: "A feast, then a duel outside.",
        keyMoment: "The duel.",
        location: "the Great Hall",
        locationChange: "moves to the courtyard midway",
        keyEvents: [
          { subject: "Ana", action: "toasts", environment: "feast", mood: "warm", composition: "wide", location: "the Great Hall" },
          { subject: "Ana", action: "duels", environment: "open air", mood: "tense", composition: "wide", location: "the Courtyard" },
        ],
      },
      0,
      [
        [0, 4],
        [5, 9],
      ],
    );
    const req: VisualRequest = {
      kind: "scene_illustration",
      bookId: "b",
      pageId: "u-1",
      pageIndex: 1,
      chapterIndex: 0,
      // The passage still NAMES the Great Hall (a memory) — the beat location must win.
      pageRange: [5, 9],
      sourceText: "Far from the Great Hall now, blades crossed.",
      characterIds: [],
      environmentIds: ["env-the-great-hall", "env-the-courtyard"],
      creatureIds: [],
      spoilerIds: [],
    };
    const text = promptUserContent(req, bible);
    expect(text).toContain("Setting for this image (use this ONE location, do not blend places): the Courtyard");
  });

  it("feeds known locations back into the next chapter's extraction context", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [{ name: "the Spire", description: ["black basalt"] }],
        spoilers: [],
      },
      0,
    );
    const text = extractionUserContent({
      bookId: "b",
      chapterIndex: 1,
      chapterText: "They returned to the Spire.",
      existing: bible,
    });
    expect(text).toContain("Known locations");
    expect(text).toContain("the Spire");
    // Bounded context: only the NAME is echoed back (the accumulated description is
    // already stored; re-sending it every chapter is what made long books crawl).
    expect(text).not.toContain("black basalt");
  });
});

describe("character de-duplication", () => {
  it("merges a partial name into its unique fuller name (Violet → Violet Sorrengail)", () => {
    const out = consolidateCharacters([
      char("Violet", { appearance: { ...emptyAppearance(), hair: "silver-tipped" } }),
      char("Violet Sorrengail", { appearance: { ...emptyAppearance(), eyes: "blue" } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("Violet Sorrengail"); // fuller name is canonical
    expect(out[0]!.aliases).toContain("Violet");
    // Appearance from both is preserved.
    expect(out[0]!.appearance.hair).toBe("silver-tipped");
    expect(out[0]!.appearance.eyes).toBe("blue");
  });

  it("merges when name/alias sets overlap", () => {
    const out = consolidateCharacters([
      char("Xaden Riorson", { aliases: ["Xaden"] }),
      char("Xaden"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("Xaden Riorson");
  });

  it("leaves an ambiguous bare name alone (two different full names)", () => {
    const out = consolidateCharacters([char("Anne Boleyn"), char("Anne Frank"), char("Anne")]);
    // "Anne" is a subset of BOTH → ambiguous → not merged; all three remain.
    expect(out.map((c) => c.name).sort()).toEqual(["Anne", "Anne Boleyn", "Anne Frank"]);
  });

  it("does NOT merge distinct characters that merely share a generic alias", () => {
    // Models hand the same descriptive alias to several people; that is not identity.
    const out = consolidateCharacters([
      char("Xaden Riorson", { aliases: ["the wingleader"] }),
      char("Garrick Tavis", { aliases: ["the wingleader"] }),
    ]);
    expect(out.map((c) => c.name).sort()).toEqual(["Garrick Tavis", "Xaden Riorson"]);
  });

  it("does NOT chain-merge a cast through shared generic aliases", () => {
    // The catastrophic case: A~B and B~C via generic aliases used to union alias sets
    // and swallow the whole chain into one entry ("lost lots of characters").
    const out = consolidateCharacters([
      char("Violet Sorrengail", { aliases: ["the rider"] }),
      char("Ridoc Gamlyn", { aliases: ["the rider", "her friend"] }),
      char("Sawyer", { aliases: ["her friend"] }),
    ]);
    expect(out).toHaveLength(3);
  });

  it("still merges when one character's primary NAME is the other's alias", () => {
    const out = consolidateCharacters([
      char("Dain Aetos", { aliases: ["Dain", "the squad leader"] }),
      char("Dain", { aliases: ["the squad leader"] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("Dain Aetos");
  });

  it("mergeExtraction consolidates across chapters (no duplicate Violet)", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [{ name: "Violet", aliases: [], persistentTraits: [], clothing: [] }],
        environments: [],
        spoilers: [],
      },
      0,
    );
    bible = mergeExtraction(
      bible,
      {
        characters: [{ name: "Violet Sorrengail", aliases: [], persistentTraits: [], clothing: [] }],
        environments: [],
        spoilers: [],
      },
      4,
    );
    expect(bible.characters).toHaveLength(1);
    expect(bible.characters[0]!.name).toBe("Violet Sorrengail");
    expect(bible.characters[0]!.aliases).toContain("Violet");
  });

  it("feeds the known cast back into the next chapter's extraction context", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [{ name: "Violet Sorrengail", aliases: ["Vi"], persistentTraits: [], clothing: [] }],
        environments: [],
        spoilers: [],
      },
      0,
    );
    const text = extractionUserContent({ bookId: "b", chapterIndex: 1, chapterText: "x", existing: bible });
    expect(text).toContain("Known characters");
    expect(text).toContain("Violet Sorrengail (aka Vi)");
  });
});

describe("appearance accumulation", () => {
  it("keeps adding new appearance details across chapters (does not drop them)", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [
          { name: "Ana", aliases: [], appearance: { hair: "brown" }, persistentTraits: [], clothing: [] },
        ],
        environments: [],
        spoilers: [],
      },
      0,
    );
    bible = mergeExtraction(
      bible,
      {
        characters: [
          {
            name: "Ana",
            aliases: [],
            appearance: { hair: "fades to silver at the tips", eyes: "green" },
            persistentTraits: [],
            clothing: [],
          },
        ],
        environments: [],
        spoilers: [],
      },
      3,
    );
    const ana = bible.characters.find((c) => c.name === "Ana")!;
    expect(ana.appearance.hair).toBe("brown; fades to silver at the tips"); // accumulated
    expect(ana.appearance.eyes).toBe("green"); // newly filled
  });
});

describe("context-based outfits", () => {
  it("accumulates distinct outfits and offers them as scene choices in the prompt", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [
          {
            name: "Violet",
            aliases: [],
            persistentTraits: [],
            outfits: [{ label: "flight leathers", description: "fitted black hide" }],
          },
        ],
        environments: [],
        spoilers: [],
      },
      0,
    );
    // A later chapter adds a different outfit (and repeats the first).
    bible = mergeExtraction(
      bible,
      {
        characters: [
          {
            name: "Violet",
            aliases: [],
            persistentTraits: [],
            outfits: [
              { label: "flight leathers", description: "fitted black hide" },
              { label: "ball gown", description: "emerald silk" },
            ],
          },
        ],
        environments: [],
        spoilers: [],
      },
      3,
    );
    const v = bible.characters.find((c) => c.name === "Violet")!;
    expect(v.outfits?.map((o) => o.label)).toEqual(["flight leathers", "ball gown"]); // deduped by label

    const req: VisualRequest = {
      kind: "scene_illustration",
      bookId: "b",
      pageId: "u-0",
      pageIndex: 0,
      chapterIndex: 0,
      sourceText: "She buckled on her flight leathers.",
      characterIds: ["char-violet"],
      environmentIds: [],
      creatureIds: [],
      spoilerIds: [],
    };
    const prompt = promptUserContent(req, bible);
    // The writer is offered the outfit LABELS to choose from (the bible expands the chosen
    // label into its description at render time).
    expect(prompt).toContain("outfit labels:");
    expect(prompt).toContain("flight leathers");
    expect(prompt).toContain("ball gown");
  });

  it("names a character with no structured outfits (no appearance/clothing dumped)", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [{ name: "Ana", aliases: [], persistentTraits: [], clothing: ["red cloak"] }],
        environments: [],
        spoilers: [],
      },
      0,
    );
    const req: VisualRequest = {
      kind: "scene_illustration",
      bookId: "b",
      pageId: "u-0",
      pageIndex: 0,
      chapterIndex: 0,
      sourceText: "Ana walked.",
      characterIds: ["char-ana"],
      environmentIds: [],
      creatureIds: [],
      spoilerIds: [],
    };
    const prompt = promptUserContent(req, bible);
    expect(prompt).toContain("Ana"); // named, not described
    expect(prompt).not.toContain("red cloak");
  });
});

describe("creatures", () => {
  it("captures a creature, accumulates its description, and injects it into the prompt", () => {
    let bible = createEmptyBible("b");
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [],
        spoilers: [],
        creatures: [{ name: "Tairn", aliases: [], kind: "dragon", description: ["massive", "midnight black"] }],
      },
      0,
    );
    expect(bible.creatures).toHaveLength(1);
    expect(bible.creatures[0]!.kind).toBe("dragon");
    expect(bible.creatures[0]!.anchor.seed).toBeGreaterThan(0);

    // A later chapter names Tairn again, adding detail (and repeating one line).
    bible = mergeExtraction(
      bible,
      {
        characters: [],
        environments: [],
        spoilers: [],
        creatures: [{ name: "tairn", aliases: [], kind: "dragon", description: ["midnight black", "tail spikes"] }],
      },
      2,
    );
    expect(bible.creatures).toHaveLength(1); // deduped by name (case-insensitive)
    expect(bible.creatures[0]!.description).toEqual(["massive", "midnight black", "tail spikes"]);

    // The known-creatures context is fed back for the next chapter.
    const ctx = extractionUserContent({
      bookId: "b",
      chapterIndex: 3,
      chapterText: "Tairn roared.",
      existing: bible,
    });
    expect(ctx).toContain("Known creatures");
    expect(ctx).toContain("Tairn (dragon)");

    // And a present creature is injected into the image prompt.
    const req: VisualRequest = {
      kind: "scene_illustration",
      bookId: "b",
      pageId: "u-0",
      pageIndex: 0,
      chapterIndex: 0,
      sourceText: "Tairn beat his wings.",
      characterIds: [],
      environmentIds: [],
      creatureIds: ["creature-tairn"],
      spoilerIds: [],
    };
    const prompt = promptUserContent(req, bible);
    expect(prompt).toContain("Creatures present");
    // Named, not described — the bible injects the look at render time.
    expect(prompt).toContain("Tairn (dragon)");
    expect(prompt).not.toContain("midnight black");
  });
});

describe("extractionUserContent bounding (perf)", () => {
  it("stays bounded as the bible grows — names only, capped lists, last-K summaries", () => {
    const bible = createEmptyBible("b");
    // A big, mature bible: many entities each carrying lots of accumulated detail,
    // plus a long history of chapter summaries (the O(n) growth that crawled).
    for (let i = 0; i < 60; i++) {
      bible.environments.push({
        id: `env-${i}`,
        name: `Location ${i}`,
        description: Array.from({ length: 12 }, (_, k) => `verbose accumulated detail ${i}-${k}`),
        firstSeenChapter: 0,
      });
      bible.creatures.push({
        id: `cr-${i}`,
        name: `Beast ${i}`,
        aliases: [],
        kind: "dragon",
        description: Array.from({ length: 12 }, (_, k) => `scale detail ${i}-${k}`),
        anchor: { seed: i },
        firstSeenChapter: 0,
      });
      bible.glossary.push({ term: `Term ${i}`, definition: `a very long world-fact definition number ${i} `.repeat(4) });
      bible.storyboard.push({
        chapterIndex: i,
        summary: `Chapter ${i} summary `.repeat(40),
        keyMoment: "x",
        location: "",
        locationChange: "",
      });
    }

    const text = extractionUserContent({
      bookId: "b",
      chapterIndex: 60,
      chapterText: "THE_CHAPTER_BODY",
      existing: bible,
    });

    // Names are still fed back (dedup needs them)…
    expect(text).toContain("Location 0");
    expect(text).toContain("Beast 0");
    // …but the unbounded accumulated descriptions are NOT.
    expect(text).not.toContain("verbose accumulated detail");
    expect(text).not.toContain("scale detail");
    // Lists are capped (40 shown + an overflow marker), not all 60.
    expect(text).not.toContain("Location 59");
    expect(text).toContain("more)");
    // Only the most-recent summaries are echoed (chapter 0's is long gone).
    expect(text).not.toContain("Chapter 0 summary");
    expect(text).toContain("Chapter 59:");
    // The actual chapter body always survives.
    expect(text).toContain("THE_CHAPTER_BODY");

    // Whole "known so far" preamble (everything before the chapter body) stays small.
    const preamble = text.slice(0, text.indexOf("THE_CHAPTER_BODY"));
    expect(preamble.length).toBeLessThan(8000);
  });
});

describe("mature mode", () => {
  const bible = createEmptyBible("b");
  const baseReq = {
    kind: "scene_illustration" as const,
    bookId: "b",
    pageId: "u-0",
    pageIndex: 0,
    chapterIndex: 0,
    sourceText: "They embraced.",
    characterIds: [],
    environmentIds: [],
    creatureIds: [],
    spoilerIds: [],
  };

  it("prepends the mature note to extraction + prompt content only when enabled", () => {
    const off = extractionUserContent({ bookId: "b", chapterIndex: 0, chapterText: "x", existing: bible });
    expect(off).not.toContain("MATURE MODE");
    const on = extractionUserContent({
      bookId: "b",
      chapterIndex: 0,
      chapterText: "x",
      existing: bible,
      allowMature: true,
    });
    expect(on).toContain("MATURE MODE");
    expect(on.startsWith("[MATURE MODE")).toBe(true); // leads the content

    expect(promptUserContent(baseReq, bible)).not.toContain("MATURE MODE");
    expect(promptUserContent({ ...baseReq, allowMature: true }, bible)).toContain("MATURE MODE");
  });
});

describe("promptSystemFor", () => {
  it("picks the technical (concept/diagram) template for technical_illustration", () => {
    expect(promptSystemFor("technical_illustration")).toBe(TECHNICAL_PROMPT_SYSTEM);
    expect(promptSystemFor("scene_illustration")).toBe(PROMPT_SYSTEM);
  });

  it("the technical template explains concepts, not story scenes", () => {
    expect(TECHNICAL_PROMPT_SYSTEM).toMatch(/concept|mechanism|process/i);
    expect(TECHNICAL_PROMPT_SYSTEM).not.toMatch(/Visual Bible/);
  });
});

describe("extractionSystemFor", () => {
  it("picks the Visual-Atlas template for technical books, the Visual Bible otherwise", () => {
    expect(extractionSystemFor("technical")).toBe(TECHNICAL_EXTRACTION_SYSTEM);
    expect(extractionSystemFor("fiction")).toBe(EXTRACTION_SYSTEM);
    expect(extractionSystemFor(undefined)).toBe(EXTRACTION_SYSTEM);
  });

  it("picks the Code-Atlas template for code books", () => {
    expect(extractionSystemFor("code")).toBe(CODE_EXTRACTION_SYSTEM);
    expect(extractionSystemFor("code")).toContain("Code Atlas");
  });

  it("the technical template remaps the schema: structures + data, no characters", () => {
    // Recurring structures/systems land in 'environments' (so name→descriptor injection works)…
    expect(TECHNICAL_EXTRACTION_SYSTEM).toMatch(/STRUCTURE, SYSTEM/);
    // …key information/data lands in the glossary…
    expect(TECHNICAL_EXTRACTION_SYSTEM).toMatch(/quantities\/data points/);
    // …keyEvents become a visualization plan with a priority for what's worth drawing…
    expect(TECHNICAL_EXTRACTION_SYSTEM).toMatch(/VISUALIZATION PLAN/);
    expect(TECHNICAL_EXTRACTION_SYSTEM).toMatch(/quantitative result/);
    expect(TECHNICAL_EXTRACTION_SYSTEM).toMatch(/visual metaphor/);
    // …and people are explicitly out.
    expect(TECHNICAL_EXTRACTION_SYSTEM).toMatch(/'characters', 'creatures', and 'spoilers' as EMPTY/);
  });
});
