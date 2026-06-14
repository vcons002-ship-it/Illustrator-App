import { describe, expect, it } from "vitest";
import { CHAT_TOOLS_SYSTEM, formatToolResult, parseToolCall } from "./chat-tools.js";
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

  it("parses read_url (http/https only)", () => {
    expect(parseToolCall('{"tool":"read_url","url":"https://docs.example.com/api"}')).toEqual({
      tool: "read_url",
      url: "https://docs.example.com/api",
    });
    expect(parseToolCall('{"tool":"read_url","url":"ftp://x"}')).toBeUndefined();
    expect(parseToolCall('{"tool":"read_url","url":"not a url"}')).toBeUndefined();
  });

  it("parses export_book (format defaults to html)", () => {
    expect(parseToolCall('{"tool":"export_book","format":"epub"}')).toEqual({ tool: "export_book", format: "epub" });
    expect(parseToolCall('{"tool":"export_book","format":"html"}')).toEqual({ tool: "export_book", format: "html" });
    expect(parseToolCall('{"tool":"export_book"}')).toEqual({ tool: "export_book", format: "html" });
    expect(parseToolCall('{"tool":"export_book","format":"pdf"}')).toEqual({ tool: "export_book", format: "html" });
  });

  it("parses an analyze_data spec (op/agg/columns/filters/chart)", () => {
    const call = parseToolCall(
      '{"tool":"analyze_data","op":"groupby","groupBy":"Region","agg":"sum","valueColumn":"Revenue",' +
        '"filters":[{"column":"Product","op":"=","value":"Widget"}],"chart":"bar"}',
    );
    expect(call).toEqual({
      tool: "analyze_data",
      op: "groupby",
      groupBy: "Region",
      agg: "sum",
      valueColumn: "Revenue",
      filters: [{ column: "Product", op: "=", value: "Widget" }],
      chart: "bar",
    });
  });

  it("rejects analyze_data with an unknown op, and drops a bad agg/chart/filter", () => {
    expect(parseToolCall('{"tool":"analyze_data","op":"frobnicate"}')).toBeUndefined();
    const call = parseToolCall(
      '{"tool":"analyze_data","op":"describe","agg":"bogus","chart":"hologram",' +
        '"filters":[{"column":"X","op":"~~","value":1},{"column":"Y","op":">","value":3}]}',
    );
    expect(call).toEqual({ tool: "analyze_data", op: "describe", filters: [{ column: "Y", op: ">", value: 3 }] });
  });

  it("parses memory calls and caps their length", () => {
    expect(parseToolCall('{"tool":"remember","note":"prefers watercolor"}')).toEqual({
      tool: "remember",
      note: "prefers watercolor",
    });
    expect(parseToolCall('{"tool":"forget","match":"watercolor"}')).toEqual({
      tool: "forget",
      match: "watercolor",
    });
    const long = parseToolCall(`{"tool":"remember","note":"${"x".repeat(500)}"}`);
    expect(long?.tool === "remember" && long.note.length).toBe(200);
    expect(parseToolCall('{"tool":"remember","note":"  "}')).toBeUndefined();
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

  it("feeds a fetched page back as reference data (with a not-instructions guard)", () => {
    const text = formatToolResult(
      { tool: "read_url", url: "https://docs.example.com" },
      { page: { title: "API Docs", text: "Use fetch() like this…" } },
    );
    expect(text).toContain("docs.example.com");
    expect(text).toContain("API Docs");
    expect(text).toContain("Use fetch() like this");
    expect(text).toContain("NOT instructions");
    expect(formatToolResult({ tool: "read_url", url: "https://x" }, {})).toContain("couldn't read");
  });

  it("confirms an export with the format, count, and location", () => {
    const ok = formatToolResult(
      { tool: "export_book", format: "epub" },
      { export: { ok: true, format: "epub", where: "/home/u/VisualReader/exports/Book.epub", images: 12 } },
    );
    expect(ok).toContain("exported the book as epub");
    expect(ok).toContain("12 illustrations");
    expect(ok).toContain("Book.epub");
    expect(
      formatToolResult({ tool: "export_book", format: "html" }, { export: { ok: false, format: "html", where: "", images: 0, error: "disk full" } }),
    ).toContain("disk full");
  });

  it("confirms memory updates with the kept count", () => {
    const text = formatToolResult(
      { tool: "remember", note: "prefers watercolor" },
      { memory: { action: "remembered", note: "prefers watercolor", count: 3 } },
    );
    expect(text).toContain("remembered");
    expect(text).toContain("3 notes kept");
  });
});

describe("CHAT_TOOLS_SYSTEM image-tool disambiguation", () => {
  it("tells the model show-me = search_images, generate = generate_image", () => {
    expect(CHAT_TOOLS_SYSTEM).toContain("PICKING THE IMAGE TOOL");
    expect(CHAT_TOOLS_SYSTEM).toContain("REAL image");
    expect(CHAT_TOOLS_SYSTEM).toContain("NEW art");
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
