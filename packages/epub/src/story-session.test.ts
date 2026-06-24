import { describe, expect, it, vi } from "vitest";
import {
  advanceStoryScene,
  DEFAULT_TIER_CONFIG,
  deterministicSeed,
  emptyAppearance,
  emptyStoryScene,
  Engine,
  MockImageProvider,
  presentFromScene,
  toRenderUnits,
  type EntityExtractionInput,
  type ImageGenerationInput,
  type LLMProvider,
  type StoryRoleplay,
  type StoryScene,
  type VisualBible,
} from "@visual-reader/core";
import { appendStoryChapter, storyBook } from "./from-text.js";

/**
 * TIER-1 methodology harness for "story as you go" (no GPU; MockImage + a scripted LLM).
 *
 * This is the proof the user asked for: scenes + characters stay consistent across a LONG,
 * rapidly-relocating story, and each rendered beat's REQUEST faithfully depicts the tracked
 * cast + setting. It drives the REAL engine append (`Engine.appendChapter`), the REAL
 * incremental bible, the REAL active-scene tracker (`advanceStoryScene`), and the REAL
 * render pipeline end to end — only the LLM (deterministic script) and image (placeholder)
 * are mocked. Every assertion is at the render-INPUT level (anchors/seeds, prompt, bible
 * terms), so "the image represents the scene" is guaranteed deterministically without pixels.
 */

const A = "Aria", B = "Borin", C = "Cira", D = "Dax", E = "Elen", F = "Finn";
const HIGH = "Highspire", RIVER = "Riverdock", THORN = "Thornwood", SEA = "Seacliff";

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** One scripted beat + the ORACLE expectation (independently-computed present cast + place). */
interface Beat {
  text: string;
  mentioned: string[];
  enters: string[];
  exits: string[];
  location?: string;
  roleplay?: StoryRoleplay;
  /** Oracle: who should be present + where, AFTER this beat. */
  present: string[];
  expectLocation: string;
}

/**
 * Build a long, location-hopping story with a hand-applied oracle. The oracle reducer here
 * is written independently of `advanceStoryScene` (plain name-set add/remove) — it works in
 * NAMES while the engine works in bible IDS — so asserting they agree is a fair cross-check
 * of name→id resolution, carry-forward, role-play seeding, exits, and the extraction→render
 * timing, not a tautology.
 */
function buildStory(): Beat[] {
  const beats: Beat[] = [];
  const present = new Set<string>();
  let location = "";
  let roleplay: string[] = [];

  const push = (o: {
    prose?: string;
    mentioned?: string[];
    enters?: string[];
    exits?: string[];
    location?: string;
  }): void => {
    const k = beats.length;
    for (const n of roleplay) present.add(n);
    for (const n of [...(o.mentioned ?? []), ...(o.enters ?? [])]) present.add(n);
    for (const n of o.exits ?? []) present.delete(n);
    if (o.location) location = o.location;
    beats.push({
      text: `Scene ${k}. ${o.prose ?? "The story continues."}`,
      mentioned: o.mentioned ?? [],
      enters: o.enters ?? [],
      exits: o.exits ?? [],
      ...(o.location ? { location: o.location } : {}),
      ...(roleplay.length ? { roleplay: { playedCharacterNames: [...roleplay] } } : {}),
      present: [...present],
      expectLocation: location,
    });
  };
  const filler = (n: number, prose: string): void => {
    // Terse, name-less beats: presence must come from the tracker, not the text.
    for (let i = 0; i < n; i++) push({ prose });
  };

  // — Act I: Highspire. Aria + Borin established; terse beats must carry them. —
  push({ prose: `${A} and ${B} meet beneath the towers.`, mentioned: [A, B], location: HIGH });
  filler(4, "A long, quiet conversation unfolds.");
  push({ prose: `${C} arrives with news.`, enters: [C] });
  filler(3, "They weigh the warning in silence.");

  // — Act II: travel to Riverdock; Borin leaves; Dax joins; move to Thornwood. —
  push({ prose: "The party rides downriver.", location: RIVER });
  filler(3, "Rain falls on the long road." );
  push({ prose: `${B} slips away into the crowd.`, exits: [B] });
  filler(4, "The remaining two press on." );
  push({ prose: `${D} falls in step with them.`, enters: [D], location: THORN });
  filler(3, "The forest closes overhead." );
  push({ prose: `${C} turns back toward home.`, exits: [C] });
  filler(2, "Only two walk the deer-path now." );

  // — Act III: return to Highspire (env REUSE); Borin returns; crowd at Seacliff. —
  push({ prose: "They climb back to the old keep.", location: HIGH });
  filler(3, "Familiar halls, an unfamiliar mood." );
  push({ prose: `${B} rejoins them at the gate.`, enters: [B] });
  filler(2, "The reunion is brief." );
  push({ prose: `They sail to the cliffs; ${E} and ${F} are waiting.`, enters: [E, F], location: SEA });
  filler(3, "Five gather on the windy ledge." ); // crowd > 4
  push({ prose: `${E} departs by boat.`, exits: [E] });
  push({ prose: `${F} departs after.`, exits: [F] });
  filler(2, "The core three remain." );

  // — Act IV: role-play 2-hander (Aria + Borin played; both present even when unnamed). —
  push({ prose: "They make camp to talk it through.", exits: [D], location: HIGH });
  roleplay = [A, B];
  push({ prose: `"We end this here," ${A} says.`, mentioned: [A] });
  filler(5, '"And if we cannot?" — a long pause.'); // name-less role-play beats: both stay present
  push({ prose: `${C} appears at the firelight.`, enters: [C] });
  filler(2, "An uneasy three-way silence." );
  push({ prose: `${C} withdraws into the dark.`, exits: [C] });
  filler(4, "Just the two of them again." );
  roleplay = [];

  // — Act V: long tail to stress carry-over depth (Aria long-lived to the very end). —
  push({ prose: "The road turns home one last time.", location: RIVER });
  filler(8, "Miles pass without a word." );
  push({ prose: `${D} catches up at the ford.`, enters: [D] });
  filler(6, "The current is high and cold." );
  push({ prose: "They reach the keep at dusk.", location: HIGH });
  filler(6, "The long story draws to its close." );

  return beats;
}

class ScriptedLLM implements LLMProvider {
  readonly id = "scripted";
  constructor(private readonly beats: Beat[]) {}

  async extractEntities(input: EntityExtractionInput): Promise<VisualBible> {
    const beat = this.beats[input.chapterIndex];
    const bible: VisualBible = {
      ...input.existing,
      characters: [...input.existing.characters],
      environments: [...input.existing.environments],
      creatures: [...(input.existing.creatures ?? [])],
      storyboard: [...(input.existing.storyboard ?? [])],
      processedChapters: [...input.existing.processedChapters],
    };
    if (beat) {
      // Introduce any character named/entering this beat — idempotent (ONE entry per name,
      // a stable per-name seed), exactly like the real incremental bible accumulates.
      const known = new Set(bible.characters.map((c) => c.name));
      for (const name of unique([...beat.mentioned, ...beat.enters])) {
        if (known.has(name)) continue;
        known.add(name);
        bible.characters.push({
          id: `char-${slug(name)}`,
          name,
          aliases: [],
          appearance: emptyAppearance(),
          persistentTraits: [`${name}'s steady look`],
          clothing: [],
          anchor: { seed: deterministicSeed(name) },
          firstSeenChapter: input.chapterIndex,
        });
      }
      // Ensure the beat's location exists (idempotent — a return reuses the same entry).
      if (beat.location && !bible.environments.some((e) => e.name === beat.location)) {
        bible.environments.push({
          id: `env-${slug(beat.location)}`,
          name: beat.location,
          aliases: [],
          description: [`${beat.location}, a recurring place`],
          firstSeenChapter: input.chapterIndex,
        });
      }
      // Fold ONE keyEvent per render unit, naming ONLY the chars the beat's prose states —
      // carried-forward cast + the current location are added by the active-scene render path.
      const named = beat.mentioned.join(" and ");
      const keyEvents = (input.unitRanges ?? []).map((pageRange) => ({
        pageRange,
        imagePrompt: { text: `[beat ${input.chapterIndex}] ${named || "the scene continues"}` },
      }));
      bible.storyboard = [
        ...bible.storyboard.filter((s) => s.chapterIndex !== input.chapterIndex),
        {
          chapterIndex: input.chapterIndex,
          summary: beat.text,
          keyMoment: named || beat.text,
          location: beat.location ?? "",
          locationChange: "",
          ...(keyEvents.length ? { keyEvents } : {}),
        },
      ].sort((a, b) => a.chapterIndex - b.chapterIndex);
    }
    if (!bible.processedChapters.includes(input.chapterIndex)) {
      bible.processedChapters.push(input.chapterIndex);
    }
    return bible;
  }

  async buildImagePrompt(): Promise<string> {
    return "unused — keyEvents are folded in";
  }
  async chat(): Promise<string> {
    return "unused";
  }
}

describe("story as you go — Tier-1 methodology", () => {
  it("keeps cast + setting consistent and renders each beat with the tracked scene (long, multi-location)", async () => {
    const beats = buildStory();
    expect(beats.length).toBeGreaterThanOrEqual(60); // a genuinely long story

    const image = new MockImageProvider();
    const realGen = image.generate.bind(image);
    const captured = new Map<number, ImageGenerationInput>();
    let genCalls = 0;
    vi.spyOn(image, "generate").mockImplementation(async (input) => {
      genCalls++;
      const m = /\[beat (\d+)\]/.exec(input.prompt);
      if (m) captured.set(Number(m[1]), input);
      return realGen(input);
    });

    const llm = new ScriptedLLM(beats);
    const extractCalls: number[] = [];
    const realExtract = llm.extractEntities.bind(llm);
    vi.spyOn(llm, "extractEntities").mockImplementation((input) => {
      extractCalls.push(input.chapterIndex);
      return realExtract(input);
    });

    // Active-scene tracker — exactly what the worker wires: after each beat is extracted,
    // advance the scene from the beat's signal and pin the resolved present-set as the
    // render override.
    let scene: StoryScene = emptyStoryScene();
    const engine = new Engine({
      llm,
      image,
      tier: { ...DEFAULT_TIER_CONFIG, tier: "local" }, // local → terms passed (descriptor injection assert)
      illustrateAfter: "chapter",
      onChapterExtracted: (chapterIndex, bible) => {
        const beat = beats[chapterIndex];
        if (!beat) return undefined;
        scene = advanceStoryScene(
          scene,
          bible,
          {
            mentionedNames: beat.mentioned,
            enters: beat.enters,
            exits: beat.exits,
            ...(beat.location ? { location: beat.location } : {}),
          },
          beat.roleplay,
        );
        return presentFromScene(scene);
      },
    });

    // Beat 0 opens the story; each later beat appends one span (the real as-you-go loop).
    let book = storyBook("story-test", "The Long Road", "You + Buddy", [beats[0]!.text]);
    await engine.openBook(toRenderUnits(book, "chapter").book);
    engine.startGeneration();
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));
    const firstImage = engine.resultFor(0)?.image;

    for (let k = 1; k < beats.length; k++) {
      book = appendStoryChapter(
        book,
        beats.slice(0, k).map((b) => b.text),
        beats[k]!.text,
      );
      const { firstNewUnit } = await engine.appendChapter(toRenderUnits(book, "chapter").book);
      expect(firstNewUnit).toBe(k); // one beat == one render unit
      await vi.waitFor(() => expect(engine.resultFor(k)?.status).toBe("ready"));
    }

    // — Mechanics: O(beat) append, no prior re-work —
    const extractCount = new Map<number, number>();
    for (const c of extractCalls) extractCount.set(c, (extractCount.get(c) ?? 0) + 1);
    for (let k = 0; k < beats.length; k++) {
      expect(extractCount.get(k), `chapter ${k} extracted exactly once`).toBe(1);
    }
    expect(genCalls, "one render per beat — no prior unit re-rendered").toBe(beats.length);
    expect(engine.resultFor(0)?.image, "beat 0's image was never re-rendered").toBe(firstImage);

    // — Entity consistency over the whole story —
    const bible = engine.getBible()!;
    const names = bible.characters.map((c) => c.name);
    expect(new Set(names).size, "no duplicate / alias-split character entries").toBe(names.length);
    for (const n of [A, B, C, D, E, F]) {
      expect(names.filter((x) => x === n).length, `${n} has exactly one entry`).toBe(1);
    }
    for (const c of bible.characters) {
      expect(c.anchor.seed, `${c.name}'s identity seed is stable`).toBe(deterministicSeed(c.name));
    }
    // Four distinct places, even though the story returns to Highspire/Riverdock repeatedly.
    expect(bible.environments.map((e) => e.name).sort()).toEqual([HIGH, RIVER, SEA, THORN].sort());

    // — Scene fidelity at the render-request level, FOR EVERY BEAT —
    for (let k = 0; k < beats.length; k++) {
      const beat = beats[k]!;
      const input = captured.get(k);
      expect(input, `beat ${k} produced a render`).toBeDefined();
      expect(beat.present.length, `beat ${k} has a present cast`).toBeGreaterThan(0);

      // (1) Cast identity: the render's anchor seeds are EXACTLY the tracked present cast's
      // seeds — no ghost (present-but-not-in-scene) and no missing (in-scene-but-absent).
      const expectedSeeds = new Set(beat.present.map((n) => deterministicSeed(n)));
      const gotSeeds = new Set((input!.anchors ?? []).map((a) => a.seed));
      expect(gotSeeds, `beat ${k} present cast = ${beat.present.join(",")}`).toEqual(expectedSeeds);

      // (2) Every present character + the current location is NAMED in the prompt (so the
      // image model is told who/where — carried forward even on terse, name-less beats).
      for (const n of beat.present) {
        expect(input!.prompt, `beat ${k} names ${n}`).toContain(n);
      }
      expect(input!.prompt, `beat ${k} names location ${beat.expectLocation}`).toContain(beat.expectLocation);

      // (3) Bible terms (descriptor injection) cover every present character + the location.
      const termNames = (input!.terms ?? []).flatMap((t) => t.names);
      for (const n of beat.present) {
        expect(termNames, `beat ${k} injects ${n}'s descriptor`).toContain(n);
      }
      expect(termNames, `beat ${k} injects ${beat.expectLocation}'s descriptor`).toContain(beat.expectLocation);
    }

    // — Long-story robustness: a beat-0 character is still resolved + present at the end —
    const lastBeat = beats[beats.length - 1]!;
    expect(lastBeat.present, "Aria (introduced at beat 0) is still in the final scene").toContain(A);
  });

  it("a name-less / dialogue-only beat still illustrates the carried cast (not an empty frame)", async () => {
    // Two beats: the second names NO ONE. Presence must come from the tracker.
    const beats: Beat[] = [
      { text: "Scene 0. Aria and Borin enter the hall.", mentioned: [A, B], enters: [], exits: [], location: HIGH, present: [A, B], expectLocation: HIGH },
      { text: "Scene 1. A long silence; someone finally nods.", mentioned: [], enters: [], exits: [], present: [A, B], expectLocation: HIGH },
    ];
    const image = new MockImageProvider();
    const realGen = image.generate.bind(image);
    const captured = new Map<number, ImageGenerationInput>();
    vi.spyOn(image, "generate").mockImplementation(async (input) => {
      const m = /\[beat (\d+)\]/.exec(input.prompt);
      if (m) captured.set(Number(m[1]), input);
      return realGen(input);
    });
    let scene: StoryScene = emptyStoryScene();
    const engine = new Engine({
      llm: new ScriptedLLM(beats),
      image,
      tier: { ...DEFAULT_TIER_CONFIG, tier: "local" },
      illustrateAfter: "chapter",
      onChapterExtracted: (chapterIndex, bible) => {
        const beat = beats[chapterIndex]!;
        scene = advanceStoryScene(scene, bible, {
          mentionedNames: beat.mentioned,
          exits: beat.exits,
          ...(beat.location ? { location: beat.location } : {}),
        });
        return presentFromScene(scene);
      },
    });
    let book = storyBook("story-nameless", "Nameless", undefined, [beats[0]!.text]);
    await engine.openBook(toRenderUnits(book, "chapter").book);
    engine.startGeneration();
    await vi.waitFor(() => expect(engine.resultFor(0)?.status).toBe("ready"));
    book = appendStoryChapter(book, [beats[0]!.text], beats[1]!.text);
    await engine.appendChapter(toRenderUnits(book, "chapter").book);
    await vi.waitFor(() => expect(engine.resultFor(1)?.status).toBe("ready"));

    // The terse beat 1 still renders BOTH characters (carried) + the location.
    const terse = captured.get(1)!;
    const seeds = new Set((terse.anchors ?? []).map((a) => a.seed));
    expect(seeds).toEqual(new Set([deterministicSeed(A), deterministicSeed(B)]));
    expect(terse.prompt).toContain(A);
    expect(terse.prompt).toContain(B);
    expect(terse.prompt).toContain(HIGH);
  });
});
