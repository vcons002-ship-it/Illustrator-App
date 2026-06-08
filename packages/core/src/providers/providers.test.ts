import { describe, it, expect } from "vitest";
import { DirectTransport } from "./transport/transport.js";
import type { Transport, TransportRequest, TransportResponse } from "./transport/transport.js";
import type { VisualBible } from "../types/bible.js";
import type { ImageGenerationInput } from "./image/image-provider.js";
import { GeminiLLMProvider } from "./llm/gemini-provider.js";
import { OpenAILLMProvider } from "./llm/openai-provider.js";
import { GeminiImageProvider } from "./image/gemini-image-provider.js";
import { OpenAIImageProvider } from "./image/openai-image-provider.js";
import { FluxProvider } from "./image/flux-provider.js";
import { ComfyUIBackend, resolveAssetName } from "./image/local-engine/comfyui-backend.js";
import { Automatic1111Backend } from "./image/local-engine/automatic1111-backend.js";
import { WebLLMProvider, parseExtraction } from "./llm/webllm-provider.js";
import type { VisualRequest } from "../types/content.js";
import { createImageProvider } from "./factory.js";
import { IMAGE_PROVIDERS, TEXT_PROVIDERS, styleLoraDownload } from "./catalog.js";
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
  return { bookId, version: 1, characters: [], environments: [], spoilers: [], processedChapters: [] };
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

describe("GeminiImageProvider", () => {
  it("decodes the inline base64 prediction", async () => {
    const transport = new FakeTransport(() => ({
      json: { predictions: [{ bytesBase64Encoded: b64("PNGDATA"), mimeType: "image/png" }] },
    }));
    const provider = new GeminiImageProvider({ apiKey: "KEY", transport });
    const out = await provider.generate(imageInput);
    expect(new TextDecoder().decode(out.bytes)).toBe("PNGDATA");
    expect(transport.requests[0]!.url).toContain(":predict?key=KEY");
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

  it("runs the prompt → history → view flow", async () => {
    const png = new TextEncoder().encode("COMFY").buffer;
    const transport = new FakeTransport((_req, i) => {
      if (i === 0) return { json: { prompt_id: "p1" } };
      if (i === 1) return { json: {} }; // not ready yet
      if (i === 2)
        return { json: { p1: { outputs: { "9": { images: [{ filename: "f.png", subfolder: "", type: "output" }] } } } } };
      return { bytes: png };
    });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188/", transport, pollIntervalMs: 0 });
    const out = await backend.generate(imageInput, "sdxl.safetensors");

    expect(transport.requests[0]!.url).toBe("http://127.0.0.1:8188/prompt");
    const body = transport.requests[0]!.body as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> };
    expect(body.prompt["4"]!.inputs.ckpt_name).toBe("sdxl.safetensors");
    expect(transport.requests[3]!.url).toContain("/view?filename=f.png");
    expect(new TextDecoder().decode(out.bytes)).toBe("COMFY");
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
    const body = transport.requests[0]!.body as { prompt: string; override_settings: { sd_model_checkpoint: string } };
    expect(body.prompt).toBe("a knight");
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
  it("returns empty on invalid JSON", () => {
    expect(parseExtraction("not json")).toEqual({ characters: [], environments: [], spoilers: [] });
  });
});

describe("WebLLMProvider (injected completion, no WebGPU)", () => {
  const req: VisualRequest = {
    kind: "scene_illustration",
    bookId: "b",
    pageId: "pg-0",
    pageIndex: 0,
    sourceText: "a quiet room",
    characterIds: [],
    environmentIds: [],
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

  it("degrades to the mock when the model errors (no GPU)", async () => {
    const provider = new WebLLMProvider({
      complete: async () => {
        throw new Error("no webgpu");
      },
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
  });
});

describe("createImageProvider local", () => {
  it("requires an engine, then delegates to the backend with the chosen model", async () => {
    expect(() => createImageProvider("local")).toThrow(/running engine/);

    let usedModel = "";
    const backend: LocalEngineBackend = {
      listModels: () => Promise.resolve([]),
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
