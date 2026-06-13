import { describe, expect, it } from "vitest";
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

  it("falls back to mock with a 'starting' note before the bundled server is up", () => {
    const built = buildProviders(settings({ textProvider: "local", localTextBackend: "bundled" }));
    expect(built.llm.id).toBe("mock");
    expect(built.diagnostics.llm.reason).toMatch(/built-in model/i);
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
