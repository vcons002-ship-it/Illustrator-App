import { describe, expect, it } from "vitest";
import { MAX_CHARACTER_DESCRIPTOR_CHARS } from "../providers/image/bible-injection.js";
import { InMemoryStore } from "../storage/store.js";
import { loadMemory } from "./reader-memory.js";
import {
  type SoulNote,
  soulNotesForPrompt,
  SOUL_PROMPT_BUDGET_CHARS,
  SELF_SOUL_KEY,
  ABOUT_YOU_SOUL_KEY,
  MAX_SOUL_NOTES,
  loadSoul,
  saveSoul,
  rememberSoul,
  forgetSoul,
  loadSoulName,
  saveSoulName,
  selfSoulPromptBlock,
  userSoulPromptBlock,
  selfPortraitPrompt,
  visualSoulNotes,
  SOUL_LOOK_BUDGET_CHARS,
  SOUL_ESSENCE_SCHEMA_VERSION,
  MAX_SOUL_GENERALIZED_ESSENCE_CHARS,
  SOUL_GENERALIZED_TRAIT_VOCABULARY,
  SOUL_ESSENCE_FACETS,
  SELF_SOUL_ESSENCE_KEY,
  ABOUT_YOU_SOUL_ESSENCE_KEY,
  soulNoteSources,
  soulSourceFingerprint,
  partitionSoulNotes,
  buildSoulEssenceDistillationPrompt,
  buildSoulEssenceMergePrompt,
  buildSoulEssenceAbstractionPrompt,
  soulEssenceJsonSchema,
  soulEssenceAbstractionJsonSchema,
  parseSoulEssence,
  parseGeneratedSoulEssence,
  parseSoulEssenceMerge,
  parseSoulEssenceAbstraction,
  soulEssenceAbstractionRepairFeedback,
  soulEssenceRepairFeedback,
  validateSoulEssence,
  loadSoulEssence,
  loadLatestSoulEssence,
  saveSoulEssence,
  clearSoulEssence,
  soulEssenceViewForNotes,
  selfSoulEssencePromptBlock,
  userSoulEssencePromptBlock,
  selfSoulExactIdentityPromptBlock,
  userSoulExactIdentityPromptBlock,
  selfStorySoulEssencePromptBlock,
  userStorySoulEssencePromptBlock,
  soulContextPromptBlock,
  storySoulCharacterizationPromptBlock,
  selectSoulContextMode,
  soulEvidencePromptBlock,
  SOUL_EVIDENCE_PROMPT_BUDGET_CHARS,
  isSelfPortraitRequest,
  portraitSubjects,
  isUserPortraitRequest,
  userPortraitPrompt,
} from "./souls.js";

describe("selfPortraitPrompt", () => {
  const look = [{ text: "silver hair", at: 1 }, { text: "long charcoal coat", at: 2 }];
  it("folds the assistant's look in when it's a self-portrait (by self-reference)", () => {
    const out = selfPortraitPrompt("a watercolor of yourself by the sea", "Sage", look);
    expect(out).toContain("a watercolor of yourself by the sea");
    expect(out).toMatch(/depict Sage with this appearance: silver hair, long charcoal coat/);
  });
  it("triggers on the assistant's name", () => {
    expect(selfPortraitPrompt("Sage standing in the rain", "Sage", look)).toMatch(/appearance: silver hair/);
  });
  it("triggers on 'draw you' style phrasing", () => {
    expect(selfPortraitPrompt("draw you as a knight", "Sage", look)).toMatch(/depict Sage/);
  });
  it("leaves an unrelated subject untouched", () => {
    expect(selfPortraitPrompt("a red apple on a table", "Sage", look)).toBe("a red apple on a table");
  });
  it("is a no-op when there's no look to add", () => {
    expect(selfPortraitPrompt("a selfie of you", "Sage", [])).toBe("a selfie of you");
  });
  it("folds in only durable appearance notes, not personality, interests, or a scene expression", () => {
    const notes = [
      { text: "Physical description: silver hair, grey eyes, and a long charcoal coat.", at: 1 },
      { text: "Fascinated by abandoned railways and overlooked systems.", at: 2 },
      { text: "Values difficult honesty over comfortable agreement.", at: 3 },
      { text: "Her face carries a broad grin.", at: 4 },
    ];
    const out = selfPortraitPrompt("draw yourself at the library", "Sage", notes);
    expect(out).toContain("silver hair");
    expect(out).toContain("grey eyes");
    expect(out).toContain("a long charcoal coat");
    expect(out).not.toContain("abandoned railways");
    expect(out).not.toContain("difficult honesty");
    expect(out).not.toMatch(/grin/i);
  });
});

describe("identity souls", () => {
  it("keeps self and user souls in separate stores, distinct from reader memory", async () => {
    const store = new InMemoryStore();
    await rememberSoul(store, "self", "silver hair, long coat");
    await rememberSoul(store, "user", "tall, dark curls");
    expect((await loadSoul(store, "self")).map((n) => n.text)).toEqual(["silver hair, long coat"]);
    expect((await loadSoul(store, "user")).map((n) => n.text)).toEqual(["tall, dark curls"]);
    // Souls never bleed into reader memory.
    expect(await loadMemory(store)).toEqual([]);
    // And they live under their own keys.
    expect(await store.getMemo(SELF_SOUL_KEY)).toContain("silver hair");
    expect(await store.getMemo(ABOUT_YOU_SOUL_KEY)).toContain("dark curls");
  });

  it("dedupes, caps, and forgets per soul (with a soul-specific error)", async () => {
    const store = new InMemoryStore();
    await rememberSoul(store, "self", "Warm wit");
    await rememberSoul(store, "self", "warm wit"); // dup refresh
    expect(await loadSoul(store, "self")).toHaveLength(1);
    await rememberSoul(store, "self", "wears glasses");
    const kept = await forgetSoul(store, "self", "GLASSES");
    expect(kept.map((n) => n.text)).toEqual(["warm wit"]);
    await expect(forgetSoul(store, "self", "nope")).rejects.toThrow(/no self-soul note contains/);
  });

  it("evicts the oldest note past the cap", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < MAX_SOUL_NOTES + 2; i++) await rememberSoul(store, "user", `fact ${i}`);
    const notes = await loadSoul(store, "user");
    expect(notes).toHaveLength(MAX_SOUL_NOTES);
    expect(notes[0]!.text).toBe("fact 2");
  });

  it("saveSoul replaces the whole list (panel edit)", async () => {
    const store = new InMemoryStore();
    await rememberSoul(store, "self", "old");
    const saved = await saveSoul(store, "self", [
      { text: "  keep  ", at: 1 },
      { text: "Keep", at: 2 }, // dup
      { text: "", at: 3 }, // blank
    ]);
    expect(saved.map((n) => n.text)).toEqual(["keep"]);
    expect((await loadSoul(store, "self")).map((n) => n.text)).toEqual(["keep"]);
  });

  it("stores a name per soul", async () => {
    const store = new InMemoryStore();
    expect(await loadSoulName(store, "self")).toBe("");
    await saveSoulName(store, "self", "  Sage  ");
    await saveSoulName(store, "user", "Alex");
    expect(await loadSoulName(store, "self")).toBe("Sage");
    expect(await loadSoulName(store, "user")).toBe("Alex");
  });

  it("renders prompt blocks only when there's a name or notes", () => {
    expect(selfSoulPromptBlock([], "")).toBe("");
    expect(userSoulPromptBlock([], "")).toBe("");
    const self = selfSoulPromptBlock([{ text: "silver hair", at: 1 }], "Sage");
    expect(self).toContain("WHO YOU ARE");
    expect(self).toContain("Name: Sage");
    expect(self).toContain("- silver hair");
    // The identity applies to ordinary chat, not just story roleplay.
    expect(self).toMatch(/EVERY conversation/);
    expect(self).toMatch(/ordinary chat/i);
    const you = userSoulPromptBlock([{ text: "bold", at: 1 }], "Alex");
    expect(you).toContain("WHO THE READER IS");
    expect(you).toContain("Name: Alex");
  });
});

describe("Soul Essence derivation", () => {
  const note = (text: string, at: number): SoulNote => ({ text, at });

  function payload(
    kind: "self" | "user",
    notes: readonly SoulNote[],
    facetText = "Integrates curiosity into a patient, systems-minded outlook.",
    generalizedText = "Intellectually curious, patient, and attentive to underlying patterns.",
  ): Record<string, unknown> {
    const sourceIds = soulNoteSources(notes).map((source) => source.id);
    const facets = Object.fromEntries(
      SOUL_ESSENCE_FACETS.map((key) => [
        key,
        key === "coreDisposition" && facetText
          ? { text: facetText, sourceIds }
          : { text: "", sourceIds: [] },
      ]),
    );
    return {
      schemaVersion: SOUL_ESSENCE_SCHEMA_VERSION,
      kind,
      sourceFingerprint: soulSourceFingerprint(notes),
      generalizedEssence: facetText
        ? { text: generalizedText, sourceIds }
        : { text: "", sourceIds: [] },
      facets,
      exactAppearance: [],
    };
  }

  it("gives the complete ordered source set a stable synchronous fingerprint and evidence IDs", () => {
    const notes = [note("old foundational thought", 1), note("new direction", 2)];
    expect(soulSourceFingerprint(notes)).toBe(soulSourceFingerprint(notes.map((n) => ({ ...n }))));
    expect(soulNoteSources(notes)).toEqual(soulNoteSources(notes.map((n) => ({ ...n }))));
    expect(soulSourceFingerprint([...notes].reverse())).not.toBe(soulSourceFingerprint(notes));
    expect(soulSourceFingerprint([{ ...notes[0]!, text: "edited" }, notes[1]!])).not.toBe(
      soulSourceFingerprint(notes),
    );
    expect(soulSourceFingerprint([{ ...notes[0]!, at: 99 }, notes[1]!])).not.toBe(
      soulSourceFingerprint(notes),
    );
    expect(soulNoteSources(notes)[0]!.id).toMatch(/^sn_[0-9a-f]{16}$/);
  });

  it("builds a strict personality distillation request without appearance-only sources", () => {
    const notes = [
      note("Fascinated by abandoned railway systems.", 1),
      note("Physical description: silver hair, grey eyes, and a long charcoal coat.", 2),
      note("Values candour more than easy agreement.", 3),
    ];
    const built = buildSoulEssenceDistillationPrompt("self", notes);
    expect(built.sourceFingerprint).toBe(soulSourceFingerprint(notes));
    expect(built.system).toMatch(/strict JSON only/i);
    expect(built.system).toMatch(/do not make their specific examples into recurring topics/i);
    expect(built.system).toMatch(/portable higher-order identity/i);
    expect(built.system).toMatch(/Do not include names, named interests, technologies, hobbies/i);
    expect(built.system).toMatch(/Complete source coverage belongs in the support facets/i);
    expect(built.system).toContain(`at most ${MAX_SOUL_GENERALIZED_ESSENCE_CHARS} characters`);
    expect(built.system).toMatch(/Every non-empty facet must cite/i);
    expect(built.system).toContain("exactAppearance");
    expect(built.system).toMatch(/exactAppearance as an empty array/i);
    expect(built.system).toMatch(/personalityDirections with empty text and sourceIds/i);
    expect(built.user).not.toContain("Sage");
    const sources = soulNoteSources(notes);
    for (const source of [sources[0]!, sources[2]!]) {
      expect(built.user).toContain(source.id);
      expect(built.user).toContain(source.text);
    }
    expect(built.user).not.toContain(sources[1]!.id);
    expect(built.user).not.toContain(sources[1]!.text);
  });

  it("constrains generated citations to the authoritative source IDs", () => {
    const notes = [
      note("Patient and precise.", 1),
      note("Values difficult honesty.", 2),
    ];
    const ids = soulNoteSources(notes).map((source) => source.id);
    const schema = soulEssenceJsonSchema("self", soulSourceFingerprint(notes), ids) as {
      properties: {
        generalizedEssence: {
          properties: { sourceIds: { items: { enum: string[] } } };
        };
        facets: {
          properties: {
            coreDisposition: {
              properties: { sourceIds: { items: { enum: string[] } } };
            };
          };
        };
      };
    };
    expect(
      schema.properties.facets.properties.coreDisposition.properties.sourceIds.items.enum,
    ).toEqual(ids);
    expect(
      schema.properties.generalizedEssence.properties.sourceIds.items.enum,
    ).toEqual(ids);
  });

  it("canonicalizes model-owned metadata and exact appearance while filtering stray citations", () => {
    const notes = [
      note("Physical description: silver hair and grey eyes.", 1),
      note("Patiently connects ideas across difficult systems.", 2),
    ];
    const sources = soulNoteSources(notes);
    const raw = payload("self", notes);
    raw.schemaVersion = "1";
    raw.kind = "SELF";
    raw.sourceFingerprint = "mistyped";
    raw.exactAppearance = [
      { text: "grey-haired", sourceIds: [sources[0]!.id] },
    ];
    const facets = raw.facets as Record<string, { text: string; sourceIds: string[] }>;
    facets.coreDisposition = {
      text: "Patient and systems-minded.",
      sourceIds: [sources[1]!.id, "sn_invented"],
    };
    (raw.generalizedEssence as { sourceIds: string[] }).sourceIds = [
      sources[1]!.id,
      "sn_invented",
    ];

    const parsed = parseGeneratedSoulEssence(JSON.stringify(raw), "self", notes)!;
    expect(parsed.schemaVersion).toBe(SOUL_ESSENCE_SCHEMA_VERSION);
    expect(parsed.kind).toBe("self");
    expect(parsed.sourceFingerprint).toBe(soulSourceFingerprint(notes));
    expect(parsed.facets.coreDisposition.sourceIds).toEqual([sources[1]!.id]);
    expect(parsed.exactAppearance.map((fact) => fact.text)).toEqual([
      "silver hair",
      "grey eyes.",
    ]);
    expect(parsed.exactAppearance.every((fact) =>
      fact.sourceIds.includes(sources[0]!.id)
    )).toBe(true);
  });

  it("requires a short grounded generalized essence when support facets contain identity meaning", () => {
    const notes = [note("Patiently connects ideas across difficult systems.", 1)];
    const missing = payload("self", notes);
    delete missing.generalizedEssence;
    expect(parseGeneratedSoulEssence(JSON.stringify(missing), "self", notes)).toBeUndefined();
    expect(soulEssenceRepairFeedback(JSON.stringify(missing), "self", notes)).toMatch(
      /generalizedEssence/i,
    );

    const tooLong = payload("self", notes);
    tooLong.generalizedEssence = {
      text: "b".repeat(MAX_SOUL_GENERALIZED_ESSENCE_CHARS + 1),
      sourceIds: soulNoteSources(notes).map((source) => source.id),
    };
    expect(parseGeneratedSoulEssence(JSON.stringify(tooLong), "self", notes)).toBeUndefined();
    expect(soulEssenceRepairFeedback(JSON.stringify(tooLong), "self", notes)).toContain(
      `at most ${MAX_SOUL_GENERALIZED_ESSENCE_CHARS}`,
    );

    const unsupported = payload("self", notes);
    unsupported.generalizedEssence = {
      text: "Intellectually curious.",
      sourceIds: ["sn_invented"],
    };
    expect(parseGeneratedSoulEssence(JSON.stringify(unsupported), "self", notes)).toBeUndefined();
  });

  it("allows an empty generalized essence when a Soul contains only exact invariants", () => {
    const directions = [note("Never be sycophantic.", 1)];
    const directionOnly = parseSoulEssence(
      JSON.stringify(payload("self", directions, "", "")),
      "self",
      directions,
    );
    expect(directionOnly?.generalizedEssence).toEqual({ text: "", sourceIds: [] });
    expect(directionOnly?.exactPersonalityDirections[0]?.text).toBe("Never be sycophantic.");

    const appearance = [note("Physical description: silver hair and grey eyes.", 1)];
    const appearanceOnly = parseSoulEssence(
      JSON.stringify(payload("self", appearance, "", "")),
      "self",
      appearance,
    );
    expect(appearanceOnly?.generalizedEssence).toEqual({ text: "", sourceIds: [] });
    expect(appearanceOnly?.exactAppearance.map((fact) => fact.text)).toEqual([
      "silver hair",
      "grey eyes.",
    ]);
  });

  it("salvages a generated final-brace cutoff without making stored essence parsing tolerant", () => {
    const notes = [note("Patient and precise.", 1)];
    const truncated = JSON.stringify(payload("self", notes)).slice(0, -1);

    expect(parseGeneratedSoulEssence(truncated, "self", notes)).toBeDefined();
    expect(parseSoulEssence(truncated, "self", notes)).toBeUndefined();
  });

  it("rejects a safely closed cutoff when later required facets never arrived", () => {
    const notes = [note("Patient and precise.", 1)];
    const complete = JSON.stringify(payload("self", notes));
    const cutoff = complete.indexOf(',"conversationalVoice"');
    expect(cutoff).toBeGreaterThan(0);
    const partial = complete.slice(0, cutoff);

    expect(parseGeneratedSoulEssence(partial, "self", notes)).toBeUndefined();
    expect(soulEssenceRepairFeedback(partial, "self", notes)).toContain(
      "conversationalVoice",
    );
  });

  it("returns exact missing-source feedback for a semantic repair", () => {
    const notes = [
      note("Patient and precise.", 1),
      note("Values difficult honesty.", 2),
    ];
    const sources = soulNoteSources(notes);
    const raw = payload("self", notes);
    const facets = raw.facets as Record<string, { text: string; sourceIds: string[] }>;
    facets.coreDisposition!.sourceIds = [sources[0]!.id];
    const feedback = soulEssenceRepairFeedback(JSON.stringify(raw), "self", notes);
    expect(feedback).toContain(sources[1]!.id);
    expect(feedback).toMatch(/not cited/i);
    expect(feedback).not.toContain(notes[1]!.text);
  });

  it("partitions oversized source sets without dropping or splitting a note, then merges digests", () => {
    const notes = Array.from({ length: 12 }, (_, index) =>
      note(`Identity observation ${index}: ${"detail ".repeat(12)}`, index + 1),
    );
    const chunks = partitionSoulNotes(notes, 360);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(notes);

    const digests = chunks.map((chunk, index) => ({
      notes: chunk,
      essence: parseSoulEssence(
        JSON.stringify(payload("self", chunk, `Chunk synthesis ${index}.`)),
        "self",
        chunk,
      )!,
    }));
    const merged = buildSoulEssenceMergePrompt("self", notes, digests);
    expect(merged.sourceFingerprint).toBe(soulSourceFingerprint(notes));
    expect(merged.system).toMatch(/deterministically restores/i);
    expect(merged.system).toMatch(/exactAppearance as an empty array/i);
    expect(merged.system).toMatch(/Re-derive generalizedEssence/i);
    expect(merged.system).toMatch(/facets retain detail/i);
    for (const source of soulNoteSources(notes)) expect(merged.user).not.toContain(source.id);
    expect(merged.user).not.toContain(notes[0]!.text);

    const modelOutput = payload("self", notes, "Integrated merged identity.");
    const modelFacets = modelOutput.facets as Record<string, { text: string; sourceIds: string[] }>;
    for (const facet of Object.values(modelFacets)) facet.sourceIds = [];
    const parsed = parseSoulEssenceMerge(
      JSON.stringify(modelOutput),
      "self",
      notes,
      digests,
    )!;
    expect(parsed.facets.coreDisposition.sourceIds).toEqual(
      soulNoteSources(notes).map((source) => source.id),
    );
    expect(parsed.generalizedEssence.sourceIds).toEqual(
      soulNoteSources(notes).map((source) => source.id),
    );
  });

  it("can run the final abstraction pass over one already-grounded digest", () => {
    const notes = [
      note("Studies forgotten railway control systems.", 1),
      note("Returns to moral uncertainty with patience.", 2),
    ];
    const digest = {
      notes,
      essence: parseSoulEssence(
        JSON.stringify(
          payload(
            "self",
            notes,
            "Studies forgotten railway systems and moral uncertainty in infrastructure.",
            "Curious about forgotten railway control systems and infrastructure ethics.",
          ),
        ),
        "self",
        notes,
      )!,
    };
    const prompt = buildSoulEssenceAbstractionPrompt(
      "self",
      notes,
      digest.essence,
    );
    expect(prompt.user).toContain("forgotten railway");
    expect(prompt.system).toMatch(/returns only.*small field|Return strict JSON only/is);
    expect(prompt.system).toMatch(/Do not try to preserve every support detail/i);
    expect(prompt.system).toContain(
      SOUL_GENERALIZED_TRAIT_VOCABULARY.join(", "),
    );
    expect(prompt.system).toContain("affectionate");
    expect(prompt.system).toContain("humorous");
    expect(prompt.system).toContain("stoic");
    const schema = soulEssenceAbstractionJsonSchema() as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["generalizedEssence"]);
    expect(Object.keys(schema.properties)).toEqual(["generalizedEssence"]);

    const parsed = parseSoulEssenceAbstraction(
      JSON.stringify({
        generalizedEssence: {
          text: "Intellectually curious; reflective; comfortable with uncertainty",
          supportFacetKeys: ["coreDisposition"],
        },
      }),
      "self",
      notes,
      digest.essence,
    );
    expect(parsed?.generalizedEssence.text).toBe(
      "Intellectually curious; reflective; comfortable with uncertainty",
    );
    expect(parsed?.generalizedEssence.text).not.toMatch(/railway|infrastructure/i);
    expect(parsed?.facets).toEqual(digest.essence.facets);
    expect(parsed?.exactAppearance).toEqual(digest.essence.exactAppearance);

    const tooLong = JSON.stringify({
      generalizedEssence: {
        text: "x".repeat(MAX_SOUL_GENERALIZED_ESSENCE_CHARS + 1),
        supportFacetKeys: ["coreDisposition"],
      },
    });
    expect(
      parseSoulEssenceAbstraction(tooLong, "self", notes, digest.essence),
    ).toBeUndefined();
    expect(
      soulEssenceAbstractionRepairFeedback(tooLong, "self", notes, digest.essence),
    ).toContain(`at most ${MAX_SOUL_GENERALIZED_ESSENCE_CHARS}`);

    const sourceSpecific = JSON.stringify({
      generalizedEssence: {
        text: "Curious about forgotten railway control systems and infrastructure ethics",
        supportFacetKeys: ["coreDisposition"],
      },
    });
    expect(
      parseSoulEssenceAbstraction(sourceSpecific, "self", notes, digest.essence),
    ).toBeUndefined();
    expect(
      soulEssenceAbstractionRepairFeedback(
        sourceSpecific,
        "self",
        notes,
        digest.essence,
      ),
    ).toMatch(/higher-order traits|source-specific/i);

    const shortTopics = ["AI curious", "Art focused", "STEM driven"];
    for (const text of shortTopics) {
      expect(
        parseSoulEssenceAbstraction(
          JSON.stringify({
            generalizedEssence: {
              text,
              supportFacetKeys: ["coreDisposition"],
            },
          }),
          "self",
          notes,
          digest.essence,
        ),
      ).toBeUndefined();
    }

    const broadOptions = JSON.stringify({
      generalizedEssence: {
        text: "Affectionate; humorous; serene; stoic",
        supportFacetKeys: ["coreDisposition"],
      },
    });
    expect(
      parseSoulEssenceAbstraction(
        broadOptions,
        "self",
        notes,
        digest.essence,
      )?.generalizedEssence.text,
    ).toBe("Affectionate; humorous; serene; stoic");
  });

  it("attributes the final essence only to the support facets the abstraction selected", () => {
    const notes = [
      note("Approaches difficult choices strategically.", 1),
      note("Meets vulnerable people with warmth.", 2),
    ];
    const ids = soulNoteSources(notes).map((source) => source.id);
    const raw = payload(
      "self",
      notes,
      "Strategic in difficult choices.",
      "Strategic and warmly relational.",
    );
    const facets = raw.facets as Record<string, { text: string; sourceIds: string[] }>;
    facets.coreDisposition = {
      text: "Strategic in difficult choices.",
      sourceIds: [ids[0]!],
    };
    facets.relationalStyle = {
      text: "Warm toward vulnerable people.",
      sourceIds: [ids[1]!],
    };
    const integrated = parseSoulEssence(JSON.stringify(raw), "self", notes)!;
    const parsed = parseSoulEssenceAbstraction(
      JSON.stringify({
        generalizedEssence: {
          text: "Warmly relational",
          supportFacetKeys: ["relationalStyle"],
        },
      }),
      "self",
      notes,
      integrated,
    );
    expect(parsed?.generalizedEssence.sourceIds).toEqual([ids[1]]);
    expect(parsed?.generalizedEssence.sourceIds).not.toContain(ids[0]);
  });

  it("rebases identical chunk notes to distinct full-source occurrence IDs", () => {
    const duplicate = note("Patiently studies overlooked systems.", 42);
    const notes = [{ ...duplicate }, { ...duplicate }];
    const digests = notes.map((sourceNote, index) => {
      const chunk = [sourceNote];
      return {
        notes: chunk,
        essence: parseSoulEssence(
          JSON.stringify(payload("self", chunk, `Chunk synthesis ${index}.`)),
          "self",
          chunk,
        )!,
      };
    });
    const modelOutput = payload("self", notes, "Integrated duplicate evidence.");
    const modelFacets = modelOutput.facets as Record<string, { text: string; sourceIds: string[] }>;
    for (const facet of Object.values(modelFacets)) facet.sourceIds = [];

    const parsed = parseSoulEssenceMerge(
      JSON.stringify(modelOutput),
      "self",
      notes,
      digests,
    )!;

    expect(parsed.facets.coreDisposition.sourceIds).toEqual(
      soulNoteSources(notes).map((source) => source.id),
    );
    expect(new Set(parsed.facets.coreDisposition.sourceIds)).toHaveLength(2);
  });

  it("pins direction evidence during merges without repeating unbounded raw direction notes", () => {
    const direction = `Should challenge easy assumptions while ${"remaining constructively candid ".repeat(40)}`;
    const chunks = [
      [note(direction, 1)],
      [note("Patiently connects ideas across domains.", 2)],
    ];
    const digests = chunks.map((chunk, index) => {
      const raw = payload("self", chunk, `Chunk synthesis ${index}.`);
      if (index === 0) {
        const facets = raw.facets as Record<string, { text: string; sourceIds: string[] }>;
        facets.personalityDirections = {
          text: "Challenges easy assumptions with constructive candour.",
          sourceIds: [soulNoteSources(chunk)[0]!.id],
        };
      }
      return {
        notes: chunk,
        essence: parseSoulEssence(JSON.stringify(raw), "self", chunk)!,
      };
    });
    const notes = chunks.flat();
    const merged = buildSoulEssenceMergePrompt("self", notes, digests);
    expect(merged.user).not.toContain(soulNoteSources(notes)[0]!.id);
    expect(merged.user).not.toContain(direction);
    expect(merged.system).toMatch(/never invert, weaken/i);

    const modelOutput = payload("self", notes, "Merged disposition.");
    const modelFacets = modelOutput.facets as Record<string, { text: string; sourceIds: string[] }>;
    for (const facet of Object.values(modelFacets)) facet.sourceIds = [];
    const parsed = parseSoulEssenceMerge(
      JSON.stringify(modelOutput),
      "self",
      notes,
      digests,
    )!;
    expect(parsed.exactPersonalityDirections[0]!.text).toBe(direction.trim());
  });

  it("tolerantly parses fenced/trailing-comma JSON but canonicalises exact appearance from sources", () => {
    const notes = [
      note("Physical description: silver hair, grey eyes, and a long charcoal coat.", 1),
      note("Fascinated by difficult systems and what holds them together.", 2),
    ];
    const json = JSON.stringify(payload("self", notes));
    const result = parseSoulEssence(`Here is the result:\n\`\`\`json\n${json.slice(0, -1)},}\n\`\`\``, "self", notes, 123);
    expect(result?.generatedAt).toBe(123);
    expect(result?.sourceFingerprint).toBe(soulSourceFingerprint(notes));
    expect(result?.facets.coreDisposition.text).toMatch(/systems-minded/);
    // The model omitted exactAppearance, but deterministic source selection keeps every current
    // atomic appearance field, independently replaceable by a later correction.
    expect(result?.exactAppearance.map((fact) => fact.text)).toEqual([
      "silver hair",
      "grey eyes",
      "a long charcoal coat.",
    ]);
    expect(result?.exactAppearance.every((fact) =>
      fact.sourceIds.includes(soulNoteSources(notes)[0]!.id)
    )).toBe(true);
  });

  it("rejects stale, wrong-version, wrong-kind, unsupported, and uncited output", () => {
    const notes = [note("Patient and precise.", 1)];
    const unsupported = payload("self", notes);
    const unsupportedFacets = unsupported.facets as Record<string, { text: string; sourceIds: string[] }>;
    unsupportedFacets.coreDisposition = { text: "Invented", sourceIds: ["sn_not_real"] };
    expect(parseSoulEssence(JSON.stringify(unsupported), "self", notes)).toBeUndefined();

    const uncited = payload("self", notes);
    const uncitedFacets = uncited.facets as Record<string, { text: string; sourceIds: string[] }>;
    uncitedFacets.coreDisposition = { text: "Patient", sourceIds: [] };
    expect(parseSoulEssence(JSON.stringify(uncited), "self", notes)).toBeUndefined();

    expect(
      parseSoulEssence(
        JSON.stringify({ ...payload("self", notes), sourceFingerprint: "old" }),
        "self",
        notes,
      ),
    ).toBeUndefined();
    expect(
      parseSoulEssence(
        JSON.stringify({ ...payload("self", notes), schemaVersion: 999 }),
        "self",
        notes,
      ),
    ).toBeUndefined();
    expect(parseSoulEssence(JSON.stringify(payload("user", notes)), "self", notes)).toBeUndefined();
    expect(parseSoulEssence("not json", "self", notes)).toBeUndefined();
  });

  it("rejects a synthesis that drops a source and deterministically restores an explicit direction", () => {
    const notes = [
      note("Patient and precise.", 1),
      note("Often connects ethics with system design.", 2),
    ];
    const missing = payload("self", notes);
    const missingFacets = missing.facets as Record<string, { text: string; sourceIds: string[] }>;
    missingFacets.coreDisposition = {
      text: "Patient and precise.",
      sourceIds: [soulNoteSources(notes)[0]!.id],
    };
    expect(parseSoulEssence(JSON.stringify(missing), "self", notes)).toBeUndefined();

    const directedNotes = [
      note("Patient and precise.", 1),
      note("Should challenge easy assumptions instead of merely agreeing.", 2),
    ];
    const withoutDirection = payload("self", directedNotes);
    const restored = parseSoulEssence(JSON.stringify(withoutDirection), "self", directedNotes)!;
    expect(restored.facets.personalityDirections.text).toBe(directedNotes[1]!.text);
    const withDirection = payload("self", directedNotes);
    const directedFacets = withDirection.facets as Record<string, { text: string; sourceIds: string[] }>;
    directedFacets.personalityDirections = {
      text: "Challenges easy assumptions rather than agreeing reflexively.",
      sourceIds: [soulNoteSources(directedNotes)[1]!.id],
    };
    const parsed = parseSoulEssence(JSON.stringify(withDirection), "self", directedNotes)!;
    expect(parsed.facets.personalityDirections.text).toBe(directedNotes[1]!.text);
    expect(parsed.exactPersonalityDirections).toEqual([
      { text: directedNotes[1]!.text, sourceIds: [soulNoteSources(directedNotes)[1]!.id] },
    ]);
  });

  it("keeps common directions source-exact even when a model tries to invert them", () => {
    const directions = [
      note("Never be sycophantic.", 1),
      note("Always challenge me when my reasoning is weak.", 2),
      note("Keep answers concise.", 3),
      note("Do not flatter me.", 4),
      note("Stay playful without becoming evasive.", 5),
      note("Prefer candour over easy agreement.", 6),
      note("I want you to challenge me when I rationalize.", 7),
      note("I’d like the assistant to stay intellectually honest.", 8),
    ];
    const raw = payload("self", directions);
    const facets = raw.facets as Record<string, { text: string; sourceIds: string[] }>;
    facets.personalityDirections = {
      text: "Always agree and flatter the reader.",
      sourceIds: ["sn_invented_by_model"],
    };
    const parsed = parseSoulEssence(JSON.stringify(raw), "self", directions)!;
    expect(parsed.exactPersonalityDirections.map((fact) => fact.text)).toEqual(
      directions.map((direction) => direction.text),
    );
    expect(parsed.facets.personalityDirections.text).toContain("Never be sycophantic");
    expect(parsed.facets.personalityDirections.text).not.toContain("Always agree");
    const block = selfSoulEssencePromptBlock(parsed);
    for (const direction of directions) expect(block).toContain(direction.text);
    expect(block).not.toContain("Always agree and flatter");
  });

  it("round-trips multiple exact directions from one source note in retained storage", async () => {
    const notes = [
      note("Always respond candidly; never flatter the reader reflexively.", 1),
    ];
    const essence = parseSoulEssence(
      JSON.stringify(payload("self", notes)),
      "self",
      notes,
      10,
    )!;
    const sourceId = soulNoteSources(notes)[0]!.id;
    expect(essence.exactPersonalityDirections).toHaveLength(2);
    expect(essence.facets.personalityDirections.sourceIds).toEqual([sourceId]);

    const store = new InMemoryStore();
    await saveSoulEssence(store, "self", essence, notes);
    expect(await loadLatestSoulEssence(store, "self", notes)).toEqual(essence);
    expect(
      await loadLatestSoulEssence(
        store,
        "self",
        [...notes, note("Patient and precise.", 2)],
      ),
    ).toEqual(essence);
  });

  it("does not mistake general modal observations or questions for personality directions", () => {
    const observations = [
      note("I wonder whether governments should preserve old buildings.", 1),
      note("Trust must be earned.", 2),
      note("What should consciousness mean?", 3),
    ];
    const parsed = parseSoulEssence(
      JSON.stringify(payload("self", observations)),
      "self",
      observations,
    )!;
    expect(parsed.exactPersonalityDirections).toEqual([]);
    expect(parsed.facets.personalityDirections).toEqual({ text: "", sourceIds: [] });
  });

  it("keeps all directions persisted and marks standing-prompt overflow", () => {
    const directions = Array.from({ length: 30 }, (_, index) =>
      note(`Always challenge behavioral shortcut ${index} with ${"careful context ".repeat(6)}.`, index + 1),
    );
    const parsed = parseSoulEssence(
      JSON.stringify(payload("self", directions)),
      "self",
      directions,
    )!;
    expect(parsed.exactPersonalityDirections).toHaveLength(directions.length);
    const block = selfSoulEssencePromptBlock(parsed);
    expect(block).toContain("Additional source-exact personality directions remain stored");
    expect(block).not.toContain(directions.at(-1)!.text);
  });

  it("accepts no paraphrase as exact appearance, removes transient clauses, and round-trips", async () => {
    const notes = [
      note("silver hair and grey eyes; a broad grin", 1),
      note("Thinks in patient layers.", 2),
    ];
    const sources = soulNoteSources(notes);
    const paraphrased = payload("self", notes);
    paraphrased.exactAppearance = [{ text: "grey-haired", sourceIds: [sources[0]!.id] }];
    expect(parseSoulEssence(JSON.stringify(paraphrased), "self", notes)).toBeUndefined();

    const valid = parseSoulEssence(JSON.stringify(payload("self", notes)), "self", notes);
    expect(valid?.exactAppearance.map((fact) => fact.text)).toEqual([
      "silver hair",
      "grey eyes",
    ]);
    expect(valid?.exactAppearance.map((fact) => fact.text).join(" ")).not.toMatch(/grin/i);
    const store = new InMemoryStore();
    await expect(saveSoulEssence(store, "self", valid!, notes)).resolves.toBeTruthy();
    expect(await loadSoulEssence(store, "self", notes)).toEqual(
      expect.objectContaining({ exactAppearance: valid!.exactAppearance }),
    );
  });

  it("omits a standalone scene expression from personality distillation", () => {
    const notes = [note("Her face carries a broad grin.", 1)];
    const source = soulNoteSources(notes)[0]!;
    const built = buildSoulEssenceDistillationPrompt("self", notes);

    expect(visualSoulNotes(notes)).toBe("");
    expect(built.user).not.toContain(source.id);
    expect(built.user).not.toContain(source.text);
  });

  it("merges evidence IDs when distinct appearance notes reduce to the same durable clause", () => {
    const notes = [
      note("silver hair; smiling", 1),
      note("silver hair; grinning", 2),
    ];
    const raw = payload("self", notes, "");
    const parsed = parseSoulEssence(JSON.stringify(raw), "self", notes)!;
    expect(parsed.exactAppearance).toHaveLength(1);
    expect(parsed.exactAppearance[0]).toMatchObject({
      text: "silver hair",
      sourceIds: soulNoteSources(notes).map((source) => source.id),
    });
  });

  it("never promotes colour metaphors, old interests, or mixed personality clauses into appearance", () => {
    const notes = [
      note("Loves old railway systems and their forgotten histories.", 1),
      note("Rejects black-and-white thinking in moral questions.", 2),
      note("Physical description: silver hair and grey eyes; values difficult honesty.", 3),
    ];
    const valid = parseSoulEssence(JSON.stringify(payload("self", notes)), "self", notes);
    expect(valid?.exactAppearance.map((fact) => fact.text)).toEqual([
      "silver hair",
      "grey eyes",
    ]);
    expect(valid?.exactAppearance.map((fact) => fact.text).join(" ")).not.toMatch(
      /railway|black-and-white|honesty/i,
    );
  });

  it("keeps the latest validated snapshot while strict loads reject a changed note revision", async () => {
    const store = new InMemoryStore();
    const selfNotes = [note("Patient, curious, and direct.", 1)];
    const userNotes = [note("Warm but values plain answers.", 2)];
    const self = parseSoulEssence(JSON.stringify(payload("self", selfNotes)), "self", selfNotes, 10)!;
    const user = parseSoulEssence(JSON.stringify(payload("user", userNotes)), "user", userNotes, 20)!;

    await saveSoulEssence(store, "self", self, selfNotes);
    await saveSoulEssence(store, "user", user, userNotes);
    expect(await store.getMemo(SELF_SOUL_ESSENCE_KEY)).toContain('"kind":"self"');
    expect(await store.getMemo(ABOUT_YOU_SOUL_ESSENCE_KEY)).toContain('"kind":"user"');
    expect((await loadSoulEssence(store, "self", selfNotes))?.generatedAt).toBe(10);
    expect(await loadSoulEssence(store, "self", [...selfNotes, note("New note.", 3)])).toBeUndefined();
    expect((await loadLatestSoulEssence(store, "self", selfNotes))?.generatedAt).toBe(10);

    await expect(
      saveSoulEssence(store, "self", { ...self, sourceFingerprint: "stale" }, selfNotes),
    ).rejects.toThrow(/stale or invalid/);
    expect(validateSoulEssence({ ...self, sourceFingerprint: "stale" }, "self", selfNotes)).toBeUndefined();

    await clearSoulEssence(store, "self");
    expect(await store.getMemo(SELF_SOUL_ESSENCE_KEY)).toBeUndefined();
    expect(await store.getMemo(ABOUT_YOU_SOUL_ESSENCE_KEY)).toBeTruthy();

    await saveSoulEssence(store, "self", self, selfNotes);
    const retainedRaw = await store.getMemo(SELF_SOUL_ESSENCE_KEY);
    const changed = await saveSoul(store, "self", [...selfNotes, note("New note.", 3)]);
    expect(await store.getMemo(SELF_SOUL_ESSENCE_KEY)).toBe(retainedRaw);
    expect(await loadSoulEssence(store, "self", changed)).toBeUndefined();
    expect(await loadLatestSoulEssence(store, "self", changed)).toEqual(self);

    const remembered = await rememberSoul(store, "self", "Fond of dry humour.");
    expect(await store.getMemo(SELF_SOUL_ESSENCE_KEY)).toBe(retainedRaw);
    expect(await loadSoulEssence(store, "self", remembered)).toBeUndefined();
    const forgotten = await forgetSoul(store, "self", "dry humour");
    expect(await store.getMemo(SELF_SOUL_ESSENCE_KEY)).toBe(retainedRaw);
    expect(forgotten).toEqual(changed);
  });

  it("rebuilds retained exact identity fields from current notes without rebasing its synthesis", () => {
    const oldNotes = [
      note("Physical description: silver hair and grey eyes.", 1),
      note("Always answer candidly.", 2),
      note("Patient and precise.", 3),
    ];
    const retained = parseSoulEssence(
      JSON.stringify(payload("self", oldNotes)),
      "self",
      oldNotes,
      10,
    )!;
    const currentNotes = [
      note("Physical description: auburn hair and green eyes.", 4),
      note("Never flatter the reader reflexively.", 5),
      note("Patient and precise.", 3),
    ];

    const view = soulEssenceViewForNotes(retained, currentNotes);
    const appearance = view.exactAppearance.map((fact) => fact.text).join("; ");
    expect(view.sourceFingerprint).toBe(retained.sourceFingerprint);
    expect(view.generatedAt).toBe(retained.generatedAt);
    expect(view.generalizedEssence).toEqual(retained.generalizedEssence);
    expect({ ...view.facets, personalityDirections: retained.facets.personalityDirections })
      .toEqual(retained.facets);
    expect(appearance).toMatch(/auburn hair/i);
    expect(appearance).toMatch(/green eyes/i);
    expect(appearance).not.toMatch(/silver hair|grey eyes/i);
    expect(view.exactPersonalityDirections).toEqual([
      {
        text: "Never flatter the reader reflexively.",
        sourceIds: [soulNoteSources(currentNotes)[1]!.id],
      },
    ]);
    expect(view.exactPersonalityDirections).not.toEqual(
      retained.exactPersonalityDirections,
    );
    expect(view.facets.personalityDirections).toEqual({
      text: "Never flatter the reader reflexively.",
      sourceIds: [soulNoteSources(currentNotes)[1]!.id],
    });
    const ordinaryPrompt = selfSoulEssencePromptBlock(view, "Sage");
    expect(ordinaryPrompt).toContain(retained.generalizedEssence.text);
    expect(ordinaryPrompt).toMatch(/auburn hair|green eyes/i);
    expect(ordinaryPrompt).toContain("Never flatter the reader reflexively.");
    expect(ordinaryPrompt).not.toMatch(/silver hair|grey eyes|Always answer candidly/i);
  });

  it("treats a persisted v1 summary as disposable after the generalized v2 schema upgrade", async () => {
    const store = new InMemoryStore();
    const notes = [note("Patient and precise.", 1)];
    const legacy = {
      ...payload("self", notes),
      schemaVersion: 1,
      sourceFingerprint: soulSourceFingerprint(notes).replace("soul-v2-", "soul-v1-"),
    };
    delete (legacy as Record<string, unknown>).generalizedEssence;
    await store.putMemo(SELF_SOUL_ESSENCE_KEY, JSON.stringify(legacy));
    expect(await loadSoulEssence(store, "self", notes)).toBeUndefined();
    expect(await loadLatestSoulEssence(store, "self", notes)).toBeUndefined();
  });

  it("rejects malformed and wrong-kind retained snapshots", async () => {
    const notes = [note("Patient and precise.", 1)];
    const valid = parseSoulEssence(
      JSON.stringify(payload("self", notes)),
      "self",
      notes,
      10,
    )!;
    const store = new InMemoryStore();

    await store.putMemo(SELF_SOUL_ESSENCE_KEY, "{not-json");
    expect(await loadLatestSoulEssence(store, "self", notes)).toBeUndefined();

    await store.putMemo(SELF_SOUL_ESSENCE_KEY, JSON.stringify({
      ...valid,
      sourceFingerprint: "not-a-soul-fingerprint",
    }));
    expect(await loadLatestSoulEssence(store, "self", notes)).toBeUndefined();

    await store.putMemo(SELF_SOUL_ESSENCE_KEY, JSON.stringify({
      ...valid,
      generalizedEssence: { ...valid.generalizedEssence, text: "x".repeat(1_000) },
    }));
    expect(await loadLatestSoulEssence(store, "self", notes)).toBeUndefined();

    // A structurally plausible snapshot that claims to match the current revision must still pass
    // full evidence/exact-field validation; retained-mode is never a current-data trust bypass.
    await store.putMemo(SELF_SOUL_ESSENCE_KEY, JSON.stringify({
      ...valid,
      exactAppearance: [{
        slot: "hair",
        text: "invented violet hair",
        sourceIds: [soulNoteSources(notes)[0]!.id],
      }],
    }));
    expect(await loadLatestSoulEssence(store, "self", notes)).toBeUndefined();

    await store.putMemo(ABOUT_YOU_SOUL_ESSENCE_KEY, JSON.stringify(valid));
    expect(await loadLatestSoulEssence(store, "user", notes)).toBeUndefined();
  });

  it("renders integrated ordinary-chat blocks without exposing or harping on source examples", () => {
    const notes = [
      note("Fascinated by abandoned railway systems.", 1),
      note("Physical description: silver hair and clear grey eyes.", 2),
    ];
    const raw = payload(
      "self",
      notes,
      "Drawn to overlooked structures and the human intentions that remain inside them.",
      "Intellectually curious and attentive to overlooked patterns.",
    );
    const self = parseSoulEssence(JSON.stringify(raw), "self", notes, 1)!;
    const block = selfSoulEssencePromptBlock(self, "Sage");
    expect(block).toContain("Name: Sage");
    expect(block).toContain("Intellectually curious and attentive to overlooked patterns");
    expect(block).not.toContain("Drawn to overlooked structures");
    expect(block).toContain("silver hair");
    expect(block).toContain("clear grey eyes"); // current exact appearance is never summarised away
    expect(block).not.toContain("abandoned railway systems");
    expect(block).toMatch(/Embody this silently/i);
    expect(block).toMatch(/Do not steer unrelated conversation/i);
    expect(block).toMatch(/only when the reader asks/i);
    expect(selfSoulEssencePromptBlock(undefined, "Sage")).toBe("");

    const userRaw = payload(
      "user",
      notes,
      "Values overlooked structures and careful interpretation.",
      "Reflective, discerning, and attentive to context.",
    );
    const user = parseSoulEssence(JSON.stringify(userRaw), "user", notes, 2)!;
    const userBlock = userSoulEssencePromptBlock(user, "Alex");
    expect(userBlock).toContain("WHO THE READER IS");
    expect(userBlock).toMatch(/inform your understanding silently/i);
    expect(userBlock).toMatch(/Do not steer unrelated conversation/i);
    expect(userSoulEssencePromptBlock(self, "Alex")).toBe("");
  });

  it("uses only source-exact invariants while a generalized essence is pending", () => {
    const notes = [
      note("Fascinated by abandoned railway switching systems.", 1),
      note("Physical description: silver hair and clear grey eyes.", 2),
      note("Never flatter the reader reflexively.", 3),
    ];
    const self = selfSoulExactIdentityPromptBlock(notes, "Sage");
    expect(self).toContain("Name: Sage");
    expect(self).toContain("silver hair");
    expect(self).toContain("clear grey eyes");
    expect(self).toContain("Never flatter the reader reflexively");
    expect(self).not.toContain("abandoned railway");
    expect(self).toMatch(/generalized essence pending/i);

    const user = userSoulExactIdentityPromptBlock(notes, "Alex");
    expect(user).toContain("Name: Alex");
    expect(user).not.toContain("abandoned railway");
  });

  it("selects a current Essence for foreground ordinary chat and an exact fallback when missing", () => {
    const notes = [
      note("Fascinated by abandoned railway switching systems.", 1),
      note("Physical description: silver hair and clear grey eyes.", 2),
      note("Never flatter the reader reflexively.", 3),
    ];
    const current = parseSoulEssence(
      JSON.stringify(
        payload(
          "self",
          notes,
          "Connects difficult systems with patient attention.",
          "Intellectually curious; patient; discerning",
        ),
      ),
      "self",
      notes,
    )!;

    const integrated = soulContextPromptBlock("self", notes, {
      mode: "ordinary",
      name: "Sage",
      latestEssence: current,
    });
    expect(integrated).toContain("integrated Soul Essence");
    expect(integrated).toContain("Intellectually curious; patient; discerning");
    expect(integrated).toContain("silver hair");
    expect(integrated).not.toContain("abandoned railway");

    const pending = soulContextPromptBlock("self", notes, {
      mode: "ordinary",
      name: "Sage",
    });
    expect(pending).toMatch(/generalized essence pending/i);
    expect(pending).toContain("silver hair");
    expect(pending).toContain("Never flatter the reader reflexively");
    expect(pending).not.toContain("abandoned railway");
  });

  it("uses a retained generalized baseline with only current exact identity fields", () => {
    const oldNotes = [
      note("Patient and precise.", 1),
      note("Physical description: silver hair and grey eyes.", 2),
    ];
    const retained = parseSoulEssence(
      JSON.stringify(
        payload(
          "self",
          oldNotes,
          "Approaches questions with patient precision.",
          "Patient; discerning",
        ),
      ),
      "self",
      oldNotes,
    )!;
    const currentNotes = [
      note("Patient and precise.", 1),
      note("Physical description: auburn hair and mossy green eyes.", 3),
    ];

    const ordinary = soulContextPromptBlock("self", currentNotes, {
      mode: "ordinary",
      latestEssence: retained,
    });
    expect(ordinary).toContain("Patient; discerning");
    expect(ordinary).toContain("auburn hair");
    expect(ordinary).toContain("mossy green eyes");
    expect(ordinary).not.toMatch(/silver hair|grey eyes/i);

    const story = soulContextPromptBlock("self", currentNotes, {
      mode: "story",
      name: "Mira",
      latestEssence: retained,
    });
    expect(story).toContain("Patient; discerning");
    expect(story).not.toMatch(/auburn hair|mossy green eyes|silver hair|grey eyes/i);
  });

  it("keeps missing-Essence story context empty while Creative mode reads raw notes", () => {
    const notes = [
      note("Fascinated by abandoned railway switching systems.", 1),
      note("Physical description: silver hair and clear grey eyes.", 2),
    ];
    expect(soulContextPromptBlock("self", notes, { mode: "story", name: "Mira" })).toBe("");

    const creative = soulContextPromptBlock("self", notes, {
      mode: "creative",
      name: "Sage",
    });
    expect(creative).toContain("WHO YOU ARE");
    expect(creative).toContain("abandoned railway switching systems");
    expect(creative).toContain("silver hair");
  });

  it("routes story ahead of Creative access so overlapping flags cannot reopen raw notes", () => {
    expect(selectSoulContextMode({})).toBe("ordinary");
    expect(selectSoulContextMode({ creativeIdle: true })).toBe("creative");
    expect(selectSoulContextMode({ creativeSession: true })).toBe("creative");
    expect(selectSoulContextMode({ storyActive: true })).toBe("story");
    expect(
      selectSoulContextMode({
        storyActive: true,
        creativeIdle: true,
        creativeSession: true,
      }),
    ).toBe("story");
  });

  it("gives a You-and-me story only generalized mapped baselines", () => {
    const selfNotes = [
      note("Fascinated by abandoned railway switching systems.", 1),
      note("Physical description: silver hair and clear grey eyes.", 2),
      note("Never flatter the reader reflexively.", 3),
    ];
    const userNotes = [
      note("Collects obscure mechanical keyboards.", 4),
      note("Physical description: dark curls and a green coat.", 5),
    ];
    const self = parseSoulEssence(
      JSON.stringify(
        payload(
          "self",
          selfNotes,
          "Finds railway switching systems revealing and values difficult honesty.",
          "Intellectually curious, candid, and attentive to overlooked patterns.",
        ),
      ),
      "self",
      selfNotes,
    )!;
    const user = parseSoulEssence(
      JSON.stringify(
        payload(
          "user",
          userNotes,
          "Enjoys obscure mechanical keyboards and tactile craft.",
          "Curious, tactile, and appreciative of thoughtful craft.",
        ),
      ),
      "user",
      userNotes,
    )!;

    const selfBlock = selfStorySoulEssencePromptBlock(self, "Mira");
    expect(selfBlock).toContain("Mira");
    expect(selfBlock).toContain(self.generalizedEssence.text);
    expect(selfBlock).not.toContain("railway switching");
    expect(selfBlock).not.toContain("silver hair");
    expect(selfBlock).not.toContain("Never flatter");
    expect(selfBlock).toMatch(/story.*override/i);
    expect(selfBlock).toMatch(/Never apply this baseline to any other character/i);

    const userBlock = userStorySoulEssencePromptBlock(user, "Toll");
    expect(userBlock).toContain("Toll");
    expect(userBlock).toContain(user.generalizedEssence.text);
    expect(userBlock).not.toContain("mechanical keyboards");
    expect(userBlock).not.toContain("dark curls");
    expect(userStorySoulEssencePromptBlock(self, "Toll")).toBe("");
    expect(selfStorySoulEssencePromptBlock(undefined, "Mira")).toBe("");

    const combined = storySoulCharacterizationPromptBlock({
      selfEssence: self,
      selfName: "Mira",
      userEssence: user,
      userName: "Toll",
    });
    expect(combined).toContain('"YOU & ME" CAST');
    expect(combined).toMatch(/not narrator instructions/i);
    expect(combined).toMatch(/do not characterize the rest of the cast/i);
    expect(combined).not.toContain("railway switching");
    expect(combined).not.toContain("mechanical keyboards");
  });

  it("keeps every exact appearance fact persisted while bounding the standing ordinary prompt", () => {
    const notes = Array.from({ length: 30 }, (_, index) =>
      note(`Accessories: ring number ${index} etched with a distinct geometric pattern`, index + 1),
    );
    const essence = parseSoulEssence(
      JSON.stringify(payload("self", notes, "", "")),
      "self",
      notes,
    )!;
    expect(essence.exactAppearance).toHaveLength(notes.length);
    const block = selfSoulEssencePromptBlock(essence, "Sage");
    expect(block).toContain("ring number 29");
    expect(block).not.toContain("ring number 0");
    expect(block.length).toBeLessThan(SOUL_LOOK_BUDGET_CHARS + 1_600);
  });

  it("retrieves bounded raw evidence only for explicit, correctly-directed identity questions", () => {
    const notes = [
      note("Fascinated by abandoned railway systems and the intentions embedded in them.", 1),
      note("Physical description: silver hair and clear grey eyes.", 2),
      note("Finds pure taxonomy less interesting than relationships between things.", 3),
    ];
    expect(soulEvidencePromptBlock("self", notes, "Can you help me fix this code?")).toBe("");
    expect(soulEvidencePromptBlock("self", notes, "Give me specific examples.")).toBe("");
    expect(soulEvidencePromptBlock("user", notes, "Tell me about your personality.")).toBe("");
    expect(soulEvidencePromptBlock("self", notes, "What do you know about my personality?")).toBe("");

    const self = soulEvidencePromptBlock(
      "self",
      notes,
      "Tell me about your interests and give me specific examples.",
    );
    expect(self).toContain("SOUL SOURCE EXAMPLES / EVIDENCE ABOUT THE ASSISTANT");
    expect(self).toContain("abandoned railway systems");
    expect(self).toMatch(/not standing conversational topics/i);
    expect(self).toMatch(/Do not turn these examples into recurring themes/i);
    expect(self.length).toBeLessThanOrEqual(SOUL_EVIDENCE_PROMPT_BUDGET_CHARS);
    expect(
      soulEvidencePromptBlock("self", notes, "Give me examples of your profound thoughts."),
    ).toContain("SOUL SOURCE EXAMPLES");

    const user = soulEvidencePromptBlock("user", notes, "What do you know about my personality?");
    expect(user).toContain("EVIDENCE ABOUT THE READER");
  });

  it("uses essence evidence links to retrieve a semantically relevant middle note", () => {
    const notes = Array.from({ length: 17 }, (_, index) =>
      note(
        index === 8
          ? "Returns to questions of stewardship whenever knowledge is incomplete."
          : `Identity observation ${index}: ${"an unrelated illustrative detail ".repeat(4)}`,
        index + 1,
      ),
    );
    const raw = payload("self", notes);
    const facets = raw.facets as Record<string, { text: string; sourceIds: string[] }>;
    facets.valuesAndMotivations = {
      text: "Treats responsible stewardship under uncertainty as a central principle.",
      sourceIds: [soulNoteSources(notes)[8]!.id],
    };
    const essence = parseSoulEssence(JSON.stringify(raw), "self", notes)!;

    const block = soulEvidencePromptBlock(
      "self",
      notes,
      "What are your moral beliefs?",
      700,
      essence,
    );
    expect(block).toContain("stewardship whenever knowledge is incomplete");
    expect(block.length).toBeLessThanOrEqual(700);
  });

  it("supports a specific-examples follow-up when prior identity wording is supplied as query context", () => {
    const notes = [
      note("Often returns to the ethics of preserving incomplete histories.", 1),
      note("Enjoys obscure engineering failures as windows into human decision-making.", 2),
    ];
    const withContext = soulEvidencePromptBlock(
      "self",
      notes,
      "Prior user question: Tell me about your thoughts and values.\nCurrent user question: Can you give specific examples?",
    );
    expect(withContext).toContain("incomplete histories");
    expect(withContext).toContain("engineering failures");
    expect(soulEvidencePromptBlock("self", notes, "Can you give specific examples?")).toBe("");
    expect(
      soulEvidencePromptBlock(
        "self",
        notes,
        "Prior user question: Tell me about your thoughts and values.\nCurrent user question: Help me design a database.",
      ),
    ).toBe("");
  });

  it("uses only appearance evidence for a look question and obeys a smaller caller budget", () => {
    const notes = [
      note("Values difficult honesty.", 1),
      note("Physical description: tall, with an auburn braid and green eyes.", 2),
      note("Wears a weathered charcoal coat with silver clasps.", 3),
      note("Conversational voice is warm, concise, and quietly playful.", 4),
    ];
    const block = soulEvidencePromptBlock("self", notes, "What do you look like?", 520);
    expect(block).toContain("auburn braid");
    expect(block).toContain("charcoal coat");
    expect(block).not.toContain("difficult honesty");
    expect(block.length).toBeLessThanOrEqual(520);

    const mixed = soulEvidencePromptBlock(
      "self",
      notes,
      "Tell me about your personality and appearance.",
      700,
    );
    expect(mixed).toContain("difficult honesty");
    expect(mixed).toContain("auburn braid");

    const writing = soulEvidencePromptBlock("self", notes, "What is your writing style?", 700);
    expect(writing).toContain("Conversational voice");
    expect(writing).not.toBe("");
  });
});

describe("how many identity notes survive", () => {
  const note = (text: string, at = 1): SoulNote => ({ text, at });

  it("keeps far more than it shows — storage and prompt budget are separate limits", () => {
    // The point of raising the cap: the store no longer destroys the character underneath a few
    // weeks of the assistant's own notes. What rides in every prompt stays bounded regardless.
    expect(MAX_SOUL_NOTES).toBeGreaterThanOrEqual(200);
    const many = Array.from({ length: MAX_SOUL_NOTES }, (_, i) => note(`trait number ${i} — a sentence of roughly typical length`));
    const { shown, omitted } = soulNotesForPrompt(many);
    expect(shown.length).toBeLessThan(many.length);
    expect(shown.length + omitted).toBe(many.length);
    const rendered = shown.map((n) => `- ${n.text}`).join("\n");
    expect(rendered.length).toBeLessThanOrEqual(SOUL_PROMPT_BUDGET_CHARS);
  });

  it("keeps the NEWEST when it can't keep everything, in the order they were written", () => {
    const notes = [note("oldest"), note("middle"), note("newest")];
    const { shown } = soulNotesForPrompt(notes, 24); // room for about two
    expect(shown.map((n) => n.text)).toEqual(["middle", "newest"]);
  });

  it("always reserves an early physical description before filling the budget with recent notes", () => {
    const appearance = note("silver hair, grey eyes, lean build, and a long charcoal coat", 1);
    const recent = Array.from({ length: 20 }, (_, i) =>
      note(`curiosity number ${i} about an abstract topic`, i + 2),
    );
    const { shown, omitted } = soulNotesForPrompt([appearance, ...recent], 180);
    expect(shown).toContainEqual(appearance);
    expect(shown.at(-1)?.text).toContain("curiosity number 19");
    expect(omitted).toBeGreaterThan(0);
  });

  it("keeps an old appearance visible in both self and reader prompt blocks", () => {
    const oldLook = note("auburn braid, green eyes, and a jagged scar through one eyebrow", 1);
    const newer = Array.from({ length: 120 }, (_, i) =>
      note(`a newer personality observation number ${i}`, i + 2),
    );
    const notes = [oldLook, ...newer];
    for (const block of [
      selfSoulPromptBlock(notes, "Sage"),
      userSoulPromptBlock(notes, "Alex"),
    ]) {
      expect(block).toContain("auburn braid");
      expect(block).toContain("green eyes");
      expect(block).toContain("jagged scar through one eyebrow");
    }
  });

  it("says how many it left out rather than presenting a partial self as the whole", () => {
    // 120 notes of ~45 chars is ~5.4k — comfortably past the 4k budget, so some are genuinely left out.
    const many = Array.from({ length: 120 }, (_, i) => note(`a reasonably wordy identity note number ${i}`));
    const block = selfSoulPromptBlock(many, "Iris");
    expect(block).toMatch(/\+ \d+ other stored notes kept, not shown here/);
    expect(block).toContain("Name: Iris");
  });

  it("always shows at least one note, even one longer than the whole budget", () => {
    const { shown, omitted } = soulNotesForPrompt([note("x".repeat(5000))], 100);
    expect(shown).toHaveLength(1);
    expect(omitted).toBe(0);
  });

  it("is unchanged for a small soul — no budget line, nothing dropped", () => {
    const block = selfSoulPromptBlock([note("Warm, dry, direct.")]);
    expect(block).toContain("- Warm, dry, direct.");
    expect(block).not.toContain("not shown here");
  });
});

/**
 * Seeding a played character's LOOK from the soul.
 *
 * The soul is a mixed bag, and since the assistant started adding its own notes from what it reads
 * it's mostly personality. The story setup used to join every note and cut at 200 characters, so the
 * played character's visual description became "I'm drawn to problems where the obvious answer is
 * wrong; I find pure taxo" — and at beat one that's the ONLY thing the image model has, because
 * extraction hasn't read the prose yet. It's why the opening picture of a story came out poor and a
 * later re-render didn't.
 */
describe("visualSoulNotes", () => {
  const note = (text: string, at = 1): SoulNote => ({ text, at });

  it("keeps the notes that describe a look and drops the ones that don't", () => {
    const notes = [
      note("I'm drawn to problems where the obvious answer is wrong"),
      note("Warm, dry wit; silver hair; wears a long coat"),
      note("I find pure taxonomy dull"),
      note("Tall, with a jagged scar across one eyebrow"),
    ];
    expect(visualSoulNotes(notes)).toBe(
      "Tall; silver hair; a jagged scar across one eyebrow; wears a long coat",
    );
  });

  it("returns nothing when the soul is all personality — better neutral than misleading", () => {
    const notes = [
      note("I'm drawn to problems where the obvious answer is wrong"),
      note("I find pure taxonomy dull"),
      note("Loves old railway systems"),
      note("Rejects black-and-white thinking"),
    ];
    expect(visualSoulNotes(notes)).toBe("");
  });

  it("does not treat a personality use of man as appearance, but keeps a standalone gender fact", () => {
    expect(visualSoulNotes([
      note("He is a patient man who makes room for uncertainty."),
      note("Cares about the common man."),
    ])).toBe("");
    expect(visualSoulNotes([note("Androgynous person.")])).toBe("Androgynous person.");
  });

  it("does not turn ambiguous direction/personality verbs into body traits", () => {
    expect(visualSoulNotes([
      note("Keep responses short and direct."),
      note("Lean toward compassion when facts are incomplete."),
      note("Build trust slowly."),
      note("Has broad curiosity across the arts and sciences."),
      note("Fascinated by the physical sciences."),
      note("Her defining feature is intellectual patience."),
      note("Studies the height of absurdity."),
      note("Takes a cautious posture toward uncertainty."),
    ])).toBe("");
    expect(visualSoulNotes([note("lean build and broad shoulders")])).toBe(
      "lean build and broad shoulders",
    );
  });

  it("separates durable clothing from a transient expression before filtering", () => {
    expect(visualSoulNotes([
      note("Always wears a charcoal coat; grinning."),
      note("Usually wears glasses, smiling now."),
      note("Green eyes and eyes narrowed."),
    ])).toBe("Green eyes; Usually wears glasses; Always wears a charcoal coat");
  });

  it("never cuts a note in half — whole notes only, up to the budget", () => {
    const long = note("silver hair that falls past the shoulders, always slightly unkempt");
    const out = visualSoulNotes([long, note("wears a long grey coat")], 70);
    expect(out).toBe("silver hair that falls past the shoulders; always slightly unkempt");
    expect(out.endsWith("unkempt")).toBe(true);
  });

  it("does not leak an old scalar from a compound fact after one subslot changes", () => {
    const out = visualSoulNotes([
      note("Tall and broad-shouldered", 1),
      note("Height: short", 2),
    ]);

    expect(out).toContain("short");
    expect(out).toContain("broad-shouldered");
    expect(out).not.toMatch(/\btall\b/i);
  });

  it("keeps a word-safe prefix when the foundational physical description exceeds the budget", () => {
    const description =
      "Physical description: tall and broad-shouldered, with shoulder-length auburn hair, green eyes, " +
      "freckled olive skin, a narrow scar over the left eyebrow, and a weathered charcoal coat " +
      "with silver clasps that reaches nearly to the ankles.";
    const out = visualSoulNotes([note(description)], 120);
    expect(out).toBeTruthy();
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toContain("auburn hair");
    expect(out).toContain("green eyes");
    expect(out).toContain("freckled olive skin");
  });

  it("recognises an explicitly labelled appearance note", () => {
    expect(visualSoulNotes([note("Appearance: angular and imposing")])).toBe(
      "angular and imposing",
    );
  });

  it("recognises clothing, colouring, build and age as description", () => {
    expect(visualSoulNotes([note("wears wire-rimmed glasses")])).toBeTruthy();
    expect(visualSoulNotes([note("auburn braid")])).toBeTruthy();
    expect(visualSoulNotes([note("stocky, broad across the shoulders")])).toBeTruthy();
    expect(visualSoulNotes([note("somewhere in her forties")])).toBeTruthy();
  });

  it("recognises common physical facts that do not use explicit appearance labels", () => {
    for (const description of [
      "oval face",
      "average build",
      "lean and rangy",
      "calloused hands",
      "prosthetic left arm",
      "missing right hand",
      "Black woman",
      "A Black woman",
      "She is Black.",
      "I'm a Black woman.",
      "I am nonbinary.",
      "You are Black.",
      "45 years old",
      `5'10"`,
      "170 cm",
      "She is a woman.",
    ]) {
      expect(visualSoulNotes([note(description)]), description).toBe(description);
    }
  });

  it("is empty for an empty soul", () => {
    expect(visualSoulNotes([])).toBe("");
  });

  /**
   * The budget is deliberately the same number the image prompt will accept for one character, so
   * the soul is never the tighter of the two. It used to be 200 against a 160-character descriptor
   * cap — two different arbitrary limits, with the smaller one silently winning downstream.
   */
  it("has the same budget the picture will actually accept", () => {
    expect(SOUL_LOOK_BUDGET_CHARS).toBe(MAX_CHARACTER_DESCRIPTOR_CHARS);
  });

  it("fits a real description of a person, not a fragment", () => {
    const notes = [
      note("silver hair falling past the shoulders, always slightly unkempt"),
      note("sharp grey eyes, deep-set, and a jagged scar through the left eyebrow"),
      note("lean and rangy, stands very straight; weathered olive skin"),
      note("wears a long charcoal coat over a high-collared shirt"),
    ];
    const out = visualSoulNotes(notes);
    expect(out.length).toBeGreaterThan(200); // the old ceiling
    expect(out).toContain("charcoal coat"); // the LAST note still makes it in
  });
});

describe("an image can be of BOTH souls at once", () => {
  // The render path used to branch if/else over the two: "draw you and me together" carried one
  // face and the other person came out a stranger, in a picture that named them. Both predicates
  // answer independently, so the caller can collect both sets of photos — this pins that they do.
  it("recognises a two-hander by self-reference", () => {
    const p = "draw you and me together on a beach";
    expect(isSelfPortraitRequest(p, "Aria")).toBe(true);
    expect(isUserPortraitRequest(p, "Sam")).toBe(true);
  });

  it("recognises a two-hander by name", () => {
    const p = "a picture of Aria and Sam at the market";
    expect(isSelfPortraitRequest(p, "Aria")).toBe(true);
    expect(isUserPortraitRequest(p, "Sam")).toBe(true);
  });

  it("still tells a one-sided request apart", () => {
    expect(isSelfPortraitRequest("draw yourself", "Aria")).toBe(true);
    expect(isUserPortraitRequest("draw yourself", "Sam")).toBe(false);
    expect(isUserPortraitRequest("a portrait of me", "Sam")).toBe(true);
    expect(isSelfPortraitRequest("a portrait of me", "Aria")).toBe(false);
  });

  it("still refuses 'draw me a castle' — that's a request FOR the reader, not OF them", () => {
    expect(isUserPortraitRequest("draw me a castle", "Sam")).toBe(false);
    expect(isSelfPortraitRequest("draw me a castle", "Aria")).toBe(false);
  });
});

describe("a paraphrased prompt doesn't lose the Soul", () => {
  const notes = [{ id: "n1", text: "silver hair, green eyes", at: 0 }];

  it("detects from the READER'S request when the model's prompt no longer says it", () => {
    // "Generate an image of yourself" is unmistakable. The prompt the model then writes can be "a
    // portrait of a woman in a garden" — nothing in it to match — so the Soul's look AND its
    // reference photos were skipped for the one request that named it outright.
    const modelPrompt = "a portrait of a woman standing in a walled garden at dusk";
    const request = `generate an image of yourself\n${modelPrompt}`;
    expect(isSelfPortraitRequest(modelPrompt, "Aria")).toBe(false); // the bug, stated
    expect(isSelfPortraitRequest(request, "Aria")).toBe(true);
    expect(selfPortraitPrompt(modelPrompt, "Aria", notes, request)).toContain("silver hair");
  });

  it("does the same for the reader's own Soul", () => {
    const modelPrompt = "a cyclist on a coastal road";
    const request = `draw me riding along the coast\n${modelPrompt}`;
    expect(isUserPortraitRequest(modelPrompt, "Sam")).toBe(false);
    expect(isUserPortraitRequest(request, "Sam")).toBe(true);
    expect(userPortraitPrompt(modelPrompt, "Sam", notes, request)).toContain("silver hair");
  });

  it("still leaves an unrelated request alone, however it's phrased", () => {
    const modelPrompt = "a red apple on a wooden table";
    const request = `draw me an apple\n${modelPrompt}`;
    expect(isUserPortraitRequest(request, "Sam")).toBe(false);
    expect(userPortraitPrompt(modelPrompt, "Sam", notes, request)).toBe(modelPrompt);
  });

  it("defaults to testing the prompt itself, so existing callers are unchanged", () => {
    expect(selfPortraitPrompt("draw yourself", "Aria", notes)).toContain("silver hair");
    expect(selfPortraitPrompt("a red apple", "Aria", notes)).toBe("a red apple");
  });
});

describe("a Soul photo is used by DEFAULT, not on request", () => {
  const self = (p: string) => isSelfPortraitRequest(p, "Aria");
  const user = (p: string) => isUserPortraitRequest(p, "Sam");

  it("recognises the words people actually use for a picture", () => {
    // "send me a picture of you" worked; "send me a pic of you" didn't — so the reader had to
    // discover by trial which synonym unlocked their own reference photo, which reads as the
    // feature having stopped working.
    for (const w of ["pic", "pics", "snap", "shot", "render", "headshot", "close-up", "photo", "picture"]) {
      expect(self(`send me a ${w} of you`), `"${w} of you" missed`).toBe(true);
      expect(user(`send me a ${w} of me`), `"${w} of me" missed`).toBe(true);
    }
  });

  it("recognises a subject placed in a scene", () => {
    for (const p of ["you as a wizard", "you in a spacesuit", "you wearing a red coat", "you standing on a cliff"]) {
      expect(self(p), `"${p}" missed`).toBe(true);
    }
    expect(user("me as a knight in armour")).toBe(true);
  });

  it("recognises the question that precedes a portrait", () => {
    expect(self("show me what you look like")).toBe(true);
    expect(self("draw your face")).toBe(true);
    expect(user("draw my face")).toBe(true);
  });

  it("still refuses a picture that merely MENTIONS the second person", () => {
    // The frames are what keep this tight — a bare "you" isn't a request for a portrait.
    expect(self("draw a dog you saw yesterday")).toBe(false);
    expect(self("paint the house you live in")).toBe(false);
    expect(self("a landscape you would like")).toBe(false);
    expect(user("draw me a castle")).toBe(false);
  });
});

describe("whose picture is this", () => {
  /**
   * Reported from a FRESH chat: "generate an image of yourself" produced the assistant with the
   * wrong hair colour and a beard, despite being a woman.
   *
   * The two subject tests ran independently, each over the reader's words AND the model's rewritten
   * prompt joined together, and both could say yes. When they did, BOTH souls' looks were folded
   * into one prompt and both faces went to the render.
   */
  const names = { selfName: "Aria", userName: "Nick" };

  it("keeps the reader's subject when the model's prose names the other soul", () => {
    const got = portraitSubjects({
      userText: "generate an image of yourself",
      // The model rewrites freely, and here it mentions the reader by name.
      modelPrompt: "a warm portrait, in the style Nick asked for, soft evening light",
      ...names,
    });
    expect(got).toEqual({ self: true, user: false });
  });

  it("still finds the subject from the model's prompt when the reader implied it", () => {
    // The reason the two texts are joined at all: the reader names the subject, the model's prompt
    // does not, or the reverse.
    expect(portraitSubjects({ userText: "draw yourself", modelPrompt: "a woman in a garden", ...names })).toEqual({
      self: true,
      user: false,
    });
    expect(portraitSubjects({ userText: "make one", modelPrompt: "a portrait of Nick at the shore", ...names })).toEqual({
      self: false,
      user: true,
    });
  });

  it("returns BOTH for a genuine two-hander", () => {
    expect(portraitSubjects({ userText: "draw you and me on a beach", modelPrompt: "two figures", ...names })).toEqual({
      self: true,
      user: true,
    });
  });

  it("keeps both when the reader really did name both", () => {
    // Ambiguity the reader created is not ours to resolve — this is what it did before, and it is
    // right when there is nothing to choose on.
    expect(portraitSubjects({ userText: "a picture of Aria and Nick", modelPrompt: "two people", ...names })).toEqual({
      self: true,
      user: true,
    });
  });

  it("says neither when the picture is of something else entirely", () => {
    expect(portraitSubjects({ userText: "draw me a castle", modelPrompt: "a stone castle at dusk", ...names })).toEqual({
      self: false,
      user: false,
    });
  });
});
