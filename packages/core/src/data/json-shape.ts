import { dataTableFromGrid, type DataTable } from "./data-table.js";

/**
 * "Automatic best view" for arbitrary structured data (today: JSON). A parsed value
 * is classified into the view that actually fits its shape, so the same upload path
 * can show a spreadsheet AS a table, an API blob AS a tree, etc. — instead of dumping
 * everything as collapsed prose.
 *
 * The trick is that most *useful* JSON is tabular (an array of records, a list, a flat
 * object) and normalises to a `DataTable`, which already has a great view (the table
 * card + analyze/chart machinery). Only genuinely nested/irregular data needs the tree.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** The fitting view for a parsed value: a normalised table, or the raw tree. */
export type DataView = { kind: "table"; table: DataTable } | { kind: "tree"; value: JsonValue };

/** How many records/keys we scan/normalise — mirrors the table caps so a giant blob
 * can't blow memory or context. */
const MAX_SCAN = 5000;

function isPrimitive(v: JsonValue): v is null | boolean | number | string {
  return v === null || typeof v !== "object";
}

/** Tolerant parse: returns the value, or undefined when the text isn't valid JSON. */
export function parseJsonValue(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Render a single JSON value as one table cell (primitive verbatim, nested compacted). */
function cellText(v: JsonValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Normalise a value to a `DataTable` when its shape is tabular, else `undefined`
 * (the caller shows a tree). Handles: array of objects (records → columns are the
 * union of keys), array of arrays (first row = header, like a CSV grid), array of
 * primitives (one "value" column), and a single FLAT object (a Key/Value table).
 */
export function jsonToDataTable(value: JsonValue): DataTable | undefined {
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_SCAN);
    if (items.length === 0) return undefined;
    if (items.every((it) => isPrimitive(it))) {
      return dataTableFromGrid([["value"], ...items.map((it) => [cellText(it)])]);
    }
    if (items.every((it) => Array.isArray(it))) {
      // Array of arrays → a grid; the first row is treated as the header (CSV-style).
      return dataTableFromGrid((items as JsonValue[][]).map((row) => row.map(cellText)));
    }
    if (items.every((it) => it !== null && typeof it === "object" && !Array.isArray(it))) {
      return dataTableFromRecords(items as Record<string, JsonValue>[]);
    }
    return undefined; // mixed element types → no honest table; show the tree
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    // A FLAT object reads best as a Key/Value table; a nested one belongs in the tree.
    if (entries.length > 0 && entries.every(([, v]) => isPrimitive(v))) {
      return dataTableFromGrid([["Key", "Value"], ...entries.map(([k, v]) => [k, cellText(v)])]);
    }
    return undefined;
  }
  return undefined; // a bare primitive → the tree shows it plainly
}

/** Build a table from an array of record objects: columns = the union of keys (in
 * first-seen order), nested/array cell values compacted to JSON text. */
export function dataTableFromRecords(records: Record<string, JsonValue>[]): DataTable | undefined {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    for (const k of Object.keys(rec)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  if (keys.length === 0) return undefined;
  const grid = [keys, ...records.map((rec) => keys.map((k) => (k in rec ? cellText(rec[k]!) : "")))];
  return dataTableFromGrid(grid);
}

/** Pick the fitting view for a parsed value: a table when tabular, else the tree. */
export function classifyJson(value: JsonValue): DataView {
  const table = jsonToDataTable(value);
  return table ? { kind: "table", table } : { kind: "tree", value };
}
