import { describe, it, expect } from "vitest";
import {
  GoogleImageSearch,
  buildFigureQuery,
  formatGroundingContext,
  groundingQuery,
} from "./image/image-search.js";
import { GeminiLLMProvider } from "./llm/gemini-provider.js";
import {
  GeminiNativeImageProvider,
  pickBestGeminiImageModel,
} from "./image/gemini-native-image-provider.js";
import { DirectTransport } from "./transport/transport.js";
import { WikiSearch } from "./image/free-search.js";
import { IMAGE_STYLES, LOCAL_IMAGE_MODELS, styleLoraDownload } from "./catalog.js";
import type { VisualBible } from "../types/bible.js";

/**
 * LIVE validation of the Google API request/response shapes — the unit suite proves our
 * logic against *documented* shapes; this suite proves the documented shapes against the
 * *actual* services. It exists because every graceful fallback in the providers means a
 * field-name drift fails silently: retrieval quietly degrades to generation, grounding
 * quietly degrades to recollection. Only a live happy-path call can tell the difference.
 *
 * Gated on env credentials so CI and keyless `pnpm test` runs skip it entirely:
 *   GOOGLE_SEARCH_API_KEY   Custom Search API key (Google Cloud console)
 *   GOOGLE_SEARCH_ENGINE_ID Programmable Search Engine id ("cx")
 *   GEMINI_API_KEY          AI Studio key (text + image + in-call grounding)
 *   GEMINI_MODEL            optional reader-model override (defaults to the provider default)
 *   VALIDATE_DOWNLOAD_URLS  any value — HEAD-check every catalog model/LoRA URL (no key needed)
 *   VALIDATE_FREE_SEARCH    any value — live-check the keyless Wikipedia/Commons backend (no key needed)
 *
 * Run: GOOGLE_SEARCH_API_KEY=… GOOGLE_SEARCH_ENGINE_ID=… GEMINI_API_KEY=… pnpm test live-validation
 */

const SEARCH_KEY = process.env["GOOGLE_SEARCH_API_KEY"] ?? "";
const SEARCH_CX = process.env["GOOGLE_SEARCH_ENGINE_ID"] ?? "";
const GEMINI_KEY = process.env["GEMINI_API_KEY"] ?? "";
const GEMINI_MODEL = process.env["GEMINI_MODEL"];

// Live network: generous budgets so a slow image render doesn't read as a shape failure.
const NET = 60_000;
const RENDER = 180_000;

function emptyBible(bookId = "live-validation"): VisualBible {
  return {
    bookId,
    version: 5,
    characters: [],
    environments: [],
    creatures: [],
    spoilers: [],
    storyboard: [],
    glossary: [],
    processedChapters: [],
  };
}

/** A stable, figure-rich topic: every check uses it so failures point at shapes, not queries. */
const TOPIC_QUERY = buildFigureQuery("the Krebs cycle", "step-by-step process diagram");

describe.runIf(SEARCH_KEY && SEARCH_CX)("LIVE Custom Search", () => {
  const search = new GoogleImageSearch({ apiKey: SEARCH_KEY, engineId: SEARCH_CX });

  it(
    "image mode returns ranked hits with usable links",
    async () => {
      const hits = await search.search(TOPIC_QUERY, 5);
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) expect(hit.link).toMatch(/^https?:\/\//);
      // The thumbnail is the hotlink fallback — if the API stops sending it, retrieval
      // quality drops sharply, so treat its absence on EVERY hit as a shape break.
      expect(hits.some((h) => h.thumbnailLink)).toBe(true);
      expect(hits.some((h) => h.contextLink)).toBe(true);
    },
    NET,
  );

  it(
    "retrieve() yields figure bytes, or at minimum a hotlinkable URL",
    async () => {
      const figure = await search.retrieve(TOPIC_QUERY);
      expect(figure).toBeDefined();
      // Bytes are the goal (cacheable/persistable); sourceUrl is the acceptable floor.
      expect(Boolean(figure!.bytes) || Boolean(figure!.sourceUrl)).toBe(true);
      if (figure!.bytes) {
        expect(figure!.bytes.bytes.byteLength).toBeGreaterThan(0);
        expect(figure!.bytes.mimeType).toMatch(/^image\//);
      }
    },
    NET,
  );

  it(
    "web mode returns snippets that build a non-empty grounding context",
    async () => {
      const query = groundingQuery("The Krebs Cycle", "", "Cell Biology");
      const hits = await search.searchWeb(query, 5);
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) expect(hit.link).toMatch(/^https?:\/\//);
      const { context, sources } = formatGroundingContext(hits);
      // No snippets ⇒ empty context ⇒ external grounding silently does nothing.
      expect(context).toContain("[1]");
      expect(sources.length).toBeGreaterThan(0);
    },
    NET,
  );
});

describe.runIf(process.env["VALIDATE_FREE_SEARCH"])("LIVE keyless Wikipedia/Commons search", () => {
  const wiki = new WikiSearch();

  // retry: Wikimedia throttles datacenter IPs (where CI/dev containers live)
  // aggressively; a transient 429 is not a shape failure.
  it(
    "Wikipedia web mode returns snippets that build a grounding context",
    { timeout: NET, retry: 2 },
    async () => {
      const hits = await wiki.searchWeb(groundingQuery("The Krebs Cycle", "", "Cell Biology"), 5);
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) expect(hit.link).toMatch(/^https:\/\/en\.wikipedia\.org\/wiki\//);
      const { context, sources } = formatGroundingContext(hits);
      expect(context).toContain("[1]");
      expect(sources.length).toBeGreaterThan(0);
    },
  );

  it(
    "Commons figure mode retrieves bytes or a hotlinkable URL",
    { timeout: NET, retry: 2 },
    async () => {
      const hits = await wiki.search(TOPIC_QUERY, 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.link).toMatch(/^https:\/\/upload\.wikimedia\.org\//);
      const figure = await wiki.retrieve(TOPIC_QUERY);
      expect(figure).toBeDefined();
      expect(Boolean(figure!.bytes) || Boolean(figure!.sourceUrl)).toBe(true);
    },
  );
});

describe.runIf(GEMINI_KEY)("LIVE Gemini grounding", () => {
  it(
    "generateContent accepts tools:[{google_search:{}}] and returns groundingChunks[].web.uri",
    async () => {
      // The provider's exact grounded body shape (non-JSON path), sent raw so a failure
      // here cleanly separates "request shape rejected" from "response shape drifted".
      const transport = new DirectTransport();
      const model = GEMINI_MODEL ?? "gemini-2.0-flash";
      const res = await transport.send({
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
        method: "POST",
        body: {
          systemInstruction: { parts: [{ text: "Ground every fact in web search results." }] },
          contents: [
            {
              role: "user",
              parts: [
                // A recency-dependent question the model cannot answer from weights,
                // so it MUST invoke the search tool and emit grounding metadata.
                { text: "What is the current men's marathon world record, and who set it?" },
              ],
            },
          ],
          generationConfig: {},
          tools: [{ google_search: {} }],
        },
      });
      expect(res.ok, `grounded request rejected: ${res.status} ${await res.text()}`).toBe(true);
      const data = await res.json<{
        candidates?: {
          content?: { parts?: { text?: string }[] };
          groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
        }[];
      }>();
      const candidate = data.candidates?.[0];
      expect(candidate?.content?.parts?.some((p) => p.text)).toBe(true);
      const uris = (candidate?.groundingMetadata?.groundingChunks ?? [])
        .map((c) => c.web?.uri)
        .filter(Boolean);
      expect(uris.length, `no groundingChunks[].web.uri — metadata shape may have drifted: ${JSON.stringify(candidate?.groundingMetadata ?? {}).slice(0, 500)}`).toBeGreaterThan(0);
    },
    NET,
  );

  it(
    "grounded technical extraction (JSON mode + search tool) cites sources in the glossary",
    async () => {
      // End-to-end through the real provider: this is the risky model/mode combination
      // (tools alongside responseSchema). If the API rejects it, the provider silently
      // retries ungrounded and NO References entry appears — which is exactly the silent
      // degradation this suite exists to surface, so the assertion is strict.
      const provider = new GeminiLLMProvider({
        apiKey: GEMINI_KEY,
        ground: true,
        ...(GEMINI_MODEL ? { model: GEMINI_MODEL } : {}),
      });
      const bible = await provider.extractEntities({
        bookId: "live-validation",
        chapterIndex: 0,
        chapterText:
          "The Krebs cycle (citric acid cycle) is a series of chemical reactions used by " +
          "aerobic organisms to release stored energy. Acetyl-CoA enters the cycle and is " +
          "oxidised through eight enzyme-catalysed steps, yielding NADH, FADH2, and GTP.",
        existing: emptyBible(),
        contentMode: "technical",
        unitRanges: [[0, 1]],
        sceneCount: 1,
      });
      const refs = bible.glossary.find((g) => /^References \(chapter 1\)/.test(g.term));
      expect(refs, "no References glossary entry — grounded JSON call likely fell back ungrounded").toBeDefined();
      expect(refs!.definition).toMatch(/^https?:\/\//);
    },
    NET * 2,
  );
});

describe.runIf(process.env["VALIDATE_DOWNLOAD_URLS"])("LIVE catalog download URLs", () => {
  // The desktop downloader is keyless, so a gated host can never auto-download:
  // these URLs are EXPECTED to demand a login (the catalog entry says so and the
  // downloader's 401/403 message walks the user through a browser download).
  const KNOWN_GATED = new Set([
    "https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9b-fp8/resolve/main/flux-2-klein-base-9b-fp8.safetensors",
  ]);

  async function expectDownloadable(url: string, what: string): Promise<void> {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (KNOWN_GATED.has(url)) {
      expect([200, 401, 403], `${what}: gated URL vanished (${res.status})`).toContain(res.status);
      return;
    }
    expect(res.status, `${what}: ${url} → ${res.status}`).toBe(200);
    // Hosts that drop Content-Length would break the downloader's progress bar —
    // worth knowing, but a redirect chain's final hop always carries it on HF today.
    expect(Number(res.headers.get("content-length") ?? "0"), `${what}: empty body`).toBeGreaterThan(0);
  }

  it(
    "every local-model component URL answers an anonymous HEAD",
    async () => {
      for (const model of LOCAL_IMAGE_MODELS) {
        const files = model.files ?? [{ url: model.url, filename: model.filename, folder: "checkpoints" as const }];
        for (const f of files) {
          if (f.url) await expectDownloadable(f.url, `${model.id} / ${f.filename}`);
        }
      }
    },
    NET * 3,
  );

  it(
    "every style-LoRA download URL answers an anonymous HEAD",
    async () => {
      for (const style of IMAGE_STYLES) {
        const d = styleLoraDownload(style.id);
        if (d) await expectDownloadable(d.url, `style ${style.id} / ${d.filename}`);
      }
    },
    NET * 2,
  );
});

describe.runIf(GEMINI_KEY)("LIVE Gemini native image", () => {
  it(
    "models.list discovery finds a generateContent image model",
    async () => {
      const transport = new DirectTransport();
      const res = await transport.send({
        url: `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}&pageSize=1000`,
        method: "GET",
      });
      expect(res.ok).toBe(true);
      const data = await res.json<{ models?: { name?: string; supportedGenerationMethods?: string[] }[] }>();
      const best = pickBestGeminiImageModel(data.models ?? []);
      expect(best, "no Gemini image model visible to this key — discovery would fall back to the default").toBeDefined();
    },
    NET,
  );

  it(
    "portrait imageConfig.aspectRatio is accepted and an image comes back",
    async () => {
      const provider = new GeminiNativeImageProvider({ apiKey: GEMINI_KEY });
      // 832×1216 resolves to the 2:3 portrait ratio — the shape under test is
      // generationConfig.imageConfig.aspectRatio being accepted, not render quality.
      const out = await provider.generate({
        prompt: "A simple, clean schematic diagram of a water molecule, labeled.",
        anchors: [],
        quality: "standard",
        width: 832,
        height: 1216,
      });
      expect(out.bytes.byteLength).toBeGreaterThan(0);
      expect(out.mimeType).toMatch(/^image\//);
    },
    RENDER,
  );
});
