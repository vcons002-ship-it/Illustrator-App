import { base64ToBytes } from "@visual-reader/core";

/**
 * CORS-safe fetch for the content script.
 *
 * In MV3 a content script's `fetch` carries the *page's* origin and is bound by
 * the page's CORS policy, so calling provider APIs (Anthropic / OpenAI / Flux)
 * or a local engine directly fails. The background service worker, however, has
 * host permissions and is exempt from CORS. So `proxyFetch` forwards every
 * request to the worker (see `background.ts`), which performs the real `fetch`
 * and returns the body base64-encoded (messages can't carry binary), and we
 * rebuild a normal `Response` here.
 *
 * It matches the `fetch` signature, so it drops straight into `DirectTransport`
 * (for the REST/local providers) and the Anthropic SDK's `fetch` option.
 */

export interface ProxyFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ProxyFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyBase64: string;
  error?: string;
}

const NO_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

export const proxyFetch: typeof fetch = async (input, init) => {
  // Normalise any (string | URL | Request) + init into a plain, serialisable form.
  const req = new Request(input as RequestInfo, init);
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let body: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const text = await req.clone().text();
    if (text) body = text;
  }

  const result = (await chrome.runtime.sendMessage({
    type: "vr-fetch",
    request: { url: req.url, method: req.method, headers, ...(body !== undefined ? { body } : {}) },
  })) as ProxyFetchResult | undefined;

  if (!result || result.error) {
    throw new TypeError(result?.error ?? "Visual Reader fetch proxy failed");
  }
  const bytes = result.bodyBase64 ? base64ToBytes(result.bodyBase64) : new ArrayBuffer(0);
  return new Response(NO_BODY_STATUS.has(result.status) ? null : bytes, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
};
