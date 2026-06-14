import { describe, expect, it } from "vitest";
import { evaluateMath } from "./math-engine.js";

describe("evaluateMath (grounded CAS via mathjs)", () => {
  it("does exact arithmetic", async () => {
    expect(await evaluateMath("2 + 2 * 5")).toBe("12");
    expect(await evaluateMath("sqrt(144)")).toBe("12");
  });

  it("converts units", async () => {
    const km = await evaluateMath("5 km to mile");
    expect(km).toMatch(/mile/i);
    expect(km).toMatch(/3\.1/);
  });

  it("does linear algebra", async () => {
    expect(await evaluateMath("det([[1, 2], [3, 4]])")).toBe("-2");
  });

  it("differentiates and simplifies symbolically", async () => {
    expect(await evaluateMath("derivative('x^2 + 3 x', 'x')")).toMatch(/2 \* x \+ 3/);
    expect(await evaluateMath("simplify('2 x + 3 x')")).toMatch(/5 \* x/);
  });

  it("computes statistics over a list", async () => {
    expect(await evaluateMath("mean([2, 4, 6])")).toBe("4");
    expect(Number(await evaluateMath("std([2, 4, 4, 4, 5, 5, 7, 9])"))).toBeCloseTo(2.138, 2);
  });

  it("rejects empty and over-long expressions", async () => {
    await expect(evaluateMath("   ")).rejects.toThrow(/empty/);
    await expect(evaluateMath("1+".repeat(600) + "1")).rejects.toThrow(/too long/);
  });

  it("throws a readable error on a bad expression", async () => {
    await expect(evaluateMath("2 +* 3")).rejects.toThrow();
  });

  it("denies the import escape hatch (sandboxed)", async () => {
    await expect(evaluateMath('import("https://x")')).rejects.toThrow();
  });
});
