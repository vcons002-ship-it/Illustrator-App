import type { ProxyFetchRequest, ProxyFetchResult } from "./message-transport.js";

/**
 * Service worker. Two jobs:
 *  1. Toolbar click toggles the overlay in the active tab.
 *  2. CORS-safe network proxy: the content script can't call provider APIs or a
 *     local engine directly (page CORS), so it forwards requests here, where the
 *     worker's host permissions exempt it from CORS. We return the body
 *     base64-encoded since `chrome.runtime` messages can't carry binary.
 *
 * The engine/providers themselves live in the content script so it shares the
 * exact same `@visual-reader/core` engine as the web app.
 */
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  chrome.tabs.sendMessage(tab.id, { type: "visual-reader/toggle" }).catch(() => {
    // Content script may not be injected on this page (e.g. chrome:// URLs).
  });
});

chrome.runtime.onMessage.addListener((msg: { type?: string; request?: ProxyFetchRequest }, _sender, sendResponse) => {
  if (msg?.type === "vr-fetch" && msg.request) {
    void proxyFetch(msg.request).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  return undefined;
});

async function proxyFetch(req: ProxyFetchRequest): Promise<ProxyFetchResult> {
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    const buffer = await res.arrayBuffer();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers,
      bodyBase64: bytesToBase64(buffer),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      statusText: "",
      headers: {},
      bodyBase64: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
