/**
 * Safe arithmetic for the chat's `calculate` tool. LLMs are unreliable at real
 * arithmetic; this gives them a calculator instead. A tiny recursive-descent
 * parser — never `eval`/`Function` (tool arguments are model-controlled and the
 * model reads book text, so expressions are treated as hostile input).
 *
 * Supports: + - * / % ^ (right-assoc), unary minus, parentheses, factorial (!),
 * constants (pi, e), and the common functions. Errors throw with a readable
 * message the chat feeds back to the model.
 */

const MAX_EXPRESSION_CHARS = 300;

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

const FUNCTIONS: Record<string, { arity: 1 | 2; fn: (a: number, b?: number) => number }> = {
  sqrt: { arity: 1, fn: (a) => Math.sqrt(a) },
  cbrt: { arity: 1, fn: (a) => Math.cbrt(a) },
  abs: { arity: 1, fn: (a) => Math.abs(a) },
  ln: { arity: 1, fn: (a) => Math.log(a) },
  log: { arity: 1, fn: (a) => Math.log10(a) },
  log2: { arity: 1, fn: (a) => Math.log2(a) },
  exp: { arity: 1, fn: (a) => Math.exp(a) },
  sin: { arity: 1, fn: (a) => Math.sin(a) },
  cos: { arity: 1, fn: (a) => Math.cos(a) },
  tan: { arity: 1, fn: (a) => Math.tan(a) },
  asin: { arity: 1, fn: (a) => Math.asin(a) },
  acos: { arity: 1, fn: (a) => Math.acos(a) },
  atan: { arity: 1, fn: (a) => Math.atan(a) },
  round: { arity: 1, fn: (a) => Math.round(a) },
  floor: { arity: 1, fn: (a) => Math.floor(a) },
  ceil: { arity: 1, fn: (a) => Math.ceil(a) },
  min: { arity: 2, fn: (a, b) => Math.min(a, b!) },
  max: { arity: 2, fn: (a, b) => Math.max(a, b!) },
  pow: { arity: 2, fn: (a, b) => Math.pow(a, b!) },
  atan2: { arity: 2, fn: (a, b) => Math.atan2(a, b!) },
};

/** Evaluate an arithmetic expression; throws Error with a readable message. */
export function evaluateExpression(expression: string): number {
  const src = expression.trim();
  if (!src) throw new Error("the expression is empty");
  if (src.length > MAX_EXPRESSION_CHARS) throw new Error("the expression is too long");
  const parser = new Parser(src);
  const value = parser.parseExpression();
  parser.expectEnd();
  if (!Number.isFinite(value)) throw new Error("the result is not a finite number");
  return value;
}

/** Human-friendly number: trims float noise, keeps integers exact when safe. */
export function formatCalcResult(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
    return String(value);
  }
  // 12 significant digits, then drop trailing zeros ("0.30000000000000004" → "0.3").
  return String(Number(value.toPrecision(12)));
}

class Parser {
  private pos = 0;
  constructor(private readonly src: string) {}

  parseExpression(): number {
    let value = this.parseTerm();
    for (;;) {
      if (this.eat("+")) value += this.parseTerm();
      else if (this.eat("-")) value -= this.parseTerm();
      else return value;
    }
  }

  expectEnd(): void {
    this.skipSpace();
    if (this.pos < this.src.length) {
      throw new Error(`unexpected "${this.src[this.pos]}" at position ${this.pos + 1}`);
    }
  }

  private parseTerm(): number {
    let value = this.parseUnary();
    for (;;) {
      if (this.eat("*")) value *= this.parseUnary();
      else if (this.eat("/")) value /= this.parseUnary();
      else if (this.eat("%")) value %= this.parseUnary();
      else return value;
    }
  }

  private parseUnary(): number {
    if (this.eat("-")) return -this.parseUnary();
    this.eat("+");
    return this.parsePower();
  }

  private parsePower(): number {
    const base = this.parsePostfix();
    // Right-associative: 2^3^2 = 2^(3^2).
    if (this.eat("^")) return Math.pow(base, this.parseUnary());
    return base;
  }

  private parsePostfix(): number {
    let value = this.parsePrimary();
    while (this.eat("!")) value = factorial(value);
    return value;
  }

  private parsePrimary(): number {
    this.skipSpace();
    const ch = this.src[this.pos];
    if (ch === undefined) throw new Error("the expression ends unexpectedly");
    if (ch === "(") {
      this.pos++;
      const value = this.parseExpression();
      if (!this.eat(")")) throw new Error("missing a closing parenthesis");
      return value;
    }
    if (/[0-9.]/.test(ch)) return this.parseNumber();
    if (/[a-z]/i.test(ch)) return this.parseWord();
    throw new Error(`unexpected "${ch}" at position ${this.pos + 1}`);
  }

  private parseNumber(): number {
    // Commas only as STRICT thousands grouping ("1,234.5") — a loose "[\d,]*"
    // would swallow the argument comma in "pow(2, 10)".
    const m = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e[+-]?\d+)?|^\.\d+/i.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`invalid number at position ${this.pos + 1}`);
    this.pos += m[0].length;
    const value = Number(m[0].replace(/,/g, ""));
    if (Number.isNaN(value)) throw new Error(`invalid number "${m[0]}"`);
    return value;
  }

  private parseWord(): number {
    const m = /^[a-z][a-z0-9]*/i.exec(this.src.slice(this.pos))!;
    const word = m[0].toLowerCase();
    this.pos += m[0].length;
    if (word in CONSTANTS) return CONSTANTS[word]!;
    const fn = FUNCTIONS[word];
    if (!fn) throw new Error(`unknown name "${word}"`);
    this.skipSpace();
    if (!this.eat("(")) throw new Error(`${word} needs parentheses, e.g. ${word}(…)`);
    const first = this.parseExpression();
    if (fn.arity === 1) {
      if (!this.eat(")")) throw new Error(`missing ")" after ${word}(…`);
      return fn.fn(first);
    }
    if (!this.eat(",")) throw new Error(`${word} needs two arguments: ${word}(a, b)`);
    const second = this.parseExpression();
    if (!this.eat(")")) throw new Error(`missing ")" after ${word}(…`);
    return fn.fn(first, second);
  }

  private eat(token: string): boolean {
    this.skipSpace();
    if (this.src.startsWith(token, this.pos)) {
      this.pos += token.length;
      return true;
    }
    return false;
  }

  private skipSpace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
  }
}

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new Error("factorial needs a non-negative integer");
  if (n > 170) throw new Error("factorial overflows beyond 170!");
  let out = 1;
  for (let i = 2; i <= n; i++) out *= i;
  return out;
}
