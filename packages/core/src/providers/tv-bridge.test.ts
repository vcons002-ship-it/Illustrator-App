import { describe, expect, it } from "vitest";
import { cdpEvaluate, describeBridgeStatus, findTradingViewTarget, tvActionScript, type CdpTarget } from "./tv-bridge.js";

describe("findTradingViewTarget", () => {
  it("picks the TradingView page target (by url or title) that has a debugger url", () => {
    const targets: CdpTarget[] = [
      { type: "page", title: "New Tab", url: "chrome://newtab", webSocketDebuggerUrl: "ws://x/1" },
      { type: "page", title: "Apple — TradingView", url: "https://www.tradingview.com/chart/", webSocketDebuggerUrl: "ws://x/2" },
      { type: "service_worker", url: "https://tradingview.com/sw", webSocketDebuggerUrl: "ws://x/3" },
    ];
    expect(findTradingViewTarget(targets)?.webSocketDebuggerUrl).toBe("ws://x/2");
    expect(findTradingViewTarget([{ type: "page", url: "https://google.com" }])).toBeUndefined();
  });
});

describe("cdpEvaluate", () => {
  it("builds a Runtime.evaluate request", () => {
    expect(cdpEvaluate(7, "1+1")).toEqual({ id: 7, method: "Runtime.evaluate", params: { expression: "1+1", returnByValue: true, awaitPromise: true } });
  });
});

describe("tvActionScript", () => {
  it("emits guarded JS per action with params escaped", () => {
    expect(tvActionScript("read_state")).toContain("activeChart");
    const sym = tvActionScript("set_symbol", { symbol: "AAPL" });
    expect(sym).toContain('c.setSymbol("AAPL")');
    expect(tvActionScript("set_interval", { interval: "60" })).toContain('c.setResolution("60")');
    expect(tvActionScript("add_study", { study: "Volume Weighted Average Price" })).toContain('c.createStudy("Volume Weighted Average Price"');
    expect(tvActionScript("inject_pine", { pine: 'study("x")' })).toContain("__vrPineInject");
    // every action is wrapped in an IIFE
    for (const a of ["read_state", "set_symbol", "set_interval", "add_study", "remove_studies", "inject_pine", "create_alert"] as const) {
      expect(tvActionScript(a, { symbol: "X", interval: "D", study: "S", pine: "p", level: 1, direction: "above" })).toMatch(/^\(\(\)=>\{/);
    }
  });
});

describe("describeBridgeStatus", () => {
  it("reports connected / not detected", () => {
    expect(describeBridgeStatus(undefined)).toMatch(/not detected/);
    expect(describeBridgeStatus({ title: "Apple — TradingView" })).toMatch(/Connected to TradingView/);
  });
});
