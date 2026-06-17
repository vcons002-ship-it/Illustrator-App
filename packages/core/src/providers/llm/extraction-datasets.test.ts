import { describe, expect, it } from "vitest";
import { EXTRACTION_JSON_SCHEMA, mergeExtraction, type RawExtraction } from "./extraction.js";
import { CLAUDE_EXTRACTION_SCHEMA } from "./claude-provider.js";
import { parseExtraction } from "./webllm-provider.js";
import { createEmptyBible, migrateBible, BIBLE_VERSION } from "../../visual-bible/bible.js";

/** Minimal raw extraction carrying only datasets. */
function rawWith(datasets: RawExtraction["datasets"]): RawExtraction {
  return { characters: [], environments: [], spoilers: [], ...(datasets ? { datasets } : {}) };
}

const series = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ label: `s${i}`, y: i * 10 }));

describe("mergeExtraction infographics", () => {
  it("stores flowchart/summary/diagram and drops malformed ones", () => {
    const raw: RawExtraction = {
      characters: [],
      environments: [],
      spoilers: [],
      infographics: [
        { kind: "flowchart", title: "Glycolysis", anchor: "glucose", bullets: [], nodes: [{ id: "a", label: "Glucose", shape: "start" }, { id: "b", label: "G6P", shape: "step" }], edges: [{ from: "a", to: "b", label: "" }], parts: [], caption: "" },
        { kind: "summary", title: "Key points", anchor: "", bullets: ["one", "two"], nodes: [], edges: [], parts: [], caption: "" },
        { kind: "diagram", title: "Cell parts", anchor: "", bullets: [], nodes: [], edges: [], parts: [{ label: "Nucleus", note: "DNA" }], caption: "a cell" },
        { kind: "flowchart", title: "Too small", anchor: "", bullets: [], nodes: [{ id: "x", label: "only", shape: "step" }], edges: [], parts: [], caption: "" },
      ],
    };
    const bible = mergeExtraction(createEmptyBible("b"), raw, 0);
    expect(bible.infographics!.map((g) => g.spec.kind)).toEqual(["flowchart", "summary", "diagram"]);
    const fc = bible.infographics![0]!.spec;
    expect(fc.kind === "flowchart" && fc.nodes).toHaveLength(2);
  });

  it("re-running a chapter replaces its infographics", () => {
    const raw1: RawExtraction = { characters: [], environments: [], spoilers: [], infographics: [{ kind: "summary", title: "A", anchor: "", bullets: ["x"], nodes: [], edges: [], parts: [], caption: "" }] };
    const raw2: RawExtraction = { characters: [], environments: [], spoilers: [], infographics: [{ kind: "summary", title: "B", anchor: "", bullets: ["y"], nodes: [], edges: [], parts: [], caption: "" }] };
    const once = mergeExtraction(createEmptyBible("b"), raw1, 0);
    const twice = mergeExtraction(once, raw2, 0);
    expect(twice.infographics!.map((g) => g.title)).toEqual(["B"]);
  });
});

describe("mergeExtraction datasets", () => {
  it("stores a chapter's datasets on the bible with a stable id", () => {
    const bible = mergeExtraction(
      createEmptyBible("b"),
      rawWith([
        {
          title: "ATP yield per stage",
          unit: "ATP",
          xLabel: "stage",
          yLabel: "molecules",
          kind: "bar",
          points: series(3),
          source: "table 2",
        },
      ]),
      2,
    );
    expect(bible.datasets).toHaveLength(1);
    const d = bible.datasets![0]!;
    expect(d.id).toBe("data-2-atp-yield-per-stage");
    expect(d.chapterIndex).toBe(2);
    expect(d.kind).toBe("bar");
    expect(d.points).toHaveLength(3);
  });

  it("re-running a chapter REPLACES its datasets (idempotent, no duplicates)", () => {
    const once = mergeExtraction(
      createEmptyBible("b"),
      rawWith([{ title: "A", unit: "", xLabel: "", yLabel: "", kind: "bar", points: series(3) }]),
      0,
    );
    const twice = mergeExtraction(
      once,
      rawWith([{ title: "B", unit: "", xLabel: "", yLabel: "", kind: "line", points: series(4) }]),
      0,
    );
    expect(twice.datasets!.map((d) => d.title)).toEqual(["B"]);
  });

  it("keeps other chapters' datasets when one chapter re-runs", () => {
    const ch0 = mergeExtraction(
      createEmptyBible("b"),
      rawWith([{ title: "A", unit: "", xLabel: "", yLabel: "", kind: "bar", points: series(3) }]),
      0,
    );
    const ch1 = mergeExtraction(
      ch0,
      rawWith([{ title: "B", unit: "", xLabel: "", yLabel: "", kind: "bar", points: series(3) }]),
      1,
    );
    expect(ch1.datasets!.map((d) => [d.chapterIndex, d.title])).toEqual([
      [0, "A"],
      [1, "B"],
    ]);
  });

  it("drops series with fewer than 2 finite points and coerces unknown kinds to bar", () => {
    const bible = mergeExtraction(
      createEmptyBible("b"),
      rawWith([
        { title: "Too thin", unit: "", xLabel: "", yLabel: "", kind: "bar", points: series(1) },
        {
          title: "Weird kind",
          unit: "",
          xLabel: "",
          yLabel: "",
          kind: "pie",
          points: series(3),
        },
      ]),
      0,
    );
    expect(bible.datasets!.map((d) => d.title)).toEqual(["Weird kind"]);
    expect(bible.datasets![0]!.kind).toBe("bar");
  });

  it("drops a positional x (echoing the index) but keeps a real numeric x", () => {
    const positional = mergeExtraction(
      createEmptyBible("b"),
      rawWith([
        {
          title: "Echoed index",
          unit: "",
          xLabel: "",
          yLabel: "",
          kind: "line",
          points: [
            { label: "a", x: 0, y: 1 },
            { label: "b", x: 1, y: 2 },
          ],
        },
      ]),
      0,
    );
    expect(positional.datasets![0]!.points.every((p) => p.x === undefined)).toBe(true);

    const realX = mergeExtraction(
      createEmptyBible("b"),
      rawWith([
        {
          title: "Years",
          unit: "",
          xLabel: "year",
          yLabel: "",
          kind: "line",
          points: [
            { label: "2010", x: 2010, y: 1 },
            { label: "2020", x: 2020, y: 2 },
          ],
        },
      ]),
      0,
    );
    expect(realX.datasets![0]!.points.map((p) => p.x)).toEqual([2010, 2020]);
  });

  it("leaves datasets untouched for a fiction extraction that has none", () => {
    const prior = mergeExtraction(
      createEmptyBible("b"),
      rawWith([{ title: "A", unit: "", xLabel: "", yLabel: "", kind: "bar", points: series(3) }]),
      0,
    );
    const after = mergeExtraction(prior, rawWith(undefined), 1);
    expect(after.datasets).toHaveLength(1);
  });
});

describe("extraction schema parity (the four mirrors must not drift)", () => {
  it("Claude's Zod schema and EXTRACTION_JSON_SCHEMA share the same top-level keys", () => {
    const zodKeys = Object.keys(CLAUDE_EXTRACTION_SCHEMA.shape).sort();
    const jsonKeys = Object.keys(EXTRACTION_JSON_SCHEMA.properties).sort();
    expect(zodKeys).toEqual(jsonKeys);
  });

  it("every JSON-schema property is required (strict-mode providers demand it)", () => {
    expect([...EXTRACTION_JSON_SCHEMA.required].sort()).toEqual(
      Object.keys(EXTRACTION_JSON_SCHEMA.properties).sort(),
    );
  });
});

describe("parseExtraction datasets (local models)", () => {
  it("parses datasets with tolerant numeric coercion", () => {
    const raw = parseExtraction(
      JSON.stringify({
        characters: [],
        glossary: [],
        environments: [],
        creatures: [],
        spoilers: [],
        summary: "s",
        keyMoment: "k",
        location: "",
        locationChange: "",
        keyEvents: [],
        worldStyle: "clean scientific",
        datasets: [
          {
            title: "T",
            unit: "%",
            xLabel: "x",
            yLabel: "y",
            kind: "line",
            points: [
              { label: "a", x: 1, y: "2.5" },
              { label: "b", x: 2, y: 3 },
            ],
            source: "fig 1",
          },
        ],
      }),
    );
    expect(raw.worldStyle).toBe("clean scientific");
    expect(raw.datasets).toHaveLength(1);
    expect(raw.datasets![0]!.points.map((p) => p.y)).toEqual([2.5, 3]);
  });

  it("tolerates a missing datasets field", () => {
    const raw = parseExtraction(
      '{"characters":[],"glossary":[],"environments":[],"spoilers":[]}',
    );
    expect(raw.datasets).toEqual([]);
  });
});

describe("bible v8 migration", () => {
  it("v7 → v8 is additive: entities kept, empty datasets added", () => {
    const v7 = { ...createEmptyBible("b"), version: 7 };
    delete (v7 as { datasets?: unknown }).datasets;
    v7.glossary.push({ term: "ATP", definition: "energy currency" });
    const m = migrateBible(v7)!;
    expect(m.version).toBe(BIBLE_VERSION);
    expect(m.glossary).toHaveLength(1);
    expect(m.datasets).toEqual([]);
  });

  it("v5/v6 chain through to v8 with datasets defaulted", () => {
    const v5 = { ...createEmptyBible("b"), version: 5 };
    delete (v5 as { datasets?: unknown }).datasets;
    const m = migrateBible(v5)!;
    expect(m.version).toBe(BIBLE_VERSION);
    expect(m.datasets).toEqual([]);
  });

  it("a fresh bible is at the current version with empty datasets + infographics", () => {
    const b = createEmptyBible("b");
    expect(b.version).toBe(BIBLE_VERSION);
    expect(b.datasets).toEqual([]);
    expect(b.infographics).toEqual([]);
  });

  it("v8 → v9 is additive: datasets kept, empty infographics added", () => {
    const v8 = { ...createEmptyBible("b"), version: 8 };
    delete (v8 as { infographics?: unknown }).infographics;
    const m = migrateBible(v8)!;
    expect(m.version).toBe(BIBLE_VERSION);
    expect(m.infographics).toEqual([]);
  });
});
