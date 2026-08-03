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

export type TvAction = "read_state" | "read_series" | "read_studies" | "probe" | "set_symbol" | "set_interval" | "add_study" | "remove_studies";

export interface TvActionParams {
  symbol?: string;
  interval?: string;
  study?: string;
  /** read_series: how many of the most recent bars to return (1–500). */
  bars?: number;
}

/** Collect an object's callable keys, walking the prototype chain — chart APIs are class
 * instances, so `Object.keys` alone reports almost nothing. A throwing getter is skipped rather
 * than aborting the whole reflection. */
const METHOD_REFLECT =
  "function ms(o){var out=[],seen={};for(var p=o;p&&p!==Object.prototype;p=Object.getPrototypeOf(p)){" +
  "Object.getOwnPropertyNames(p).forEach(function(k){if(seen[k])return;seen[k]=1;try{if(typeof o[k]==='function')out.push(k);}catch(e){}});}return out.sort();}";

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
    /**
     * WHAT THIS BUILD ACTUALLY EXPOSES — read-only reflection, no side effects.
     *
     * Every other action here is a guess about TradingView's internal API that only fails once a
     * reader tries it, and the honest answer to "can you read my chart's data?" was "nobody knows
     * until someone runs it". This turns that into something checkable: it reports which global was
     * found, the widget's and chart's callable methods, and specifically whether the data reads
     * below are available. Run it first when an action stops working.
     */
    case "probe":
      return (
        `(()=>{${METHOD_REFLECT}` +
        "var g=Object.keys(window).filter(function(k){return /^(tv|tradingview)/i.test(k);}).slice(0,20);" +
        "var w=window.tvWidget||window.TradingViewApi;" +
        "if(!w){return JSON.stringify({widget:null,tvGlobals:g,note:'No TradingView widget global found — open a chart, or the API changed (see MARKETS-BRIDGE.md)'});}" +
        "var c=null;try{c=w.activeChart?w.activeChart():(w.chart?w.chart():null);}catch(e){}" +
        "return JSON.stringify({widget:window.tvWidget?'tvWidget':'TradingViewApi',tvGlobals:g," +
        "widgetMethods:ms(w).slice(0,60),chartMethods:c?ms(c).slice(0,80):null," +
        "canReadSeries:!!(c&&typeof c.exportData==='function')," +
        "canListStudies:!!(c&&typeof c.getAllStudies==='function')," +
        "canSetSymbol:!!(c&&typeof c.setSymbol==='function')});})()"
      );
    /**
     * The bars the chart is actually showing.
     *
     * `exportData` is the charting-library call for this and returns a promise — the CDP transport
     * evaluates with `awaitPromise`, so returning one is fine. It is NOT guaranteed to exist in the
     * desktop build, so the absence is reported as itself and pointed at `probe`, rather than
     * throwing something that reads like the chart is missing. Whatever comes back is whatever
     * TradingView is displaying: delayed or real-time according to the reader's own entitlements,
     * not to anything this app can do.
     */
    case "read_series": {
      const bars = Math.max(1, Math.min(500, Math.round(params.bars ?? 100)));
      return (
        `(()=>{${guard}` +
        "if(typeof c.exportData!=='function'){throw new Error('This TradingView build does not expose exportData on the chart — run tv_chart probe to see what it does expose (see MARKETS-BRIDGE.md)');}" +
        "return Promise.resolve(c.exportData({includeTimeValues:true})).then(function(r){" +
        "var rows=(r&&r.data)||[];var tail=rows.slice(" +
        `-${bars});` +
        "return JSON.stringify({symbol:c.symbol&&c.symbol(),interval:c.resolution&&c.resolution()," +
        "schema:(r&&r.schema)||null,totalBars:rows.length,returned:tail.length,bars:tail});});})()"
      );
    }
    /** The studies currently on the chart, by id — the same call `remove_studies` already relies on. */
    case "read_studies":
      return (
        `(()=>{${guard}` +
        "if(typeof c.getAllStudies!=='function'){throw new Error('This TradingView build does not expose getAllStudies — run tv_chart probe (see MARKETS-BRIDGE.md)');}" +
        "return JSON.stringify(c.getAllStudies().map(function(s){return {id:s.id,name:s.name};}));})()"
      );
    case "set_symbol":
      return `(()=>{${guard}c.setSymbol(${js(params.symbol ?? "")});return 'set symbol ${params.symbol}';})()`;
    case "set_interval":
      return `(()=>{${guard}c.setResolution(${js(params.interval ?? "D")});return 'set interval ${params.interval}';})()`;
    case "add_study":
      return `(()=>{${guard}c.createStudy(${js(params.study ?? "")},false,false);return 'added ${params.study}';})()`;
    case "remove_studies":
      return `(()=>{${guard}(c.getAllStudies?c.getAllStudies():[]).forEach(s=>c.removeEntity(s.id));return 'cleared studies';})()`;
  }
  // `inject_pine` and `create_alert` used to live here and neither could work.
  //
  // `inject_pine` called `window.__vrPineInject`, described in a comment as a helper "added in the
  // desktop bridge". It was never added — the identifier existed nowhere else in the codebase — so
  // the action threw every time, while the tool list and MARKETS-BRIDGE.md both advertised Pine
  // injection as a feature.
  //
  // `create_alert` was worse: it checked that an alert API existed and then returned the STRING
  // "alert request: above 123" without calling anything. It set no alert and reported success. It
  // happened to be unreachable (never in the tool's action union), which is the only reason it had
  // not yet lied to anyone.
  //
  // Both are gone rather than stubbed. A capability that cannot work should not be advertised, and
  // `trading_script` already generates Pine the reader pastes in themselves. If they're built for
  // real later, `probe` above is how to find out what this build actually supports first.
}

/** A one-line status for the bridge (for the UI + the model). */
export function describeBridgeStatus(target: CdpTarget | undefined): string {
  if (!target) return "TradingView Desktop not detected on the debug port";
  return `Connected to TradingView (${target.title || target.url || "page"})`;
}
