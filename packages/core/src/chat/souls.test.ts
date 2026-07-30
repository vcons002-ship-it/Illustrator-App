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
  SOUL_ESSENCE_FACETS,
  SELF_SOUL_ESSENCE_KEY,
  ABOUT_YOU_SOUL_ESSENCE_KEY,
  soulNoteSources,
  soulSourceFingerprint,
  partitionSoulNotes,
  buildSoulEssenceDistillationPrompt,
  buildSoulEssenceMergePrompt,
  parseSoulEssence,
  parseSoulEssenceMerge,
  validateSoulEssence,
  loadSoulEssence,
  saveSoulEssence,
  clearSoulEssence,
  selfSoulEssencePromptBlock,
  userSoulEssencePromptBlock,
  soulEvidencePromptBlock,
  SOUL_EVIDENCE_PROMPT_BUDGET_CHARS,
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
    expect(out).toContain("silver hair, grey eyes, and a long charcoal coat");
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

  it("builds a strict distillation request grounded in every current note", () => {
    const notes = [
      note("Fascinated by abandoned railway systems.", 1),
      note("Physical description: silver hair, grey eyes, and a long charcoal coat.", 2),
      note("Values candour more than easy agreement.", 3),
    ];
    const built = buildSoulEssenceDistillationPrompt("self", notes);
    expect(built.sourceFingerprint).toBe(soulSourceFingerprint(notes));
    expect(built.system).toMatch(/strict JSON only/i);
    expect(built.system).toMatch(/do not make their specific examples into recurring topics/i);
    expect(built.system).toMatch(/Every non-empty facet must cite/i);
    expect(built.system).toContain("exactAppearance");
    expect(built.system).toMatch(/exactAppearance as an empty array/i);
    expect(built.system).toMatch(/personalityDirections with empty text and sourceIds/i);
    expect(built.user).not.toContain("Sage");
    for (const source of soulNoteSources(notes)) {
      expect(built.user).toContain(source.id);
      expect(built.user).toContain(source.text);
    }
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
    // The model omitted exactAppearance, but deterministic source selection keeps the old look.
    expect(result?.exactAppearance).toEqual([
      {
        text: notes[0]!.text,
        sourceIds: [soulNoteSources(notes)[0]!.id],
      },
    ]);
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
    expect(valid?.exactAppearance[0]?.text).toBe("silver hair and grey eyes");
    expect(valid?.exactAppearance[0]?.text).not.toMatch(/grin/i);
    const store = new InMemoryStore();
    await expect(saveSoulEssence(store, "self", valid!, notes)).resolves.toBeTruthy();
    expect(await loadSoulEssence(store, "self", notes)).toEqual(
      expect.objectContaining({ exactAppearance: valid!.exactAppearance }),
    );
  });

  it("merges evidence IDs when distinct appearance notes reduce to the same durable clause", () => {
    const notes = [
      note("silver hair; smiling", 1),
      note("silver hair; grinning", 2),
    ];
    const raw = payload("self", notes, "");
    const parsed = parseSoulEssence(JSON.stringify(raw), "self", notes)!;
    expect(parsed.exactAppearance).toEqual([
      {
        text: "silver hair",
        sourceIds: soulNoteSources(notes).map((source) => source.id),
      },
    ]);
  });

  it("never promotes colour metaphors, old interests, or mixed personality clauses into appearance", () => {
    const notes = [
      note("Loves old railway systems and their forgotten histories.", 1),
      note("Rejects black-and-white thinking in moral questions.", 2),
      note("Physical description: silver hair and grey eyes; values difficult honesty.", 3),
    ];
    const valid = parseSoulEssence(JSON.stringify(payload("self", notes)), "self", notes);
    expect(valid?.exactAppearance.map((fact) => fact.text)).toEqual([
      "Physical description: silver hair and grey eyes",
    ]);
    expect(valid?.exactAppearance.map((fact) => fact.text).join(" ")).not.toMatch(
      /railway|black-and-white|honesty/i,
    );
  });

  it("persists separate current essences and invalidates them when authoritative notes change", async () => {
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

    await expect(
      saveSoulEssence(store, "self", { ...self, sourceFingerprint: "stale" }, selfNotes),
    ).rejects.toThrow(/stale or invalid/);
    expect(validateSoulEssence({ ...self, sourceFingerprint: "stale" }, "self", selfNotes)).toBeUndefined();

    await clearSoulEssence(store, "self");
    expect(await store.getMemo(SELF_SOUL_ESSENCE_KEY)).toBeUndefined();
    expect(await store.getMemo(ABOUT_YOU_SOUL_ESSENCE_KEY)).toBeTruthy();

    await saveSoulEssence(store, "self", self, selfNotes);
    await saveSoul(store, "self", selfNotes);
    expect(await store.getMemo(SELF_SOUL_ESSENCE_KEY)).toBeUndefined();
  });

  it("does not report a failed note save when best-effort stale-essence deletion fails", async () => {
    class DeleteFailingStore extends InMemoryStore {
      override async deleteMemo(key: string): Promise<void> {
        if (key === SELF_SOUL_ESSENCE_KEY) throw new Error("storage cleanup failed");
        await super.deleteMemo(key);
      }
    }
    const store = new DeleteFailingStore();
    const oldNotes = [note("Patient and precise.", 1)];
    const oldEssence = parseSoulEssence(
      JSON.stringify(payload("self", oldNotes)),
      "self",
      oldNotes,
      10,
    )!;
    await saveSoulEssence(store, "self", oldEssence, oldNotes);

    const newNotes = [note("Patient, precise, and newly playful.", 2)];
    await expect(saveSoul(store, "self", newNotes)).resolves.toEqual(newNotes);
    expect(await loadSoul(store, "self")).toEqual(newNotes);
    expect(await store.getMemo(SELF_SOUL_ESSENCE_KEY)).toBeTruthy(); // deletion really did fail
    expect(await loadSoulEssence(store, "self", newNotes)).toBeUndefined(); // fingerprint is the guard
    await expect(rememberSoul(store, "self", "Fond of dry humour.")).resolves.toHaveLength(2);
    await expect(forgetSoul(store, "self", "dry humour")).resolves.toHaveLength(1);
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
    );
    const self = parseSoulEssence(JSON.stringify(raw), "self", notes, 1)!;
    const block = selfSoulEssencePromptBlock(self, "Sage");
    expect(block).toContain("Name: Sage");
    expect(block).toContain("Drawn to overlooked structures");
    expect(block).toContain(notes[1]!.text); // exact appearance is never summarised away
    expect(block).not.toContain("abandoned railway systems");
    expect(block).toMatch(/Embody this silently/i);
    expect(block).toMatch(/Do not steer unrelated conversation/i);
    expect(block).toMatch(/only when the reader asks/i);
    expect(selfSoulEssencePromptBlock(undefined, "Sage")).toBe("");

    const userRaw = payload("user", notes, "Values overlooked structures and careful interpretation.");
    const user = parseSoulEssence(JSON.stringify(userRaw), "user", notes, 2)!;
    const userBlock = userSoulEssencePromptBlock(user, "Alex");
    expect(userBlock).toContain("WHO THE READER IS");
    expect(userBlock).toMatch(/inform your understanding silently/i);
    expect(userBlock).toMatch(/Do not steer unrelated conversation/i);
    expect(userSoulEssencePromptBlock(self, "Alex")).toBe("");
  });

  it("keeps every exact appearance fact persisted while bounding the standing ordinary prompt", () => {
    const notes = Array.from({ length: 30 }, (_, index) =>
      note(`Appearance detail ${index}: a distinct scar beside the left eyebrow`, index + 1),
    );
    const essence = parseSoulEssence(JSON.stringify(payload("self", notes)), "self", notes)!;
    expect(essence.exactAppearance).toHaveLength(notes.length);
    const block = selfSoulEssencePromptBlock(essence, "Sage");
    expect(block).toContain("Appearance detail 0");
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
    expect(selfSoulPromptBlock(notes, "Sage")).toContain(oldLook.text);
    expect(userSoulPromptBlock(notes, "Alex")).toContain(oldLook.text);
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
      "silver hair; wears a long coat; Tall, with a jagged scar across one eyebrow",
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
    ])).toBe("Always wears a charcoal coat; Usually wears glasses; Green eyes");
  });

  it("never cuts a note in half — whole notes only, up to the budget", () => {
    const long = note("silver hair that falls past the shoulders, always slightly unkempt");
    const out = visualSoulNotes([long, note("wears a long grey coat")], 70);
    expect(out).toBe(long.text); // the second didn't fit, so it isn't there at all
    expect(out.endsWith("unkempt")).toBe(true);
  });

  it("keeps a word-safe prefix when the foundational physical description exceeds the budget", () => {
    const description =
      "Physical description: tall and broad-shouldered, with shoulder-length auburn hair, green eyes, " +
      "freckled olive skin, a narrow scar over the left eyebrow, and a weathered charcoal coat " +
      "with silver clasps that reaches nearly to the ankles.";
    const out = visualSoulNotes([note(description)], 120);
    expect(out).toBeTruthy();
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toContain("Physical description");
    expect(out).toContain("auburn hair");
    expect(description.startsWith(out)).toBe(true);
  });

  it("recognises an explicitly labelled appearance note", () => {
    expect(visualSoulNotes([note("Appearance: angular and imposing")])).toBe(
      "Appearance: angular and imposing",
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
