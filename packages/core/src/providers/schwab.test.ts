import { describe, expect, it } from "vitest";
import {
  buildEquityOrder,
  buildOptionOrder,
  describeOrder,
  buildSchwabAuthUrl,
  exchangeSchwabCode,
  parseOptionChain,
  parseSchwabPositions,
  parseSchwabQuote,
  placeSchwabOrder,
  schwabAccountNumbers,
} from "./schwab.js";
import type { Transport, TransportRequest, TransportResponse } from "./transport/transport.js";

class FakeTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  constructor(private readonly json: unknown, private readonly ok = true) {}
  send(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    return Promise.resolve({
      ok: this.ok,
      status: this.ok ? 200 : 400,
      json: <T>() => Promise.resolve(this.json as T),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      text: () => Promise.resolve(""),
    });
  }
}

describe("buildSchwabAuthUrl", () => {
  it("builds the authorization-code consent URL", () => {
    const url = new URL(buildSchwabAuthUrl({ clientId: "cid", redirectUri: "https://127.0.0.1", state: "st" }));
    expect(url.origin + url.pathname).toBe("https://api.schwabapi.com/v1/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("https://127.0.0.1");
  });
});

describe("exchangeSchwabCode", () => {
  it("POSTs Basic-auth + form fields and returns tokens with an expiry", async () => {
    const t = new FakeTransport({ access_token: "at", refresh_token: "rt", expires_in: 1800 });
    const before = Date.now();
    const tokens = await exchangeSchwabCode({ transport: t, clientId: "cid", clientSecret: "sec", code: "code123", redirectUri: "https://127.0.0.1" });
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 1800_000);
    const req = t.requests[0]!;
    expect(req.url).toBe("https://api.schwabapi.com/v1/oauth/token");
    expect(req.headers?.authorization).toBe(`Basic ${btoa("cid:sec")}`);
    expect(req.formEncoded).toMatchObject({ grant_type: "authorization_code", code: "code123" });
  });

  it("throws Schwab's error_description on failure", async () => {
    const t = new FakeTransport({ error: "invalid_grant", error_description: "Bad code" }, false);
    await expect(exchangeSchwabCode({ transport: t, clientId: "c", clientSecret: "s", code: "x", redirectUri: "r" })).rejects.toThrow(/Bad code/);
  });
});

describe("parseSchwabQuote", () => {
  it("pulls the quote fields for a symbol", () => {
    const json = { AAPL: { quote: { lastPrice: 204.25, bidPrice: 204.2, askPrice: 204.3, netChange: 4, netPercentChange: 2, totalVolume: 51_000_000 } } };
    expect(parseSchwabQuote(json, "aapl")).toEqual({ symbol: "AAPL", last: 204.25, bid: 204.2, ask: 204.3, netChange: 4, netPercentChange: 2, volume: 51_000_000 });
    expect(parseSchwabQuote({}, "AAPL")).toBeUndefined();
  });
});

describe("parseOptionChain", () => {
  it("flattens call/put exp maps with Greeks + IV", () => {
    const json = {
      symbol: "AAPL",
      underlyingPrice: 204,
      callExpDateMap: {
        "2026-06-20:5": {
          "200.0": [
            { putCall: "CALL", symbol: "AAPL_062026C200", strikePrice: 200, expirationDate: "2026-06-20", bid: 6.1, ask: 6.3, last: 6.2, delta: 0.62, gamma: 0.03, theta: -0.08, vega: 0.12, rho: 0.05, volatility: 28.5, openInterest: 1500, totalVolume: 320, inTheMoney: true },
          ],
        },
      },
      putExpDateMap: {
        "2026-06-20:5": { "200.0": [{ putCall: "PUT", strikePrice: 200, delta: -0.38, volatility: 29.1 }] },
      },
    };
    const chain = parseOptionChain(json)!;
    expect(chain.symbol).toBe("AAPL");
    expect(chain.underlyingPrice).toBe(204);
    expect(chain.contracts).toHaveLength(2);
    const call = chain.contracts.find((c) => c.type === "CALL")!;
    expect(call).toMatchObject({ strike: 200, delta: 0.62, theta: -0.08, iv: 28.5, inTheMoney: true });
    expect(chain.contracts.find((c) => c.type === "PUT")!.delta).toBe(-0.38);
    expect(parseOptionChain({})).toBeUndefined();
  });
});

describe("parseSchwabPositions + buildEquityOrder", () => {
  it("nets long/short into positions", () => {
    const json = [
      { securitiesAccount: { positions: [{ instrument: { symbol: "AAPL" }, longQuantity: 100, shortQuantity: 0, marketValue: 20400, averagePrice: 190 }, { instrument: { symbol: "TSLA" }, longQuantity: 0, shortQuantity: 0 }] } },
    ];
    expect(parseSchwabPositions(json)).toEqual([{ symbol: "AAPL", quantity: 100, marketValue: 20400, averagePrice: 190 }]);
  });
  it("builds a reviewable single-leg equity order", () => {
    const o = buildEquityOrder({ symbol: "aapl", quantity: 10, instruction: "BUY", orderType: "LIMIT", price: 200 });
    expect(o).toMatchObject({ orderType: "LIMIT", price: 200, orderStrategyType: "SINGLE" });
    expect((o.orderLegCollection as { instruction: string; instrument: { symbol: string } }[])[0]).toMatchObject({ instruction: "BUY", instrument: { symbol: "AAPL" } });
  });
});

describe("option order + place", () => {
  it("builds an option order and describes it", () => {
    const o = buildOptionOrder({ optionSymbol: "AAPL  260620C00200000", quantity: 1, instruction: "BUY_TO_OPEN", orderType: "LIMIT", price: 6.25 });
    expect(o).toMatchObject({ orderType: "LIMIT", price: 6.25, complexOrderStrategyType: "NONE" });
    expect((o.orderLegCollection as { instruction: string; instrument: { assetType: string } }[])[0]).toMatchObject({ instruction: "BUY_TO_OPEN", instrument: { assetType: "OPTION" } });
    expect(describeOrder(o)).toMatch(/BUY_TO_OPEN 1 AAPL.*OPTION.*LIMIT @ 6.25/);
  });

  it("reads account numbers + posts an order to the account hash", async () => {
    const accts = new FakeTransport([{ accountNumber: "123", hashValue: "HASH123" }]);
    expect(await schwabAccountNumbers(accts, "tok")).toEqual([{ accountNumber: "123", hashValue: "HASH123" }]);

    const place = new FakeTransport({});
    const r = await placeSchwabOrder(place, "tok", "HASH123", buildEquityOrder({ symbol: "AAPL", quantity: 1, instruction: "BUY", orderType: "MARKET" }));
    expect(r.ok).toBe(true);
    const req = place.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/accounts/HASH123/orders");
    expect(req.headers?.authorization).toBe("Bearer tok");
  });
});
