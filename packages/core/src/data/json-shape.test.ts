import { describe, expect, it } from "vitest";
import { classifyJson, jsonToDataTable, parseJsonValue } from "./json-shape.js";
import { chartDatasetFromTable, type DataTable } from "./data-table.js";

describe("parseJsonValue", () => {
  it("parses valid JSON and returns undefined for garbage", () => {
    expect(parseJsonValue('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonValue("not json")).toBeUndefined();
    expect(parseJsonValue("")).toBeUndefined();
  });
});

describe("jsonToDataTable — tabular shapes normalise to a table", () => {
  it("array of flat objects → columns are the union of keys, typed", () => {
    const t = jsonToDataTable([
      { name: "Ada", age: 36 },
      { name: "Linus", age: 54, city: "Helsinki" },
    ])!;
    expect(t.columns.map((c) => c.name)).toEqual(["name", "age", "city"]);
    expect(t.columns.map((c) => c.type)).toEqual(["string", "number", "string"]);
    expect(t.rows[0]).toEqual(["Ada", 36, null]); // missing key → null
    expect(t.rows[1]).toEqual(["Linus", 54, "Helsinki"]);
  });

  it("a single FLAT object → a Key/Value table (mixed values stay text)", () => {
    const t = jsonToDataTable({ host: "localhost", port: 8080 })!;
    expect(t.columns.map((c) => c.name)).toEqual(["Key", "Value"]);
    // The Value column holds both a string and a number, so its honest type is string.
    expect(t.rows).toEqual([
      ["host", "localhost"],
      ["port", "8080"],
    ]);
  });

  it("array of primitives → a single 'value' column", () => {
    const t = jsonToDataTable([10, 20, 30])!;
    expect(t.columns).toEqual([{ name: "value", type: "number" }]);
    expect(t.rows).toEqual([[10], [20], [30]]);
  });

  it("array of arrays → a grid with the first row as the header", () => {
    const t = jsonToDataTable([
      ["region", "sales"],
      ["West", "100"],
      ["East", "250"],
    ])!;
    expect(t.columns.map((c) => c.name)).toEqual(["region", "sales"]);
    expect(t.columns[1]!.type).toBe("number");
    expect(t.rows).toEqual([
      ["West", 100],
      ["East", 250],
    ]);
  });

  it("nested cell values are compacted to JSON text, not dropped", () => {
    const t = jsonToDataTable([{ id: 1, tags: ["a", "b"] }])!;
    expect(t.rows[0]).toEqual([1, '["a","b"]']);
  });
});

describe("jsonToDataTable — non-tabular shapes return undefined (→ tree)", () => {
  it("a nested object, mixed array, empty array, and bare primitive don't tabularise", () => {
    expect(jsonToDataTable({ user: { name: "x" }, items: [1, 2] })).toBeUndefined();
    expect(jsonToDataTable([1, "two", { three: 3 }])).toBeUndefined();
    expect(jsonToDataTable([])).toBeUndefined();
    expect(jsonToDataTable(42)).toBeUndefined();
  });
});

describe("classifyJson picks the fitting view", () => {
  it("tabular → table, nested → tree", () => {
    expect(classifyJson([{ a: 1 }]).kind).toBe("table");
    const tree = classifyJson({ deep: { nested: true } });
    expect(tree.kind).toBe("tree");
    if (tree.kind === "tree") expect(tree.value).toEqual({ deep: { nested: true } });
  });
});

describe("chartDatasetFromTable", () => {
  const table: DataTable = {
    columns: [
      { name: "Region", type: "string" },
      { name: "Sales", type: "number" },
    ],
    rows: [
      ["West", 100],
      ["East", 250],
    ],
  };

  it("labels from the first text column, values from the first numeric column", () => {
    const ds = chartDatasetFromTable(table)!;
    expect(ds.xLabel).toBe("Region");
    expect(ds.title).toBe("Sales");
    expect(ds.points).toEqual([
      { label: "West", y: 100 },
      { label: "East", y: 250 },
    ]);
  });

  it("returns undefined when there's no numeric column to chart", () => {
    expect(
      chartDatasetFromTable({ columns: [{ name: "Region", type: "string" }], rows: [["West"]] }),
    ).toBeUndefined();
  });
});
