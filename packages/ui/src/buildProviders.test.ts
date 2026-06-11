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

describe("buildProviders search credentials", () => {
  it("activates search with the dedicated key + engine id", () => {
    const built = buildProviders(settings({ keys: { search: "k" }, searchEngineId: "cx" }));
    expect(built.imageSearch).toBeDefined();
  });

  it("falls back to the Gemini key when the search key is blank", () => {
    const built = buildProviders(settings({ keys: { gemini: "g" }, searchEngineId: "cx" }));
    expect(built.imageSearch).toBeDefined();
  });

  it("still requires the engine id (cx) with the Gemini-key fallback", () => {
    const built = buildProviders(settings({ keys: { gemini: "g" } }));
    expect(built.imageSearch).toBeUndefined();
  });

  it("stays inactive with no key at all", () => {
    const built = buildProviders(settings({ searchEngineId: "cx" }));
    expect(built.imageSearch).toBeUndefined();
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
