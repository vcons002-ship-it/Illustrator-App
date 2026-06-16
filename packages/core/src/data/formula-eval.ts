import type { CellValue, DataTable } from "./data-table.js";

/**
 * A compact but capable Excel-formula evaluator so cell formulas (imported or authored
 * in chat) compute LIVE in the app — `=B2-C2` shows its number, `VLOOKUP`/`SUMIFS`
 * resolve, and the chat's analyze_data sees the results. NOT a full Excel engine, but
 * it covers the common operators and a broad function set; anything it can't evaluate
 * throws, and `recalcTable` then keeps whatever cached value the cell already had (e.g.
 * Excel's own result on import).
 *
 * Pure, two-stage: tokenise + parse to an AST, then evaluate over an abstract cell
 * accessor. `recalcTable` drives it across a DataTable's `formulas` map with memoised
 * recursion + cycle detection. The AST stage makes IF/IFS/IFERROR lazy (only the taken
 * branch is evaluated) and gives ranges a 2-D shape so lookups work.
 */

export type FormulaValue = number | string | boolean | null;

export interface FormulaContext {
  /** A cell's value by 0-based column + 1-based Excel row (row 1 = the header). An
   * optional sheet name resolves a cross-sheet reference (`'Data'!B2`); undefined =
   * the current sheet. */
  cell(col: number, excelRow: number, sheet?: string): FormulaValue;
}

/** A rectangular range result, row-major. */
interface RangeVal {
  width: number;
  height: number;
  cells: FormulaValue[];
}
type Value = FormulaValue | RangeVal;
function isRange(v: Value): v is RangeVal {
  return typeof v === "object" && v !== null && "cells" in v;
}

// ---- Tokeniser -------------------------------------------------------------

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "cell"; col: number; row: number }
  | { t: "sheet"; name: string }
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
    // A cross-sheet prefix: 'Quoted Name'! or BareName! (before the cell/ident match).
    const sheetQuoted = /^'((?:[^']|'')*)'!/.exec(s.slice(i));
    if (sheetQuoted) {
      tokens.push({ t: "sheet", name: sheetQuoted[1]!.replace(/''/g, "'") });
      i += sheetQuoted[0].length;
      continue;
    }
    const sheetBare = /^([A-Za-z_][A-Za-z0-9_.]*)!/.exec(s.slice(i));
    if (sheetBare) {
      tokens.push({ t: "sheet", name: sheetBare[1]! });
      i += sheetBare[0].length;
      continue;
    }
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

// ---- Parser → AST ----------------------------------------------------------

type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "name"; v: string }
  | { k: "cell"; col: number; row: number; sheet?: string }
  | { k: "range"; c1: number; r1: number; c2: number; r2: number; sheet?: string }
  | { k: "unary"; op: string; x: Node }
  | { k: "binary"; op: string; a: Node; b: Node }
  | { k: "call"; name: string; args: Node[] };

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const n = this.comparison();
    if (this.pos < this.tokens.length) throw new Error("trailing tokens");
    return n;
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
  private isOp(...vs: string[]): boolean {
    const t = this.peek();
    return !!t && t.t === "op" && vs.includes(t.v);
  }
  private comparison(): Node {
    let a = this.concat();
    while (this.isOp("=", "<>", "<", ">", "<=", ">=")) {
      const op = (this.eat() as { v: string }).v;
      a = { k: "binary", op, a, b: this.concat() };
    }
    return a;
  }
  private concat(): Node {
    let a = this.additive();
    while (this.isOp("&")) {
      this.eat();
      a = { k: "binary", op: "&", a, b: this.additive() };
    }
    return a;
  }
  private additive(): Node {
    let a = this.multiplicative();
    while (this.isOp("+", "-")) {
      const op = (this.eat() as { v: string }).v;
      a = { k: "binary", op, a, b: this.multiplicative() };
    }
    return a;
  }
  private multiplicative(): Node {
    let a = this.power();
    while (this.isOp("*", "/")) {
      const op = (this.eat() as { v: string }).v;
      a = { k: "binary", op, a, b: this.power() };
    }
    return a;
  }
  private power(): Node {
    const a = this.unary();
    if (this.isOp("^")) {
      this.eat();
      return { k: "binary", op: "^", a, b: this.power() }; // right-assoc
    }
    return a;
  }
  private unary(): Node {
    if (this.isOp("-", "+")) {
      const op = (this.eat() as { v: string }).v;
      return { k: "unary", op, x: this.unary() };
    }
    return this.primary();
  }
  private primary(): Node {
    const t = this.eat();
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "str") return { k: "str", v: t.v };
    if (t.t === "punc" && t.v === "(") {
      const n = this.comparison();
      const close = this.eat();
      if (!(close.t === "punc" && close.v === ")")) throw new Error("expected )");
      return n;
    }
    // A cross-sheet prefix qualifies the cell/range that follows.
    let sheet: string | undefined;
    let head: Token = t;
    if (t.t === "sheet") {
      sheet = t.name;
      head = this.eat();
    }
    if (head.t === "cell") {
      const next = this.peek();
      if (next?.t === "punc" && next.v === ":") {
        this.eat();
        const end = this.eat();
        if (end.t !== "cell") throw new Error("expected a cell after :");
        return { k: "range", c1: head.col, r1: head.row, c2: end.col, r2: end.row, ...(sheet ? { sheet } : {}) };
      }
      return { k: "cell", col: head.col, row: head.row, ...(sheet ? { sheet } : {}) };
    }
    if (sheet) throw new Error("expected a cell after a sheet reference");
    if (head.t === "ident") {
      const next = this.peek();
      if (next?.t === "punc" && next.v === "(") {
        this.eat();
        return { k: "call", name: head.v.toUpperCase(), args: this.args() };
      }
      return { k: "name", v: head.v.toUpperCase() };
    }
    throw new Error("unexpected token");
  }
  private args(): Node[] {
    const out: Node[] = [];
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
}

// ---- Evaluator -------------------------------------------------------------

function evalNode(node: Node, ctx: FormulaContext): Value {
  switch (node.k) {
    case "num":
      return node.v;
    case "str":
      return node.v;
    case "name":
      if (node.v === "TRUE") return true;
      if (node.v === "FALSE") return false;
      throw new Error(`unknown name "${node.v}"`);
    case "cell":
      return ctx.cell(node.col, node.row, node.sheet);
    case "range": {
      const c1 = Math.min(node.c1, node.c2);
      const c2 = Math.max(node.c1, node.c2);
      const r1 = Math.min(node.r1, node.r2);
      const r2 = Math.max(node.r1, node.r2);
      const cells: FormulaValue[] = [];
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) cells.push(ctx.cell(c, r, node.sheet));
      return { width: c2 - c1 + 1, height: r2 - r1 + 1, cells };
    }
    case "unary": {
      if (node.op === "+") return evalNode(node.x, ctx);
      return -toNum(scalar(evalNode(node.x, ctx)));
    }
    case "binary":
      return binary(node.op, node, ctx);
    case "call":
      return callFn(node.name, node.args, ctx);
  }
}

function binary(op: string, node: { a: Node; b: Node }, ctx: FormulaContext): Value {
  const a = scalar(evalNode(node.a, ctx));
  const b = scalar(evalNode(node.b, ctx));
  switch (op) {
    case "+":
      return toNum(a) + toNum(b);
    case "-":
      return toNum(a) - toNum(b);
    case "*":
      return toNum(a) * toNum(b);
    case "/":
      if (toNum(b) === 0) throw new Error("#DIV/0!");
      return toNum(a) / toNum(b);
    case "^":
      return Math.pow(toNum(a), toNum(b));
    case "&":
      return `${toStr(a)}${toStr(b)}`;
    default:
      return compare(op, a, b);
  }
}

// ---- Coercions + operators -------------------------------------------------

function scalar(v: Value): FormulaValue {
  if (isRange(v)) {
    if (v.cells.length === 1) return v.cells[0]!;
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

/** All cells of a value (a range's cells, or the lone scalar). */
function cellsOf(v: Value): FormulaValue[] {
  return isRange(v) ? v.cells : [v];
}
/** Numbers among one or more values (text/blank skipped — Excel SUM semantics). */
function numsOf(values: Value[]): number[] {
  const out: number[] = [];
  for (const v of values)
    for (const cell of cellsOf(v)) {
      if (typeof cell === "number") out.push(cell);
      else if (typeof cell === "boolean") out.push(cell ? 1 : 0);
      else if (typeof cell === "string" && cell.trim() !== "" && Number.isFinite(Number(cell))) out.push(Number(cell));
    }
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
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error("#NUM!");
  if (sorted.length === 1) return sorted[0]!;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

// ---- Functions -------------------------------------------------------------

function callFn(name: string, args: Node[], ctx: FormulaContext): Value {
  const ev = (i: number): Value => evalNode(args[i]!, ctx);
  const sc = (i: number): FormulaValue => scalar(ev(i));
  const all = (): Value[] => args.map((a) => evalNode(a, ctx));

  switch (name) {
    // --- Lazy logical / error handling (only the taken branch evaluates) ---
    case "IF":
      return toBool(sc(0)) ? ev(1) : args.length > 2 ? ev(2) : false;
    case "IFS": {
      for (let i = 0; i + 1 < args.length; i += 2) if (toBool(sc(i))) return ev(i + 1);
      throw new Error("#N/A");
    }
    case "IFERROR":
    case "IFNA":
      try {
        const v = ev(0);
        if (isRange(v)) return v;
        return typeof v === "number" && !Number.isFinite(v) ? ev(1) : v;
      } catch {
        return ev(1);
      }
    case "AND":
      return all().flatMap(cellsOf).every((v) => toBool(v));
    case "OR":
      return all().flatMap(cellsOf).some((v) => toBool(v));
    case "NOT":
      return !toBool(sc(0));
    case "ISERROR":
    case "ISERR":
      try {
        const v = sc(0);
        return typeof v === "number" && !Number.isFinite(v);
      } catch {
        return true;
      }
    case "ISNUMBER":
      try {
        return typeof sc(0) === "number";
      } catch {
        return false;
      }
    case "ISTEXT":
      return typeof sc(0) === "string";
    case "ISBLANK":
      return sc(0) === null || sc(0) === "";
    case "ISLOGICAL":
      return typeof sc(0) === "boolean";
    case "NA":
      throw new Error("#N/A");

    // --- Aggregates ---
    case "SUM":
      return numsOf(all()).reduce((a, b) => a + b, 0);
    case "AVERAGE":
    case "AVG": {
      const v = numsOf(all());
      if (v.length === 0) throw new Error("#DIV/0!");
      return v.reduce((a, b) => a + b, 0) / v.length;
    }
    case "MIN":
      return min0(numsOf(all()));
    case "MAX":
      return max0(numsOf(all()));
    case "COUNT":
      return numsOf(all()).length;
    case "COUNTA":
      return all().flatMap(cellsOf).filter((v) => v !== null && v !== "").length;
    case "COUNTBLANK":
      return all().flatMap(cellsOf).filter((v) => v === null || v === "").length;
    case "PRODUCT":
      return numsOf(all()).reduce((a, b) => a * b, 1);
    case "MEDIAN": {
      const v = numsOf(all()).slice().sort((a, b) => a - b);
      if (v.length === 0) throw new Error("#NUM!");
      const mid = Math.floor(v.length / 2);
      return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
    }
    case "MODE": {
      const v = numsOf(all());
      const counts = new Map<number, number>();
      let best = NaN;
      let bestN = 0;
      for (const x of v) {
        const c = (counts.get(x) ?? 0) + 1;
        counts.set(x, c);
        if (c > bestN) {
          bestN = c;
          best = x;
        }
      }
      if (bestN < 2) throw new Error("#N/A");
      return best;
    }
    case "STDEV":
    case "STDEVA":
    case "VAR": {
      const v = numsOf(all());
      if (v.length < 2) throw new Error("#DIV/0!");
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      const variance = v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1);
      return name === "VAR" ? variance : Math.sqrt(variance);
    }
    case "STDEVP":
    case "VARP": {
      const v = numsOf(all());
      if (v.length === 0) throw new Error("#DIV/0!");
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      const variance = v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length;
      return name === "VARP" ? variance : Math.sqrt(variance);
    }
    case "SUMPRODUCT": {
      const arrays = all().map((a) => cellsOf(a).map((v) => (typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : Number(v) || 0)));
      const len = Math.max(...arrays.map((a) => a.length));
      let total = 0;
      for (let i = 0; i < len; i++) total += arrays.reduce((p, a) => p * (a[i] ?? 0), 1);
      return total;
    }
    case "LARGE":
    case "SMALL": {
      const v = numsOf([ev(0)]).slice().sort((a, b) => (name === "LARGE" ? b - a : a - b));
      const k = Math.round(toNum(sc(1)));
      if (k < 1 || k > v.length) throw new Error("#NUM!");
      return v[k - 1]!;
    }
    case "RANK": {
      const x = toNum(sc(0));
      const v = numsOf([ev(1)]);
      const order = args.length > 2 ? toNum(sc(2)) : 0;
      return v.filter((y) => (order === 0 ? y > x : y < x)).length + 1;
    }
    case "PERCENTILE":
    case "QUARTILE": {
      const v = numsOf([ev(0)]).slice().sort((a, b) => a - b);
      const p = name === "QUARTILE" ? toNum(sc(1)) / 4 : toNum(sc(1));
      return percentile(v, p);
    }

    // --- Conditional aggregates (single + multi criteria) ---
    case "SUMIF":
    case "AVERAGEIF": {
      const range = cellsOf(ev(0));
      const crit = sc(1);
      const sumRange = args.length > 2 ? cellsOf(ev(2)) : range;
      const picked = pickByCriteria([{ range, crit }], sumRange);
      if (name === "SUMIF") return picked.reduce((a, b) => a + b, 0);
      if (picked.length === 0) throw new Error("#DIV/0!");
      return picked.reduce((a, b) => a + b, 0) / picked.length;
    }
    case "COUNTIF": {
      const range = cellsOf(ev(0));
      const crit = sc(1);
      return range.filter((v) => matchesCriteria(v, crit)).length;
    }
    case "SUMIFS":
    case "AVERAGEIFS":
    case "MAXIFS":
    case "MINIFS": {
      const target = cellsOf(ev(0));
      const conds: { range: FormulaValue[]; crit: FormulaValue }[] = [];
      for (let i = 1; i + 1 < args.length; i += 2) conds.push({ range: cellsOf(ev(i)), crit: sc(i + 1) });
      const picked = pickByCriteria(conds, target);
      if (name === "SUMIFS") return picked.reduce((a, b) => a + b, 0);
      if (name === "MAXIFS") return max0(picked);
      if (name === "MINIFS") return min0(picked);
      if (picked.length === 0) throw new Error("#DIV/0!");
      return picked.reduce((a, b) => a + b, 0) / picked.length;
    }
    case "COUNTIFS": {
      const conds: { range: FormulaValue[]; crit: FormulaValue }[] = [];
      for (let i = 0; i + 1 < args.length; i += 2) conds.push({ range: cellsOf(ev(i)), crit: sc(i + 1) });
      const len = conds[0]?.range.length ?? 0;
      let count = 0;
      for (let i = 0; i < len; i++) if (conds.every((c) => matchesCriteria(c.range[i] ?? null, c.crit))) count++;
      return count;
    }

    // --- Lookup / reference ---
    case "VLOOKUP":
    case "HLOOKUP": {
      const key = sc(0);
      const table = ev(1);
      if (!isRange(table)) throw new Error("#REF!");
      const idx = Math.round(toNum(sc(2)));
      const exact = args.length > 3 ? toBool(sc(3)) === false : false;
      const vert = name === "VLOOKUP";
      const line = vert ? Array.from({ length: table.height }, (_, r) => table.cells[r * table.width]!) : table.cells.slice(0, table.width);
      const at = lookupIndex(line, key, exact);
      if (at < 0) throw new Error("#N/A");
      return vert ? table.cells[at * table.width + (idx - 1)] ?? null : table.cells[(idx - 1) * table.width + at] ?? null;
    }
    case "MATCH": {
      const key = sc(0);
      const range = ev(1);
      const line = cellsOf(range);
      const type = args.length > 2 ? toNum(sc(2)) : 1;
      const at = matchIndex(line, key, type);
      if (at < 0) throw new Error("#N/A");
      return at + 1;
    }
    case "INDEX": {
      const range = ev(0); // INDEX(range, row, [col])
      if (!isRange(range)) return scalar(range);
      const rowNum = Math.round(toNum(sc(1)));
      const colNum = args.length > 2 ? Math.round(toNum(sc(2))) : 0;
      if (range.height === 1 && colNum === 0) return range.cells[rowNum - 1] ?? null; // single row
      if (range.width === 1 && colNum === 0) return range.cells[rowNum - 1] ?? null; // single col
      return range.cells[(rowNum - 1) * range.width + Math.max(0, colNum - 1)] ?? null;
    }
    case "CHOOSE": {
      const idx = Math.round(toNum(sc(0)));
      if (idx < 1 || idx >= args.length) throw new Error("#VALUE!");
      return ev(idx);
    }

    // --- Math ---
    case "ROUND":
    case "ROUNDUP":
    case "ROUNDDOWN": {
      const p = Math.pow(10, args.length > 1 ? toNum(sc(1)) : 0);
      const x = toNum(sc(0)) * p;
      const r = name === "ROUND" ? Math.round(x) : name === "ROUNDUP" ? Math.sign(x) * Math.ceil(Math.abs(x)) : Math.sign(x) * Math.floor(Math.abs(x));
      return r / p;
    }
    case "CEILING": {
      const sig = args.length > 1 ? toNum(sc(1)) : 1;
      return sig === 0 ? 0 : Math.ceil(toNum(sc(0)) / sig) * sig;
    }
    case "FLOOR": {
      const sig = args.length > 1 ? toNum(sc(1)) : 1;
      return sig === 0 ? 0 : Math.floor(toNum(sc(0)) / sig) * sig;
    }
    case "TRUNC":
      return Math.trunc(toNum(sc(0)));
    case "ABS":
      return Math.abs(toNum(sc(0)));
    case "INT":
      return Math.floor(toNum(sc(0)));
    case "SIGN":
      return Math.sign(toNum(sc(0)));
    case "MOD":
      return toNum(sc(0)) % toNum(sc(1));
    case "SQRT":
      return Math.sqrt(toNum(sc(0)));
    case "POWER":
      return Math.pow(toNum(sc(0)), toNum(sc(1)));
    case "EXP":
      return Math.exp(toNum(sc(0)));
    case "LN":
      return Math.log(toNum(sc(0)));
    case "LOG10":
      return Math.log10(toNum(sc(0)));
    case "LOG":
      return args.length > 1 ? Math.log(toNum(sc(0))) / Math.log(toNum(sc(1))) : Math.log10(toNum(sc(0)));
    case "PI":
      return Math.PI;

    // --- Text ---
    case "CONCAT":
    case "CONCATENATE":
      return all().flatMap(cellsOf).map(toStr).join("");
    case "TEXTJOIN": {
      const delim = toStr(sc(0));
      const skipEmpty = toBool(sc(1));
      const parts = all().slice(2).flatMap(cellsOf).map(toStr).filter((s) => !skipEmpty || s !== "");
      return parts.join(delim);
    }
    case "LEN":
      return toStr(sc(0)).length;
    case "LEFT":
      return toStr(sc(0)).slice(0, args.length > 1 ? toNum(sc(1)) : 1);
    case "RIGHT": {
      const n = args.length > 1 ? toNum(sc(1)) : 1;
      const str = toStr(sc(0));
      return n <= 0 ? "" : str.slice(-n);
    }
    case "MID":
      return toStr(sc(0)).slice(toNum(sc(1)) - 1, toNum(sc(1)) - 1 + toNum(sc(2)));
    case "UPPER":
      return toStr(sc(0)).toUpperCase();
    case "LOWER":
      return toStr(sc(0)).toLowerCase();
    case "TRIM":
      return toStr(sc(0)).trim();
    case "SUBSTITUTE":
      return toStr(sc(0)).split(toStr(sc(1))).join(toStr(sc(2)));
    case "VALUE":
      return toNum(sc(0));

    // --- Regression / correlation ---
    case "CORREL":
      return regression(numsOf([ev(0)]), numsOf([ev(1)])).r;
    case "SLOPE":
      return regression(numsOf([ev(1)]), numsOf([ev(0)])).slope;
    case "INTERCEPT":
      return regression(numsOf([ev(1)]), numsOf([ev(0)])).intercept;
    case "RSQ":
      return regression(numsOf([ev(0)]), numsOf([ev(1)])).r ** 2;

    default:
      throw new Error(`unsupported function ${name}()`);
  }
}

function pickByCriteria(conds: { range: FormulaValue[]; crit: FormulaValue }[], target: FormulaValue[]): number[] {
  const len = conds[0]?.range.length ?? target.length;
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    if (!conds.every((c) => matchesCriteria(c.range[i] ?? null, c.crit))) continue;
    const v = target[i];
    if (typeof v === "number") out.push(v);
    else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) out.push(Number(v));
  }
  return out;
}
/** Exact (or approximate ascending) lookup → 0-based index, or -1. */
function lookupIndex(line: FormulaValue[], key: FormulaValue, exact: boolean): number {
  if (exact) return line.findIndex((v) => compare("=", v, key));
  let best = -1;
  for (let i = 0; i < line.length; i++) if (line[i] !== null && compare("<=", line[i]!, key)) best = i;
  return best;
}
function matchIndex(line: FormulaValue[], key: FormulaValue, type: number): number {
  if (type === 0) return line.findIndex((v) => compare("=", v, key));
  if (type === 1) {
    let best = -1;
    for (let i = 0; i < line.length; i++) if (line[i] !== null && compare("<=", line[i]!, key)) best = i;
    return best;
  }
  // type -1: smallest value ≥ key (descending data)
  let best = -1;
  for (let i = 0; i < line.length; i++) if (line[i] !== null && compare(">=", line[i]!, key)) best = i;
  return best;
}
function min0(v: number[]): number {
  return v.length ? Math.min(...v) : 0;
}
function max0(v: number[]): number {
  return v.length ? Math.max(...v) : 0;
}

/** Evaluate one formula expression (without the leading "=") against a context. */
export function evaluateFormula(expr: string, ctx: FormulaContext): FormulaValue {
  const v = scalar(evalNode(new Parser(tokenize(expr)).parse(), ctx));
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
    if (excelRow === 1) return table.columns[col]?.name ?? null;
    const r = excelRow - 2;
    if (r < 0 || r >= table.rows.length || col < 0 || col >= ncols) return null;
    const key = `${r},${col}`;
    const f = fmap[key];
    if (f === undefined) return table.rows[r]![col] ?? null;
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
        return v;
      }
      if ((computed === null || (typeof computed === "number" && !Number.isFinite(computed))) && v !== null) return v;
      const out: CellValue = typeof computed === "boolean" ? (computed ? "TRUE" : "FALSE") : computed;
      if (out !== v) changed = true;
      return out;
    }),
  );
  return changed ? { ...table, rows } : table;
}

/**
 * Recompute formula cells across a whole WORKBOOK, resolving cross-sheet references
 * (`'Data'!B2`). Like `recalcTable` but the cell accessor can hop to any sheet by name
 * (case-insensitive); memoisation + cycle detection span all sheets. Returns a new
 * sheet list (same references where a sheet didn't change).
 */
export function recalcWorkbook(sheets: { name: string; table: DataTable }[]): { name: string; table: DataTable }[] {
  const byName = new Map(sheets.map((s) => [s.name.toLowerCase(), s.table]));
  const memo = new Map<string, FormulaValue>();
  const stack = new Set<string>();

  const cellIn = (sheetName: string, col: number, excelRow: number, refSheet?: string): FormulaValue => {
    const tName = refSheet ?? sheetName;
    const table = byName.get(tName.toLowerCase());
    if (!table) return null;
    if (excelRow === 1) return table.columns[col]?.name ?? null;
    const r = excelRow - 2;
    if (r < 0 || r >= table.rows.length || col < 0 || col >= table.columns.length) return null;
    const f = table.formulas?.[`${r},${col}`];
    if (f === undefined) return table.rows[r]![col] ?? null;
    const key = `${tName.toLowerCase()}|${r},${col}`;
    if (memo.has(key)) return memo.get(key)!;
    if (stack.has(key)) throw new Error("#REF! (circular)");
    stack.add(key);
    try {
      const v = evaluateFormula(f, { cell: (c2, r2, s2) => cellIn(tName, c2, r2, s2) });
      memo.set(key, v);
      return v;
    } finally {
      stack.delete(key);
    }
  };

  return sheets.map((s) => {
    const fmap = s.table.formulas;
    if (!fmap || Object.keys(fmap).length === 0) return s;
    let changed = false;
    const rows = s.table.rows.map((row, r) =>
      row.map((v, c): CellValue => {
        if (fmap[`${r},${c}`] === undefined) return v;
        let computed: FormulaValue;
        try {
          computed = cellIn(s.name, c, r + 2);
        } catch {
          return v;
        }
        if ((computed === null || (typeof computed === "number" && !Number.isFinite(computed))) && v !== null) return v;
        const out: CellValue = typeof computed === "boolean" ? (computed ? "TRUE" : "FALSE") : computed;
        if (out !== v) changed = true;
        return out;
      }),
    );
    return changed ? { name: s.name, table: { ...s.table, rows } } : s;
  });
}
