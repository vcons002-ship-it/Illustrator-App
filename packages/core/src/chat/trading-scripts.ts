/**
 * Generate ready-to-paste TradingView **Pine Script (v5)** and thinkorswim
 * **thinkScript** for the common alert/study patterns a trader asks for — VWAP cross,
 * RSI threshold, moving-average cross, price-level break. These are verified templates
 * (not model-hallucinated syntax), so what the assistant hands you actually compiles
 * when you paste it into TradingView's Pine Editor or thinkorswim's thinkScript editor.
 *
 * Pure: parameter coercion + string templates, unit-tested.
 */

export type ScriptPlatform = "pine" | "thinkscript";
export type ScriptKind = "vwap_cross" | "rsi" | "ma_cross" | "price_level";

export interface ScriptParams {
  /** RSI threshold, or price level for price_level. */
  level?: number;
  /** RSI length (default 14). */
  length?: number;
  /** Fast/slow MA periods for ma_cross. */
  fast?: number;
  slow?: number;
  /** MA type for ma_cross: "sma" or "ema". */
  maType?: "sma" | "ema";
}

function int(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
}
function numOr(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function pine(kind: ScriptKind, p: ScriptParams): string {
  switch (kind) {
    case "vwap_cross":
      return [
        "//@version=5",
        'indicator("VWAP Cross Alert", overlay=true)',
        "v = ta.vwap(hlc3)",
        'plot(v, "VWAP", color=color.orange)',
        "crossUp = ta.crossover(close, v)",
        "crossDn = ta.crossunder(close, v)",
        'alertcondition(crossUp, "Cross above VWAP", "{{ticker}} crossed ABOVE VWAP")',
        'alertcondition(crossDn, "Cross below VWAP", "{{ticker}} crossed BELOW VWAP")',
      ].join("\n");
    case "rsi": {
      const length = int(p.length, 14);
      const level = numOr(p.level, 70);
      return [
        "//@version=5",
        'indicator("RSI Alert")',
        `r = ta.rsi(close, ${length})`,
        'plot(r, "RSI", color=color.purple)',
        `hline(${level})`,
        `alertcondition(ta.crossover(r, ${level}), "RSI above", "{{ticker}} RSI crossed above ${level}")`,
        `alertcondition(ta.crossunder(r, ${level}), "RSI below", "{{ticker}} RSI crossed below ${level}")`,
      ].join("\n");
    }
    case "ma_cross": {
      const fn = p.maType === "ema" ? "ema" : "sma";
      const fast = int(p.fast, 9);
      const slow = int(p.slow, 21);
      return [
        "//@version=5",
        'indicator("MA Cross Alert", overlay=true)',
        `fast = ta.${fn}(close, ${fast})`,
        `slow = ta.${fn}(close, ${slow})`,
        'plot(fast, "Fast", color=color.aqua)',
        'plot(slow, "Slow", color=color.fuchsia)',
        `alertcondition(ta.crossover(fast, slow), "Bullish cross", "{{ticker}} ${fast}/${slow} crossed up")`,
        `alertcondition(ta.crossunder(fast, slow), "Bearish cross", "{{ticker}} ${fast}/${slow} crossed down")`,
      ].join("\n");
    }
    case "price_level": {
      const level = numOr(p.level, 100);
      return [
        "//@version=5",
        'indicator("Price Level Alert", overlay=true)',
        `level = ${level}`,
        "hline(level)",
        `alertcondition(ta.crossover(close, level), "Above", "{{ticker}} crossed above ${level}")`,
        `alertcondition(ta.crossunder(close, level), "Below", "{{ticker}} crossed below ${level}")`,
      ].join("\n");
    }
  }
}

function thinkScript(kind: ScriptKind, p: ScriptParams): string {
  switch (kind) {
    case "vwap_cross":
      return [
        "# VWAP Cross Alert (thinkorswim)",
        "def v = reference VWAP();",
        "plot VWAP = v;",
        "VWAP.SetDefaultColor(Color.ORANGE);",
        'Alert(close crosses above v, "Crossed above VWAP", Alert.BAR, Sound.Ding);',
        'Alert(close crosses below v, "Crossed below VWAP", Alert.BAR, Sound.Ding);',
      ].join("\n");
    case "rsi": {
      const length = int(p.length, 14);
      const level = numOr(p.level, 70);
      return [
        "# RSI Alert (thinkorswim)",
        `input length = ${length};`,
        `input level = ${level};`,
        "def r = RSI(length = length);",
        "plot RSI = r;",
        'Alert(r crosses above level, "RSI above " + level, Alert.BAR, Sound.Ring);',
        'Alert(r crosses below level, "RSI below " + level, Alert.BAR, Sound.Ring);',
      ].join("\n");
    }
    case "ma_cross": {
      const fn = p.maType === "ema" ? "ExpAverage" : "SimpleMovingAvg";
      const fast = int(p.fast, 9);
      const slow = int(p.slow, 21);
      return [
        "# MA Cross Alert (thinkorswim)",
        `input fast = ${fast};`,
        `input slow = ${slow};`,
        `def f = ${fn}(close, fast);`,
        `def s = ${fn}(close, slow);`,
        "plot Fast = f;",
        "plot Slow = s;",
        'Alert(f crosses above s, "Bullish cross", Alert.BAR, Sound.Bell);',
        'Alert(f crosses below s, "Bearish cross", Alert.BAR, Sound.Bell);',
      ].join("\n");
    }
    case "price_level": {
      const level = numOr(p.level, 100);
      return [
        "# Price Level Alert (thinkorswim)",
        `input level = ${level};`,
        "plot Level = level;",
        'Alert(close crosses above level, "Above " + level, Alert.BAR, Sound.Ding);',
        'Alert(close crosses below level, "Below " + level, Alert.BAR, Sound.Ding);',
      ].join("\n");
    }
  }
}

/** Build a verified Pine / thinkScript alert study for a kind + params. */
export function buildTradingScript(platform: ScriptPlatform, kind: ScriptKind, params: ScriptParams = {}): string {
  return platform === "pine" ? pine(kind, params) : thinkScript(kind, params);
}

/** The fenced-code language tag + where to paste each platform's script. */
export function scriptLanguage(platform: ScriptPlatform): { lang: string; where: string } {
  return platform === "pine"
    ? { lang: "pine", where: "TradingView → Pine Editor → paste → Add to chart, then create an alert on the indicator" }
    : { lang: "thinkscript", where: "thinkorswim → Studies → Edit Studies → Create → paste → and (for alerts) the study's Alert() fires" };
}
