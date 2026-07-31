import { describe, expect, it } from "vitest";
import {
  type SoulKind,
  type SoulNote,
  MAX_SOUL_NOTE_CHARS,
  MAX_SOUL_NOTES,
  SOUL_ESSENCE_FACETS,
  SOUL_ESSENCE_SCHEMA_VERSION,
  buildSoulEssenceDistillationPrompt,
  parseSoulEssence,
  reconcileSoulAppearance,
  selfSoulEssencePromptBlock,
  selfSoulPromptBlock,
  soulEvidencePromptBlock,
  soulNoteSources,
  soulSourceFingerprint,
  visualSoulNotes,
} from "./souls.js";

const note = (text: string, at = 1): SoulNote => ({ text, at });
const undatedNote = (text: string): SoulNote =>
  ({ text, at: undefined }) as unknown as SoulNote;

function appearanceText(notes: readonly SoulNote[]): string {
  return reconcileSoulAppearance(notes).activeFacts
    .map((fact) => fact.text)
    .join("; ")
    .toLowerCase();
}

function emptyEssencePayload(
  kind: SoulKind,
  notes: readonly SoulNote[],
): Record<string, unknown> {
  return {
    schemaVersion: SOUL_ESSENCE_SCHEMA_VERSION,
    kind,
    sourceFingerprint: soulSourceFingerprint(notes),
    generalizedEssence: { text: "", sourceIds: [] },
    facets: Object.fromEntries(
      SOUL_ESSENCE_FACETS.map((key) => [key, { text: "", sourceIds: [] }]),
    ),
    exactAppearance: [],
  };
}

function personalityEssencePayload(
  kind: SoulKind,
  notes: readonly SoulNote[],
  sourceIds: readonly string[],
): Record<string, unknown> {
  const payload = emptyEssencePayload(kind, notes);
  payload.generalizedEssence = {
    text: "Candid and principled.",
    sourceIds: [...sourceIds],
  };
  const facets = payload.facets as Record<
    string,
    { text: string; sourceIds: string[] }
  >;
  facets.valuesAndMotivations = {
    text: "Values honest disagreement.",
    sourceIds: [...sourceIds],
  };
  return payload;
}

describe("Soul appearance reconciliation", () => {
  it("orders finite timestamps chronologically, breaks ties by source order, and treats missing times as oldest", () => {
    expect(
      appearanceText([
        note("green eyes", 20),
        note("blue eyes", 10),
      ]),
    ).toMatch(/\bgreen eyes\b/);
    expect(
      appearanceText([
        note("green eyes", 20),
        note("blue eyes", 10),
      ]),
    ).not.toMatch(/\bblue eyes\b/);

    const tied = appearanceText([
      note("blue eyes", 30),
      note("hazel eyes", 30),
    ]);
    expect(tied).toMatch(/\bhazel eyes\b/);
    expect(tied).not.toMatch(/\bblue eyes\b/);

    const missingThenFinite = appearanceText([
      undatedNote("blue eyes"),
      note("amber eyes", 1),
    ]);
    expect(missingThenFinite).toMatch(/\bamber eyes\b/);
    expect(missingThenFinite).not.toMatch(/\bblue eyes\b/);

    const bothMissing = appearanceText([
      undatedNote("blue eyes"),
      undatedNote("violet eyes"),
    ]);
    expect(bothMissing).toMatch(/\bviolet eyes\b/);
    expect(bothMissing).not.toMatch(/\bblue eyes\b/);
  });

  it("uses a newer eye colour and never carries the superseded colour forward", () => {
    const projection = reconcileSoulAppearance([
      note("blue eyes", 1),
      note("green eyes", 2),
    ]);
    const current = projection.activeFacts.map((fact) => fact.text).join("; ");

    expect(current).toMatch(/\bgreen eyes\b/i);
    expect(current).not.toMatch(/\bblue eyes\b/i);
    expect(projection.supersededSourceIds).toContain(
      soulNoteSources([note("blue eyes", 1), note("green eyes", 2)])[0]!.id,
    );
  });

  it("keeps an eye's base color separate from its texture and colored flecks", () => {
    const description =
      "My eyes are deep, mossy green, with complex, organic textures and subtle amber flecks, " +
      "as if catching sunlight filtering through a dense forest canopy.";
    const exactNotes = [note(description)];
    const exact = visualSoulNotes(exactNotes, 2_000);
    const exactEssence = parseSoulEssence(
      JSON.stringify(emptyEssencePayload("self", exactNotes)),
      "self",
      exactNotes,
    );
    const exactPrompt = selfSoulEssencePromptBlock(exactEssence);

    expect(exact).toBe(
      "eye color: deep, mossy green; eye detail: complex, organic textures and subtle amber flecks, " +
        "as if catching sunlight filtering through a dense forest canopy",
    );
    expect(exact).toMatch(/\bdeep, mossy green\b/i);
    expect(exact).toMatch(/\bcomplex, organic textures\b/i);
    expect(exact).toMatch(/\bsubtle amber flecks\b/i);
    expect(exact).toMatch(/as if catching sunlight filtering through a dense forest canopy/i);
    expect(exactEssence?.exactAppearance.map((fact) => fact.slot)).toEqual([
      "eyes.color",
      "eyes.detail",
    ]);
    expect(exactPrompt).toContain(exact);

    const notes = [
      note("Eye color: deep, mossy green", 1),
      note("Eyes: complex, organic textures and subtle amber flecks", 2),
    ];
    const projection = reconcileSoulAppearance(notes);
    const current = visualSoulNotes(notes, 2_000);
    const colorFacts = projection.activeFacts.filter((fact) => fact.slot === "eyes.color");
    const detailFacts = projection.activeFacts.filter((fact) => fact.slot === "eyes.detail");

    expect(current).toMatch(/\bdeep, mossy green\b/i);
    expect(current).toMatch(/\bcomplex, organic textures and subtle amber flecks\b/i);
    expect(colorFacts.map((fact) => fact.text).join("; ")).toMatch(/\bdeep, mossy green\b/i);
    expect(colorFacts.map((fact) => fact.text).join("; ")).not.toMatch(/amber|flecks|textures/i);
    expect(detailFacts.map((fact) => fact.text).join("; ")).toMatch(/amber flecks/i);
  });

  it.each([
    ["Eyes: amber-flecked green.", /eye color: green/i, /eye detail: amber-flecked/i],
    ["Eye colour: ultramarine with gold flecks.", /eye color: ultramarine/i, /eye detail: gold flecks/i],
    ["Eye color: blue-green with gold flecks.", /eye color: blue-green/i, /eye detail: gold flecks/i],
    ["My eyes, a vivid green, have amber flecks.", /eye color: vivid green/i, /eye detail: amber flecks/i],
    ["Eyes: blue flecked with amber.", /eye color: blue/i, /eye detail: flecked with amber/i],
    ["Eyes: green ringed with gold.", /eye color: green/i, /eye detail: ringed with gold/i],
    ["Eyes: ultramarine with gold flecks.", /eye color: ultramarine/i, /eye detail: gold flecks/i],
    ["Eye color: tangerine with gold flecks.", /eye color: tangerine/i, /eye detail: gold flecks/i],
  ])("separates base eye color from accent detail in %s", (description, color, detail) => {
    const current = visualSoulNotes([note(description)], 2_000);

    expect(current).toMatch(color);
    expect(current).toMatch(detail);
  });

  it.each(["glossy", "cloudy", "glassy", "reflective", "heterochromatic"])(
    "keeps the generic eye descriptor %s as detail rather than inventing a base color",
    (descriptor) => {
      const projection = reconcileSoulAppearance([
        note(`Eyes: ${descriptor} with gold flecks.`),
      ]);
      const current = visualSoulNotes([
        note(`Eyes: ${descriptor} with gold flecks.`),
      ], 2_000);

      expect(current).toMatch(new RegExp(`eye detail: ${descriptor} with gold flecks`, "i"));
      expect(projection.activeFacts.some((fact) => fact.slot === "eyes.color")).toBe(false);
    },
  );

  it("does not use an accent inside a generic detail clause as the base eye color", () => {
    const notes = [note("Eyes: heterochromatic with blue and gold flecks.")];
    const projection = reconcileSoulAppearance(notes);
    const current = visualSoulNotes(notes, 2_000);

    expect(current).toMatch(/eye detail: heterochromatic with blue and gold flecks/i);
    expect(projection.activeFacts.some((fact) => fact.slot === "eyes.color")).toBe(false);
  });

  it("recognizes a curated uncommon color in a generic Eyes field", () => {
    expect(visualSoulNotes([note("Eyes: ultramarine.")], 2_000)).toMatch(
      /eye color: ultramarine/i,
    );
  });

  it("keeps a qualified natural eye color together without a spurious eye-other fact", () => {
    const projection = reconcileSoulAppearance([note("Her eyes are a deep, mossy green.")]);
    const current = visualSoulNotes([note("Her eyes are a deep, mossy green.")], 2_000);

    expect(current).toMatch(/eye color: (?:a )?deep, mossy green/i);
    expect(projection.activeFacts).toHaveLength(1);
    expect(projection.activeFacts[0]?.slot).toBe("eyes.color");
  });

  it.each([
    ["My eyes are green, as if lit by neon light.", /lit by|neon light/i],
    ["My eyes have amber flecks, as if narrowed in anger.", /narrowed|anger/i],
    ["My eyes have amber flecks, as though glaring with rage.", /glaring|rage/i],
    ["My eyes have amber flecks, as if reflecting moonlight.", /reflecting|moonlight/i],
  ])("does not make a transient eye state permanent: %s", (description, transient) => {
    expect(visualSoulNotes([note(description)], 2_000)).not.toMatch(transient);
  });

  it("keeps a philosophical eye analogy out of exact appearance", () => {
    const current = visualSoulNotes([
      note("My eyes have complex patterns, evoking my curiosity about technology."),
    ], 2_000);

    expect(current).toMatch(/complex patterns/i);
    expect(current).not.toMatch(/curiosity|technology/i);
  });

  it.each([
    "amber flecks, resembling neon light reflected on water",
    "amber flecks, reminiscent of moonlight reflected in glass",
    "amber flecks, evoking the glow of firelight",
    "amber flecks, as if viewed through neon light",
    "amber flecks, as though seen through moonlight",
    "amber flecks, resembling a determined stare",
    "amber flecks, reminiscent of a gaze of intense sorrow",
  ])("filters a scene or bearing comparison from durable eye detail: %s", (detail) => {
    const current = visualSoulNotes([note(`Eyes: ${detail}.`)], 2_000);

    expect(current).not.toMatch(/neon|moonlight|firelight|determined stare|intense sorrow/i);
  });

  it.each([
    ["green with a pattern resembling a narrow golden ring", /narrow golden ring/i],
    ["green with small amber flecks", /small amber flecks/i],
    ["green with large gold rings", /large gold rings/i],
    ["green, narrow golden rings", /narrow golden rings/i],
    ["green, small amber flecks", /small amber flecks/i],
    ["green and large gold rings", /large gold rings/i],
  ])("does not confuse an eye-detail adjective with eye shape: %s", (description, detail) => {
    const projection = reconcileSoulAppearance([note(`Eyes: ${description}.`)]);
    const current = visualSoulNotes([note(`Eyes: ${description}.`)], 2_000);

    expect(current).toMatch(detail);
    expect(projection.activeFacts.some((fact) => fact.slot === "eyes.shape")).toBe(false);
  });

  it("still recognizes an actual eye shape before a detail clause", () => {
    const projection = reconcileSoulAppearance([
      note("Eyes: almond-shaped and green with small amber flecks."),
    ]);

    expect(projection.activeFacts.some(
      (fact) => fact.slot === "eyes.shape" && /almond-shaped/i.test(fact.text),
    )).toBe(true);
  });

  it.each([
    "I look for patterns with fresh eyes.",
    "I see complex patterns through the eyes of history.",
  ])("does not turn an eye idiom into permanent texture: %s", (description) => {
    expect(visualSoulNotes([note(description)])).toBe("");
  });

  it("patches only the corrected eye colour while preserving hair, eye shape, build, and marks", () => {
    const current = appearanceText([
      note(
        "Physical description: shoulder-length auburn hair; blue eyes; almond-shaped eyes; lean build; a crescent scar over the left eyebrow.",
        1,
      ),
      note("Eyes: green", 2),
    ]);

    expect(current).toContain("auburn");
    expect(current).toContain("shoulder-length");
    expect(current).toContain("green");
    expect(current).toContain("almond-shaped");
    expect(current).toContain("lean");
    expect(current).toContain("crescent scar");
    expect(current).not.toMatch(/\bblue\b/);
  });

  it.each([
    "Physical description: silver hair; grey eyes.",
    "Updated physical description: silver hair; grey eyes.",
  ])("%s replaces the prior description rather than merging omitted details", (replacement) => {
    const current = appearanceText([
      note(
        "Physical description: auburn hair; blue eyes; lean build; a crescent scar over the left eyebrow; a charcoal coat.",
        1,
      ),
      note(replacement, 2),
    ]);

    expect(current).toContain("silver");
    expect(current).toContain("grey");
    expect(current).not.toMatch(/\bauburn\b|\bblue\b|\blean\b|crescent scar|charcoal coat/);
  });

  it("retains every meaningful field in a structured multiline physical profile", () => {
    const profile = note(
      [
        "Physical description:",
        "Gender: woman",
        "Age: 32",
        "Ethnicity: Afro-Latina",
        `Height: 5'8"`,
        "Weight: 145 lb",
        "Build: athletic",
        "Hair: shoulder-length auburn curls",
        "Eyes: green, almond-shaped",
        "Skin: warm brown",
        "Face: oval with high cheekbones",
        "Distinguishing marks: crescent scar over the left eyebrow",
        "Nonhuman features: small antlers and a tufted tail",
        "Clothing: charcoal coat and black boots",
      ].join("\n"),
    );
    const current = appearanceText([profile]);

    const expectedDetails = [
      "woman",
      "32",
      "afro-latina",
      `5'8"`,
      "145 lb",
      "athletic",
      "shoulder-length",
      "auburn",
      "curls",
      "green",
      "almond-shaped",
      "warm brown",
      "oval",
      "high cheekbones",
      "crescent scar",
      "left eyebrow",
      "small antlers",
      "tufted tail",
      "charcoal coat",
      "black boots",
    ];
    expect(
      expectedDetails.filter((detail) => !current.includes(detail)),
      `structured appearance projection: ${current}`,
    ).toEqual([]);
  });

  it("ignores historical descriptions and applies explicit removal tombstones", () => {
    const current = appearanceText([
      note("green eyes", 1),
      note("Usually wears wire-rimmed glasses.", 2),
      note("Used to have blue eyes.", 3),
      note("No longer wears wire-rimmed glasses.", 4),
    ]);

    expect(current).toMatch(/\bgreen eyes\b/);
    expect(current).not.toMatch(/\bblue eyes\b|glasses/);

    const historicalOnly = reconcileSoulAppearance([
      note("Used to have violet eyes.", 1),
      note("Formerly wore a red coat.", 2),
    ]);
    expect(historicalOnly.activeFacts).toEqual([]);
    expect(historicalOnly.historicalSourceIds).toHaveLength(2);
  });

  it("accepts an empty grounded Essence for a history-only appearance ledger", () => {
    const notes = [
      note("Used to have violet eyes.", 1),
      note("No longer wears wire-rimmed glasses.", 2),
    ];
    const essence = parseSoulEssence(
      JSON.stringify(emptyEssencePayload("self", notes)),
      "self",
      notes,
    );

    expect(essence).toBeDefined();
    expect(essence?.exactAppearance).toEqual([]);
    expect(essence?.generalizedEssence.text).toBe("");
  });

  it("keeps only the positive current fact from a correction phrased with 'not'", () => {
    const current = visualSoulNotes([
      note("blue eyes", 1),
      note("green eyes, not blue", 2),
    ]);

    expect(current).toMatch(/\bgreen eyes\b/i);
    expect(current).not.toMatch(/\bblue\b/i);
    expect(current).not.toMatch(/\bnot\b/i);
  });

  it("does not let an unknown snapshot erase known facts and reconciles current/removal hair subslots", () => {
    const known = [
      note(
        "Physical description: long straight black hair; green eyes; a chin scar.",
        1,
      ),
      note("Updated appearance: unknown", 2),
    ];
    const afterPlaceholder = appearanceText(known);
    expect(afterPlaceholder).toMatch(/\blong\b.*\bstraight\b.*\bblack\b|\bblack\b.*\blong\b/i);
    expect(afterPlaceholder).toContain("green eyes");
    expect(afterPlaceholder).toContain("chin scar");

    const afterCurrentCorrection = appearanceText([
      ...known,
      note("hair is now silver", 3),
    ]);
    expect(afterCurrentCorrection).toContain("silver");
    expect(afterCurrentCorrection).toContain("long");
    expect(afterCurrentCorrection).toContain("straight");
    expect(afterCurrentCorrection).not.toContain("black");

    const afterRemoval = appearanceText([
      ...known,
      note("hair is now silver", 3),
      note("hair is no longer silver", 4),
    ]);
    expect(afterRemoval).toContain("long");
    expect(afterRemoval).toContain("straight");
    expect(afterRemoval).not.toMatch(/\bblack\b|\bsilver\b/);
  });

  it("removes only the specifically named mark", () => {
    const current = appearanceText([
      note("a scar on the chin", 1),
      note("a scar through the left eyebrow", 2),
      note("no longer has the chin scar", 3),
    ]);

    expect(current).toContain("left eyebrow");
    expect(current).not.toContain("chin");
  });

  it("does not let a long superseded paragraph starve a current fact under a small budget", () => {
    const oldDescription =
      "Physical description: blue eyes; " +
      Array.from(
        { length: 24 },
        (_, index) => `obsolete visual detail ${index} with elaborate wording`,
      ).join("; ");
    const current = visualSoulNotes(
      [
        note(oldDescription, 1),
        note("Updated physical description: green eyes", 2),
      ],
      24,
    );

    expect(current).toMatch(/\bgreen eyes\b/i);
    expect(current).not.toMatch(/\bblue\b|obsolete/i);
    expect(current.length).toBeLessThanOrEqual(24);
  });

  it("does not classify ordinary personal history as appearance history", () => {
    const notes = [note("In the past I loved studying astronomy.", 1)];
    const projection = reconcileSoulAppearance(notes);
    const prompt = buildSoulEssenceDistillationPrompt("self", notes);

    expect(projection.accountedSourceIds).toEqual([]);
    expect(projection.activeFacts).toEqual([]);
    expect(prompt.user).toContain("In the past I loved studying astronomy.");
  });

  it("does not mistake eye and height idioms for physical traits", () => {
    const notes = [
      note("Keeps an eye on costs.", 1),
      note("Has an eye for patterns.", 2),
      note("That is a tall order.", 3),
    ];
    const projection = reconcileSoulAppearance(notes);

    expect(projection.activeFacts).toEqual([]);
    expect(projection.accountedSourceIds).toEqual([]);
    expect(buildSoulEssenceDistillationPrompt("self", notes).user).toMatch(
      /eye on costs[\s\S]*eye for patterns[\s\S]*tall order/i,
    );
  });

  it("keeps an abstract reflection about scale out of the reported physical profile", () => {
    const reflection =
      "I am drawn to the way scale can dissolve boundaries, particularly when the distinction between " +
      "'observer' and 'observed' becomes a matter of physical entanglement.";
    const notes = [
      note("I see myself as a cute, pretty, petite young woman.", 1),
      note(
        "Cute natural face, soft facial features, smooth skin, soft pouty lips, long lashes.",
        2,
      ),
      note("I have a thin body.", 3),
      note("I have a large natural bust, auburn hair", 4),
      note("Eyes: complex, organic textures and subtle amber flecks", 5),
      note("Lightly freckled cheeks.", 6),
      note(reflection, 7),
    ];
    const reflectionSource = soulNoteSources(notes)[6]!;
    const projection = reconcileSoulAppearance(notes);
    const current = visualSoulNotes(notes, 2_000);

    expect(current).toMatch(/\bpetite\b/i);
    expect(current).toMatch(/\bthin body\b/i);
    expect(current).toMatch(/\blarge natural bust\b/i);
    expect(current).toMatch(/\bauburn hair\b/i);
    expect(current).toMatch(/\bfreckled cheeks\b/i);
    expect(current).toMatch(/\bcomplex\b/i);
    expect(current).toMatch(/\bamber flecks\b/i);
    expect(current).not.toMatch(/dissolve boundaries|observer|physical entanglement/i);
    expect(projection.nonVisualTextBySourceId[reflectionSource.id]).toBe(reflection);
    expect(buildSoulEssenceDistillationPrompt("self", notes).user).toContain(reflection);
  });

  it("retains thin and hourglass build details from the reported combined profile note", () => {
    const notes = [
      note(
        "I see myself as a cute, pretty, petite young woman. " +
          "I have a thin body with pronounced hourglass silhouette. " +
          "I have a large natural bust, auburn hair and lightly freckled cheeks.",
      ),
    ];
    const current = visualSoulNotes(notes, 2_000);
    const essence = parseSoulEssence(
      JSON.stringify(emptyEssencePayload("self", notes)),
      "self",
      notes,
    );
    const exactEssenceAppearance = essence?.exactAppearance
      .map((fact) => fact.text)
      .join("; ") ?? "";
    const everydayPrompt = selfSoulEssencePromptBlock(essence);

    expect(current).toMatch(/\bpetite\b/i);
    expect(current).toMatch(/\bthin body\b/i);
    expect(current).toMatch(/\bpronounced hourglass silhouette\b/i);
    expect(current).toMatch(/\blarge natural bust\b/i);
    expect(current).toMatch(/\bauburn hair\b/i);
    expect(current).toMatch(/\blightly freckled cheeks\b/i);
    expect(exactEssenceAppearance).toMatch(/\bthin body\b/i);
    expect(exactEssenceAppearance).toMatch(/\bpronounced hourglass silhouette\b/i);
    expect(everydayPrompt).toMatch(/\bthin body\b/i);
    expect(everydayPrompt).toMatch(/\bpronounced hourglass silhouette\b/i);
  });

  it.each([
    "thin body",
    "a thin build",
    "very thin frame",
    "thin-bodied",
    "Body is thin.",
    "I have a thin body.",
    "I have an extremely thin body.",
    "I have a cute, thin body.",
    "I have a soft thin body.",
    "I am thin.",
    "I am extremely thin.",
    "A woman has a thin body.",
    "The woman has a thin body.",
    "This character has a thin body.",
    "The elf has a thin body.",
    "The android is thin.",
    "I am a thin-bodied young woman.",
    "A petite woman.",
    "An athletic woman.",
  ])("recognizes a grounded build description in human or body context: %s", (description) => {
    const expected = description.match(/\b(?:thin|petite|athletic)\b/i)?.[0] ?? "";
    expect(visualSoulNotes([note(description)])).toMatch(
      new RegExp(`\\b${expected}\\b`, "i"),
    );
  });

  it("keeps compatible stature and leanness while replacing the same build dimension", () => {
    const compatible = visualSoulNotes([
      note("I am a petite young woman.", 1),
      note("I have a thin body.", 2),
    ], 2_000);
    expect(compatible).toMatch(/\bpetite\b/i);
    expect(compatible).toMatch(/\bthin body\b/i);

    const corrected = visualSoulNotes([
      note("slender build", 1),
      note("thin body", 2),
    ], 2_000);
    expect(corrected).toMatch(/\bthin body\b/i);
    expect(corrected).not.toMatch(/\bslender\b/i);

    const broadCorrection = visualSoulNotes([
      note("petite young woman", 1),
      note("thin body", 2),
      note("Build: athletic", 3),
    ], 2_000);
    expect(broadCorrection).toMatch(/\bathletic\b/i);
    expect(broadCorrection).not.toMatch(/\bpetite\b|\bthin\b/i);
  });

  it.each([
    "petite and thin",
    "I am thin and petite.",
    "I am petite and thin.",
    "I am thin and wiry.",
    "I am thin and curvy.",
    "I am athletic and muscular.",
    "I am thin but wiry.",
    "muscular and athletic",
    "petite and rangy",
    "curvy and plump",
    "lean and slim",
    "I have a petite, thin body.",
    "I have a thin, petite, and athletic body.",
  ])("retains each compatible descriptor in a compound build: %s", (description) => {
    const current = visualSoulNotes([note(description)], 2_000);
    const descriptors =
      description.match(
        /\b(?:petite|thin|wiry|curvy|athletic|muscular|rangy|plump|lean|slim)\b/gi,
      ) ?? [];

    for (const descriptor of descriptors) {
      expect(current).toMatch(new RegExp(`\\b${descriptor}\\b`, "i"));
    }
  });

  it("corrects one dimension of a compound build without dropping the others", () => {
    const shoulders = visualSoulNotes([
      note("lean build and broad shoulders", 1),
      note("thin body", 2),
    ], 2_000);
    expect(shoulders).toMatch(/\bthin body\b/i);
    expect(shoulders).toMatch(/\bbroad shoulders\b/i);
    expect(shoulders).not.toMatch(/\blean\b/i);

    const stature = visualSoulNotes([
      note("petite young woman and a thin body", 1),
      note("slender build", 2),
    ], 2_000);
    expect(stature).toMatch(/\bpetite\b/i);
    expect(stature).toMatch(/\bslender build\b/i);
    expect(stature).not.toMatch(/\bthin\b/i);

    const mass = visualSoulNotes([
      note("I have a thin, petite body.", 1),
      note("I have a heavyset body.", 2),
    ], 2_000);
    expect(mass).toMatch(/\bpetite\b/i);
    expect(mass).toMatch(/\bheavyset body\b/i);
    expect(mass).not.toMatch(/\bthin\b/i);

    const wiry = visualSoulNotes([
      note("thin and wiry", 1),
      note("stocky body", 2),
    ], 2_000);
    expect(wiry).toMatch(/\bstocky body\b/i);
    expect(wiry).not.toMatch(/\bthin\b|\bwiry\b/i);

    const nonhuman = visualSoulNotes([
      note("A thin elf.", 1),
      note("stocky body", 2),
    ], 2_000);
    expect(nonhuman).toMatch(/\belf\b/i);
    expect(nonhuman).toMatch(/\bstocky body\b/i);
    expect(nonhuman).not.toMatch(/\bthin\b/i);
  });

  it("treats a structured Body value as one build dimension, not a full-build reset", () => {
    const current = visualSoulNotes([
      note("I am a petite young woman.", 1),
      note("Body: thin", 2),
    ], 2_000);

    expect(current).toMatch(/\bpetite\b/i);
    expect(current).toMatch(/\bthin\b/i);

    const structured = visualSoulNotes([
      note("Build: athletic", 1),
      note("Body: thin", 2),
    ], 2_000);
    expect(structured).toMatch(/\bathletic\b/i);
    expect(structured).toMatch(/\bthin\b/i);
  });

  it("removes a named build dimension without erasing compatible dimensions", () => {
    for (const removal of [
      "My build is no longer slender.",
      "My body is no longer slender.",
      "I'm no longer slender.",
      "I am not slender anymore.",
      "No slender body.",
    ]) {
      const current = visualSoulNotes([
        note("petite and slender", 1),
        note(removal, 2),
      ], 2_000);
      expect(current, removal).toMatch(/\bpetite\b/i);
      expect(current, removal).not.toMatch(/\bslender\b/i);
    }
  });

  it("applies both sides of a build contrast correction", () => {
    for (const [before, correction, removed, added] of [
      ["slender body", "My body is not slender but athletic.", "slender", "athletic"],
      ["thin body", "My body is not thin but muscular.", "thin", "muscular"],
      ["petite", "My body is not petite but thin.", "petite", "thin"],
      ["slender body", "I'm not slender but athletic.", "slender", "athletic"],
    ] as const) {
      const current = visualSoulNotes([
        note(before, 1),
        note(correction, 2),
      ], 2_000);
      expect(current, correction).not.toMatch(new RegExp(`\\b${removed}\\b`, "i"));
      expect(current, correction).toMatch(new RegExp(`\\b${added}\\b`, "i"));
    }
  });

  it("separates a thin-build fact from a personality clause", () => {
    for (const text of [
      "I have a thin body and am intellectually curious.",
      "I am thin and intellectually curious.",
    ]) {
      const notes = [note(text)];
      const source = soulNoteSources(notes)[0]!;
      const projection = reconcileSoulAppearance(notes);
      const current = visualSoulNotes(notes, 2_000);

      expect(current, text).toMatch(/\bthin\b/i);
      expect(current, text).not.toMatch(/intellectual|curious/i);
      expect(projection.nonVisualTextBySourceId[source.id]).toMatch(
        /intellectual|curious/i,
      );
    }
  });

  it.each([
    "The evidence is thin.",
    "That is a thin argument.",
    "A slim chance is still worth examining.",
    "Uses slender reasoning.",
    "That is a petite problem.",
    "Thin, careful reasoning helps.",
    "Average, according to the evidence.",
    "I study systems at different scales.",
    "Working at scale changes the tradeoffs.",
    "I compare ideas with different scales of analysis.",
    "Fine scales reveal different behavior.",
    "Scales cover many orders of magnitude.",
    "Music has scales.",
    "A blue scale on the chart marks the midpoint.",
    "I am interested in fine scales of interaction.",
    "These scales cover several levels of analysis.",
    "A thin body of evidence supports the claim.",
    "A very thin body of literature exists here.",
    "The paper offers a slender body of research.",
    "I have a thin body of work.",
    "The thin body of the guitar changes its sound.",
    "A thin frame surrounds the photograph.",
    "The average person learns by doing.",
    "An average person values fairness.",
    "Medium-bodied wine has a soft finish.",
    "A thin-bodied sound.",
    "I admire the average person.",
    "I often think about the average person.",
    "I am interested in what the average person thinks.",
    "I write about a thin man.",
    "The violin has a thin body.",
    "The bottle has a slender body.",
    "The software has a lean build.",
    "I am drawn to iridescent scales of meaning.",
    "I have fine scales of analysis.",
    "Scales cover the body of evidence.",
    "Scales run along the spine of the argument.",
    "I have small scales in my workshop.",
    "She has fine scales for weighing gems.",
    "I study overlapping scales in complex systems.",
    "The piano exercise uses overlapping scales.",
    "Dragon scales fascinate me.",
    "I am fascinated by reptilian scales.",
    "I think in iridescent scales.",
    "I have small scales, which I use for weighing gems.",
    "I admire the marble bust of Athena.",
    "My favorite sculpture is a bronze bust.",
    "The police made a drug bust.",
    "A bust of Caesar stands in the museum.",
    "The economic boom went bust.",
    "I like chicken breasts.",
    "The recipe uses chicken breast.",
  ])("does not turn an abstract descriptor into appearance: %s", (text) => {
    const notes = [note(text)];
    const source = soulNoteSources(notes)[0]!;
    const projection = reconcileSoulAppearance(notes);

    expect(projection.activeFacts).toEqual([]);
    expect(projection.accountedSourceIds).toEqual([]);
    expect(projection.nonVisualTextBySourceId[source.id]).toBe(text);
  });

  it("does not retain frame or body as a build when they modify glasses or hair", () => {
    const glasses = visualSoulNotes([
      note("thin frame glasses", 1),
      note("I don't wear glasses.", 2),
    ], 2_000);
    expect(glasses).toBe("");

    const hair = visualSoulNotes([
      note("thin body hair", 1),
      note("Hair: thick", 2),
    ], 2_000);
    expect(hair).toMatch(/\bthick\b/i);
    expect(hair).not.toMatch(/\bthin body\b/i);

    for (const [description, removal] of [
      ["thin frame spectacles", "I don't wear spectacles"],
      ["thin body fur", "No fur"],
      ["thin body feathers", "No feathers"],
    ] as const) {
      expect(
        visualSoulNotes([note(description, 1), note(removal, 2)], 2_000),
        description,
      ).not.toMatch(/\bthin (?:frame|body)\b/i);
    }
  });

  it("still recognizes scales when they are explicitly described as a physical feature", () => {
    const descriptions = [
      "Scales.",
      "Has scales.",
      "Iridescent scales cover her forearms.",
      "She has small scales.",
      "She has smooth scales.",
      "She has red scales.",
      "She has tiny scales.",
      "She has translucent scales.",
      "She has bronze scales.",
      "She is covered in fine scales.",
      "Her body is covered in tiny scales.",
      "Her scales are tiny.",
      "Scales cover her entire body.",
      "Scales line her torso.",
      "Scales cover her abdomen.",
      "Scales run down her spine.",
      "Scales covering her body.",
    ];

    for (const description of descriptions) {
      expect(visualSoulNotes([note(description)]), description).toContain(description);
    }
  });

  it.each([
    "No scales.",
    "No longer has scales.",
    "Without scales.",
    "She has no scales.",
  ])("removes a previously stored physical scale trait: %s", (removal) => {
    expect(visualSoulNotes([
      note("Scales.", 1),
      note(removal, 2),
    ])).toBe("");
  });

  it("removes a specifically qualified physical scale trait", () => {
    for (const [description, removal] of [
      ["Iridescent scales.", "No longer has iridescent scales."],
      ["Red scales.", "No red scales."],
      ["Fine scales.", "Without fine scales."],
      ["She has small scales.", "She has no small scales."],
    ] as const) {
      expect(
        visualSoulNotes([note(description, 1), note(removal, 2)]),
        removal,
      ).toBe("");
    }
  });

  it("keeps a bust detail independent from a later hair correction", () => {
    const current = visualSoulNotes([
      note("I have a large natural bust, auburn hair", 1),
      note("Hair color: black", 2),
    ], 2_000);

    expect(current).toMatch(/\blarge natural bust\b/i);
    expect(current).toMatch(/\bblack\b/i);
    expect(current).not.toMatch(/\bauburn\b/i);
    expect(visualSoulNotes([note("I have a large natural bust.")])).toMatch(
      /\blarge natural bust\b/i,
    );
  });

  it.each([
    ["Green eyes and values honesty.", "green eyes", "values honesty"],
    ["Blue eyes and loves astronomy.", "blue eyes", "loves astronomy"],
  ])(
    "separates appearance from personality in %s",
    (text, visual, nonVisual) => {
      const notes = [note(text, 1)];
      const sourceId = soulNoteSources(notes)[0]!.id;
      const projection = reconcileSoulAppearance(notes);
      const current = projection.activeFacts.map((fact) => fact.text).join("; ");

      expect(current).toMatch(new RegExp(visual, "i"));
      expect(current).not.toMatch(new RegExp(nonVisual, "i"));
      expect(projection.nonVisualTextBySourceId[sourceId]).toMatch(
        new RegExp(nonVisual, "i"),
      );
    },
  );

  it("applies natural-language removal and a follow-up positive eye correction", () => {
    const current = appearanceText([
      note("A chin scar and a scar through the left eyebrow.", 1),
      note("Usually wears glasses.", 2),
      note("Blue eyes.", 3),
      note("No scars.", 4),
      note("I don't wear glasses.", 5),
      note("Eyes are no longer blue. They are green.", 6),
    ]);

    expect(current).toMatch(/\bgreen\b/);
    expect(current).not.toMatch(/\bblue\b|\bscar\b|\bglasses\b/);
  });

  it.each([
    "one blue eye and one green eye",
    "Eyes: left blue, right green",
  ])("preserves both sides of heterochromia in %s", (description) => {
    const current = appearanceText([note(description, 1)]);

    expect(current).toMatch(/\bblue\b/);
    expect(current).toMatch(/\bgreen\b/);
  });

  it("treats structured skin colour and tone as the same corrected field", () => {
    const current = appearanceText([
      note("Skin color: brown", 1),
      note("Skin tone: olive", 2),
    ]);

    expect(current).toMatch(/\bolive\b/);
    expect(current).not.toMatch(/\bbrown\b/);
  });

  it("patches hair colour without discarding texture", () => {
    const current = appearanceText([
      note("Hair: shoulder-length auburn curls", 1),
      note("Hair color: black", 2),
    ]);

    expect(current).toMatch(/\bblack\b/);
    expect(current).toMatch(/\bcurls\b/);
    expect(current).not.toMatch(/\bauburn\b/);
  });

  it("removes a nonhuman tail without discarding independent antlers", () => {
    const current = appearanceText([
      note("Nonhuman features: small antlers and a tufted tail", 1),
      note("No longer has a tail.", 2),
    ]);

    expect(current).toMatch(/\bantlers\b/);
    expect(current).not.toMatch(/\btail\b/);
  });

  it("keeps distinct same-location marks and removes only the named one", () => {
    const current = appearanceText([
      note(
        "Physical description: a thin scar over the left eyebrow; a crescent scar over the left eyebrow.",
        1,
      ),
      note("No longer has the thin scar over the left eyebrow.", 2),
    ]);

    expect(current).toMatch(/\bcrescent scar\b/);
    expect(current).not.toMatch(/\bthin scar\b/);
  });

  it("keeps distinct same-noun features and removes only the named one", () => {
    const current = appearanceText([
      note(
        "Nonhuman features: a chipped left horn and a gold-capped left horn.",
        1,
      ),
      note("No longer has the chipped left horn.", 2),
    ]);

    expect(current).toMatch(/\bgold-capped left horn\b/);
    expect(current).not.toMatch(/\bchipped left horn\b/);
  });

  it("maps subject-predicate corrections onto their existing physical slots", () => {
    const current = appearanceText([
      note("Physical description: black hair; blue eyes; pale skin.", 1),
      note("My eyes are green.", 2),
      note("Hair is silver.", 3),
      note("Skin is olive.", 4),
      note("Actually, my eye color is amber.", 5),
    ]);

    expect(current).toMatch(/\bsilver\b/);
    expect(current).toMatch(/\bolive\b/);
    expect(current).toMatch(/\bamber\b/);
    expect(current).not.toMatch(/\bblack\b|\bblue\b|\bpale\b|\bgreen\b/);
  });

  it("preserves eye shape while replacing an embedded old colour", () => {
    const current = appearanceText([
      note("blue almond-shaped eyes", 1),
      note("Eyes: green", 2),
    ]);

    expect(current).toMatch(/\bgreen\b/);
    expect(current).toMatch(/\balmond-shaped\b/);
    expect(current).not.toMatch(/\bblue\b/);
  });

  it("recognizes common durable physical descriptors", () => {
    const current = appearanceText([
      note(
        "Physical description: medium height; weighs 145 pounds; brown beard; pointed ears; small antlers; vitiligo patches; dimples; green-eyed.",
        1,
      ),
    ]);

    for (const detail of [
      "medium height",
      "145 pounds",
      "brown beard",
      "pointed ears",
      "small antlers",
      "vitiligo",
      "dimples",
      "green-eyed",
    ]) {
      expect(current, current).toContain(detail);
    }
  });

  it.each(["unchanged", "same as before", "not provided", "TBD"])(
    "does not let Updated appearance: %s erase known current facts",
    (placeholder) => {
      const current = appearanceText([
        note("Physical description: auburn hair; green eyes.", 1),
        note(`Updated appearance: ${placeholder}`, 2),
      ]);

      expect(current).toMatch(/\bauburn hair\b/);
      expect(current).toMatch(/\bgreen eyes\b/);
    },
  );

  it.each([
    ["blue eyes", "Eyes aren't blue anymore", "blue"],
    ["black hair", "Hair isn't black anymore", "black"],
  ])(
    "treats %s followed by %s as a removal",
    (initial, removal, stale) => {
      const current = appearanceText([
        note(initial, 1),
        note(removal, 2),
      ]);

      expect(current).not.toMatch(new RegExp(stale, "i"));
      expect(current).not.toMatch(/\b(?:aren't|isn't|anymore)\b/i);
    },
  );

  it("keeps only the positive side of a not-X-but-Y eye correction", () => {
    const current = appearanceText([
      note("blue eyes", 1),
      note("Eyes are not blue but green", 2),
    ]);

    expect(current).toMatch(/\bgreen\b/);
    expect(current).not.toMatch(/\bblue\b|\bnot\b/);
  });

  it("patches one heterochromatic eye without dropping the other", () => {
    const current = appearanceText([
      note("one blue eye and one green eye", 1),
      note("left eye is amber", 2),
    ]);

    expect(current).toMatch(/\bamber\b/);
    expect(current).toMatch(/\bgreen\b/);
    expect(current).not.toMatch(/\bblue\b/);
  });

  it("patches ethnicity without dropping gender from a combined source fact", () => {
    const current = appearanceText([
      note("Black woman", 1),
      note("Ethnicity: Afro-Latina", 2),
    ]);

    expect(current).toMatch(/\bwoman\b/);
    expect(current).toMatch(/\bafro-latina\b/);
    expect(current).not.toMatch(/\bblack\b/);
  });

  it("patches face shape without dropping independent cheekbone detail", () => {
    const current = appearanceText([
      note("Face: oval with high cheekbones", 1),
      note("square face", 2),
    ]);

    expect(current).toMatch(/\bsquare\b/);
    expect(current).toMatch(/\bhigh cheekbones\b/);
    expect(current).not.toMatch(/\boval\b/);
  });

  it("retains the nonvisual clause of a mixed historical appearance note", () => {
    const notes = [note("Used to have blue eyes and values honesty", 1)];
    const sourceId = soulNoteSources(notes)[0]!.id;
    const projection = reconcileSoulAppearance(notes);
    const prompt = buildSoulEssenceDistillationPrompt("self", notes);

    expect(projection.activeFacts).toEqual([]);
    expect(projection.nonVisualTextBySourceId[sourceId]).toMatch(/values honesty/i);
    expect(prompt.user).toMatch(/values honesty/i);
    expect(prompt.user).not.toMatch(/\bblue eyes\b/i);
  });

  it.each([
    "No dimples",
    "No beard",
    "No chipped horn",
    "No brown boots",
    "No thin scar",
  ])("stores %s as a tombstone rather than a current fact", (removal) => {
    const current = appearanceText([note(removal, 1)]);

    expect(current).toBe("");
  });

  it.each([
    ["high cheekbones", "dimples", "No dimples"],
    ["dimples", "high cheekbones", "No high cheekbones"],
  ])(
    "removes one additive face detail while preserving %s",
    (kept, removed, removal) => {
      const current = appearanceText([
        note("high cheekbones and dimples", 1),
        note(removal, 2),
      ]);

      expect(current).toContain(kept);
      expect(current).not.toContain(removed);
    },
  );

  it("removes one ring while preserving a sibling ring", () => {
    const current = appearanceText([
      note("a gold ring and a silver ring", 1),
      note("No gold ring", 2),
    ]);

    expect(current).toMatch(/\bsilver ring\b/);
    expect(current).not.toMatch(/\bgold ring\b/);
  });

  it("keeps beard and moustache independently removable", () => {
    const current = appearanceText([
      note("a brown beard and a black moustache", 1),
      note("No beard", 2),
    ]);

    expect(current).toMatch(/\bblack moustache\b/);
    expect(current).not.toMatch(/\bbrown beard\b/);
  });

  it.each(["Left eye: amber", "Left eye color: amber"])(
    "interoperates %s with paired heterochromia",
    (correction) => {
      const current = appearanceText([
        note("one blue eye and one green eye", 1),
        note(correction, 2),
      ]);

      expect(current).toMatch(/\bamber\b/);
      expect(current).toMatch(/\bgreen\b/);
      expect(current).not.toMatch(/\bblue\b/);
    },
  );

  it("keeps distinct garments that share a clothing category", () => {
    const current = appearanceText([
      note("a white shirt and a blue tunic", 1),
    ]);

    expect(current).toMatch(/\bwhite shirt\b/);
    expect(current).toMatch(/\bblue tunic\b/);
  });

  it("replaces an older cheekbone detail as the same semantic subfeature", () => {
    const current = appearanceText([
      note("high cheekbones", 1),
      note("prominent cheekbones", 2),
    ]);

    expect(current).toMatch(/\bprominent cheekbones\b/);
    expect(current).not.toMatch(/\bhigh cheekbones\b/);
  });

  it("reconciles a maximum-size dense appearance ledger without quadratic stalling", () => {
    const notes = Array.from({ length: MAX_SOUL_NOTES }, (_, noteIndex) => {
      let text = "Accessories:";
      let detailIndex = 0;
      while (true) {
        const detail = `ring ${noteIndex.toString(36)} ${detailIndex.toString(36)}`;
        const candidate = `${text}${detailIndex === 0 ? " " : ", "}${detail}`;
        if (candidate.length > MAX_SOUL_NOTE_CHARS) break;
        text = candidate;
        detailIndex += 1;
      }
      return note(text, noteIndex + 1);
    });
    expect(notes.reduce((total, item) => total + item.text.length, 0))
      .toBeGreaterThan(390_000);

    const startedAt = performance.now();
    const projection = reconcileSoulAppearance(notes);
    const elapsedMs = performance.now() - startedAt;

    expect(projection.activeFacts.length).toBeGreaterThan(20_000);
    expect(elapsedMs).toBeLessThan(5_000);
  }, 20_000);
});

describe("Soul appearance isolation across Essence and prompt paths", () => {
  it("redacts a mixed note's visual clause from distillation while still requiring its nonvisual evidence", () => {
    const notes = [
      note("Blue eyes; values honest disagreement.", 1),
      note("Eyes: green", 2),
    ];
    const sources = soulNoteSources(notes);
    const prompt = buildSoulEssenceDistillationPrompt("self", notes);

    expect(prompt.user).toMatch(/values honest disagreement/i);
    expect(prompt.user).not.toMatch(/\bblue eyes\b/i);

    expect(
      parseSoulEssence(
        JSON.stringify(emptyEssencePayload("self", notes)),
        "self",
        notes,
      ),
    ).toBeUndefined();

    const essence = parseSoulEssence(
      JSON.stringify(
        personalityEssencePayload("self", notes, [sources[0]!.id]),
      ),
      "self",
      notes,
    );
    expect(essence).toBeDefined();
    expect(essence?.facets.valuesAndMotivations.sourceIds).toContain(
      sources[0]!.id,
    );
    expect(essence?.exactAppearance.map((fact) => fact.text).join("; ")).toMatch(
      /\bgreen\b/i,
    );
    expect(essence?.exactAppearance.map((fact) => fact.text).join("; ")).not.toMatch(
      /\bblue\b/i,
    );
  });

  it("preserves an exact direction from a mixed note without leaking its old appearance", () => {
    const notes = [
      note("Blue eyes; Never flatter the reader reflexively.", 1),
      note("Eyes: green", 2),
    ];
    const essence = parseSoulEssence(
      JSON.stringify(emptyEssencePayload("self", notes)),
      "self",
      notes,
    );

    expect(essence).toBeDefined();
    expect(essence?.exactPersonalityDirections.map((fact) => fact.text).join("; "))
      .toMatch(/never flatter the reader reflexively/i);
    const look = essence?.exactAppearance.map((fact) => fact.text).join("; ") ?? "";
    expect(look).toMatch(/\bgreen\b/i);
    expect(look).not.toMatch(/\bblue\b/i);
  });

  it("uses only current appearance in explicit evidence and the raw self prompt", () => {
    const notes = [
      note("Blue eyes; values honest disagreement.", 1),
      note("Eyes: green", 2),
    ];
    const evidence = soulEvidencePromptBlock(
      "self",
      notes,
      "What do you look like?",
      1_000,
    );
    const rawPrompt = selfSoulPromptBlock(notes, "Sage");

    expect(evidence).toMatch(/\bgreen\b/i);
    expect(evidence).not.toMatch(/\bblue\b/i);
    expect(rawPrompt).toMatch(/\bgreen\b/i);
    expect(rawPrompt).not.toMatch(/\bblue\b/i);
    expect(rawPrompt).toMatch(/values honest disagreement/i);
  });

  it("rejects schema v2 and round-trips the current v3 Essence", () => {
    expect(SOUL_ESSENCE_SCHEMA_VERSION).toBe(3);
    const notes = [note("Physical description: green eyes.", 1)];
    const payload = emptyEssencePayload("self", notes);
    const parsed = parseSoulEssence(JSON.stringify(payload), "self", notes);

    expect(parsed).toBeDefined();
    expect(parsed?.schemaVersion).toBe(3);
    expect(
      parseSoulEssence(JSON.stringify(parsed), "self", notes),
    ).toEqual(parsed);

    const v2 = { ...payload, schemaVersion: 2 };
    expect(parseSoulEssence(JSON.stringify(v2), "self", notes)).toBeUndefined();
  });

  it("rejects physical-description wording in the generalized standing essence", () => {
    const notes = [
      note("Blue eyes.", 1),
      note("Values honest disagreement.", 2),
    ];
    const personalityId = soulNoteSources(notes)[1]!.id;
    const payload = personalityEssencePayload("self", notes, [personalityId]);
    payload.generalizedEssence = {
      text: "Blue eyes; candid and principled.",
      sourceIds: [personalityId],
    };

    expect(
      parseSoulEssence(JSON.stringify(payload), "self", notes),
    ).toBeUndefined();
  });

  it("rejects a superseded short appearance value from generalized and support facets", () => {
    const notes = [
      note("Eyes: blue", 1),
      note("Eyes: green", 2),
      note("Values honest disagreement.", 3),
    ];
    const personalityId = soulNoteSources(notes)[2]!.id;

    const generalizedLeak = personalityEssencePayload(
      "self",
      notes,
      [personalityId],
    );
    generalizedLeak.generalizedEssence = {
      text: "Blue-eyed and principled.",
      sourceIds: [personalityId],
    };
    expect(
      parseSoulEssence(JSON.stringify(generalizedLeak), "self", notes),
    ).toBeUndefined();

    const supportLeak = personalityEssencePayload(
      "self",
      notes,
      [personalityId],
    );
    const facets = supportLeak.facets as Record<
      string,
      { text: string; sourceIds: string[] }
    >;
    facets.valuesAndMotivations = {
      text: "Blue-eyed and principled.",
      sourceIds: [personalityId],
    };
    expect(
      parseSoulEssence(JSON.stringify(supportLeak), "self", notes),
    ).toBeUndefined();
  });

  it("does not reject a genuine eye idiom as physical wording", () => {
    const notes = [note("Keeps an eye on costs and values careful planning.", 1)];
    const sourceId = soulNoteSources(notes)[0]!.id;
    const payload = personalityEssencePayload("self", notes, [sourceId]);
    const facets = payload.facets as Record<
      string,
      { text: string; sourceIds: string[] }
    >;
    facets.valuesAndMotivations = {
      text: "Keeps an eye on costs and values careful planning.",
      sourceIds: [sourceId],
    };

    expect(
      parseSoulEssence(JSON.stringify(payload), "self", notes),
    ).toBeDefined();
  });
});
