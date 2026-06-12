import { describe, expect, it } from "vitest";
import { evaluateExpression, formatCalcResult } from "./calculator.js";

describe("evaluateExpression", () => {
  it("handles precedence, parentheses, and right-associative powers", () => {
    expect(evaluateExpression("2+3*4")).toBe(14);
    expect(evaluateExpression("(2+3)*4")).toBe(20);
    expect(evaluateExpression("2^3^2")).toBe(512); // right-assoc: 2^(3^2)
    expect(evaluateExpression("-3^2")).toBe(-9); // unary minus binds looser than ^
    expect(evaluateExpression("10 % 3")).toBe(1);
  });

  it("supports functions, constants, factorial, commas and exponents", () => {
    expect(evaluateExpression("sqrt(144)")).toBe(12);
    expect(evaluateExpression("pow(2, 10)")).toBe(1024);
    expect(evaluateExpression("min(3, max(1, 2))")).toBe(2);
    expect(evaluateExpression("cos(0) + sin(0)")).toBe(1);
    expect(evaluateExpression("5!")).toBe(120);
    expect(evaluateExpression("1,234.5 * 2")).toBe(2469);
    expect(evaluateExpression("1.5e3 + 1")).toBe(1501);
    expect(evaluateExpression("2 * pi")).toBeCloseTo(6.2831853, 6);
  });

  it("rejects malformed and hostile input with readable errors", () => {
    expect(() => evaluateExpression("")).toThrow("empty");
    expect(() => evaluateExpression("2 +")).toThrow("ends unexpectedly");
    expect(() => evaluateExpression("(2+3")).toThrow("closing parenthesis");
    expect(() => evaluateExpression("system('rm')")).toThrow('unknown name "system"');
    expect(() => evaluateExpression("2; 3")).toThrow("unexpected");
    expect(() => evaluateExpression("1/0")).toThrow("not a finite number");
    expect(() => evaluateExpression("200!")).toThrow("overflows");
    expect(() => evaluateExpression("(-1)!")).toThrow("non-negative integer");
    expect(() => evaluateExpression("9".repeat(400))).toThrow("too long");
  });
});

describe("formatCalcResult", () => {
  it("keeps integers exact and trims float noise", () => {
    expect(formatCalcResult(120)).toBe("120");
    expect(formatCalcResult(0.1 + 0.2)).toBe("0.3");
    expect(formatCalcResult(Math.PI)).toBe("3.14159265359");
  });
});
