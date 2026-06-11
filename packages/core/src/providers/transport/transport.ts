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
  /**
   * Multipart file upload (e.g. ComfyUI `/upload/image`). When set, `body` is
   * ignored and the request is sent as `multipart/form-data` with this one file
   * field; `fetch` sets the boundary. Used by the local ComfyUI IP-Adapter path.
   */
  form?: { field: string; bytes: ArrayBuffer; filename: string; contentType: string };
  /**
   * Multipart upload with multiple files and/or text fields (e.g. OpenAI's
   * `/images/edits`, which takes `image[]` references plus `prompt`/`model`/`size`).
   * When set, `body` and `form` are ignored and the request is `multipart/form-data`.
   */
  multipart?: {
    fields?: Record<string, string>;
    files?: { field: string; bytes: ArrayBuffer; filename: string; contentType: string }[];
  };
  /**
   * Optional cancellation signal. When it aborts, the underlying request is
   * cancelled (fetch rejects with an AbortError). Lets a pause stop in-flight LLM
   * extraction / image generation promptly instead of waiting it out.
   */
  signal?: AbortSignal;
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
    let init: RequestInit;
    if (request.multipart) {
      // Multi-file + text-field multipart (let fetch set the boundary).
      const fd = new FormData();
      for (const [k, v] of Object.entries(request.multipart.fields ?? {})) fd.append(k, v);
      for (const f of request.multipart.files ?? []) {
        fd.append(f.field, new Blob([f.bytes], { type: f.contentType }), f.filename);
      }
      init = { method: request.method ?? "POST", headers: { ...request.headers }, body: fd };
    } else if (request.form) {
      // Multipart upload: let fetch set the content-type boundary (don't force JSON).
      const fd = new FormData();
      fd.append(
        request.form.field,
        new Blob([request.form.bytes], { type: request.form.contentType }),
        request.form.filename,
      );
      init = { method: request.method ?? "POST", headers: { ...request.headers }, body: fd };
    } else {
      init = {
        method: request.method ?? "POST",
        headers: { "content-type": "application/json", ...request.headers },
      };
      if (request.body !== undefined) {
        init.body = JSON.stringify(request.body);
      }
    }
    if (request.signal) init.signal = request.signal;
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
