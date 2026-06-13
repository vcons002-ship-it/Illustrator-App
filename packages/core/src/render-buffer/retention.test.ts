import { describe, expect, it } from "vitest";
import { planRetention, type RetentionItem } from "./retention.js";

/** A book of `n` rendered (resident) units. */
function residentBook(n: number): Map<number, RetentionItem> {
  const m = new Map<number, RetentionItem>();
  for (let u = 0; u < n; u++) m.set(u, { image: {}, requestId: `r${u}` });
  return m;
}
/** Mark a unit evicted: bytes dropped (no `image`), still cached + reloadable. */
function evict(m: Map<number, RetentionItem>, unit: number): void {
  m.set(unit, { evicted: true, requestId: `r${unit}` });
}

describe("planRetention", () => {
  it("leaves a typical-length book untouched (under the resident floor)", () => {
    const plan = planRetention(residentBook(80), 40, 30, 100);
    expect(plan.evict).toEqual([]);
    expect(plan.reload).toEqual([]);
  });

  it("evicts only units far from the reader once a book is large", () => {
    const plan = planRetention(residentBook(400), 200, 30, 100);
    // Within ±30 of unit 200 stay; everything outside is evicted.
    expect(plan.evict).not.toContain(200);
    expect(plan.evict).not.toContain(170);
    expect(plan.evict).not.toContain(230);
    expect(plan.evict).toContain(100);
    expect(plan.evict).toContain(399);
    expect(plan.evict).toContain(169);
    expect(plan.evict).toContain(231);
  });

  it("reloads evicted units back in the window — even below the resident floor", () => {
    // Almost everything evicted (resident count tiny, below the floor).
    const m = residentBook(400);
    for (let u = 0; u < 400; u++) if (Math.abs(u - 50) > 30) evict(m, u);
    // Reader among the resident units → nothing to reload.
    expect(planRetention(m, 50, 30, 100).reload).toEqual([]);
    // Reader jumps into evicted territory → those units reload.
    const plan = planRetention(m, 200, 30, 100);
    expect(plan.reload.map((r) => r.unit)).toContain(200);
    expect(plan.reload.find((r) => r.unit === 200)?.requestId).toBe("r200");
    expect(plan.evict).toEqual([]); // below the floor: never evict
  });

  it("never reloads a unit that lacks a requestId", () => {
    const m = residentBook(400);
    m.set(200, { evicted: true }); // evicted but no cache key
    expect(planRetention(m, 200, 30, 100).reload.find((r) => r.unit === 200)).toBeUndefined();
  });
});
