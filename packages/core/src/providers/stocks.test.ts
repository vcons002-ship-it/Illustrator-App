import { describe, expect, it } from "vitest";
import { formatQuote, parseStooqQuote, parseYahooQuote, sourceLabel, sourceNote, stooqQuoteUrl, stooqSymbol, yahooFetchError, yahooQuoteUrl } from "./stocks.js";

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

describe("yahooQuoteUrl / parseYahooQuote (the keyless quote source)", () => {
  it("builds the keyless chart URL", () => {
    expect(yahooQuoteUrl("aapl")).toBe("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d");
  });

  it("pulls a quote from Yahoo's chart `meta` block (price, day range, volume, time)", () => {
    const json = {
      chart: {
        result: [
          {
            meta: {
              symbol: "AAPL",
              regularMarketPrice: 295.95,
              regularMarketDayHigh: 302.07,
              regularMarketDayLow: 294.38,
              regularMarketVolume: 42329351,
              regularMarketTime: 1781726401,
            },
            indicators: { quote: [{ open: [298.5] }] },
          },
        ],
      },
    };
    const q = parseYahooQuote(json, "AAPL")!;
    expect(q.symbol).toBe("AAPL");
    expect(q.close).toBe(295.95);
    expect(q.high).toBe(302.07);
    expect(q.low).toBe(294.38);
    expect(q.open).toBe(298.5); // from the day's bar when meta has no regularMarketOpen
    expect(q.volume).toBe(42329351);
    expect(q.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns undefined when there's no usable price", () => {
    expect(parseYahooQuote({ chart: { result: [{ meta: {} }] } }, "ZZZZ")).toBeUndefined();
    expect(parseYahooQuote({ chart: { result: [] } }, "X")).toBeUndefined();
    expect(parseYahooQuote("not json", "X")).toBeUndefined();
  });
});

describe("yahooFetchError", () => {
  it("names a rate limit as a rate limit, with what to do about it", () => {
    // Yahoo's failures aren't JSON — a 429 body is the plain text "Edge: Too Many Requests" — so
    // reading the response as JSON turned a throttle into "Unexpected token E", which names neither
    // the cause nor the cure and reads like a bug in the app.
    const msg = yahooFetchError(429)!;
    expect(msg).toMatch(/rate-limit/i);
    expect(msg).toMatch(/wait a minute/i);
    expect(msg).toMatch(/schwab/i); // the entitled way out
  });

  it("separates an unknown ticker from a feed that's down", () => {
    expect(yahooFetchError(404)).toMatch(/check the ticker/i);
    expect(yahooFetchError(503)).toMatch(/having problems/i);
    expect(yahooFetchError(403)).toMatch(/blocking this connection/i);
  });

  it("passes a usable response through untouched", () => {
    expect(yahooFetchError(200)).toBeUndefined();
    expect(yahooFetchError(204)).toBeUndefined();
    expect(yahooFetchError(299)).toBeUndefined();
  });

  it("still says something for a status it doesn't recognise", () => {
    expect(yahooFetchError(302)).toContain("302");
  });
});

describe("sourceLabel / sourceNote — every number says where it came from", () => {
  it("distinguishes the four feeds, which are not interchangeable", () => {
    // Printed bare, "MSFT: 512.30" looks the same whether it's a delayed keyless quote, an entitled
    // broker one, or the reader's own chart — and a reader can't tell which they're acting on.
    expect(sourceLabel("yahoo")).toMatch(/delayed/i);
    expect(sourceLabel("schwab")).toMatch(/entitlements/i);
    expect(sourceLabel("tradingview")).toMatch(/displaying/i);
    expect(sourceLabel("web")).toMatch(/UNVERIFIED/);
  });

  it("names recall as NOT a source, so an unsourced number is refusable", () => {
    const m = sourceLabel("memory");
    expect(m).toMatch(/NOT A SOURCE/);
    expect(m).toMatch(/must not be given as a price/i);
  });

  it("appends the source to a formatted quote, and omits it when none is claimed", () => {
    const q = { symbol: "MSFT", close: 512.3, open: 510 };
    expect(formatQuote(q, "yahoo")).toContain("MSFT: 512.3");
    expect(formatQuote(q, "yahoo")).toContain("Source: Yahoo");
    expect(formatQuote(q)).not.toContain("Source:");
    expect(sourceNote("schwab").startsWith("\n")).toBe(true);
  });
});
