import { describe, it, expect } from "vitest";
import { DirectTransport } from "./transport/transport.js";
import type { Transport, TransportRequest, TransportResponse } from "./transport/transport.js";
import type { VisualBible } from "../types/bible.js";
import type { ImageGenerationInput } from "./image/image-provider.js";
import { GeminiLLMProvider } from "./llm/gemini-provider.js";
import { OpenAILLMProvider } from "./llm/openai-provider.js";
import { GeminiNativeImageProvider, pickBestGeminiImageModel } from "./image/gemini-native-image-provider.js";
import { OpenAIImageProvider } from "./image/openai-image-provider.js";
import { OpenAINativeImageProvider } from "./image/openai-native-image-provider.js";
import { FluxProvider } from "./image/flux-provider.js";
import {
  ComfyUIBackend,
  assetStem,
  comfyExecutionError,
  flux2EncoderPatterns,
  pickComponentAsset,
  resolveAssetName,
} from "./image/local-engine/comfyui-backend.js";
import { Automatic1111Backend } from "./image/local-engine/automatic1111-backend.js";
import { WebLLMProvider, parseExtraction } from "./llm/webllm-provider.js";
import { LocalServerLLMProvider } from "./llm/local-server-provider.js";
import type { VisualRequest } from "../types/content.js";
import { createImageProvider, createLLMProvider } from "./factory.js";
import {
  IMAGE_PROVIDERS,
  LOCAL_IMAGE_MODELS,
  OLLAMA_TEXT_MODELS,
  TEXT_PROVIDERS,
  catalogEntryForModel,
  catalogModelFamily,
  ollamaModelMatches,
  recommendImageModePairings,
  serverModelVramCostGb,
  styleLoraDownload,
} from "./catalog.js";
import type { LocalEngineBackend } from "./image/local-engine/backend.js";

interface Scripted {
  ok?: boolean;
  status?: number;
  json?: unknown;
  bytes?: ArrayBuffer;
  text?: string;
}

class FakeTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  constructor(private readonly handler: (req: TransportRequest, index: number) => Scripted) {}
  send(request: TransportRequest): Promise<TransportResponse> {
    const index = this.requests.length;
    this.requests.push(request);
    const s = this.handler(request, index);
    return Promise.resolve({
      ok: s.ok ?? true,
      status: s.status ?? 200,
      json: <T>() => Promise.resolve(s.json as T),
      arrayBuffer: () => Promise.resolve(s.bytes ?? new ArrayBuffer(0)),
      text: () => Promise.resolve(s.text ?? ""),
    });
  }
}

function emptyBible(bookId = "book"): VisualBible {
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

function b64(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64");
}

const imageInput: ImageGenerationInput = { prompt: "a knight", anchors: [], quality: "standard" };

describe("catalog", () => {
  it("excludes Claude from the image slot (no image model) but keeps it for text", () => {
    expect(IMAGE_PROVIDERS.find((p) => p.id === "claude")).toBeUndefined();
    expect(TEXT_PROVIDERS.find((p) => p.id === "claude")).toBeDefined();
    expect(IMAGE_PROVIDERS.find((p) => p.id === "local")?.local).toBe(true);
  });

  it("estimates a server chat model's VRAM from its Ollama-style name", () => {
    // Parameter count + quantization parsed from the tag; rounds up. Used to decide whether a big
    // chat model + the image model both fit, so the engine can skip evicting it for a render.
    expect(serverModelVramCostGb("gemma2:27b")).toBe(18); // 27 * 0.6 (q4 default) + 1.5 → ceil
    expect(serverModelVramCostGb("qwen3:32b-q8_0")).toBe(37); // 32 * 1.1 + 1.5
    expect(serverModelVramCostGb("llama3.1:70b")).toBe(44); // 70 * 0.6 + 1.5
    expect(serverModelVramCostGb("mistral:7b-instruct-q4_K_M")).toBe(6); // 7 * 0.6 + 1.5
    expect(serverModelVramCostGb("phi3:3.8b")).toBe(4); // 3.8 * 0.6 + 1.5 → ceil
    // MoE: ALL experts are resident, so "8x7b" ≈ 56B, not 7B.
    expect(serverModelVramCostGb("mixtral:8x7b")).toBe(36); // 56 * 0.6 + 1.5 → ceil
    // fp16 is heavier per weight than the q4 default.
    expect(serverModelVramCostGb("gemma2:27b-fp16")).toBeGreaterThan(serverModelVramCostGb("gemma2:27b"));
    // No parseable size → 0 so the caller keeps its existing "free it" behaviour.
    expect(serverModelVramCostGb("gemma2:latest")).toBe(0);
    expect(serverModelVramCostGb("")).toBe(0);
  });

  it("recommendImageModePairings ranks installed chat models that fit alongside an image model", () => {
    const r = recommendImageModePairings({
      imageModel: "flux-schnell", // ~17 GB
      gpuVramMb: 32768, // 32 GB
      installed: ["gemma4:31b", "qwen3:8b", "llama3.2:3b"],
    })!;
    expect(r).toBeDefined();
    expect(r.imageGb).toBeGreaterThan(0);
    // A 31B (~21 GB) can't coexist with a ~17 GB image model on 32 GB; the small ones can.
    expect(r.fits.map((f) => f.model)).not.toContain("gemma4:31b");
    expect(r.fits.map((f) => f.model)).toContain("qwen3:8b");
    // Ranked biggest-first (best prose that still fits).
    for (let i = 1; i < r.fits.length; i++) {
      expect(r.fits[i - 1]!.vramGb).toBeGreaterThanOrEqual(r.fits[i]!.vramGb);
    }
    // Suggested window is modest + bounded (prompt-editing doesn't need a huge one).
    for (const f of r.fits) {
      expect(f.suggestedNumCtx).toBeGreaterThanOrEqual(8192);
      expect(f.suggestedNumCtx).toBeLessThanOrEqual(16384);
    }
    expect(r.noneFit).toBe(false);
  });

  it("recommendImageModePairings flags noneFit when the image model leaves no room", () => {
    const r = recommendImageModePairings({
      imageModel: "qwen-image", // ~30 GB → ~0 left on 32 GB
      gpuVramMb: 32768,
      installed: ["qwen3:8b", "llama3.2:3b"],
    })!;
    expect(r.noneFit).toBe(true);
    expect(r.fits).toHaveLength(0);
  });

  it("recommendImageModePairings returns undefined when GPU or image size is unknown", () => {
    expect(recommendImageModePairings({ imageModel: "flux-schnell", gpuVramMb: 0, installed: [] })).toBeUndefined();
    expect(recommendImageModePairings({ imageModel: "not-a-model", gpuVramMb: 32768, installed: [] })).toBeUndefined();
  });
});

describe("DirectTransport", () => {
  it("routes requests through an injected fetch (the extension's SW proxy path)", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ value: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const transport = new DirectTransport(fakeFetch);
    const res = await transport.send({ url: "https://example/api", method: "POST", body: { a: 1 } });

    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ value: 42 });
    expect(calls[0]!.url).toBe("https://example/api");
    expect(calls[0]!.init!.body).toBe(JSON.stringify({ a: 1 }));
  });
});

describe("GeminiLLMProvider", () => {
  it("requests structured JSON and merges entities into the Bible", async () => {
    const transport = new FakeTransport(() => ({
      json: {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    characters: [{ name: "Aria", aliases: [], persistentTraits: ["tall"], clothing: [] }],
                    environments: [],
                    spoilers: [],
                  }),
                },
              ],
            },
          },
        ],
      },
    }));
    const provider = new GeminiLLMProvider({ apiKey: "KEY", transport });
    const bible = await provider.extractEntities({
      bookId: "book",
      chapterIndex: 0,
      chapterText: "Aria walked in.",
      existing: emptyBible(),
    });

    const req = transport.requests[0]!;
    expect(req.url).toContain("models/gemini-2.0-flash:generateContent?key=KEY");
    expect((req.body as Record<string, unknown>).generationConfig).toMatchObject({
      responseMimeType: "application/json",
    });
    expect(bible.characters[0]?.name).toBe("Aria");
    expect(bible.processedChapters).toContain(0);
  });

  it("grounds TECHNICAL extraction in Google Search and folds sources into the glossary", async () => {
    const emptyExtraction = JSON.stringify({ characters: [], environments: [], spoilers: [] });
    const transport = new FakeTransport(() => ({
      json: {
        candidates: [
          {
            content: { parts: [{ text: emptyExtraction }] },
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: "https://nature.com/krebs", title: "Nature" } },
                { web: { uri: "https://nature.com/krebs" } }, // duplicate de-duped
                { web: { uri: "https://nih.gov/atp" } },
              ],
            },
          },
        ],
      },
    }));
    const provider = new GeminiLLMProvider({ apiKey: "KEY", transport, ground: true });
    const bible = await provider.extractEntities({
      bookId: "book",
      chapterIndex: 0,
      chapterText: "The Krebs cycle…",
      existing: emptyBible(),
      contentMode: "technical",
    });

    // The per-request google_search tool rides along (same Gemini key — no extra key).
    expect((transport.requests[0]!.body as { tools?: unknown[] }).tools).toEqual([{ google_search: {} }]);
    // Cited sources land in the glossary as a per-chapter References entry.
    const refs = bible.glossary.find((g) => g.term.startsWith("References"));
    expect(refs?.definition).toContain("https://nature.com/krebs");
    expect(refs?.definition).toContain("https://nih.gov/atp");
    expect(refs?.definition.match(/nature\.com/g)).toHaveLength(1); // de-duplicated
  });

  it("ground=true never sends tools for FICTION, and retries ungrounded if the grounded call is rejected", async () => {
    const emptyExtraction = JSON.stringify({ characters: [], environments: [], spoilers: [] });
    const fiction = new FakeTransport(() => ({
      json: { candidates: [{ content: { parts: [{ text: emptyExtraction }] } }] },
    }));
    const p1 = new GeminiLLMProvider({ apiKey: "KEY", transport: fiction, ground: true });
    await p1.extractEntities({ bookId: "b", chapterIndex: 0, chapterText: "x", existing: emptyBible() });
    expect((fiction.requests[0]!.body as { tools?: unknown[] }).tools).toBeUndefined();

    // Grounded technical call rejected (tool/JSON-mode combos vary) → plain retry succeeds.
    const flaky = new FakeTransport((_req, i) =>
      i === 0
        ? { ok: false, status: 400 }
        : { json: { candidates: [{ content: { parts: [{ text: emptyExtraction }] } }] } },
    );
    const p2 = new GeminiLLMProvider({ apiKey: "KEY", transport: flaky, ground: true });
    const bible = await p2.extractEntities({
      bookId: "b",
      chapterIndex: 0,
      chapterText: "x",
      existing: emptyBible(),
      contentMode: "technical",
    });
    expect(flaky.requests).toHaveLength(2);
    expect((flaky.requests[1]!.body as { tools?: unknown[] }).tools).toBeUndefined();
    expect(bible.processedChapters).toContain(0); // analysis survived the rejection
  });
});

describe("OpenAILLMProvider", () => {
  it("sends a json_schema request with auth and parses the Bible", async () => {
    const transport = new FakeTransport(() => ({
      json: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                characters: [{ name: "Bram", aliases: [], persistentTraits: [], clothing: [] }],
                environments: [{ name: "Keep", description: ["stone"] }],
                spoilers: [],
              }),
            },
          },
        ],
      },
    }));
    const provider = new OpenAILLMProvider({ apiKey: "KEY", transport });
    const bible = await provider.extractEntities({
      bookId: "book",
      chapterIndex: 1,
      chapterText: "Bram entered the Keep.",
      existing: emptyBible(),
    });

    const req = transport.requests[0]!;
    expect(req.url).toContain("/chat/completions");
    expect(req.headers?.authorization).toBe("Bearer KEY");
    expect((req.body as { response_format?: { type?: string } }).response_format?.type).toBe("json_schema");
    expect(bible.characters[0]?.name).toBe("Bram");
    expect(bible.environments[0]?.name).toBe("Keep");
  });
});

describe("OpenAIImageProvider", () => {
  it("maps size and decodes b64_json", async () => {
    const transport = new FakeTransport(() => ({ json: { data: [{ b64_json: b64("IMG") }] } }));
    const provider = new OpenAIImageProvider({ apiKey: "KEY", transport });
    const out = await provider.generate({ ...imageInput, width: 1600, height: 900 });
    expect((transport.requests[0]!.body as { size?: string }).size).toBe("1536x1024");
    expect(new TextDecoder().decode(out.bytes)).toBe("IMG");
  });
});

describe("GeminiNativeImageProvider (one-API multimodal)", () => {
  const ref = { bytes: new TextEncoder().encode("REFBYTES").buffer, mimeType: "image/png", weight: 0.5 };
  // Pin a model so these test request SHAPING, not discovery (covered separately).
  const pinned = { apiKey: "KEY", model: "gemini-2.5-flash-image" };

  it("sends prompt + reference photos inline and decodes the returned image part", async () => {
    const transport = new FakeTransport(() => ({
      json: { candidates: [{ content: { parts: [{ text: "ok" }, { inlineData: { mimeType: "image/png", data: b64("DRAWN") } }] } }] },
    }));
    const provider = new GeminiNativeImageProvider({ ...pinned, transport });
    const out = await provider.generate({ ...imageInput, ipAdapterRefs: [ref] });

    const body = transport.requests[0]!.body as { contents: { parts: Record<string, unknown>[] }[] };
    const parts = body.contents[0]!.parts;
    expect(parts[0]).toEqual({ text: "a knight" });
    // The reference photo rides along as an inline image part (character conditioning).
    expect((parts[1]!.inline_data as { data: string }).data).toBe(b64("REFBYTES"));
    expect(transport.requests[0]!.url).toContain("gemini-2.5-flash-image:generateContent?key=KEY");
    expect(new TextDecoder().decode(out.bytes)).toBe("DRAWN");
  });

  it("works with no references (plain text-to-image) and tolerates snake_case parts", async () => {
    const transport = new FakeTransport(() => ({
      json: { candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/jpeg", data: b64("J") } }] } }] },
    }));
    const provider = new GeminiNativeImageProvider({ ...pinned, transport });
    const out = await provider.generate(imageInput);
    const body = transport.requests[0]!.body as { contents: { parts: unknown[] }[] };
    expect(body.contents[0]!.parts).toHaveLength(1); // prompt only
    expect(out.mimeType).toBe("image/jpeg");
  });

  it("passes the canvas orientation as imageConfig.aspectRatio (the API takes a ratio)", async () => {
    const transport = new FakeTransport(() => ({
      json: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: b64("I") } }] } }] },
    }));
    const provider = new GeminiNativeImageProvider({ ...pinned, transport });
    await provider.generate({ ...imageInput, width: 832, height: 1248 }); // portrait
    type Body = { generationConfig: { imageConfig: { aspectRatio: string } } };
    expect((transport.requests[0]!.body as Body).generationConfig.imageConfig.aspectRatio).toBe("2:3");

    await provider.generate({ ...imageInput, width: 1248, height: 832 }); // landscape
    expect((transport.requests[1]!.body as Body).generationConfig.imageConfig.aspectRatio).toBe("3:2");

    await provider.generate(imageInput); // default square
    expect((transport.requests[2]!.body as Body).generationConfig.imageConfig.aspectRatio).toBe("1:1");
  });

  it("throws when the response has no image part", async () => {
    const transport = new FakeTransport(() => ({ json: { candidates: [{ content: { parts: [{ text: "no image" }] } }] } }));
    const provider = new GeminiNativeImageProvider({ ...pinned, transport });
    await expect(provider.generate(imageInput)).rejects.toThrow(/no image data/);
  });

  it("auto-discovers the best image model the key can access (Pro > Flash), once", async () => {
    const transport = new FakeTransport((req, i) => {
      if (i === 0) {
        expect(req.url).toContain("/models?key=KEY"); // models.list
        return {
          json: {
            models: [
              { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
              { name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] },
              { name: "models/gemini-3-pro-image-preview", supportedGenerationMethods: ["generateContent"] },
              { name: "models/imagen-3.0-generate-002", supportedGenerationMethods: ["predict"] },
            ],
          },
        };
      }
      return { json: { candidates: [{ content: { parts: [{ inlineData: { data: b64("X") } }] } }] } };
    });
    const provider = new GeminiNativeImageProvider({ apiKey: "KEY", transport }); // no pinned model
    await provider.generate(imageInput);
    await provider.generate(imageInput);
    // Picked the Pro image model (not Flash, not the predict-only Imagen)…
    expect(transport.requests[1]!.url).toContain("gemini-3-pro-image-preview:generateContent");
    // …and discovery ran ONCE (req0 list, req1+req2 generate — no second list).
    expect(transport.requests.filter((r) => r.url.includes("/models?key=")).length).toBe(1);
  });

  it("falls back to the default model when discovery fails", async () => {
    const transport = new FakeTransport((_req, i) => {
      if (i === 0) return { ok: false, status: 403 }; // models.list denied
      return { json: { candidates: [{ content: { parts: [{ inlineData: { data: b64("X") } }] } }] } };
    });
    const provider = new GeminiNativeImageProvider({ apiKey: "KEY", transport });
    await provider.generate(imageInput);
    expect(transport.requests[1]!.url).toContain("gemini-2.5-flash-image:generateContent");
  });

  it("pickBestGeminiImageModel ranks Pro over Flash and excludes Imagen/vision", () => {
    expect(
      pickBestGeminiImageModel([
        { name: "models/gemini-2.5-flash-image" },
        { name: "models/gemini-3-pro-image-preview" },
        { name: "models/imagen-4.0-generate" },
        { name: "models/gemini-pro-vision" },
      ]),
    ).toBe("gemini-3-pro-image-preview");
    // A key with only Flash image picks Flash; a key with no Gemini image model → undefined.
    expect(pickBestGeminiImageModel([{ name: "models/gemini-2.5-flash-image" }])).toBe("gemini-2.5-flash-image");
    expect(pickBestGeminiImageModel([{ name: "models/gemini-2.5-flash" }])).toBeUndefined();
  });
});

describe("OpenAINativeImageProvider (one-API)", () => {
  const ref = { bytes: new TextEncoder().encode("R").buffer, mimeType: "image/png", weight: 0.5 };

  it("uses /images/edits with the reference photos as multipart files", async () => {
    const transport = new FakeTransport(() => ({ json: { data: [{ b64_json: b64("EDITED") }] } }));
    const provider = new OpenAINativeImageProvider({ apiKey: "KEY", transport });
    const out = await provider.generate({ ...imageInput, ipAdapterRefs: [ref, ref] });

    const req = transport.requests[0]!;
    expect(req.url).toContain("/images/edits");
    expect(req.multipart!.fields!.prompt).toBe("a knight");
    expect(req.multipart!.files).toHaveLength(2);
    expect(req.multipart!.files![0]!.field).toBe("image[]");
    expect(new TextDecoder().decode(out.bytes)).toBe("EDITED");
  });

  it("falls back to /images/generations with no references", async () => {
    const transport = new FakeTransport(() => ({ json: { data: [{ b64_json: b64("GEN") }] } }));
    const provider = new OpenAINativeImageProvider({ apiKey: "KEY", transport });
    await provider.generate(imageInput);
    expect(transport.requests[0]!.url).toContain("/images/generations");
    expect(transport.requests[0]!.multipart).toBeUndefined();
  });
});

describe("createImageProvider image variants", () => {
  it("routes Gemini images through the multimodal provider (avoids Imagen's 404)", () => {
    // Imagen :predict 404s for most keys, so Gemini always uses generateContent now.
    expect(createImageProvider("gemini", { key: "K" })).toBeInstanceOf(GeminiNativeImageProvider);
    expect(createImageProvider("gemini", { key: "K", native: true })).toBeInstanceOf(GeminiNativeImageProvider);
  });
  it("uses OpenAI's multimodal (edits) variant only when native is requested", () => {
    expect(createImageProvider("openai", { key: "K" })).toBeInstanceOf(OpenAIImageProvider);
    expect(createImageProvider("openai", { key: "K", native: true })).toBeInstanceOf(OpenAINativeImageProvider);
    // A non-native vendor ignores the flag (Flux has no multimodal variant).
    expect(createImageProvider("flux", { key: "K", native: true }).id).toBe("flux");
  });
});

describe("FluxProvider", () => {
  it("submits, polls until Ready, then downloads the sample", async () => {
    const png = new TextEncoder().encode("FLUXPNG").buffer;
    const transport = new FakeTransport((_req, i) => {
      if (i === 0) return { json: { id: "abc", polling_url: "https://poll.example" } };
      if (i === 1) return { json: { status: "Pending" } };
      if (i === 2) return { json: { status: "Ready", result: { sample: "https://img.example/x.png" } } };
      return { bytes: png };
    });
    const provider = new FluxProvider({ apiKey: "KEY", transport, pollIntervalMs: 0 });
    const out = await provider.generate(imageInput);

    expect(transport.requests[0]!.headers?.["x-key"]).toBe("KEY");
    expect(transport.requests[1]!.url).toContain("https://poll.example?id=abc");
    expect(transport.requests[3]!.url).toBe("https://img.example/x.png");
    expect(new TextDecoder().decode(out.bytes)).toBe("FLUXPNG");
  });

  it("throws when generation is moderated", async () => {
    const transport = new FakeTransport((_req, i) =>
      i === 0 ? { json: { id: "a", polling_url: "https://p" } } : { json: { status: "Content Moderated" } },
    );
    const provider = new FluxProvider({ apiKey: "KEY", transport, pollIntervalMs: 0 });
    await expect(provider.generate(imageInput)).rejects.toThrow(/Content Moderated/);
  });
});

describe("ComfyUIBackend", () => {
  it("lists checkpoints from object_info", async () => {
    const transport = new FakeTransport(() => ({
      json: { CheckpointLoaderSimple: { input: { required: { ckpt_name: [["a.safetensors", "b.safetensors"], {}] } } } },
    }));
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport });
    const models = await backend.listModels();
    expect(models.map((m) => m.id)).toEqual(["a.safetensors", "b.safetensors"]);
  });

  it("runs the prompt → history → view flow (waiting while the prompt is queued)", async () => {
    const png = new TextEncoder().encode("COMFY").buffer;
    let historyCalls = 0;
    const transport = new FakeTransport((req) => {
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "p1" } };
      if (req.url.includes("/history/")) {
        historyCalls++;
        // Empty for the first few polls (still rendering), then the finished image.
        return historyCalls < 3
          ? { json: {} }
          : { json: { p1: { outputs: { "9": { images: [{ filename: "f.png", subfolder: "", type: "output" }] } } } } };
      }
      if (req.url.endsWith("/queue")) return { json: { queue_running: [[0, "p1"]] } }; // still alive
      return { bytes: png }; // /view
    });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188/", transport, pollIntervalMs: 0 });
    const out = await backend.generate(imageInput, "sdxl.safetensors");

    expect(transport.requests[0]!.url).toBe("http://127.0.0.1:8188/prompt");
    const body = transport.requests[0]!.body as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> };
    expect(body.prompt["4"]!.inputs.ckpt_name).toBe("sdxl.safetensors");
    // It polled /queue while history was empty (didn't give up), then fetched the finished image.
    expect(transport.requests.some((r) => r.url.endsWith("/queue"))).toBe(true);
    expect(transport.requests.at(-1)!.url).toContain("/view?filename=f.png");
    expect(new TextDecoder().decode(out.bytes)).toBe("COMFY");
  });

  it("never times out a slow render that stays in the queue (only the cancel stops it)", async () => {
    const png = new TextEncoder().encode("SLOW").buffer;
    let historyCalls = 0;
    const transport = new FakeTransport((req) => {
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "p9" } };
      if (req.url.includes("/history/")) {
        historyCalls++;
        // Empty for MANY polls — far beyond any old fixed timeout — then finally finishes.
        return historyCalls < 50
          ? { json: {} }
          : { json: { p9: { outputs: { "9": { images: [{ filename: "slow.png", subfolder: "", type: "output" }] } } } } };
      }
      if (req.url.endsWith("/queue")) return { json: { queue_pending: [[0, "p9"]] } }; // queued the whole time
      return { bytes: png };
    });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport, pollIntervalMs: 0 });
    const out = await backend.generate(imageInput, "sdxl.safetensors");
    expect(new TextDecoder().decode(out.bytes)).toBe("SLOW"); // collected the image, never timed out
  });

  it("fails only if the prompt vanishes from BOTH history and the queue", async () => {
    const transport = new FakeTransport((req) => {
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "gone" } };
      if (req.url.includes("/history/")) return { json: {} }; // never finishes
      if (req.url.endsWith("/queue")) return { json: { queue_running: [], queue_pending: [] } }; // not queued
      return { bytes: new ArrayBuffer(0) };
    });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport, pollIntervalMs: 0 });
    await expect(backend.generate(imageInput, "sdxl.safetensors")).rejects.toThrow(/dropped the render/i);
  });
});

describe("Automatic1111Backend", () => {
  it("lists checkpoints from sd-models", async () => {
    const transport = new FakeTransport(() => ({
      json: [
        { title: "sdxl.safetensors [abc]", model_name: "sdxl" },
        { title: "dreamshaper.safetensors [def]", model_name: "dreamshaper" },
      ],
    }));
    const backend = new Automatic1111Backend({ baseUrl: "http://127.0.0.1:7860", transport });
    const models = await backend.listModels();
    expect(models.map((m) => m.id)).toEqual(["sdxl.safetensors [abc]", "dreamshaper.safetensors [def]"]);
    expect(models.map((m) => m.label)).toEqual(["sdxl", "dreamshaper"]);
  });

  it("posts txt2img with the chosen checkpoint and decodes the base64 image", async () => {
    const transport = new FakeTransport(() => ({ json: { images: [b64("A1111")] } }));
    const backend = new Automatic1111Backend({ baseUrl: "http://127.0.0.1:7860/", transport });
    const out = await backend.generate(imageInput, "sdxl.safetensors [abc]");

    expect(transport.requests[0]!.url).toBe("http://127.0.0.1:7860/sdapi/v1/txt2img");
    const body = transport.requests[0]!.body as {
      prompt: string;
      negative_prompt: string;
      override_settings: { sd_model_checkpoint: string };
    };
    // SDXL checkpoint → SD formatting: quality preamble + the scene, plus a negative.
    expect(body.prompt).toContain("a knight");
    expect(body.prompt).toContain("masterpiece");
    expect(body.negative_prompt).toContain("bad anatomy");
    expect(body.override_settings.sd_model_checkpoint).toBe("sdxl.safetensors [abc]");
    expect(new TextDecoder().decode(out.bytes)).toBe("A1111");
  });

  it("omits the checkpoint override when no model is given", async () => {
    const transport = new FakeTransport(() => ({ json: { images: [b64("X")] } }));
    const backend = new Automatic1111Backend({ baseUrl: "http://127.0.0.1:7860", transport });
    await backend.generate(imageInput, "");
    const body = transport.requests[0]!.body as { override_settings?: unknown };
    expect(body.override_settings).toBeUndefined();
  });

  it("throws when the server returns no image", async () => {
    const transport = new FakeTransport(() => ({ json: { images: [] } }));
    const backend = new Automatic1111Backend({ baseUrl: "http://127.0.0.1:7860", transport });
    await expect(backend.generate(imageInput, "m")).rejects.toThrow(/no image/);
  });
});

describe("styleLoraDownload", () => {
  it("returns a saved-as-style-id descriptor for styles with a source", () => {
    const d = styleLoraDownload("animation-3d");
    expect(d?.id).toBe("animation-3d");
    expect(d?.filename).toBe("animation-3d.safetensors");
    expect(d?.url).toMatch(/^https?:\/\//);
  });
  it("returns undefined for styles without a download source", () => {
    expect(styleLoraDownload("auto")).toBeUndefined(); // no LoRA at all
    expect(styleLoraDownload("anime")).toBeUndefined(); // LoRA mapped but no url
  });
});

describe("resolveAssetName", () => {
  it("matches exact, base-name, and case-insensitively", () => {
    const set = new Set(["anime.safetensors", "Oil-Painting.safetensors"]);
    expect(resolveAssetName(set, "anime.safetensors")).toBe("anime.safetensors");
    expect(resolveAssetName(set, "anime")).toBe("anime.safetensors");
    expect(resolveAssetName(set, "oil-painting")).toBe("Oil-Painting.safetensors");
    expect(resolveAssetName(set, "missing")).toBeUndefined();
  });
});

describe("style LoRA mapping (local engines)", () => {
  const png = new TextEncoder().encode("IMG").buffer;
  const loraInput = { ...imageInput, styleLora: { name: "anime", strength: 0.8, trigger: "anime" } };

  function comfyTransport(loras: string[]) {
    return new FakeTransport((req) => {
      if (req.url.endsWith("/object_info/LoraLoader"))
        return { json: { LoraLoader: { input: { required: { lora_name: [loras, {}] } } } } };
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "p1" } };
      if (req.url.includes("/history/"))
        return { json: { p1: { outputs: { "9": { images: [{ filename: "f.png", subfolder: "", type: "output" }] } } } } };
      return { bytes: png };
    });
  }

  it("ComfyUI: inserts a LoraLoader and prepends the trigger when the LoRA is installed", async () => {
    const transport = comfyTransport(["anime.safetensors", "other.safetensors"]);
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport, pollIntervalMs: 0 });
    await backend.generate(loraInput, "sdxl.safetensors");

    const promptReq = transport.requests.find((r) => r.url.endsWith("/prompt"))!;
    const wf = (promptReq.body as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }).prompt;
    expect(wf["10"]!.class_type).toBe("LoraLoader");
    expect(wf["10"]!.inputs.lora_name).toBe("anime.safetensors");
    expect(wf["3"]!.inputs.model).toEqual(["10", 0]); // sampler reads model from the LoRA
    expect(wf["6"]!.inputs.text).toContain("anime,"); // trigger prepended
  });

  it("ComfyUI: falls back to the plain checkpoint when the LoRA is absent", async () => {
    const transport = comfyTransport(["other.safetensors"]);
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport, pollIntervalMs: 0 });
    await backend.generate(loraInput, "sdxl.safetensors");

    const promptReq = transport.requests.find((r) => r.url.endsWith("/prompt"))!;
    const wf = (promptReq.body as { prompt: Record<string, { inputs: Record<string, unknown> }> }).prompt;
    expect(wf["10"]).toBeUndefined();
    expect(wf["3"]!.inputs.model).toEqual(["4", 0]);
  });

  it("AUTOMATIC1111: adds the LoRA via prompt syntax (graceful if missing)", async () => {
    const transport = new FakeTransport(() => ({ json: { images: [b64("A")] } }));
    const backend = new Automatic1111Backend({ baseUrl: "http://127.0.0.1:7860", transport });
    await backend.generate(loraInput, "");

    const body = transport.requests[0]!.body as { prompt: string };
    expect(body.prompt).toContain("<lora:anime:0.8>");
    expect(body.prompt).toContain("anime,");
  });
});

describe("parseExtraction", () => {
  it("parses valid JSON into the RawExtraction shape", () => {
    const raw = parseExtraction(
      JSON.stringify({
        characters: [{ name: "Ana", aliases: ["A"], persistentTraits: ["tall"], clothing: ["cloak"] }],
        environments: [{ name: "Hall", description: ["dim"] }],
        spoilers: [{ label: "twist", revealHint: "end" }],
      }),
    );
    expect(raw.characters[0]!.name).toBe("Ana");
    expect(raw.environments[0]!.name).toBe("Hall");
    expect(raw.spoilers[0]!.label).toBe("twist");
  });
  it("strips code fences and tolerates missing fields", () => {
    const raw = parseExtraction('```json\n{"characters":[{"name":"Bo"}]}\n```');
    expect(raw.characters[0]!.name).toBe("Bo");
    expect(raw.characters[0]!.aliases).toEqual([]);
    expect(raw.environments).toEqual([]);
  });
  it("strips a thinking model's <think> preamble before parsing (Qwen 3 etc.)", () => {
    const raw = parseExtraction(
      '<think>The chapter introduces Bo, who has red hair...</think>\n```json\n{"characters":[{"name":"Bo"}]}\n```',
    );
    expect(raw.characters[0]!.name).toBe("Bo"); // reasoning ignored, JSON still parsed
  });
  it("returns empty on invalid JSON", () => {
    expect(parseExtraction("not json")).toEqual({
      characters: [],
      glossary: [],
      environments: [],
      spoilers: [],
    });
  });
  it("parses folded keyEvents (scene prompts) with their beat-level location", () => {
    const raw = parseExtraction(
      JSON.stringify({
        characters: [],
        keyEvents: [
          { subject: "Ana", action: "runs", environment: "hall", mood: "tense", composition: "wide", location: "the Hall" },
        ],
      }),
    );
    expect(raw.keyEvents).toHaveLength(1);
    expect(raw.keyEvents![0]).toEqual({
      subject: "Ana",
      action: "runs",
      environment: "hall",
      mood: "tense",
      composition: "wide",
      location: "the Hall",
    });
  });
});

describe("WebLLMProvider (injected completion, no WebGPU)", () => {
  const req: VisualRequest = {
    kind: "scene_illustration",
    bookId: "b",
    pageId: "pg-0",
    pageIndex: 0,
    chapterIndex: 0,
    sourceText: "a quiet room",
    characterIds: [],
    environmentIds: [],
    creatureIds: [],
    spoilerIds: [],
  };

  it("extracts entities into the Bible", async () => {
    const complete = async () =>
      JSON.stringify({
        characters: [{ name: "Ana", aliases: [], persistentTraits: ["tall"], clothing: [] }],
        environments: [],
        spoilers: [],
      });
    const bible = await new WebLLMProvider({ complete }).extractEntities({
      bookId: "b",
      chapterIndex: 0,
      chapterText: "…",
      existing: emptyBible("b"),
    });
    expect(bible.characters.map((c) => c.name)).toContain("Ana");
  });

  it("returns the trimmed prompt text", async () => {
    const prompt = await new WebLLMProvider({ complete: async () => "  a vivid scene  " }).buildImagePrompt(
      req,
      emptyBible("b"),
    );
    expect(prompt).toBe("a vivid scene");
  });

  it("reports live token activity for bible extraction and prompt writing", async () => {
    const activity: Array<{ phase: string; tokens: number }> = [];
    const complete = async (
      _messages: unknown,
      opts: { json: boolean; onToken?: (n: number) => void },
    ): Promise<string> => {
      opts.onToken?.(1);
      opts.onToken?.(2);
      opts.onToken?.(3);
      return JSON.stringify({ characters: [], environments: [], spoilers: [] });
    };
    const provider = new WebLLMProvider({ complete, onActivity: (a) => activity.push(a) });

    await provider.extractEntities({ bookId: "b", chapterIndex: 0, chapterText: "x", existing: emptyBible("b") });
    expect(activity).toContainEqual({ phase: "bible", tokens: 3 });

    activity.length = 0;
    await provider.buildImagePrompt(req, emptyBible("b"));
    expect(activity).toContainEqual({ phase: "prompt", tokens: 3 });
  });

  it("degrades to the mock when the model errors (no GPU) — and says so via onFallback", async () => {
    const reasons: string[] = [];
    const provider = new WebLLMProvider({
      complete: async () => {
        throw new Error("no webgpu");
      },
      onFallback: (reason) => reasons.push(reason),
    });
    const bible = await provider.extractEntities({
      bookId: "b",
      chapterIndex: 0,
      chapterText: "x",
      existing: emptyBible("b"),
    });
    expect(bible).toBeDefined();
    const prompt = await provider.buildImagePrompt(req, emptyBible("b"));
    expect(prompt.length).toBeGreaterThan(0);
    // The degradation is loud: both calls reported the failure (with the cause).
    expect(reasons.length).toBe(2);
    expect(reasons[0]).toMatch(/unavailable/i);
    expect(reasons[0]).toContain("no webgpu");
  });
});

describe("LocalServerLLMProvider", () => {
  const sceneReq: VisualRequest = {
    kind: "scene_illustration",
    bookId: "b",
    pageId: "pg-0",
    pageIndex: 0,
    chapterIndex: 0,
    sourceText: "a quiet room",
    characterIds: [],
    environmentIds: [],
    creatureIds: [],
    spoilerIds: [],
  };

  it("requests json_object (not json_schema) and parses the Bible", async () => {
    const transport = new FakeTransport(() => ({
      json: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                characters: [{ name: "Cal", aliases: [], persistentTraits: ["scarred"], clothing: [] }],
                environments: [],
                spoilers: [],
              }),
            },
          },
        ],
      },
    }));
    const provider = new LocalServerLLMProvider({
      baseUrl: "http://localhost:11434/v1/",
      model: "llama3.2",
      transport,
    });
    const bible = await provider.extractEntities({
      bookId: "book",
      chapterIndex: 0,
      chapterText: "Cal walked in.",
      existing: emptyBible(),
    });

    const req = transport.requests[0]!;
    expect(req.url).toBe("http://localhost:11434/v1/chat/completions");
    const body = req.body as { response_format?: { type?: string }; model?: string; keep_alive?: string };
    expect(body.response_format?.type).toBe("json_object");
    expect(body.model).toBe("llama3.2");
    expect(body.keep_alive).toBe("30m"); // keeps the model resident between calls
    expect(bible.characters[0]?.name).toBe("Cal");
  });

  it("tolerates code-fenced JSON from a small model", async () => {
    const transport = new FakeTransport(() => ({
      json: {
        choices: [{ message: { content: '```json\n{"characters":[{"name":"Bo"}]}\n```' } }],
      },
    }));
    const provider = new LocalServerLLMProvider({ baseUrl: "http://localhost:1234/v1", model: "m", transport });
    const bible = await provider.extractEntities({
      bookId: "book",
      chapterIndex: 0,
      chapterText: "Bo waved.",
      existing: emptyBible(),
    });
    expect(bible.characters[0]?.name).toBe("Bo");
  });

  it("omits the auth header without a key and sends Bearer with one", async () => {
    const minimal = '{"characters":[],"environments":[],"spoilers":[],"summary":"s"}';
    const noKey = new FakeTransport(() => ({ json: { choices: [{ message: { content: minimal } }] } }));
    await new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", transport: noKey }).extractEntities({
      bookId: "b",
      chapterIndex: 0,
      chapterText: "x",
      existing: emptyBible(),
    });
    expect(noKey.requests[0]!.headers?.authorization).toBeUndefined();

    const withKey = new FakeTransport(() => ({ json: { choices: [{ message: { content: minimal } }] } }));
    await new LocalServerLLMProvider({
      baseUrl: "http://x/v1",
      model: "m",
      apiKey: "K",
      transport: withKey,
    }).extractEntities({ bookId: "b", chapterIndex: 0, chapterText: "x", existing: emptyBible() });
    expect(withKey.requests[0]!.headers?.authorization).toBe("Bearer K");
  });

  it("fails (for retry) when the extraction was truncated at the response limit", async () => {
    // OpenAI-compatible servers report finish_reason "length" when max_tokens cut
    // the response — the JSON is unusable, so the chapter must NOT silently commit
    // empty (that's how a chapter ends up stuck at 'waiting to be illustrated').
    const transport = new FakeTransport(() => ({
      json: { choices: [{ message: { content: '{"characters":[{"name":"Vio' }, finish_reason: "length" }] },
    }));
    const provider = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", transport });
    await expect(
      provider.extractEntities({ bookId: "b", chapterIndex: 9, chapterText: "long chapter", existing: emptyBible() }),
    ).rejects.toThrow(/truncated/);
  });

  it("fails (for retry) when the response parses to a completely empty extraction", async () => {
    const transport = new FakeTransport(() => ({
      json: { choices: [{ message: { content: "Sorry, here is my analysis: the chapter..." }, finish_reason: "stop" }] },
    }));
    const provider = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", transport });
    await expect(
      provider.extractEntities({ bookId: "b", chapterIndex: 9, chapterText: "x", existing: emptyBible() }),
    ).rejects.toThrow(/not parseable/);
  });

  it("raises the extraction response bound (folded scene prompts need headroom)", async () => {
    const transport = new FakeTransport(() => ({
      json: { choices: [{ message: { content: '{"summary":"s"}' } }] },
    }));
    const provider = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", transport });
    await provider.extractEntities({ bookId: "b", chapterIndex: 0, chapterText: "x", existing: emptyBible() });
    expect((transport.requests[0]!.body as { max_tokens?: number }).max_tokens).toBe(12288);
  });

  it("disables model reasoning for ANALYSIS calls only (chat keeps thinking)", async () => {
    // Extraction is rubric-guided structured capture; a thinking model's hidden
    // reasoning pass is the bulk of each chapter's analysis time on a local GPU.
    const transport = new FakeTransport(() => ({
      json: { choices: [{ message: { content: '{"summary":"s"}' } }] },
    }));
    const provider = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", transport });
    await provider.extractEntities({ bookId: "b", chapterIndex: 0, chapterText: "x", existing: emptyBible() });
    expect((transport.requests[0]!.body as { reasoning_effort?: string }).reasoning_effort).toBe("none");

    await provider.buildImagePrompt(
      { kind: "scene_illustration", bookId: "b", pageId: "p", pageIndex: 0, chapterIndex: 0, sourceText: "x", characterIds: [], environmentIds: [], creatureIds: [], spoilerIds: [] },
      emptyBible(),
    );
    expect((transport.requests[1]!.body as { reasoning_effort?: string }).reasoning_effort).toBe("none");

    await provider.chat([{ role: "user", content: "hi" }]);
    expect((transport.requests[2]!.body as { reasoning_effort?: string }).reasoning_effort).toBeUndefined();
  });

  it("retries an analysis call without the reasoning opt-out when a strict server 400s it", async () => {
    const transport = new FakeTransport((req) =>
      (req.body as { reasoning_effort?: string }).reasoning_effort
        ? { ok: false, status: 400, text: '{"error":"invalid reasoning_effort"}' }
        : { json: { choices: [{ message: { content: '{"summary":"s"}' } }] } },
    );
    const provider = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", transport });
    const bible = await provider.extractEntities({
      bookId: "b",
      chapterIndex: 0,
      chapterText: "x",
      existing: emptyBible(),
    });
    expect(bible.storyboard[0]?.summary).toBe("s");
    expect(transport.requests).toHaveLength(2); // rejected once, succeeded without the field
    expect((transport.requests[1]!.body as { reasoning_effort?: string }).reasoning_effort).toBeUndefined();
  });

  it("builds an image prompt without response_format and trims it", async () => {
    const transport = new FakeTransport(() => ({
      json: { choices: [{ message: { content: "  a vivid scene  " } }] },
    }));
    const provider = new LocalServerLLMProvider({ baseUrl: "http://x/v1", model: "m", transport });
    const prompt = await provider.buildImagePrompt(sceneReq, emptyBible("b"));
    expect(prompt).toBe("a vivid scene");
    expect((transport.requests[0]!.body as { response_format?: unknown }).response_format).toBeUndefined();
  });

  it("lists models from GET /models", async () => {
    const transport = new FakeTransport(() => ({ json: { data: [{ id: "llama3.2" }, { id: "qwen2.5" }] } }));
    const models = await LocalServerLLMProvider.listModels("http://localhost:11434/v1/", transport);
    const req = transport.requests[0]!;
    expect(req.url).toBe("http://localhost:11434/v1/models");
    expect(req.method).toBe("GET");
    expect(models).toEqual([
      { id: "llama3.2", label: "llama3.2" },
      { id: "qwen2.5", label: "qwen2.5" },
    ]);
  });

  it("factory builds it from a base URL, and throws without one", () => {
    expect(createLLMProvider("local-server", { baseUrl: "http://x/v1" }).id).toBe("local-server");
    expect(() => createLLMProvider("local-server", {})).toThrow(/base URL/);
  });

  it("pullModel streams NDJSON progress from {root}/api/pull (strips /v1)", async () => {
    const lines = [
      JSON.stringify({ status: "pulling manifest" }),
      JSON.stringify({ status: "downloading", total: 200, completed: 100 }),
      JSON.stringify({ status: "success" }),
    ].join("\n");
    let url = "";
    let body: unknown;
    const fakeFetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
      url = String(u);
      body = JSON.parse(String(init?.body));
      return new Response(lines, { status: 200 });
    }) as typeof fetch;
    const progress: { status: string; percent?: number }[] = [];
    await LocalServerLLMProvider.pullModel(
      "http://localhost:11434/v1",
      "qwen3:8b",
      (p) => progress.push(p),
      fakeFetch,
    );
    expect(url).toBe("http://localhost:11434/api/pull");
    expect(body).toEqual({ model: "qwen3:8b", stream: true });
    expect(progress.some((p) => p.status === "downloading" && p.percent === 50)).toBe(true);
    expect(progress.at(-1)?.status).toBe("success");
  });

  it("pullModel surfaces an Ollama error line as a rejection", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "pull model manifest: file does not exist" }), {
        status: 200,
      })) as typeof fetch;
    await expect(
      LocalServerLLMProvider.pullModel("http://x/v1", "nope", undefined, fakeFetch),
    ).rejects.toThrow(/does not exist/);
  });

  it("pullModelViaTransport posts stream:false through the Transport proxy", async () => {
    const t = new FakeTransport(() => ({ json: { status: "success" } }));
    await LocalServerLLMProvider.pullModelViaTransport("http://localhost:11434/v1/", "qwen3:8b", t);
    expect(t.requests[0]!.url).toBe("http://localhost:11434/api/pull");
    expect(t.requests[0]!.body).toEqual({ model: "qwen3:8b", stream: false });
  });

  it("with numCtx set, streams chat via Ollama NATIVE /api/chat and sends options.num_ctx", async () => {
    // num_ctx can't be set on the OpenAI /v1 endpoint, so a per-model window routes to the native
    // /api/chat (NDJSON). This is the lever that loads a big model at a small window so it fits VRAM.
    const ndjson = [
      JSON.stringify({ message: { content: "Hel" }, done: false }),
      JSON.stringify({ message: { content: "lo" }, done: false }),
      JSON.stringify({ done: true, done_reason: "stop" }),
    ].join("\n");
    let url = "";
    let body: { stream?: boolean; options?: { num_ctx?: number } } = {};
    const fakeFetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
      url = String(u);
      body = JSON.parse(String(init?.body));
      return new Response(ndjson, { status: 200 });
    }) as typeof fetch;
    const provider = new LocalServerLLMProvider({
      baseUrl: "http://localhost:11434/v1",
      model: "gemma4:31b",
      numCtx: 16384,
      fetchImpl: fakeFetch,
    });
    const tokens: string[] = [];
    const text = await provider.chat([{ role: "user", content: "hi" }], { onToken: (t) => tokens.push(t) });
    expect(url).toBe("http://localhost:11434/api/chat"); // native root (/v1 stripped)
    expect(body.stream).toBe(true);
    expect(body.options?.num_ctx).toBe(16384);
    expect(tokens.join("")).toBe("Hello");
    expect(text).toBe("Hello");
  });

  it("with numCtx set, extraction uses native /api/chat (stream:false, format json, options.num_ctx)", async () => {
    const transport = new FakeTransport(() => ({
      json: { message: { content: '{"characters":[{"name":"Cal","aliases":[],"persistentTraits":[],"clothing":[]}],"environments":[],"spoilers":[]}' } },
    }));
    const provider = new LocalServerLLMProvider({
      baseUrl: "http://localhost:11434/v1",
      model: "gemma4:31b",
      numCtx: 16384,
      transport,
    });
    const bible = await provider.extractEntities({ bookId: "b", chapterIndex: 0, chapterText: "Cal walked in.", existing: emptyBible() });
    const req = transport.requests[0]!;
    expect(req.url).toBe("http://localhost:11434/api/chat");
    const b = req.body as { stream?: boolean; format?: string; options?: { num_ctx?: number } };
    expect(b.stream).toBe(false);
    expect(b.format).toBe("json");
    expect(b.options?.num_ctx).toBe(16384);
    expect(bible.characters[0]?.name).toBe("Cal");
  });
});

describe("assetStem / pickComponentAsset (split-file variant matching)", () => {
  it("strips precision/quant qualifiers so variants share a stem", () => {
    expect(assetStem("qwen_3_8b_fp8mixed.safetensors")).toBe("qwen-3-8b");
    expect(assetStem("qwen_3_8b.safetensors")).toBe("qwen-3-8b"); // same component, no quant
    expect(assetStem("flux-2-klein-base-9b-fp8.safetensors")).toBe("flux-2-klein-base-9b");
    expect(assetStem("flux-2-klein-base-9b-fp16.safetensors")).toBe("flux-2-klein-base-9b");
    expect(assetStem("model-Q4_K_M.gguf")).toBe("model");
  });

  it("matches exact, then a same-stem variant, then a family pattern", () => {
    const installed = ["qwen_3_8b.safetensors", "clip_l.safetensors"];
    // No exact `_fp8mixed`, but the same-stem variant is accepted.
    expect(pickComponentAsset(installed, "qwen_3_8b_fp8mixed.safetensors", [/qwen.?3/i])).toBe("qwen_3_8b.safetensors");
    // Nothing matching the wanted name → fall back to the family regex.
    expect(pickComponentAsset(["mistral3-fp8.safetensors"], "qwen_3_8b_fp8mixed.safetensors", [/mistral/i])).toBe(
      "mistral3-fp8.safetensors",
    );
    // VAE by name hint when no exact/variant.
    expect(pickComponentAsset(["flux2_full_encoder.safetensors"], "full_encoder_small_decoder.safetensors", [], ["encoder"])).toBe(
      "flux2_full_encoder.safetensors",
    );
    expect(pickComponentAsset(["unrelated.safetensors"], "qwen_3_8b.safetensors", [/qwen/i])).toBeUndefined();
  });
});

describe("comfyExecutionError + flux2EncoderPatterns (encoder/model mismatch)", () => {
  it("translates a shape-mismatch into an encoder↔model guidance message", () => {
    const status = {
      status_str: "error",
      messages: [
        ["execution_start", {}],
        ["execution_error", { exception_message: "mat1 and mat2 shapes cannot be multiplied (512x12288 and 15360x6144)" }],
      ] as [string, Record<string, unknown>][],
    };
    const msg = comfyExecutionError(status)!;
    expect(msg).toMatch(/text encoder doesn't match/i);
    expect(msg).toMatch(/Mistral-Small/);
    expect(msg).toMatch(/Advanced: split-file/);
    expect(msg).toContain("15360x6144"); // raw kept for reference
  });
  it("gives a HiDream shape-mismatch a clip_g-specific message (not the Mistral one)", () => {
    const status = {
      status_str: "error",
      messages: [
        ["execution_error", { exception_message: "mat1 and mat2 shapes cannot be multiplied (1x768 and 2048x2560)" }],
      ] as [string, Record<string, unknown>][],
    };
    const msg = comfyExecutionError(status, "hidream")!;
    expect(msg).toMatch(/clip_g/);
    expect(msg).toMatch(/768 vs 2048|768.*2048/);
    expect(msg).not.toMatch(/Mistral/); // the Flux.2 translation must NOT fire for HiDream
    expect(msg).toContain("2048x2560"); // raw kept
  });
  it("names the resolved clip_l/clip_g files in a HiDream shape-mismatch when known", () => {
    const status = {
      status_str: "error",
      messages: [
        ["execution_error", { exception_message: "mat1 and mat2 shapes cannot be multiplied (2x768 and 2048x2560)" }],
      ] as [string, Record<string, unknown>][],
    };
    // The self-diagnosing case: a mislabeled clip_g (here, clip_l reused) is named outright so the
    // user can see WHICH file is wrong without opening the console.
    const msg = comfyExecutionError(status, "hidream", { clipL: "clip_l_hidream.safetensors", clipG: "clip_l_hidream.safetensors" })!;
    expect(msg).toContain("clip_l=clip_l_hidream.safetensors");
    expect(msg).toContain("clip_g=clip_l_hidream.safetensors");
    expect(msg).toMatch(/genuine clip_g/);
    // Without the resolved names it still works (no "Resolved files:" tail).
    expect(comfyExecutionError(status, "hidream")!).not.toMatch(/Resolved files/);
  });
  it("passes a non-cryptic error through, and returns undefined for success", () => {
    expect(
      comfyExecutionError({ status_str: "error", messages: [["execution_error", { exception_message: "Out of memory" }]] }),
    ).toBe("ComfyUI: Out of memory");
    expect(comfyExecutionError({ status_str: "success", messages: [] })).toBeUndefined();
    expect(comfyExecutionError(undefined)).toBeUndefined();
  });
  it("orders Flux.2 encoders by the model name (Klein→Qwen, dev→Mistral)", () => {
    const tryNames = (model: string, names: string[]) => {
      for (const re of flux2EncoderPatterns(model)) {
        const hit = names.find((n) => re.test(n));
        if (hit) return hit;
      }
      return undefined;
    };
    const both = ["mistral3-fp8.safetensors", "qwen_3_8b.safetensors"];
    expect(tryNames("flux2-klein-9b.safetensors", both)).toBe("qwen_3_8b.safetensors");
    expect(tryNames("flux2-dev.safetensors", both)).toBe("mistral3-fp8.safetensors");
    // Variant-specific: Klein must NOT match Z-Image's Qwen-3-4B (different hidden size → crash).
    expect(tryNames("flux2-klein-9b.safetensors", ["qwen_3_4b.safetensors"])).toBeUndefined();
    // With both 4B and 8B present, Klein still picks the 8B regardless of order.
    expect(tryNames("flux2-klein-9b.safetensors", ["qwen_3_4b.safetensors", "qwen_3_8b.safetensors"])).toBe("qwen_3_8b.safetensors");
    // A 4B Flux.2 variant → the Qwen-3 4B encoder (NOT the 8B / Mistral).
    expect(tryNames("flux2-4b-fp8.safetensors", ["qwen_3_4b.safetensors", "qwen_3_8b.safetensors", "mistral3.safetensors"])).toBe("qwen_3_4b.safetensors");
    // …but "94b"/"14b" in a name is NOT a 4B model (no false 4B match).
    expect(tryNames("flux2-94b.safetensors", both)).toBe("mistral3-fp8.safetensors");
  });
});

describe("createImageProvider local", () => {
  it("requires an engine, then delegates to the backend with the chosen model", async () => {
    expect(() => createImageProvider("local")).toThrow(/running engine/);

    let usedModel = "";
    const backend: LocalEngineBackend = {
      listModels: () => Promise.resolve([]),
      listComponents: () => Promise.resolve({ textEncoders: [], vaes: [] }),
      generate: (_input, model) => {
        usedModel = model;
        return Promise.resolve({ bytes: new ArrayBuffer(0), mimeType: "image/png" });
      },
    };
    const provider = createImageProvider("local", { engine: { backend, model: "flux-schnell" } });
    await provider.generate(imageInput);
    expect(usedModel).toBe("flux-schnell");
  });
});

describe("ComfyUI prompt formatting by family", () => {
  const png = new TextEncoder().encode("IMG").buffer;
  function comfyRun() {
    return new FakeTransport((req) => {
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "p1" } };
      if (req.url.includes("/history/"))
        return { json: { p1: { outputs: { "9": { images: [{ filename: "f.png", subfolder: "", type: "output" }] } } } } };
      return { bytes: png };
    });
  }
  function workflowOf(t: FakeTransport) {
    const r = t.requests.find((x) => x.url.endsWith("/prompt"))!;
    return (r.body as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }).prompt;
  }

  it("SD checkpoint → quality tags + a real negative prompt", async () => {
    const t = comfyRun();
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    await backend.generate(imageInput, "sd_xl_base_1.0.safetensors");
    const wf = workflowOf(t);
    expect(wf["6"]!.inputs.text).toContain("masterpiece");
    expect(wf["6"]!.inputs.text).toContain("a knight");
    expect(wf["7"]!.inputs.text).toContain("bad anatomy");
    // SD families keep the standard sampler settings.
    expect(wf["3"]!.inputs.cfg).toBe(7);
    expect(wf["3"]!.inputs.scheduler).toBe("normal");
  });

  it("Flux checkpoint → natural language, empty negative, Flux-correct sampler", async () => {
    const t = comfyRun();
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    await backend.generate(imageInput, "flux1-schnell-fp8.safetensors");
    const wf = workflowOf(t);
    expect(wf["6"]!.inputs.text).toBe("a knight");
    expect(wf["7"]!.inputs.text).toBe("");
    // Flux ignores CFG/negative → cfg≈1 + the "simple" scheduler.
    expect(wf["3"]!.inputs.cfg).toBe(1);
    expect(wf["3"]!.inputs.scheduler).toBe("simple");
  });

  it("Flux.2 Klein (catalog) → separate loaders from its exact files + real CFG 5", async () => {
    const t = new FakeTransport((req) => {
      if (req.url.endsWith("/object_info/CLIPLoader"))
        return { json: { CLIPLoader: { input: { required: { clip_name: [["qwen_3_8b_fp8mixed.safetensors"]] } } } } };
      if (req.url.endsWith("/object_info/VAELoader"))
        return { json: { VAELoader: { input: { required: { vae_name: [["full_encoder_small_decoder.safetensors"]] } } } } };
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "p1" } };
      if (req.url.includes("/history/"))
        return { json: { p1: { outputs: { "9": { images: [{ filename: "f.png", subfolder: "", type: "output" }] } } } } };
      return { bytes: png };
    });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    await backend.generate(imageInput, "flux-2-klein-base-9b-fp8.safetensors");
    const wf = workflowOf(t);
    expect(wf["4"]!.class_type).toBe("UNETLoader");
    expect(wf["12"]!.inputs).toMatchObject({ clip_name: "qwen_3_8b_fp8mixed.safetensors", type: "flux2" });
    expect(wf["13"]!.inputs.vae_name).toBe("full_encoder_small_decoder.safetensors");
    // Klein base is NOT guidance-distilled: real CFG 5, 20 steps, no FluxGuidance.
    expect(wf["3"]!.inputs.cfg).toBe(5);
    expect(wf["3"]!.inputs.steps).toBe(20);
    expect(wf["14"]).toBeUndefined();
    expect(wf["3"]!.inputs.positive).toEqual(["6", 0]);
    expect(wf["7"]!.inputs.text).toBe(""); // empty negative
  });

  // All-in-one checkpoint transport (lists the model so it loads via CheckpointLoaderSimple,
  // skipping split-file component resolution — sampler/resolution don't depend on load kind).
  const comfyCkpt = (name: string) =>
    new FakeTransport((req) => {
      if (req.url.endsWith("/object_info/CheckpointLoaderSimple"))
        return { json: { CheckpointLoaderSimple: { input: { required: { ckpt_name: [[name]] } } } } };
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "p1" } };
      if (req.url.includes("/history/"))
        return { json: { p1: { outputs: { "9": { images: [{ filename: "f.png", subfolder: "", type: "output" }] } } } } };
      return { bytes: png };
    });

  it("manual steps/CFG overrides win — CFG routes to real cfg on Klein (non-distilled)", async () => {
    const t = comfyCkpt("flux-2-klein-base-9b-fp8.safetensors");
    await new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 }).generate(
      { ...imageInput, modelFamily: "flux2", stepsOverride: 30, cfgOverride: 6.5 },
      "flux-2-klein-base-9b-fp8.safetensors",
    );
    const wf = workflowOf(t);
    expect(wf["3"]!.inputs.steps).toBe(30); // override beats the natural-language fixed 20
    expect(wf["3"]!.inputs.cfg).toBe(6.5); // Klein has no guidance node → real CFG
    expect(wf["14"]).toBeUndefined();
  });

  it("a CFG override on a guidance-distilled Flux routes to the FluxGuidance node, cfg stays 1", async () => {
    const t = comfyCkpt("flux1-schnell-fp8.safetensors");
    await new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 }).generate(
      { ...imageInput, modelFamily: "flux", cfgOverride: 2.5, stepsOverride: 18 },
      "flux1-schnell-fp8.safetensors",
    );
    const wf = workflowOf(t);
    expect(wf["3"]!.inputs.cfg).toBe(1); // KSampler cfg stays 1 for distilled Flux
    expect(wf["14"]!.inputs.guidance).toBe(2.5); // the CFG knob set embedded guidance
    expect(wf["3"]!.inputs.steps).toBe(18);
  });

  it("High/Ultra reach a larger canvas on Flux.2, but SDXL is still capped at 1024", async () => {
    const flux = comfyCkpt("flux2-dev.safetensors");
    await new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: flux, pollIntervalMs: 0 }).generate(
      { ...imageInput, modelFamily: "flux2", width: 1536, height: 1536 },
      "flux2-dev.safetensors",
    );
    expect((workflowOf(flux)["5"]!.inputs as { width: number }).width).toBe(1536);

    const sdxl = comfyCkpt("sd_xl_base_1.0.safetensors");
    await new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: sdxl, pollIntervalMs: 0 }).generate(
      { ...imageInput, modelFamily: "sdxl", width: 1536, height: 1536 },
      "sd_xl_base_1.0.safetensors",
    );
    expect((workflowOf(sdxl)["5"]!.inputs as { width: number }).width).toBe(1024); // clamped
  });

  it("Z-Image Turbo (catalog) → lumina2 encoder, AuraFlow shift, 8-step turbo sampler", async () => {
    const t = new FakeTransport((req) => {
      if (req.url.endsWith("/object_info/CLIPLoader"))
        return { json: { CLIPLoader: { input: { required: { clip_name: [["qwen_3_4b.safetensors"]] } } } } };
      if (req.url.endsWith("/object_info/VAELoader"))
        return { json: { VAELoader: { input: { required: { vae_name: [["ae.safetensors"]] } } } } };
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "p1" } };
      if (req.url.includes("/history/"))
        return { json: { p1: { outputs: { "9": { images: [{ filename: "f.png", subfolder: "", type: "output" }] } } } } };
      return { bytes: png };
    });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    await backend.generate(imageInput, "z_image_turbo_bf16.safetensors");
    const wf = workflowOf(t);
    expect(wf["4"]!.class_type).toBe("UNETLoader");
    expect(wf["12"]!.inputs).toMatchObject({ clip_name: "qwen_3_4b.safetensors", type: "lumina2" });
    expect(wf["13"]!.inputs.vae_name).toBe("ae.safetensors");
    expect(wf["3"]!.inputs).toMatchObject({ cfg: 1, steps: 8, sampler_name: "res_multistep" });
    // Sigma shift node wraps the model feeding the sampler (node 17, off the img2img 15/16 lane).
    expect(wf["17"]!.class_type).toBe("ModelSamplingAuraFlow");
    expect(wf["17"]!.inputs.shift).toBe(3);
    expect(wf["3"]!.inputs.model).toEqual(["17", 0]);
    expect(wf["6"]!.inputs.text).toBe("a knight"); // natural language, no SD tags
    expect(wf["7"]!.inputs.text).toBe("");
  });

  it("HiDream Dev (catalog) → QuadrupleCLIPLoader (4 encoders), Flux VAE, SD3 shift, distilled sampler", async () => {
    const encoders = [
      "clip_l_hidream.safetensors",
      "clip_g_hidream.safetensors",
      "t5xxl_fp8_e4m3fn_scaled.safetensors",
      "llama_3.1_8b_instruct_fp8_scaled.safetensors",
    ];
    const t = new FakeTransport((req) => {
      // HiDream resolves its encoders from the QuadrupleCLIPLoader enum (unioned with CLIPLoader).
      if (req.url.endsWith("/object_info/QuadrupleCLIPLoader"))
        return { json: { QuadrupleCLIPLoader: { input: { required: { clip_name1: [encoders] } } } } };
      if (req.url.endsWith("/object_info/VAELoader"))
        return { json: { VAELoader: { input: { required: { vae_name: [["ae.safetensors"]] } } } } };
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "p1" } };
      if (req.url.includes("/history/"))
        return { json: { p1: { outputs: { "9": { images: [{ filename: "f.png", subfolder: "", type: "output" }] } } } } };
      return { bytes: png };
    });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    await backend.generate(imageInput, "hidream_i1_dev_fp8.safetensors");
    const wf = workflowOf(t);
    expect(wf["4"]!.class_type).toBe("UNETLoader"); // diffusion-only load
    expect(wf["12"]!.class_type).toBe("QuadrupleCLIPLoader");
    expect(wf["12"]!.inputs).toMatchObject({
      clip_name1: "clip_l_hidream.safetensors",
      clip_name2: "clip_g_hidream.safetensors",
      clip_name3: "t5xxl_fp8_e4m3fn_scaled.safetensors",
      clip_name4: "llama_3.1_8b_instruct_fp8_scaled.safetensors",
    });
    expect(wf["13"]!.inputs.vae_name).toBe("ae.safetensors"); // Flux VAE
    // Dev recipe (catalog sampler), matching the working Comfy-Org template: cfg 2 (REAL CFG,
    // not guidance-distilled), lcm/normal, 28 steps, SD3 shift 5.5.
    expect(wf["3"]!.inputs).toMatchObject({ cfg: 2, steps: 28, sampler_name: "lcm", scheduler: "normal" });
    expect(wf["17"]!.class_type).toBe("ModelSamplingSD3");
    expect(wf["17"]!.inputs.shift).toBe(5.5);
    expect(wf["3"]!.inputs.model).toEqual(["17", 0]);
    expect(wf["14"]).toBeUndefined(); // real CFG, no FluxGuidance node
    // Plain CLIPTextEncode reads the full pooled (clip_l + clip_g = 2048) off the quad CLIP,
    // exactly like the official template.
    expect(wf["6"]!.class_type).toBe("CLIPTextEncode");
    expect(wf["6"]!.inputs).toMatchObject({ text: "a knight", clip: ["12", 0] });
    // HiDream runs at real CFG, so the NEGATIVE must be non-empty (empty → None pooled crash).
    expect(wf["7"]!.class_type).toBe("CLIPTextEncode");
    expect(String((wf["7"]!.inputs as { text: string }).text)).toContain("bad anatomy");
    expect(wf["5"]!.class_type).toBe("EmptySD3LatentImage"); // 16-channel latent
  });

  it("a catalog model with components missing names the exact files + the Download button", async () => {
    const t = new FakeTransport(() => ({ json: {} })); // nothing installed
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    await expect(backend.generate(imageInput, "z_image_turbo_bf16.safetensors")).rejects.toThrow(
      /qwen_3_4b\.safetensors.*ae\.safetensors.*Download button/s,
    );
  });

  it("a non-catalog Klein file picks Qwen-3-8B, not Z-Image's 4B (variant-specific)", async () => {
    // BOTH a Z-Image 4B and a Klein 8B are installed; Klein must pick the 8B (they have different
    // hidden sizes → the 4B would crash). A loose /qwen.?3/ used to grab whichever was listed first.
    const t = new FakeTransport((req) => {
      if (req.url.endsWith("/object_info/CLIPLoader"))
        return { json: { CLIPLoader: { input: { required: { clip_name: [["qwen_3_4b.safetensors", "qwen_3_8b_fp8mixed.safetensors"]] } } } } };
      if (req.url.endsWith("/object_info/VAELoader"))
        return { json: { VAELoader: { input: { required: { vae_name: [["flux2-vae.safetensors"]] } } } } };
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "p1" } };
      if (req.url.includes("/history/"))
        return { json: { p1: { outputs: { "9": { images: [{ filename: "f.png", subfolder: "", type: "output" }] } } } } };
      return { bytes: png };
    });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    await backend.generate(imageInput, "my-flux2-klein.safetensors");
    const wf = workflowOf(t);
    expect(wf["12"]!.inputs).toMatchObject({ clip_name: "qwen_3_8b_fp8mixed.safetensors", type: "flux2" });
    expect(wf["13"]!.inputs.vae_name).toBe("flux2-vae.safetensors");
  });

  it("a Klein file with ONLY Z-Image's 4B installed errors instead of loading the wrong 4B", async () => {
    // The reported bug: Klein (9B) was recommended/loaded Z-Image's Qwen-3-4B. Now it refuses and
    // asks for the right encoder rather than silently building a mismatched graph.
    const t = new FakeTransport((req) => {
      if (req.url.endsWith("/object_info/CLIPLoader"))
        return { json: { CLIPLoader: { input: { required: { clip_name: [["qwen_3_4b.safetensors"]] } } } } };
      if (req.url.endsWith("/object_info/VAELoader"))
        return { json: { VAELoader: { input: { required: { vae_name: [["flux2-vae.safetensors"]] } } } } };
      return { bytes: png };
    });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    await expect(backend.generate(imageInput, "my-flux2-klein.safetensors")).rejects.toThrow(/text encoder/i);
  });

  it("modelFamily override forces formatting for a non-catalog checkpoint (beats the filename heuristic)", async () => {
    const t = comfyRun();
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    // Not a catalog model, so the override applies over the lenient filename heuristic (which would
    // otherwise read "flux"). A KNOWN catalog model would keep its curated family — the override
    // can't reclassify it into an incompatible encoder structure (e.g. HiDream → Flux.2).
    await backend.generate({ ...imageInput, modelFamily: "sdxl" }, "my_flux_merge.safetensors");
    const wf = workflowOf(t);
    expect(wf["7"]!.inputs.text).toContain("bad anatomy"); // override → treated as SDXL
  });

  it("SD uses cfg 7; Flux uses cfg 1 + a FluxGuidance node", async () => {
    const sd = comfyRun();
    await new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: sd, pollIntervalMs: 0 }).generate(
      imageInput,
      "sd_xl_base_1.0.safetensors",
    );
    const sdwf = workflowOf(sd);
    expect(sdwf["3"]!.inputs.cfg).toBe(7);
    expect(sdwf["14"]).toBeUndefined(); // no FluxGuidance for SD
    expect(sdwf["3"]!.inputs.positive).toEqual(["6", 0]);

    const flux = comfyRun();
    await new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: flux, pollIntervalMs: 0 }).generate(
      imageInput,
      "flux1-schnell-fp8.safetensors",
    );
    const fwf = workflowOf(flux);
    expect(fwf["3"]!.inputs.cfg).toBe(1);
    expect(fwf["14"]!.class_type).toBe("FluxGuidance"); // embedded guidance
    expect(fwf["3"]!.inputs.positive).toEqual(["14", 0]); // sampler reads guided conditioning
  });

  it("Flux.2 builds a separate-loader graph (UNET + CLIP encoder + VAE), not CheckpointLoaderSimple", async () => {
    const t = new FakeTransport((req) => {
      if (req.url.endsWith("/object_info/VAELoader"))
        return { json: { VAELoader: { input: { required: { vae_name: [["flux2-vae.safetensors"]] } } } } };
      if (req.url.endsWith("/object_info/CLIPLoader"))
        return { json: { CLIPLoader: { input: { required: { clip_name: [["mistral3-fp8.safetensors"]] } } } } };
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "p1" } };
      if (req.url.includes("/history/"))
        return { json: { p1: { outputs: { "9": { images: [{ filename: "f.png", subfolder: "", type: "output" }] } } } } };
      return { bytes: new TextEncoder().encode("IMG").buffer };
    });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    await backend.generate({ ...imageInput, modelFamily: "flux2" }, "flux2-dev.safetensors");
    const wf = workflowOf(t);
    expect(wf["4"]!.class_type).toBe("UNETLoader");
    expect(wf["4"]!.inputs.unet_name).toBe("flux2-dev.safetensors");
    expect(wf["12"]!.class_type).toBe("CLIPLoader");
    expect(wf["12"]!.inputs.clip_name).toBe("mistral3-fp8.safetensors");
    expect(wf["13"]!.class_type).toBe("VAELoader");
    expect(wf["13"]!.inputs.vae_name).toBe("flux2-vae.safetensors");
    // CLIP + VAE come from the separate loaders, not a checkpoint.
    expect(wf["6"]!.inputs.clip).toEqual(["12", 0]);
    expect(wf["8"]!.inputs.vae).toEqual(["13", 0]);
  });

  it("Flux.2 (diffusion path): applies a style LoRA via LoraLoaderModelOnly", async () => {
    const t = new FakeTransport((req) => {
      if (req.url.endsWith("/object_info/VAELoader"))
        return { json: { VAELoader: { input: { required: { vae_name: [["flux2-vae.safetensors"]] } } } } };
      if (req.url.endsWith("/object_info/CLIPLoader"))
        return { json: { CLIPLoader: { input: { required: { clip_name: [["mistral3-fp8.safetensors"]] } } } } };
      if (req.url.endsWith("/object_info/LoraLoader"))
        return { json: { LoraLoader: { input: { required: { lora_name: [["anime.safetensors"]] } } } } };
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "p1" } };
      if (req.url.includes("/history/"))
        return { json: { p1: { outputs: { "9": { images: [{ filename: "f.png", subfolder: "", type: "output" }] } } } } };
      return { bytes: new TextEncoder().encode("IMG").buffer };
    });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    await backend.generate(
      { ...imageInput, modelFamily: "flux2", styleLora: { name: "anime", strength: 0.8, trigger: "anime" } },
      "flux2-dev.safetensors",
    );
    const wf = workflowOf(t);
    // A UNET-only model gets a model-only LoRA (no clip output to thread through).
    expect(wf["11"]!.class_type).toBe("LoraLoaderModelOnly");
    expect(wf["11"]!.inputs.lora_name).toBe("anime.safetensors");
    expect(wf["11"]!.inputs.model).toEqual(["4", 0]); // wraps the UNET
    expect(wf["3"]!.inputs.model).toEqual(["11", 0]); // sampler reads the LoRA'd model
    expect(wf["6"]!.inputs.text).toContain("anime,"); // trigger still prepended
  });

  it("Flux.2 with no Mistral encoder / VAE installed throws an actionable error", async () => {
    const t = new FakeTransport(() => ({ json: {} })); // no enums available
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    await expect(backend.generate({ ...imageInput, modelFamily: "flux2" }, "flux2-dev.safetensors")).rejects.toThrow(
      /Flux\.2 needs/i,
    );
  });

  it("surfaces ComfyUI's real execution error (encoder/model mismatch), not 'no image'", async () => {
    const t = new FakeTransport((req) => {
      if (req.url.endsWith("/object_info/VAELoader"))
        return { json: { VAELoader: { input: { required: { vae_name: [["flux2-vae.safetensors"]] } } } } };
      if (req.url.endsWith("/object_info/CLIPLoader"))
        return { json: { CLIPLoader: { input: { required: { clip_name: [["qwen_3_8b.safetensors"]] } } } } };
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "p1" } };
      if (req.url.includes("/history/"))
        return {
          json: {
            p1: {
              outputs: {}, // failed → no image
              status: {
                status_str: "error",
                messages: [["execution_error", { exception_message: "mat1 and mat2 shapes cannot be multiplied (512x12288 and 15360x6144)" }]],
              },
            },
          },
        };
      return { bytes: new ArrayBuffer(0) };
    });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    await expect(backend.generate({ ...imageInput, modelFamily: "flux2" }, "flux2-dev.safetensors")).rejects.toThrow(
      /text encoder doesn't match/i,
    );
  });

  it("Flux.2 Klein resolves a same-family VARIANT encoder/VAE (different quant / naming)", async () => {
    // The user dropped in differently-named-but-compatible files: the Qwen-3 encoder
    // WITHOUT the catalog's `_fp8mixed` suffix, and a Flux.2 VAE under another name.
    const t = new FakeTransport((req) => {
      if (req.url.endsWith("/object_info/VAELoader"))
        return { json: { VAELoader: { input: { required: { vae_name: [["flux2_full_encoder.safetensors"]] } } } } };
      if (req.url.endsWith("/object_info/CLIPLoader"))
        return { json: { CLIPLoader: { input: { required: { clip_name: [["qwen_3_8b.safetensors"]] } } } } };
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "p1" } };
      if (req.url.includes("/history/"))
        return { json: { p1: { outputs: { "9": { images: [{ filename: "f.png", subfolder: "", type: "output" }] } } } } };
      return { bytes: new TextEncoder().encode("IMG").buffer };
    });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    // The catalog Klein filename → catalog-first wants qwen_3_8b_fp8mixed + full_encoder_small_decoder.
    await backend.generate({ ...imageInput, modelFamily: "flux2" }, "flux-2-klein-base-9b-fp8.safetensors");
    const wf = workflowOf(t);
    expect(wf["12"]!.inputs.clip_name).toBe("qwen_3_8b.safetensors"); // variant encoder accepted
    expect(wf["12"]!.inputs.type).toBe("flux2"); // catalog clip type still applied
    expect(wf["13"]!.inputs.vae_name).toBe("flux2_full_encoder.safetensors"); // variant VAE accepted
  });

  it("Flux.2 honours a manual text-encoder / VAE override over auto-detection", async () => {
    // Two encoders + two VAEs installed; auto-detect would pick by heuristic, but the
    // user pinned the exact files they know work (input.textEncoder / input.vae).
    const t = new FakeTransport((req) => {
      if (req.url.endsWith("/object_info/VAELoader"))
        return { json: { VAELoader: { input: { required: { vae_name: [["flux2-vae.safetensors", "my-vae.safetensors"]] } } } } };
      if (req.url.endsWith("/object_info/CLIPLoader"))
        return { json: { CLIPLoader: { input: { required: { clip_name: [["mistral3-fp8.safetensors", "my-encoder.safetensors"]] } } } } };
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "p1" } };
      if (req.url.includes("/history/"))
        return { json: { p1: { outputs: { "9": { images: [{ filename: "f.png", subfolder: "", type: "output" }] } } } } };
      return { bytes: new TextEncoder().encode("IMG").buffer };
    });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    await backend.generate(
      { ...imageInput, modelFamily: "flux2", textEncoder: "my-encoder.safetensors", vae: "my-vae.safetensors" },
      "flux2-dev.safetensors",
    );
    const wf = workflowOf(t);
    expect(wf["12"]!.inputs.clip_name).toBe("my-encoder.safetensors"); // override, not the mistral heuristic
    expect(wf["13"]!.inputs.vae_name).toBe("my-vae.safetensors");
  });

  it("an all-in-one Flux.2 checkpoint (Klein) loads via CheckpointLoaderSimple with Flux sampling", async () => {
    const t = new FakeTransport((req) => {
      // The Klein file IS in ComfyUI's checkpoint list → all-in-one, no separate loaders.
      if (req.url.endsWith("/object_info/CheckpointLoaderSimple"))
        return {
          json: {
            CheckpointLoaderSimple: { input: { required: { ckpt_name: [["flux2-klein-9b-fp8.safetensors"]] } } },
          },
        };
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "p1" } };
      if (req.url.includes("/history/"))
        return { json: { p1: { outputs: { "9": { images: [{ filename: "f.png", subfolder: "", type: "output" }] } } } } };
      return { bytes: new TextEncoder().encode("IMG").buffer };
    });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    await backend.generate({ ...imageInput, modelFamily: "flux2" }, "flux2-klein-9b-fp8.safetensors");
    const wf = workflowOf(t);
    expect(wf["4"]!.class_type).toBe("CheckpointLoaderSimple");
    expect(wf["3"]!.inputs.cfg).toBe(1); // still Flux sampling
    expect(wf["14"]!.class_type).toBe("FluxGuidance");
  });
});

describe("ComfyUI IP-Adapter (version-aware, graceful)", () => {
  const png = new TextEncoder().encode("IMG").buffer;
  const refInput = {
    ...imageInput,
    ipAdapterRefs: [{ bytes: new ArrayBuffer(3), mimeType: "image/png", weight: 0.7 }],
  };
  function transportWith(objectInfo: Record<string, unknown>) {
    return new FakeTransport((req) => {
      if (req.url.endsWith("/object_info")) return { json: objectInfo };
      if (req.url.endsWith("/upload/image")) return { json: { name: "vr-ref.png" } };
      if (req.url.endsWith("/prompt")) return { json: { prompt_id: "p1" } };
      if (req.url.includes("/history/"))
        return { json: { p1: { outputs: { "9": { images: [{ filename: "f.png", subfolder: "", type: "output" }] } } } } };
      return { bytes: png };
    });
  }
  function workflowOf(t: FakeTransport) {
    const r = t.requests.find((x) => x.url.endsWith("/prompt"))!;
    return (r.body as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }).prompt;
  }

  it("modern node set → IPAdapterUnifiedLoader + IPAdapterAdvanced wired to the sampler", async () => {
    const t = transportWith({ IPAdapterAdvanced: { input: {} }, IPAdapterUnifiedLoader: { input: {} } });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    await backend.generate(refInput, "sd_xl_base_1.0.safetensors");
    const wf = workflowOf(t);
    expect(wf["20"]!.class_type).toBe("IPAdapterUnifiedLoader");
    expect(wf["22"]!.class_type).toBe("IPAdapterAdvanced");
    expect(wf["3"]!.inputs.model).toEqual(["22", 0]);
    expect(t.requests.some((r) => r.url.endsWith("/upload/image"))).toBe(true);
    // Scene-focused tuning: STANDARD preset (not high-strength) and IP-Adapter ends
    // partway so composition forms before identity is refined (no portrait bias).
    expect(wf["20"]!.inputs.preset).toBe("STANDARD");
    expect(wf["22"]!.inputs.end_at).toBeLessThan(1);
  });

  it("old node set → IPAdapterModelLoader + CLIPVisionLoader + IPAdapterApply", async () => {
    const t = transportWith({
      IPAdapterApply: { input: {} },
      IPAdapterModelLoader: { input: { required: { ipadapter_file: [["ip-adapter-plus_sd15.safetensors"], {}] } } },
      CLIPVisionLoader: { input: { required: { clip_name: [["clip_vision_g.safetensors"], {}] } } },
    });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    await backend.generate(refInput, "v1-5-pruned-emaonly-fp16.safetensors");
    const wf = workflowOf(t);
    expect(wf["20"]!.class_type).toBe("IPAdapterModelLoader");
    expect(wf["21"]!.class_type).toBe("CLIPVisionLoader");
    expect(wf["23"]!.class_type).toBe("IPAdapterApply");
    expect(wf["3"]!.inputs.model).toEqual(["23", 0]);
  });

  it("no IP-Adapter nodes installed → seed-only, generation still succeeds", async () => {
    const t = transportWith({});
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: t, pollIntervalMs: 0 });
    const out = await backend.generate(refInput, "sd_xl_base_1.0.safetensors");
    const wf = workflowOf(t);
    expect(wf["20"]).toBeUndefined(); // no IP-Adapter chain
    expect(wf["3"]!.inputs.model).toEqual(["4", 0]); // sampler reads the checkpoint directly
    expect(new TextDecoder().decode(out.bytes)).toBe("IMG");
    expect(t.requests.some((r) => r.url.endsWith("/upload/image"))).toBe(false);
  });
});

describe("LOCAL_IMAGE_MODELS catalog", () => {
  it("split-file entries are complete: valid URLs, all three components, sizes", () => {
    const splitIds = ["z-image-turbo", "flux2-klein-9b", "qwen-image"];
    for (const id of splitIds) {
      const entry = LOCAL_IMAGE_MODELS.find((m) => m.id === id)!;
      expect(entry, id).toBeDefined();
      expect(entry.files!.length).toBeGreaterThanOrEqual(3);
      expect(entry.clipType).toBeTruthy();
      expect(entry.sizeGB).toBeGreaterThan(0);
      const folders = entry.files!.map((f) => f.folder);
      expect(folders).toContain("diffusion_models");
      expect(folders).toContain("text_encoders");
      expect(folders).toContain("vae");
      for (const f of entry.files!) {
        expect(f.url, `${id}/${f.filename}`).toMatch(/^https:\/\/huggingface\.co\/.+\.safetensors$/);
        expect(f.filename).toMatch(/\.safetensors$/);
      }
      // The main filename is the diffusion model — what the engine lists/selects.
      expect(entry.files!.find((f) => f.folder === "diffusion_models")!.filename).toBe(entry.filename);
      expect(entry.url).toBeTruthy();
    }
  });
  it("resolves entries and families by id and by main filename", () => {
    expect(catalogEntryForModel("z-image-turbo")?.id).toBe("z-image-turbo");
    expect(catalogEntryForModel("z_image_turbo_bf16.safetensors")?.id).toBe("z-image-turbo");
    expect(catalogModelFamily("z_image_turbo_bf16.safetensors")).toBe("zimage");
    expect(catalogModelFamily("flux-2-klein-base-9b-fp8.safetensors")).toBe("flux2");
    expect(catalogModelFamily("qwen_image_fp8_e4m3fn.safetensors")).toBe("qwenimage");
    expect(catalogEntryForModel("nope.safetensors")).toBeUndefined();
  });
  it("Klein base carries a real-CFG sampler override (it is not guidance-distilled)", () => {
    const klein = LOCAL_IMAGE_MODELS.find((m) => m.id === "flux2-klein-9b")!;
    expect(klein.sampler).toMatchObject({ cfg: 5, steps: 20 });
    expect(klein.sampler!.guidance).toBeUndefined();
  });
});

describe("OLLAMA_TEXT_MODELS catalog", () => {
  it("offers the curated pull menu with a recommended default first", () => {
    expect(OLLAMA_TEXT_MODELS[0]!.id).toBe("qwen3:8b");
    for (const m of OLLAMA_TEXT_MODELS) {
      expect(m.id).toMatch(/^[\w.-]+:[\w.-]+$/); // name:tag
      expect(m.sizeGB).toBeGreaterThan(0);
    }
  });
  it("matches server-reported ids exactly, by :latest, or by bare name", () => {
    expect(ollamaModelMatches("qwen3:8b", "qwen3:8b")).toBe(true);
    expect(ollamaModelMatches("qwen3:latest", "qwen3")).toBe(true);
    expect(ollamaModelMatches("qwen3:14b", "qwen3")).toBe(true);
    expect(ollamaModelMatches("qwen3:14b", "qwen3:8b")).toBe(false);
  });
});
