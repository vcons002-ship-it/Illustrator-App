import type { CellValue, DataTable } from "./data-table.js";

/**
 * A small, self-contained Excel-formula evaluator so cell formulas (imported or
 * authored in chat) compute LIVE in the app — `=B2-C2` shows its number, and the
 * chat's analyze_data sees the result. NOT a full Excel engine: it covers the common
 * operators and functions; anything it can't evaluate throws, and `recalcTable` then
 * keeps whatever cached value the cell already had (e.g. Excel's own result on import).
 *
 * Pure: `evaluateFormula` works over an abstract cell-accessor, and `recalcTable`
 * drives it across a DataTable's `formulas` map with memoisation + cycle detection.
 */

export type FormulaValue = number | string | boolean | null;
type EvalResult = FormulaValue | FormulaValue[];

export interface FormulaContext {
  /** A cell's value by 0-based column + 1-based Excel row (row 1 = the header). */
  cell(col: number, excelRow: number): FormulaValue;
}

// ---- Tokeniser -------------------------------------------------------------

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "cell"; col: number; row: number }
  | { t: "ident"; v: string }
  | { t: "op"; v: string }
  | { t: "punc"; v: "(" | ")" | "," | ":" };

function lettersToCol(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = input;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let str = "";
      while (j < s.length) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') {
            str += '"';
            j += 2;
            continue;
          }
          break;
        }
        str += s[j];
        j++;
      }
      tokens.push({ t: "str", v: str });
      i = j + 1;
      continue;
    }
    // Cell reference: optional $, letters, optional $, digits (must have both).
    const cell = /^\$?([A-Za-z]{1,3})\$?(\d+)/.exec(s.slice(i));
    if (cell) {
      tokens.push({ t: "cell", col: lettersToCol(cell[1]!), row: Number(cell[2]) });
      i += cell[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(s.slice(i));
    if (ident) {
      tokens.push({ t: "ident", v: ident[0] });
      i += ident[0].length;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (num) {
      tokens.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "," || ch === ":") {
      tokens.push({ t: "punc", v: ch });
      i++;
      continue;
    }
    // Multi-char operators first.
    const two = s.slice(i, i + 2);
    if (two === "<>" || two === "<=" || two === ">=") {
      tokens.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>".includes(ch)) {
      tokens.push({ t: "op", v: ch });
      i++;
      continue;
    }
    throw new Error(`unexpected character "${ch}"`);
  }
  return tokens;
}

// ---- Parser / evaluator ----------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[], private readonly ctx: FormulaContext) {}

  parse(): EvalResult {
    const v = this.comparison();
    if (this.pos < this.tokens.length) throw new Error("trailing tokens");
    return v;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private eat(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error("unexpected end of formula");
    this.pos++;
    return t;
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === "op" && t.v === v;
  }

  private comparison(): EvalResult {
    let left = this.concat();
    while (true) {
      const t = this.peek();
      if (t?.t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(t.v)) {
        this.pos++;
        const right = this.concat();
        left = compare(t.v, scalar(left), scalar(right));
      } else break;
    }
    return left;
  }
  private concat(): EvalResult {
    let left = this.additive();
    while (this.isOp("&")) {
      this.pos++;
      const right = this.additive();
      left = `${toStr(scalar(left))}${toStr(scalar(right))}`;
    }
    return left;
  }
  private additive(): EvalResult {
    let left = this.multiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.eat() as { v: string }).v;
      const right = this.multiplicative();
      left = op === "+" ? toNum(scalar(left)) + toNum(scalar(right)) : toNum(scalar(left)) - toNum(scalar(right));
    }
    return left;
  }
  private multiplicative(): EvalResult {
    let left = this.power();
    while (this.isOp("*") || this.isOp("/")) {
      const op = (this.eat() as { v: string }).v;
      const right = this.power();
      const a = toNum(scalar(left));
      const b = toNum(scalar(right));
      if (op === "/" && b === 0) throw new Error("#DIV/0!");
      left = op === "*" ? a * b : a / b;
    }
    return left;
  }
  private power(): EvalResult {
    const left = this.unary();
    if (this.isOp("^")) {
      this.pos++;
      const right = this.power(); // right-associative
      return Math.pow(toNum(scalar(left)), toNum(scalar(right)));
    }
    return left;
  }
  private unary(): EvalResult {
    if (this.isOp("-")) {
      this.pos++;
      return -toNum(scalar(this.unary()));
    }
    if (this.isOp("+")) {
      this.pos++;
      return this.unary();
    }
    return this.primary();
  }

  private primary(): EvalResult {
    const t = this.eat();
    if (t.t === "num") return t.v;
    if (t.t === "str") return t.v;
    if (t.t === "punc" && t.v === "(") {
      const v = this.comparison();
      const close = this.eat();
      if (!(close.t === "punc" && close.v === ")")) throw new Error("expected )");
      return v;
    }
    if (t.t === "cell") {
      // A range "A1:B2" yields the flattened list of its cells.
      const next = this.peek();
      if (next?.t === "punc" && next.v === ":") {
        this.pos++;
        const end = this.eat();
        if (end.t !== "cell") throw new Error("expected a cell after :");
        return this.rangeValues(t, end);
      }
      return this.ctx.cell(t.col, t.row);
    }
    if (t.t === "ident") {
      const upper = t.v.toUpperCase();
      const next = this.peek();
      if (next?.t === "punc" && next.v === "(") {
        this.pos++;
        const args = this.args();
        return callFunction(upper, args);
      }
      if (upper === "TRUE") return true;
      if (upper === "FALSE") return false;
      throw new Error(`unknown name "${t.v}"`);
    }
    throw new Error("unexpected token");
  }

  private args(): EvalResult[] {
    const out: EvalResult[] = [];
    if (this.peek()?.t === "punc" && (this.peek() as { v: string }).v === ")") {
      this.eat();
      return out;
    }
    while (true) {
      out.push(this.comparison());
      const t = this.eat();
      if (t.t === "punc" && t.v === ")") break;
      if (!(t.t === "punc" && t.v === ",")) throw new Error("expected , or )");
    }
    return out;
  }

  private rangeValues(start: { col: number; row: number }, end: { col: number; row: number }): FormulaValue[] {
    const c1 = Math.min(start.col, end.col);
    const c2 = Math.max(start.col, end.col);
    const r1 = Math.min(start.row, end.row);
    const r2 = Math.max(start.row, end.row);
    const out: FormulaValue[] = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push(this.ctx.cell(c, r));
    return out;
  }
}

// ---- Coercions + operators -------------------------------------------------

function scalar(v: EvalResult): FormulaValue {
  if (Array.isArray(v)) {
    if (v.length === 1) return v[0]!;
    throw new Error("expected a single value, got a range");
  }
  return v;
}
function toNum(v: FormulaValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === "") return 0;
  const n = Number(String(v).replace(/[,$£€\s]/g, "").replace(/%$/, ""));
  if (!Number.isFinite(n)) throw new Error("#VALUE!");
  return n;
}
function toStr(v: FormulaValue): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}
function toBool(v: FormulaValue): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (v === null || v === "") return false;
  return String(v).toUpperCase() === "TRUE";
}
function compare(op: string, a: FormulaValue, b: FormulaValue): boolean {
  // Numeric when both look numeric; else string (case-insensitive, Excel-ish).
  const an = typeof a === "number" ? a : typeof a === "boolean" ? (a ? 1 : 0) : Number(a);
  const bn = typeof b === "number" ? b : typeof b === "boolean" ? (b ? 1 : 0) : Number(b);
  const bothNum = a !== null && b !== null && Number.isFinite(an) && Number.isFinite(bn) && typeof a !== "string" && typeof b !== "string";
  let cmp: number;
  if (bothNum) cmp = an - bn;
  else cmp = toStr(a).toLowerCase() < toStr(b).toLowerCase() ? -1 : toStr(a).toLowerCase() > toStr(b).toLowerCase() ? 1 : 0;
  switch (op) {
    case "=":
      return cmp === 0;
    case "<>":
      return cmp !== 0;
    case "<":
      return cmp < 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case ">=":
      return cmp >= 0;
    default:
      throw new Error("bad comparison");
  }
}

/** Flatten args (arrays + scalars) to the numbers among them (text/blank skipped). */
function nums(args: EvalResult[]): number[] {
  const out: number[] = [];
  for (const a of args) {
    const list = Array.isArray(a) ? a : [a];
    for (const v of list) {
      if (typeof v === "number") out.push(v);
      else if (typeof v === "boolean") out.push(v ? 1 : 0);
      else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) out.push(Number(v));
    }
  }
  return out;
}
function flat(args: EvalResult[]): FormulaValue[] {
  const out: FormulaValue[] = [];
  for (const a of args) (Array.isArray(a) ? a : [a]).forEach((v) => out.push(v));
  return out;
}

function matchesCriteria(value: FormulaValue, crit: FormulaValue): boolean {
  if (typeof crit === "string") {
    const m = /^(<=|>=|<>|<|>|=)(.*)$/.exec(crit.trim());
    if (m) {
      const op = m[1] === "=" ? "=" : m[1]!;
      const rhsRaw = m[2]!.trim();
      const rhs: FormulaValue = rhsRaw !== "" && Number.isFinite(Number(rhsRaw)) ? Number(rhsRaw) : rhsRaw;
      return compare(op, value, rhs);
    }
  }
  return compare("=", value, crit);
}

function regression(xs: number[], ys: number[]): { slope: number; intercept: number; r: number } {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) throw new Error("#DIV/0!");
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
    sxx += xs[i]! * xs[i]!;
    syy += ys[i]! * ys[i]!;
    sxy += xs[i]! * ys[i]!;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const rDenom = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  const r = rDenom === 0 ? 0 : (n * sxy - sx * sy) / rDenom;
  return { slope, intercept, r };
}

function callFunction(name: string, args: EvalResult[]): EvalResult {
  switch (name) {
    case "SUM":
      return nums(args).reduce((a, b) => a + b, 0);
    case "AVERAGE":
    case "AVG": {
      const v = nums(args);
      if (v.length === 0) throw new Error("#DIV/0!");
      return v.reduce((a, b) => a + b, 0) / v.length;
    }
    case "MIN":
      return Math.min(...orZero(nums(args)));
    case "MAX":
      return Math.max(...orZero(nums(args)));
    case "COUNT":
      return nums(args).length;
    case "COUNTA":
      return flat(args).filter((v) => v !== null && v !== "").length;
    case "PRODUCT":
      return nums(args).reduce((a, b) => a * b, 1);
    case "MEDIAN": {
      const v = nums(args).slice().sort((a, b) => a - b);
      if (v.length === 0) throw new Error("#NUM!");
      const mid = Math.floor(v.length / 2);
      return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
    }
    case "STDEV":
    case "VAR": {
      const v = nums(args);
      if (v.length < 2) throw new Error("#DIV/0!");
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      const variance = v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1);
      return name === "VAR" ? variance : Math.sqrt(variance);
    }
    case "SUMPRODUCT": {
      const arrays = args.map((a) => (Array.isArray(a) ? a : [a]).map((v) => (typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : Number(v) || 0)));
      const len = Math.max(...arrays.map((a) => a.length));
      let total = 0;
      for (let i = 0; i < len; i++) total += arrays.reduce((p, a) => p * (a[i] ?? 0), 1);
      return total;
    }
    case "IF":
      return toBool(scalar(args[0]!)) ? scalar(args[1] ?? null) : scalar(args[2] ?? false);
    case "AND":
      return flat(args).every((v) => toBool(v));
    case "OR":
      return flat(args).some((v) => toBool(v));
    case "NOT":
      return !toBool(scalar(args[0]!));
    case "ROUND": {
      const p = Math.pow(10, args[1] !== undefined ? toNum(scalar(args[1])) : 0);
      return Math.round(toNum(scalar(args[0]!)) * p) / p;
    }
    case "ABS":
      return Math.abs(toNum(scalar(args[0]!)));
    case "INT":
      return Math.floor(toNum(scalar(args[0]!)));
    case "MOD":
      return toNum(scalar(args[0]!)) % toNum(scalar(args[1]!));
    case "SQRT":
      return Math.sqrt(toNum(scalar(args[0]!)));
    case "POWER":
      return Math.pow(toNum(scalar(args[0]!)), toNum(scalar(args[1]!)));
    case "CONCAT":
    case "CONCATENATE":
      return flat(args).map(toStr).join("");
    case "LEN":
      return toStr(scalar(args[0]!)).length;
    case "LEFT":
      return toStr(scalar(args[0]!)).slice(0, args[1] !== undefined ? toNum(scalar(args[1])) : 1);
    case "RIGHT": {
      const n = args[1] !== undefined ? toNum(scalar(args[1])) : 1;
      const str = toStr(scalar(args[0]!));
      return n <= 0 ? "" : str.slice(-n);
    }
    case "MID":
      return toStr(scalar(args[0]!)).slice(toNum(scalar(args[1]!)) - 1, toNum(scalar(args[1]!)) - 1 + toNum(scalar(args[2]!)));
    case "UPPER":
      return toStr(scalar(args[0]!)).toUpperCase();
    case "LOWER":
      return toStr(scalar(args[0]!)).toLowerCase();
    case "TRIM":
      return toStr(scalar(args[0]!)).trim();
    case "COUNTIF": {
      const range = Array.isArray(args[0]) ? args[0] : [args[0]!];
      const crit = scalar(args[1]!);
      return range.filter((v) => matchesCriteria(v, crit)).length;
    }
    case "SUMIF":
    case "AVERAGEIF": {
      const range = Array.isArray(args[0]) ? args[0] : [args[0]!];
      const crit = scalar(args[1]!);
      const sumRange = args[2] !== undefined ? (Array.isArray(args[2]) ? args[2] : [args[2]]) : range;
      const picked: number[] = [];
      range.forEach((v, i) => {
        if (matchesCriteria(v, crit)) {
          const sv = sumRange[i];
          if (typeof sv === "number") picked.push(sv);
          else if (typeof sv === "string" && Number.isFinite(Number(sv))) picked.push(Number(sv));
        }
      });
      if (name === "SUMIF") return picked.reduce((a, b) => a + b, 0);
      if (picked.length === 0) throw new Error("#DIV/0!");
      return picked.reduce((a, b) => a + b, 0) / picked.length;
    }
    case "CORREL":
      return regression(nums([args[0]!]), nums([args[1]!])).r;
    case "SLOPE":
      return regression(nums([args[1]!]), nums([args[0]!])).slope;
    case "INTERCEPT":
      return regression(nums([args[1]!]), nums([args[0]!])).intercept;
    case "RSQ":
      return regression(nums([args[0]!]), nums([args[1]!])).r ** 2;
    default:
      throw new Error(`unsupported function ${name}()`);
  }
}
function orZero(v: number[]): number[] {
  return v.length ? v : [0];
}

/** Evaluate one formula expression (without the leading "=") against a context. */
export function evaluateFormula(expr: string, ctx: FormulaContext): FormulaValue {
  const result = new Parser(tokenize(expr), ctx).parse();
  const v = scalar(result);
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error("#NUM!");
  return v;
}

/**
 * Recompute every formula cell in a table's `formulas` map and write the results into
 * `rows` (a new table). Dependencies between formula cells are resolved with memoised
 * recursion; a circular reference or any unevaluable formula leaves that cell's existing
 * cached value untouched. Returns the same table reference when nothing changed.
 */
export function recalcTable(table: DataTable): DataTable {
  const fmap = table.formulas;
  if (!fmap || Object.keys(fmap).length === 0) return table;
  const ncols = table.columns.length;
  const memo = new Map<string, FormulaValue>();
  const stack = new Set<string>();

  const cell = (col: number, excelRow: number): FormulaValue => {
    if (excelRow === 1) return table.columns[col]?.name ?? null; // header row
    const r = excelRow - 2;
    if (r < 0 || r >= table.rows.length || col < 0 || col >= ncols) return null;
    const key = `${r},${col}`;
    const f = fmap[key];
    if (f === undefined) return table.rows[r]![col] ?? null; // literal cell
    if (memo.has(key)) return memo.get(key)!;
    if (stack.has(key)) throw new Error("#REF! (circular)");
    stack.add(key);
    try {
      const v = evaluateFormula(f, { cell });
      memo.set(key, v);
      return v;
    } finally {
      stack.delete(key);
    }
  };

  let changed = false;
  const rows = table.rows.map((row, r) =>
    row.map((v, c): CellValue => {
      if (fmap[`${r},${c}`] === undefined) return v;
      let computed: FormulaValue;
      try {
        computed = cell(c, r + 2);
      } catch {
        return v; // keep the cached value on any error / cycle
      }
      if ((computed === null || (typeof computed === "number" && !Number.isFinite(computed))) && v !== null) return v;
      // The table holds number | string | null, so a boolean result shows as Excel does.
      const out: CellValue = typeof computed === "boolean" ? (computed ? "TRUE" : "FALSE") : computed;
      if (out !== v) changed = true;
      return out;
    }),
  );
  return changed ? { ...table, rows } : table;
}
