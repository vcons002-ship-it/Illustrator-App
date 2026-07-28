import { describe, expect, it } from "vitest";
import { createEmptyBible } from "./bible.js";
import {
  advanceStoryScene,
  emptyStoryScene,
  locationToEnvironmentId,
  namesToCharacterIds,
  presentFromScene,
  type StoryScene,
} from "./story-scene.js";
import { emptyAppearance, type Character, type Environment, type VisualBible } from "../types/bible.js";

/** A bible with the given characters/environments (everything else empty). */
function bibleWith(opts: {
  characters?: { name: string; aliases?: string[] }[];
  environments?: { name: string; aliases?: string[] }[];
}): VisualBible {
  const characters: Character[] = (opts.characters ?? []).map((c, i) => ({
    id: `char-${c.name.toLowerCase()}`,
    name: c.name,
    aliases: c.aliases ?? [],
    appearance: emptyAppearance(),
    persistentTraits: [],
    clothing: [],
    anchor: { seed: 1000 + i },
    firstSeenChapter: 0,
  }));
  const environments: Environment[] = (opts.environments ?? []).map((e) => ({
    id: `env-${e.name.toLowerCase().replace(/\s+/g, "-")}`,
    name: e.name,
    aliases: e.aliases ?? [],
    description: [],
    firstSeenChapter: 0,
  }));
  return { ...createEmptyBible("book-x"), characters, environments };
}

describe("namesToCharacterIds", () => {
  const bible = bibleWith({ characters: [{ name: "Aria", aliases: ["the Captain"] }, { name: "Borin" }] });

  it("resolves by name and alias, case-insensitively", () => {
    expect(namesToCharacterIds(bible, ["aria"])).toEqual(["char-aria"]);
    expect(namesToCharacterIds(bible, ["the captain"])).toEqual(["char-aria"]);
    expect(namesToCharacterIds(bible, ["BORIN"])).toEqual(["char-borin"]);
  });

  it("drops unknown names and dedups in bible order", () => {
    expect(namesToCharacterIds(bible, ["Aria", "Ghost", "Aria"])).toEqual(["char-aria"]);
    expect(namesToCharacterIds(bible, ["Borin", "Aria"])).toEqual(["char-aria", "char-borin"]);
  });
});

describe("locationToEnvironmentId", () => {
  const bible = bibleWith({ environments: [{ name: "Highspire", aliases: ["the keep"] }, { name: "Riverdock" }] });

  it("matches exact name/alias and contains-both-ways", () => {
    expect(locationToEnvironmentId(bible, "Highspire")).toBe("env-highspire");
    expect(locationToEnvironmentId(bible, "the keep")).toBe("env-highspire");
    // "the throne room of Highspire" CONTAINS "highspire".
    expect(locationToEnvironmentId(bible, "the throne room of Highspire")).toBe("env-highspire");
  });

  it("returns undefined for an unknown / empty place", () => {
    expect(locationToEnvironmentId(bible, "Atlantis")).toBeUndefined();
    expect(locationToEnvironmentId(bible, "")).toBeUndefined();
    expect(locationToEnvironmentId(bible, undefined)).toBeUndefined();
  });
});

describe("advanceStoryScene", () => {
  const bible = bibleWith({
    characters: [{ name: "Aria" }, { name: "Borin" }, { name: "Cira" }],
    environments: [{ name: "Highspire" }, { name: "Riverdock" }],
  });

  it("adds newly-mentioned characters and resolves the location", () => {
    const next = advanceStoryScene(emptyStoryScene(), bible, {
      mentionedNames: ["Aria", "Borin"],
      location: "Highspire",
    });
    expect(next.presentCharacterIds).toEqual(["char-aria", "char-borin"]);
    expect(next.locationId).toBe("env-highspire");
  });

  it("carries the present cast + location forward across a terse, name-less beat", () => {
    const prev: StoryScene = { presentCharacterIds: ["char-aria", "char-borin"], locationId: "env-highspire" };
    const next = advanceStoryScene(prev, bible, {}); // a "she nods" beat — nothing named
    expect(next.presentCharacterIds).toEqual(["char-aria", "char-borin"]);
    expect(next.locationId).toBe("env-highspire");
  });

  it("moves the location but keeps the cast (a walk to a new place)", () => {
    const prev: StoryScene = { presentCharacterIds: ["char-aria", "char-borin"], locationId: "env-highspire" };
    const next = advanceStoryScene(prev, bible, { location: "Riverdock" });
    expect(next.presentCharacterIds).toEqual(["char-aria", "char-borin"]);
    expect(next.locationId).toBe("env-riverdock");
  });

  it("removes a character who exits, keeps the rest", () => {
    const prev: StoryScene = { presentCharacterIds: ["char-aria", "char-borin"], locationId: "env-highspire" };
    const next = advanceStoryScene(prev, bible, { exits: ["Borin"] });
    expect(next.presentCharacterIds).toEqual(["char-aria"]);
  });

  it("an enter+exit in the same beat nets out to absent", () => {
    const next = advanceStoryScene(emptyStoryScene(), bible, { enters: ["Cira"], exits: ["Cira"] });
    expect(next.presentCharacterIds).toEqual([]);
  });

  it("role-play: both played characters stay present even on beats that name no one", () => {
    const roleplay = { playedCharacterNames: ["Aria", "Borin"] };
    let scene = advanceStoryScene(emptyStoryScene(), bible, { location: "Highspire" }, roleplay);
    expect(new Set(scene.presentCharacterIds)).toEqual(new Set(["char-aria", "char-borin"]));
    // A pure-dialogue beat naming no one: the played cast persists.
    scene = advanceStoryScene(scene, bible, {}, roleplay);
    expect(new Set(scene.presentCharacterIds)).toEqual(new Set(["char-aria", "char-borin"]));
    // A guest enters; the played cast is still present.
    scene = advanceStoryScene(scene, bible, { enters: ["Cira"] }, roleplay);
    expect(new Set(scene.presentCharacterIds)).toEqual(new Set(["char-aria", "char-borin", "char-cira"]));
  });

  it("keeps a stable order (prior cast first) so the present set doesn't churn", () => {
    const prev: StoryScene = { presentCharacterIds: ["char-borin", "char-aria"], locationId: "env-highspire" };
    const next = advanceStoryScene(prev, bible, { mentionedNames: ["Cira"] });
    // Prior two keep their order; the newcomer is appended.
    expect(next.presentCharacterIds).toEqual(["char-borin", "char-aria", "char-cira"]);
  });

  it("returning to a prior location reuses the SAME environment id", () => {
    let scene = advanceStoryScene(emptyStoryScene(), bible, { location: "Highspire" });
    const first = scene.locationId;
    scene = advanceStoryScene(scene, bible, { location: "Riverdock" });
    scene = advanceStoryScene(scene, bible, { location: "Highspire" });
    expect(scene.locationId).toBe(first); // same entry, not a duplicate
  });
});

describe("presentFromScene", () => {
  it("maps a scene to a render override (cast + the one location env)", () => {
    const present = presentFromScene({ presentCharacterIds: ["char-aria"], locationId: "env-highspire" });
    expect(present).toEqual({ characterIds: ["char-aria"], environmentIds: ["env-highspire"], creatureIds: [] });
  });

  it("omits the environment when no location is tracked yet", () => {
    expect(presentFromScene({ presentCharacterIds: ["char-aria"] })).toEqual({
      characterIds: ["char-aria"],
      environmentIds: [],
      creatureIds: [],
    });
  });
});

/**
 * The scene's cast decides whose descriptor rides into the image prompt, so a phantom extra here is
 * an extra FACE in the picture. Aliases collide with real names ("Rell" holding "the Captain" while
 * another character IS "The Captain"), and matching them blindly meant asking for two characters and
 * getting three.
 */
describe("a requested name resolves to the character who owns it", () => {
  const bible = bibleWith({
    characters: [
      { name: "Rell", aliases: ["the Captain"] }, // listed first, so order can't rescue it
      { name: "Mara" },
      { name: "The Captain" },
    ],
  });

  it("doesn't also return the character holding that name as an ALIAS", () => {
    expect(namesToCharacterIds(bible, ["Mara", "The Captain"])).toEqual(["char-mara", "char-the captain"]);
  });

  it("an alias that collides with nobody still resolves", () => {
    const b = bibleWith({ characters: [{ name: "Rell", aliases: ["the quartermaster"] }] });
    expect(namesToCharacterIds(b, ["the quartermaster"])).toEqual(["char-rell"]);
  });

  it("a shared alias nobody owns as a name still returns both — there's nothing to choose between", () => {
    const b = bibleWith({ characters: [{ name: "Rell", aliases: ["the rider"] }, { name: "Mara", aliases: ["the rider"] }] });
    expect(namesToCharacterIds(b, ["the rider"])).toEqual(["char-rell", "char-mara"]);
  });

  it("the scene tracker therefore keeps the third character out of the beat", () => {
    const scene = advanceStoryScene(emptyStoryScene(), bible, { mentionedNames: ["Mara", "The Captain"] });
    expect(scene.presentCharacterIds).toEqual(["char-mara", "char-the captain"]);
  });
});

/**
 * The reported case, at the layer that made it STICK: the worker fed the tracker a bare
 * `text.includes(name)` scan, so a beat set in "Sato's Synthetic Noodles" reported Sato as mentioned
 * — and the present cast CARRIES FORWARD, so one bad beat kept him in every picture afterwards. The
 * worker now feeds it findBibleTermsInText (same matcher as the render). These tests cover the
 * tracker's half: given a correct mention list, the cast is right; given a bad one, it persists.
 */
describe("a place named after a character doesn't join the cast", () => {
  const bible = bibleWith({
    characters: [{ name: "Sato" }, { name: "Mara" }, { name: "Cass" }],
    environments: [{ name: "Sato's Synthetic Noodles" }],
  });

  it("three in the scene, place named after a FOURTH: only the three", () => {
    const scene = advanceStoryScene(emptyStoryScene(), bible, {
      mentionedNames: ["Mara", "Cass"],
      location: "Sato's Synthetic Noodles",
    });
    expect(scene.presentCharacterIds).toEqual(["char-mara", "char-cass"]);
    expect(scene.locationId).toBe("env-sato's-synthetic-noodles");
  });

  it("and when Sato IS there, he's there — the place doesn't remove him", () => {
    const scene = advanceStoryScene(emptyStoryScene(), bible, {
      mentionedNames: ["Sato", "Mara", "Cass"],
      location: "Sato's Synthetic Noodles",
    });
    expect(scene.presentCharacterIds).toEqual(["char-sato", "char-mara", "char-cass"]);
  });

  it("shows why it mattered: a cast is CARRIED FORWARD, so one wrong beat is every later beat", () => {
    // A bad mention list (what the old bare-substring scan produced) on beat one...
    const beat1 = advanceStoryScene(emptyStoryScene(), bible, {
      mentionedNames: ["Sato", "Mara", "Cass"],
      location: "Sato's Synthetic Noodles",
    });
    // ...and beat two mentions nobody, as chat beats often don't.
    const beat2 = advanceStoryScene(beat1, bible, {});
    expect(beat2.presentCharacterIds).toContain("char-sato"); // still there, and would stay
  });
});
