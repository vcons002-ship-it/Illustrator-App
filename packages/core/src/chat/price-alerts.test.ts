import { describe, expect, it } from "vitest";
import { advanceAlert, describeAlert, evaluateAlert, normalizePriceAlert, type PriceAlert } from "./price-alerts.js";
import type { Indicators } from "../providers/market-data.js";

const ind = (over: Partial<Indicators> = {}): Indicators => ({ symbol: "AAPL", bars: 50, last: 204, vwap: 200, rsi14: 65, changePct: 1.5, ...over });
const make = (over: Partial<PriceAlert> & { type: PriceAlert["type"] }): PriceAlert =>
  normalizePriceAlert({ symbol: "AAPL", value: 200, ...over })!;

describe("normalizePriceAlert", () => {
  it("requires a value for threshold types, not for cross_vwap", () => {
    expect(normalizePriceAlert({ symbol: "AAPL", type: "above" })).toBeUndefined();
    expect(normalizePriceAlert({ symbol: "AAPL", type: "above", value: 210 })).toMatchObject({ symbol: "AAPL", value: 210 });
    expect(normalizePriceAlert({ symbol: "aapl", type: "cross_vwap" })).toMatchObject({ symbol: "AAPL", type: "cross_vwap" });
  });
});

describe("evaluateAlert", () => {
  it("above / below / pct_move / rsi thresholds", () => {
    expect(evaluateAlert(make({ type: "above", value: 200 }), ind()).fired).toBe(true);
    expect(evaluateAlert(make({ type: "above", value: 210 }), ind()).fired).toBe(false);
    expect(evaluateAlert(make({ type: "below", value: 205 }), ind()).fired).toBe(true);
    expect(evaluateAlert(make({ type: "pct_move", value: 1 }), ind({ changePct: 1.5 })).fired).toBe(true);
    expect(evaluateAlert(make({ type: "pct_move", value: 1 }), ind({ changePct: -2 })).fired).toBe(true); // ± both ways
    expect(evaluateAlert(make({ type: "rsi_above", value: 70 }), ind({ rsi14: 72 })).fired).toBe(true);
    expect(evaluateAlert(make({ type: "rsi_below", value: 30 }), ind({ rsi14: 25 })).fired).toBe(true);
  });

  it("cross_vwap fires only on a side flip and reports the new side", () => {
    const a = make({ type: "cross_vwap" });
    // first eval: no prior side → not fired, records side
    const first = evaluateAlert(a, ind({ last: 204, vwap: 200 }));
    expect(first.fired).toBe(false);
    expect(first.newSide).toBe("above");
    const a2 = advanceAlert(a, first, "t");
    expect(a2.lastSide).toBe("above");
    // now price drops below VWAP → flip → fires
    const flip = evaluateAlert(a2, ind({ last: 198, vwap: 200 }));
    expect(flip.fired).toBe(true);
    expect(flip.message).toMatch(/crossed below VWAP/);
  });
});

describe("advanceAlert", () => {
  it("disables a one-shot threshold alert after firing, keeps cross_vwap enabled", () => {
    const above = make({ type: "above", value: 200 });
    const fired = advanceAlert(above, { fired: true }, "t");
    expect(fired.enabled).toBe(false);
    expect(fired.lastFiredIso).toBe("t");
    const cross = make({ type: "cross_vwap", lastSide: "below" });
    const adv = advanceAlert(cross, { fired: true, newSide: "above" }, "t");
    expect(adv.enabled).toBe(true);
    expect(adv.lastSide).toBe("above");
  });
});

describe("describeAlert", () => {
  it("reads naturally", () => {
    expect(describeAlert(make({ type: "below", value: 200 }))).toBe("AAPL drops below 200");
    expect(describeAlert(make({ type: "cross_vwap" }))).toBe("AAPL crosses VWAP");
  });
});
