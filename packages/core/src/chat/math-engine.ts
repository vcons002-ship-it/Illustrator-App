import type { MathJsInstance } from "mathjs";

/**
 * Grounded math for the chat's `calculate` tool, upgraded from plain arithmetic to a
 * real (but SANDBOXED) computer-algebra engine via mathjs: unit conversions, matrices
 * and linear algebra, derivatives / simplify, big-number precision, combinatorics and
 * statistics — keyless, offline, deterministic. The expression comes from the model
 * (which reads book text), so it's treated as hostile input: `import` and `createUnit`
 * — mathjs's only escape hatches — are disabled, the length is capped, and mathjs's
 * v11+ parser has no `eval`/prototype access. `calculator.ts`'s tiny no-dependency
 * parser remains the fallback when mathjs can't load.
 */

export const MAX_MATH_EXPRESSION_CHARS = 1000;

let mathPromise: Promise<MathJsInstance> | undefined;

async function mathReady(): Promise<MathJsInstance> {
  if (!mathPromise) {
    mathPromise = (async () => {
      const { create, all } = await import("mathjs");
      const math = create(all!, {});
      const blocked = (): never => {
        throw new Error("That function is disabled.");
      };
      // The documented hardening: import/createUnit are the only ways an expression
      // could reach beyond pure math, so deny them. reviver too (JSON revival).
      math.import({ import: blocked, createUnit: blocked, reviver: blocked }, { override: true });
      return math;
    })();
  }
  return mathPromise;
}

/**
 * Evaluate a math expression and return a formatted string result. Throws an Error
 * with a readable message on a bad expression (which the chat feeds back to the model)
 * OR when mathjs can't be loaded (so the caller can fall back to plain arithmetic).
 */
export async function evaluateMath(expression: string): Promise<string> {
  const expr = expression.trim();
  if (!expr) throw new Error("empty expression");
  if (expr.length > MAX_MATH_EXPRESSION_CHARS) throw new Error("expression too long");
  const math = await mathReady();
  const result = math.evaluate(expr);
  return formatMathResult(math, result);
}

function formatMathResult(math: MathJsInstance, result: unknown): string {
  // simplify / derivative return a parse Node — its toString is the symbolic form.
  if (result && typeof result === "object" && (result as { isNode?: boolean }).isNode === true) {
    return (result as { toString(): string }).toString();
  }
  if (typeof result === "string") return result;
  try {
    return math.format(result, { precision: 12 });
  } catch {
    return String(result);
  }
}
