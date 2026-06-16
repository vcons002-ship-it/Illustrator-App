import { describe, expect, it } from "vitest";
import { formatQuote, parseStooqQuote, stooqQuoteUrl, stooqSymbol } from "./stocks.js";

describe("stooqSymbol", () => {
  it("lower-cases and adds .us for bare US tickers", () => {
    expect(stooqSymbol("AAPL")).toBe("aapl.us");
    expect(stooqSymbol("brk.b")).toBe("brk.b"); // already has a dot
    expect(stooqSymbol("^spx")).toBe("^spx"); // an index symbol
  });
  it("builds the keyless CSV URL", () => {
    expect(stooqQuoteUrl("MSFT")).toBe("https://stooq.com/q/l/?s=msft.us&f=sd2t2ohlcv&h&e=csv");
  });
});

describe("parseStooqQuote", () => {
  it("maps the CSV header + row into a typed quote", () => {
    const csv = "Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-06-15,22:00:02,200.5,205,199,204.25,51000000";
    expect(parseStooqQuote(csv, "AAPL")).toEqual({
      symbol: "AAPL",
      date: "2026-06-15",
      time: "22:00:02",
      open: 200.5,
      high: 205,
      low: 199,
      close: 204.25,
      volume: 51000000,
    });
  });

  it("returns undefined for an unknown symbol (no close / N/D)", () => {
    expect(parseStooqQuote("Symbol,Date,Time,Open,High,Low,Close,Volume\nZZZZ.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D", "ZZZZ")).toBeUndefined();
    expect(parseStooqQuote("Symbol,Close\n", "X")).toBeUndefined();
  });

  it("summarises a quote with change vs open", () => {
    const s = formatQuote({ symbol: "AAPL", open: 200, close: 204, high: 205, low: 199, volume: 1000, date: "2026-06-15" });
    expect(s).toContain("AAPL: 204");
    expect(s).toContain("+4.00 (+2.00% vs open)");
    expect(s).toContain("H 205 / L 199");
  });
});
