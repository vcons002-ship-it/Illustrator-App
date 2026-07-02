/**
 * Minimal SSE consumer for the providers' streaming chat endpoints. The
 * `Transport` seam deliberately buffers whole responses, so streaming uses an
 * injectable raw `fetch` instead — the same pattern as Ollama's `pullModel`.
 * Through a non-streaming host fetch (the extension's background proxy, which
 * rebuilds a full Response) this still works: the "stream" just arrives as one
 * chunk, degrading to the buffered behaviour instead of breaking.
 */

/** Bound on the CONNECT phase only (until response headers arrive) — a dead server must fail fast,
 * but the stream itself may legitimately run for many minutes, so the timer is cleared the moment
 * the connection is established rather than being tied to the whole request. */
const SSE_CONNECT_TIMEOUT_MS = 30_000;

/** POST `body` to `url`, parse the SSE response, invoke `onEvent` per data event.
 * Throws with the response body's text on a non-ok status. */
export async function streamSse(
  fetchImpl: typeof fetch,
  url: string,
  opts: {
    headers?: Record<string, string>;
    body: unknown;
    signal?: AbortSignal;
    onEvent: (data: unknown) => void;
  },
): Promise<void> {
  // A fetch signal governs the body read too, so a plain AbortSignal.timeout would kill a long
  // stream mid-read — instead abort via a controller whose timer dies once headers are in. The
  // caller's own signal is composed in, so it still cancels mid-stream as before.
  const connect = new AbortController();
  const connectTimer = setTimeout(
    () => connect.abort(new DOMException("SSE connect timed out", "TimeoutError")),
    SSE_CONNECT_TIMEOUT_MS,
  );
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...opts.headers },
      body: JSON.stringify(opts.body),
      signal: opts.signal ? AbortSignal.any([opts.signal, connect.signal]) : connect.signal,
    });
  } finally {
    clearTimeout(connectTimer);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).trim().slice(0, 300);
    throw new Error(`status ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  if (!res.body) {
    // A host without body streaming (very old proxy): parse the whole text once.
    parseSseChunk(await res.text(), opts.onEvent, { buffer: "" });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const state = { buffer: "" };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parseSseChunk(decoder.decode(value, { stream: true }), opts.onEvent, state);
  }
  // Flush a final event that lacked a trailing newline.
  parseSseChunk("\n\n", opts.onEvent, state);
}

/** Incremental SSE line parser: `data: {...}` events, multi-line safe, "[DONE]" skipped. */
function parseSseChunk(
  chunk: string,
  onEvent: (data: unknown) => void,
  state: { buffer: string },
): void {
  state.buffer += chunk;
  // Events are separated by a blank line; keep the trailing partial in the buffer.
  const events = state.buffer.split(/\r?\n\r?\n/);
  state.buffer = events.pop() ?? "";
  for (const event of events) {
    // An event's data may span multiple `data:` lines (joined per the SSE spec).
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      onEvent(JSON.parse(data));
    } catch {
      /* tolerate malformed frames (some servers emit keep-alives/comments) */
    }
  }
}
