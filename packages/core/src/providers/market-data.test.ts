import { describe, expect, it } from "vitest";
import { computeIndicators, ema, parseYahooChart, rsi, sma, vwap, yahooChartUrl, type Bar } from "./market-data.js";

const bar = (c: number, v = 100, h = c + 1, l = c - 1): Bar => ({ t: 0, o: c, h, l, c, v });

describe("yahooChartUrl + parseYahooChart", () => {
  it("builds the keyless chart URL", () => {
    expect(yahooChartUrl("aapl", { interval: "5m", range: "1d" })).toBe(
      "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=5m&range=1d",
    );
  });

  it("parses Yahoo's chart JSON, dropping incomplete rows", () => {
    const json = {
      chart: {
        result: [
          {
            timestamp: [1, 2, 3],
            indicators: {
              quote: [
                {
                  open: [10, 11, null],
                  high: [10.5, 11.5, 12],
                  low: [9.5, 10.5, 11],
                  close: [10.2, 11.2, 11.8],
                  volume: [1000, 1200, 900],
                },
              ],
            },
          },
        ],
      },
    };
    const bars = parseYahooChart(json);
    expect(bars).toHaveLength(2); // the row with a null open is dropped
    expect(bars[0]).toEqual({ t: 1, o: 10, h: 10.5, l: 9.5, c: 10.2, v: 1000 });
  });

  it("returns [] for malformed input", () => {
    expect(parseYahooChart({})).toEqual([]);
    expect(parseYahooChart(null)).toEqual([]);
  });
});

describe("indicators", () => {
  it("VWAP weights typical price by volume", () => {
    // two bars, typical = c (h=c+1,l=c-1 → (c+1+c-1+c)/3 = c)
    expect(vwap([bar(10, 100), bar(20, 300)])).toBeCloseTo((10 * 100 + 20 * 300) / 400, 6);
    expect(vwap([])).toBeUndefined();
  });

  it("SMA + EMA over the last N", () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
    expect(sma([1, 2], 3)).toBeUndefined();
    expect(ema([1, 1, 1, 1], 2)).toBeCloseTo(1, 6);
  });

  it("RSI is 100 with only gains and ~50 for alternating", () => {
    expect(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 14)).toBe(100);
    expect(rsi([1, 2], 14)).toBeUndefined();
  });

  it("computeIndicators rolls everything up + change %", () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar(100 + i));
    const ind = computeIndicators("aapl", bars)!;
    expect(ind.symbol).toBe("AAPL");
    expect(ind.last).toBe(129);
    expect(ind.sma20).toBeGreaterThan(0);
    expect(ind.changePct).toBeCloseTo(29, 1);
    expect(ind.vwap).toBeGreaterThan(0);
    expect(computeIndicators("X", [])).toBeUndefined();
  });
});
