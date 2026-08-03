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
    // every action is wrapped in an IIFE
    for (const a of ["read_state", "read_series", "read_studies", "probe", "set_symbol", "set_interval", "add_study", "remove_studies"] as const) {
      expect(tvActionScript(a, { symbol: "X", interval: "D", study: "S", bars: 10 })).toMatch(/^\(\(\)=>\{/);
    }
  });

  it("probe reports what the build exposes without touching the chart", () => {
    const s = tvActionScript("probe");
    expect(s).toContain("canReadSeries");
    expect(s).toContain("chartMethods");
    // Read-only: it must not set, create or remove anything while reporting.
    expect(s).not.toMatch(/setSymbol\(|createStudy\(|removeEntity\(|setResolution\(/);
  });

  it("read_series asks for the displayed bars and bounds how many come back", () => {
    expect(tvActionScript("read_series", { bars: 25 })).toContain("rows.slice(-25)");
    expect(tvActionScript("read_series")).toContain("rows.slice(-100)"); // default
    expect(tvActionScript("read_series", { bars: 9999 })).toContain("rows.slice(-500)"); // capped
    expect(tvActionScript("read_series", { bars: 0 })).toContain("rows.slice(-1)");
    // Absence of the API is reported AS ITSELF, pointing at probe — not as a missing chart.
    expect(tvActionScript("read_series")).toContain("does not expose exportData");
    expect(tvActionScript("read_series")).toContain("probe");
  });

  it("no longer emits the two actions that could never work", () => {
    // inject_pine called a helper (`__vrPineInject`) that was never added to the codebase, and
    // create_alert returned a success string without creating an alert. Both were advertised.
    const all = (["read_state", "read_series", "read_studies", "probe", "set_symbol", "set_interval", "add_study", "remove_studies"] as const)
      .map((a) => tvActionScript(a, { symbol: "X", study: "S" }))
      .join("\n");
    expect(all).not.toContain("__vrPineInject");
    expect(all).not.toContain("alert request");
  });
});

describe("describeBridgeStatus", () => {
  it("reports connected / not detected", () => {
    expect(describeBridgeStatus(undefined)).toMatch(/not detected/);
    expect(describeBridgeStatus({ title: "Apple — TradingView" })).toMatch(/Connected to TradingView/);
  });
});
