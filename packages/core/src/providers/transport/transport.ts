/**
 * Transport seam — the abstraction that makes "client now, server-ready" real.
 *
 * v1 ships `DirectTransport`, which calls provider APIs straight from the
 * client with a bring-your-own key. Later, a `ProxyTransport` pointing at a
 * hosted backend (Supabase edge function) can be dropped in with zero changes
 * at provider call sites — providers only ever see this interface.
 */

export interface TransportRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** JSON-serialisable body. */
  body?: unknown;
}

export interface TransportResponse {
  ok: boolean;
  status: number;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface Transport {
  send(request: TransportRequest): Promise<TransportResponse>;
}

/**
 * Calls the network directly using `fetch`. The `fetch` implementation is
 * injectable so non-page hosts can route requests elsewhere — e.g. the Chrome
 * extension proxies through its background service worker (which has host
 * permissions and is not bound by page CORS). Defaults to the platform `fetch`,
 * wrapped so it is always invoked with the global `this` (avoids "Illegal
 * invocation" when held on an instance field).
 */
export class DirectTransport implements Transport {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async send(request: TransportRequest): Promise<TransportResponse> {
    const init: RequestInit = {
      method: request.method ?? "POST",
      headers: {
        "content-type": "application/json",
        ...request.headers,
      },
    };
    if (request.body !== undefined) {
      init.body = JSON.stringify(request.body);
    }
    const res = await this.fetchImpl(request.url, init);
    return {
      ok: res.ok,
      status: res.status,
      json: <T>() => res.json() as Promise<T>,
      arrayBuffer: () => res.arrayBuffer(),
      text: () => res.text(),
    };
  }
}
