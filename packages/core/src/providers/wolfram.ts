import { DirectTransport, type Transport } from "./transport/transport.js";

/**
 * Wolfram|Alpha grounding for the chat — the OPTIONAL real-world-data layer on top of
 * the keyless `calculate` tool (mathjs). Where mathjs computes, Wolfram answers
 * natural-language queries against curated knowledge + computation: real-world data
 * (populations, chemistry, constants, finance, nutrition…), equation solving, and
 * step-by-step results. Uses the **LLM API** (plain text tuned for tool use). Needs a
 * free AppID; without one the chat just falls back to `calculate`.
 *
 * The endpoint isn't CORS-open, so in the plain web app this rides the same proxy the
 * keyless search uses (desktop `http_fetch` / the extension worker); a direct call
 * from a browser tab will fail CORS and the tool degrades to an error the model
 * recovers from.
 */

const WOLFRAM_LLM_API = "https://www.wolframalpha.com/api/v1/llm-api";

export async function queryWolfram(opts: {
  appId: string;
  query: string;
  transport?: Transport;
  signal?: AbortSignal;
  /** Cap the response so a verbose result can't blow the chat context. */
  maxChars?: number;
}): Promise<string> {
  const t = opts.transport ?? new DirectTransport();
  const max = opts.maxChars ?? 2000;
  const url =
    `${WOLFRAM_LLM_API}?appid=${encodeURIComponent(opts.appId)}` +
    `&input=${encodeURIComponent(opts.query)}&maxchars=${max}`;
  const res = await t.send({ url, method: "GET", ...(opts.signal ? { signal: opts.signal } : {}) });
  const text = (await res.text()).trim();
  if (!res.ok) {
    // On a miss Wolfram returns 501 with a short explanation / suggestions — surface it.
    throw new Error(text.slice(0, 300) || `Wolfram|Alpha error ${res.status}`);
  }
  if (!text) throw new Error("Wolfram|Alpha returned nothing for that query.");
  return text.slice(0, max);
}
