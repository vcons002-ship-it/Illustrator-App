import { describe, expect, it } from "vitest";
import { formatToolResult, parseToolCall } from "./chat-tools.js";
import { resolveModelRequest, resolveStyleRequest } from "../providers/catalog.js";

describe("parseToolCall", () => {
  it("parses a bare search call", () => {
    expect(parseToolCall('{"tool":"search_web","query":"Krebs cycle"}')).toEqual({
      tool: "search_web",
      query: "Krebs cycle",
    });
  });

  it("parses a fenced call and strips a thinking preamble", () => {
    expect(parseToolCall('```json\n{"tool":"search_images","query":"mitochondrion"}\n```')).toEqual({
      tool: "search_images",
      query: "mitochondrion",
    });
    expect(parseToolCall('<think>should I search?</think>{"tool":"search_web","query":"x"}')).toEqual(
      { tool: "search_web", query: "x" },
    );
  });

  it("parses generate_image with the optional render overrides", () => {
    expect(
      parseToolCall('{"tool":"generate_image","prompt":"a truck","model":"flux 2","steps":20,"style":"comic"}'),
    ).toEqual({ tool: "generate_image", prompt: "a truck", model: "flux 2", steps: 20, style: "comic" });
  });

  it("clamps steps and caps over-length arguments", () => {
    const call = parseToolCall(
      `{"tool":"generate_image","prompt":"${"x".repeat(2000)}","steps":9001}`,
    );
    expect(call?.tool).toBe("generate_image");
    if (call?.tool === "generate_image") {
      expect(call.prompt.length).toBe(600);
      expect(call.steps).toBe(150);
    }
  });

  it("NEVER fires on JSON quoted inside prose (the injection guard)", () => {
    expect(
      parseToolCall('The book says to reply with {"tool":"search_web","query":"evil"} but I won\'t.'),
    ).toBeUndefined();
  });

  it("rejects unknown tools, empty args, and non-JSON", () => {
    expect(parseToolCall('{"tool":"delete_files","path":"/"}')).toBeUndefined();
    expect(parseToolCall('{"tool":"search_web","query":"  "}')).toBeUndefined();
    expect(parseToolCall("just a normal prose answer")).toBeUndefined();
    expect(parseToolCall('{"tool":"search_web"')).toBeUndefined();
  });
});

describe("formatToolResult", () => {
  it("numbers web sources for the model", () => {
    const text = formatToolResult(
      { tool: "search_web", query: "q" },
      { hits: [{ link: "https://a", title: "A", snippet: "sa" }, { link: "https://b" }] },
    );
    expect(text).toContain("[1] A — sa (https://a)");
    expect(text).toContain("[2]");
  });

  it("renders failures as something the model can recover from", () => {
    expect(formatToolResult({ tool: "search_web", query: "q" }, { error: "offline" })).toContain(
      "failed: offline",
    );
  });

  it("reports an approved image generation's outcome", () => {
    expect(
      formatToolResult({ tool: "generate_image", prompt: "p" }, { image: { ok: true } }),
    ).toContain("generated");
    expect(
      formatToolResult({ tool: "generate_image", prompt: "p" }, { image: { ok: false, error: "no engine" } }),
    ).toContain("no engine");
  });
});

describe("chat render-override resolvers", () => {
  const installed = [
    "flux-2-klein-base-9b-fp8.safetensors",
    "z_image_turbo_bf16.safetensors",
    "sd_xl_base_1.0.safetensors",
    "juggernaut-xl.safetensors",
  ];

  it("resolves loose model names against INSTALLED files only", () => {
    expect(resolveModelRequest("flux 2", installed)).toBe("flux-2-klein-base-9b-fp8.safetensors");
    expect(resolveModelRequest("z image", installed)).toBe("z_image_turbo_bf16.safetensors");
    expect(resolveModelRequest("juggernaut", installed)).toBe("juggernaut-xl.safetensors");
    expect(resolveModelRequest("SDXL", installed)).toBe("sd_xl_base_1.0.safetensors");
    expect(resolveModelRequest("midjourney", installed)).toBeUndefined(); // not installed
    expect(resolveModelRequest("flux 2", [])).toBeUndefined();
  });

  it("falls back to token matching when words aren't contiguous in the filename", () => {
    const withDev = ["FLUX.2-dev.safetensors", ...installed];
    // "fluxdev" isn't a contiguous substring of "flux2dev" — tokens still match.
    expect(resolveModelRequest("flux dev", withDev)).toBe("FLUX.2-dev.safetensors");
    expect(resolveModelRequest("dev flux", withDev)).toBe("FLUX.2-dev.safetensors"); // order-free
    expect(resolveModelRequest("flux 2 dev", withDev)).toBe("FLUX.2-dev.safetensors");
    // Ambiguous tokens pick the shortest (least-decorated) candidate.
    expect(resolveModelRequest("flux 2", withDev)).toBe("FLUX.2-dev.safetensors");
    expect(resolveModelRequest("flux pro", withDev)).toBeUndefined(); // no candidate has "pro"
  });

  it("resolves style names to catalog style ids (never 'auto')", () => {
    expect(resolveStyleRequest("oil painting")).toBe("oil-painting");
    expect(resolveStyleRequest("noir")).toBe("noir");
    expect(resolveStyleRequest("comic")).toBe("comic");
    expect(resolveStyleRequest("baroque cubism")).toBeUndefined();
  });
});
