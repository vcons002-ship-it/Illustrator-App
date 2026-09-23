import { describe, expect, it } from "vitest";
import {
  buildSoulAppearanceClassificationPrompt,
  parseSoulAppearanceVerdicts,
  reconcileSoulAppearance,
  soulAppearanceClassificationJsonSchema,
  soulNoteSources,
  type SoulNote,
} from "./souls.js";

/**
 * SELECTION AND TRANSCRIPTION ARE TWO DIFFERENT JOBS.
 *
 * Appearance text is copied verbatim by code and always will be: rewriting "auburn hair" as
 * "reddish-brown" is corruption the reader cannot see. But deciding WHICH notes are about a body is
 * a judgement, and a word test cannot make it — it files "a conversion factor wearing a constant's
 * coat" under clothing because the word `coat` occurred.
 *
 * So the model answers the judgement and nothing else: it returns pointers, code does the copying.
 */
describe("the model selects, code transcribes", () => {
  // Short, so the word test reads it as a descriptor phrase; `scar` is in the vocabulary; and it is
  // a metaphor about a decision. Grammar cannot separate this from "A chin scar." — only meaning can.
  const metaphor = "The scar of that decision.";
  const real = "Auburn hair, past the shoulders.";
  const notes: SoulNote[] = [
    { at: 1, text: metaphor },
    { at: 2, text: real },
  ];
  const [metaphorId, realId] = soulNoteSources(notes).map((s) => s.id) as [string, string];

  it("asks only for IDs, and hands over every note to judge", () => {
    const prompt = buildSoulAppearanceClassificationPrompt("self", notes);
    expect(prompt.sourceIds).toEqual([metaphorId, realId]);
    // Both notes are offered — unlike the distillation prompt, which sees only the residue.
    expect(prompt.user).toContain("scar of that decision");
    expect(prompt.user).toContain("Auburn hair");
    expect(prompt.system).toContain("Answer with IDs only.");
    // The instruction is about the SUBJECT of the sentence, because vocabulary is what already fails.
    expect(prompt.system).toContain("Judge the SUBJECT of the sentence, not the words in it");
  });

  it("constrains the answer to IDs the model was given, so it cannot invent one", () => {
    const schema = soulAppearanceClassificationJsonSchema([metaphorId, realId]);
    const props = (schema as { properties: Record<string, { items: { enum?: string[] } }> }).properties;
    expect(props.appearanceSourceIds!.items.enum).toEqual([metaphorId, realId]);
    expect(props.otherSourceIds!.items.enum).toEqual([metaphorId, realId]);
  });

  it("overrides the word test DOWNWARD — the direction it could never reach alone", () => {
    // On its own the word test files the metaphor as a distinguishing mark: `scar` is in the text
    // and the note is short enough to read as a descriptor phrase. Both facts are true; the reading
    // is still wrong, and no amount of grammar around the word fixes it.
    expect(reconcileSoulAppearance(notes).activeFacts.map((f) => f.text).join(" ")).toContain("scar");
    const judged = reconcileSoulAppearance(notes, { [metaphorId]: false, [realId]: true });
    const text = judged.activeFacts.map((f) => f.text).join(" ");
    expect(text).not.toContain("scar");
    expect(text).toContain("uburn");
    // Demoted, not deleted: it becomes residue for the personality distillation.
    expect(judged.nonVisualTextBySourceId[metaphorId]).toContain("decision");
  });

  it("overrides UPWARD too, rescuing a description buried in prose", () => {
    // A real physical fact carried by one word in thirty. The word test needs a note to READ as a
    // description — short, or dense in appearance words — and this is neither, so it loses both of
    // these outright. A verdict puts them back.
    for (const [text, kept] of [
      [
        "After the accident in the summer of 2019, and following months of reconstructive work she rarely discusses with anyone, there is now a scar.",
        "scar",
      ],
      [
        "Over many years of working outdoors in all weather and rarely bothering with a hat of any kind, the hair has gone almost entirely silver.",
        "silver",
      ],
    ] as const) {
      const buried: SoulNote[] = [{ at: 1, text }];
      const [id] = soulNoteSources(buried).map((s) => s.id) as [string];
      expect(reconcileSoulAppearance(buried).activeFacts, text).toEqual([]);
      const rescued = reconcileSoulAppearance(buried, { [id]: true }).activeFacts;
      expect(rescued.map((f) => f.text).join(" "), text).toContain(kept);
    }
  });

  it("copies the wording from the note, never from the model", () => {
    // The model is never asked for prose, so there is no path by which a paraphrase could arrive:
    // the fact text is a span of the authoritative note.
    const facts = reconcileSoulAppearance(notes, { [metaphorId]: false, [realId]: true }).activeFacts;
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) expect(real.toLowerCase()).toContain(fact.text.toLowerCase());
  });
});

describe("reading the classification answer", () => {
  const ids = ["sn_a", "sn_b", "sn_c"];

  it("takes a clean answer", () => {
    expect(
      parseSoulAppearanceVerdicts('{"appearanceSourceIds":["sn_a"],"otherSourceIds":["sn_b"]}', ids),
    ).toEqual({ sn_b: false, sn_a: true });
  });

  it("tolerates the envelope a small local model actually produces", () => {
    const fenced = '```json\n{"appearanceSourceIds":["sn_a"],"otherSourceIds":["sn_b"],}\n```';
    expect(parseSoulAppearanceVerdicts(fenced, ids)).toEqual({ sn_b: false, sn_a: true });
  });

  it("drops an invented ID instead of failing the whole pass", () => {
    // A hallucinated ID cannot name a real note, so it can do no harm — and losing the answer over
    // one would send every note back to the word test.
    expect(
      parseSoulAppearanceVerdicts('{"appearanceSourceIds":["sn_a","sn_zzz"],"otherSourceIds":[]}', ids),
    ).toEqual({ sn_a: true });
  });

  it("leaves a contradicted note unjudged rather than guessing", () => {
    const both = '{"appearanceSourceIds":["sn_a","sn_b"],"otherSourceIds":["sn_b"]}';
    expect(parseSoulAppearanceVerdicts(both, ids)).toEqual({ sn_a: true });
  });

  it("leaves a note it never mentioned unjudged, so the word test still answers for it", () => {
    const partial = parseSoulAppearanceVerdicts('{"appearanceSourceIds":["sn_a"],"otherSourceIds":[]}', ids);
    expect(partial).toEqual({ sn_a: true });
    expect(partial && "sn_c" in partial).toBe(false);
  });

  it("distinguishes an unusable answer from an answer of 'none of them'", () => {
    expect(parseSoulAppearanceVerdicts("not json at all", ids)).toBeUndefined();
    expect(parseSoulAppearanceVerdicts('{"wrong":"shape"}', ids)).toBeUndefined();
    // An explicit "none are appearance" is a real answer and must not be read as silence.
    expect(parseSoulAppearanceVerdicts('{"appearanceSourceIds":[],"otherSourceIds":["sn_a"]}', ids)).toEqual({
      sn_a: false,
    });
  });
});
