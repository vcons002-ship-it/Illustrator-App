/**
 * TradingView Desktop bridge — the keyless "Claude sets it up directly in TradingView"
 * path (the approach from the community MCP servers). TradingView Desktop is an Electron
 * app; launched with remote debugging it exposes the Chrome DevTools Protocol on a local
 * port. The desktop shell (Rust) discovers the TradingView page target and runs JS in it
 * via `Runtime.evaluate`; this module is the PURE, testable heart: it parses the CDP
 * target list, builds the evaluate request, and holds the **action-script registry** — the
 * one place to update when TradingView changes its internal chart API.
 *
 * NOTE: the action JS targets TradingView's charting-library widget (commonly the global
 * `tvWidget` in the desktop app). It is version-sensitive — if an action stops working,
 * update `tvActionScript` here (see MARKETS-BRIDGE.md). Strictly chart-only: it never
 * places trades.
 */

export interface CdpTarget {
  id?: string;
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

/** Pick the TradingView page target from a CDP `/json/list` response. */
export function findTradingViewTarget(targets: CdpTarget[]): CdpTarget | undefined {
  return targets.find(
    (t) =>
      t.type === "page" &&
      !!t.webSocketDebuggerUrl &&
      ((t.url ?? "").toLowerCase().includes("tradingview") || (t.title ?? "").toLowerCase().includes("tradingview")),
  );
}

/** The CDP `Runtime.evaluate` request for an expression (return-by-value, awaits promises). */
export function cdpEvaluate(id: number, expression: string): { id: number; method: string; params: Record<string, unknown> } {
  return { id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } };
}

export type TvAction = "read_state" | "set_symbol" | "set_interval" | "add_study" | "remove_studies" | "inject_pine" | "create_alert";

export interface TvActionParams {
  symbol?: string;
  interval?: string;
  study?: string;
  pine?: string;
  /** For create_alert: a price level + above/below. */
  level?: number;
  direction?: "above" | "below";
}

/** JSON-escape a string for safe embedding inside the evaluated JS. */
function js(value: string): string {
  return JSON.stringify(value);
}

/**
 * The JS to run in the TradingView page for an action. Wrapped so a missing widget API
 * reports a clean error instead of throwing. THIS is the maintenance surface — adjust the
 * widget calls here if a TradingView update changes them.
 */
export function tvActionScript(action: TvAction, params: TvActionParams = {}): string {
  const guard = "var w=window.tvWidget||(window.TradingViewApi);if(!w){throw new Error('TradingView widget not found — open a chart, or the internal API changed (see MARKETS-BRIDGE.md)');}var c=w.activeChart?w.activeChart():w.chart();";
  switch (action) {
    case "read_state":
      return `(()=>{${guard}return JSON.stringify({symbol:c.symbol&&c.symbol(),interval:(c.resolution&&c.resolution())});})()`;
    case "set_symbol":
      return `(()=>{${guard}c.setSymbol(${js(params.symbol ?? "")});return 'set symbol ${params.symbol}';})()`;
    case "set_interval":
      return `(()=>{${guard}c.setResolution(${js(params.interval ?? "D")});return 'set interval ${params.interval}';})()`;
    case "add_study":
      return `(()=>{${guard}c.createStudy(${js(params.study ?? "")},false,false);return 'added ${params.study}';})()`;
    case "remove_studies":
      return `(()=>{${guard}(c.getAllStudies?c.getAllStudies():[]).forEach(s=>c.removeEntity(s.id));return 'cleared studies';})()`;
    case "inject_pine":
      // Pine injection isn't a public widget call; this asks the host UI helper (added in
      // the desktop bridge) to paste it into the Pine editor. Documented as experimental.
      return `(()=>{if(!window.__vrPineInject){throw new Error('Pine injection helper not available in this TradingView build (see MARKETS-BRIDGE.md)');}return window.__vrPineInject(${js(params.pine ?? "")});})()`;
    case "create_alert":
      return `(()=>{${guard}if(!c.createOrderLine&&!w.createAlert){throw new Error('Alert API not exposed; set the alert manually or use Pine alertcondition');}return 'alert request: ${params.direction ?? "cross"} ${params.level ?? ""}';})()`;
  }
}

/** A one-line status for the bridge (for the UI + the model). */
export function describeBridgeStatus(target: CdpTarget | undefined): string {
  if (!target) return "TradingView Desktop not detected on the debug port";
  return `Connected to TradingView (${target.title || target.url || "page"})`;
}
