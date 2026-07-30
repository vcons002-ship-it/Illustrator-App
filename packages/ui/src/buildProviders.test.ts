import { describe, expect, it } from "vitest";
import { supportsChat } from "@visual-reader/core";
import { buildProviders } from "./buildProviders.js";
import { DEFAULT_SETTINGS, type ReaderSettings } from "./SettingsPanel.js";

/**
 * Wiring tests for the search/grounding slots of buildProviders. The interesting
 * contract is WHICH credentials activate search: the dedicated Custom Search key
 * wins, the Gemini key is the documented fallback (same Google Cloud key serves
 * Custom Search when that API is enabled on its project), and the engine id (cx)
 * is non-negotiable. Assertions stay on slot presence/identity — the key itself
 * is private to GoogleImageSearch, and that's fine: a wrong key degrades at run
 * time exactly like an un-enabled project does.
 */

function settings(overrides: Partial<ReaderSettings>): ReaderSettings {
  return { ...DEFAULT_SETTINGS, ...overrides, keys: { ...overrides.keys } };
}

describe("buildProviders bundled text model (desktop)", () => {
  it("routes the bundled backend through the local-server provider once its URL is set", () => {
    const built = buildProviders(
      settings({
        textProvider: "local",
        localTextBackend: "bundled",
        localServerTextUrl: "http://127.0.0.1:11435/v1",
        localServerTextModel: "Llama-3.2-3B-Instruct",
      }),
    );
    expect(built.llm.id).toBe("local-server");
    expect(built.diagnostics.llm.mock).toBe(false);
  });

  it("marks the bundled server as llama.cpp so utility jobs receive its schema grammar", async () => {
    let body: { response_format?: unknown } = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}")) as typeof body;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"summary":"ok"}' } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const built = buildProviders(
      settings({
        textProvider: "local",
        localTextBackend: "bundled",
        localServerTextUrl: "http://127.0.0.1:11435/v1",
        localServerTextModel: "Llama-3.2-3B-Instruct",
      }),
      { fetch: fetchImpl },
    );
    expect(supportsChat(built.llm)).toBe(true);
    if (!supportsChat(built.llm)) throw new Error("expected chat provider");
    const schema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    };
    await built.llm.chat([{ role: "user", content: "summarize" }], {
      responseFormat: "json",
      jsonSchema: schema,
    });
    expect(body.response_format).toEqual({
      type: "json_object",
      schema,
    });
  });

  it("falls back to mock with a 'starting' note before the bundled server is up", () => {
    const built = buildProviders(settings({ textProvider: "local", localTextBackend: "bundled" }));
    expect(built.llm.id).toBe("mock");
    expect(built.diagnostics.llm.reason).toMatch(/built-in model/i);
  });
});

describe("buildProviders local image backend", () => {
  it("talks to the user's server with the chosen backend when no active override is set", () => {
    const a1111 = buildProviders(
      settings({ imageProvider: "local", localBackend: "a1111", localServerUrl: "http://127.0.0.1:7860", localModel: "sd_xl_base" }),
    );
    expect(a1111.diagnostics.image.mock).toBe(false);
    expect(a1111.diagnostics.image.label).toMatch(/AUTOMATIC1111/);
  });

  it("the resolved engineBackend wins over localBackend (fallback to managed ComfyUI speaks ComfyUI)", () => {
    // The user picked A1111, but engine resolution fell back to the managed ComfyUI and stamped
    // engineBaseUrl + engineBackend; the provider must talk ComfyUI, not A1111.
    const fellBack = buildProviders(
      settings({
        imageProvider: "local",
        localBackend: "a1111",
        localServerUrl: "http://127.0.0.1:7860",
        engineBaseUrl: "http://127.0.0.1:8188",
        engineBackend: "comfyui",
        localModel: "sd_xl_base",
      }),
    );
    expect(fellBack.diagnostics.image.label).toMatch(/ComfyUI/);
    expect(fellBack.diagnostics.image.label).not.toMatch(/AUTOMATIC1111/);
  });

  it("routes the self-hosted local engine through corsFetch (CORS-exempt) so the packaged app can generate", async () => {
    // The bug: the local A1111/ComfyUI backend used the browser fetch, which the packaged app's
    // Tauri-scheme origin is CORS-blocked from — generation "failed to fetch" (worked in dev only).
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const seen: string[] = [];
    const corsFetch = (async (input: RequestInfo | URL) => {
      const url = String((input as Request).url ?? input);
      seen.push(url);
      if (url.includes("/sdapi/v1/sd-models")) {
        return new Response(JSON.stringify([{ title: "sd_xl_base.safetensors [abc]", model_name: "sd_xl_base" }]), { status: 200 });
      }
      return new Response(JSON.stringify({ images: [PNG] }), { status: 200 });
    }) as typeof fetch;
    const built = buildProviders(
      settings({ imageProvider: "local", localBackend: "a1111", localServerUrl: "http://127.0.0.1:7860", localModel: "sd_xl_base" }),
      { corsFetch },
    );
    const out = await built.image.generate({ prompt: "a cat", anchors: [], quality: "standard" });
    expect(out.bytes.byteLength).toBeGreaterThan(0);
    expect(seen.some((u) => u.includes("/sdapi/v1/txt2img"))).toBe(true); // hit the engine via corsFetch
  });

  it("falls back to mock with a clear reason when nothing is connected", () => {
    const none = buildProviders(settings({ imageProvider: "local", localModel: "sd_xl_base" }));
    expect(none.diagnostics.image.mock).toBe(true);
    expect(none.diagnostics.image.reason).toMatch(/isn't connected/i);
  });
});

describe("buildProviders search credentials", () => {
  it("activates Google search with the dedicated key + engine id", () => {
    const built = buildProviders(settings({ keys: { search: "k" }, searchEngineId: "cx" }));
    expect(built.searchBackend).toBe("google");
  });

  it("falls back to the Gemini key when the search key is blank", () => {
    const built = buildProviders(settings({ keys: { gemini: "g" }, searchEngineId: "cx" }));
    expect(built.searchBackend).toBe("google");
  });

  it("uses the keyless backend when the engine id (cx) is missing", () => {
    const built = buildProviders(settings({ keys: { gemini: "g" } }));
    expect(built.searchBackend).toBe("keyless");
    expect(built.imageSearch.id).toBe("keyless-search");
  });

  it("uses the keyless backend with no key at all (search always available)", () => {
    const built = buildProviders(settings({ searchEngineId: "cx" }));
    expect(built.searchBackend).toBe("keyless");
    expect(built.imageSearch).toBeDefined();
  });

  it("grounds a non-Gemini reader through the fallback-keyed search", () => {
    // textProvider defaults to "claude" with no key → mock reader; external grounding
    // applies to any reader that isn't Gemini, mock included.
    const built = buildProviders(
      settings({ keys: { gemini: "g" }, searchEngineId: "cx", groundFacts: true }),
    );
    expect(built.webSearch).toBeDefined();
    expect(built.webSearch).toBe(built.imageSearch);
  });

  it("grounds keylessly through Wikipedia when grounding is on with no creds", () => {
    const built = buildProviders(settings({ groundFacts: true }));
    expect(built.webSearch).toBeDefined();
    expect(built.webSearch!.id).toBe("keyless-search");
  });

  it("leaves external grounding off for the Gemini reader (grounds in-call)", () => {
    const built = buildProviders(
      settings({
        textProvider: "gemini",
        keys: { gemini: "g" },
        searchEngineId: "cx",
        groundFacts: true,
      }),
    );
    expect(built.imageSearch).toBeDefined();
    expect(built.webSearch).toBeUndefined();
  });

  it("leaves external grounding off when groundFacts is off", () => {
    const built = buildProviders(settings({ keys: { search: "k" }, searchEngineId: "cx" }));
    expect(built.webSearch).toBeUndefined();
  });
});
