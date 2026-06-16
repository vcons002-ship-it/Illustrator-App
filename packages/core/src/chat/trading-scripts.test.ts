import { describe, expect, it } from "vitest";
import { buildTradingScript, scriptLanguage } from "./trading-scripts.js";

describe("buildTradingScript — Pine", () => {
  it("VWAP cross uses v5 + ta.vwap + alertcondition", () => {
    const s = buildTradingScript("pine", "vwap_cross");
    expect(s).toContain("//@version=5");
    expect(s).toContain("ta.vwap(hlc3)");
    expect(s).toContain("ta.crossover(close, v)");
    expect(s).toContain("alertcondition");
  });
  it("RSI + MA cross honour params", () => {
    expect(buildTradingScript("pine", "rsi", { length: 9, level: 80 })).toContain("ta.rsi(close, 9)");
    expect(buildTradingScript("pine", "rsi", { length: 9, level: 80 })).toContain("crossover(r, 80)");
    const ma = buildTradingScript("pine", "ma_cross", { maType: "ema", fast: 12, slow: 26 });
    expect(ma).toContain("ta.ema(close, 12)");
    expect(ma).toContain("ta.ema(close, 26)");
    expect(buildTradingScript("pine", "price_level", { level: 250 })).toContain("level = 250");
  });
});

describe("buildTradingScript — thinkScript", () => {
  it("VWAP cross uses reference VWAP() + Alert()", () => {
    const s = buildTradingScript("thinkscript", "vwap_cross");
    expect(s).toContain("reference VWAP()");
    expect(s).toContain("crosses above v");
    expect(s).toContain("Alert(");
  });
  it("MA cross picks the right MA function + defaults", () => {
    expect(buildTradingScript("thinkscript", "ma_cross", { maType: "ema" })).toContain("ExpAverage(close, fast)");
    expect(buildTradingScript("thinkscript", "ma_cross", {})).toContain("SimpleMovingAvg(close, fast)");
    expect(buildTradingScript("thinkscript", "rsi", { length: 21 })).toContain("input length = 21;");
  });
});

describe("scriptLanguage", () => {
  it("returns the fenced lang + paste location", () => {
    expect(scriptLanguage("pine").lang).toBe("pine");
    expect(scriptLanguage("thinkscript").where).toMatch(/thinkorswim/);
  });
});
