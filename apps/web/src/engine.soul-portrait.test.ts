import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../../../packages/core/src/chat/chat-tools.js";
import { buildSoulPortraitRender } from "../../../packages/core/src/chat/soul-portrait.js";
import {
  describeReferenceSources,
  referenceOutcome,
} from "../../../packages/core/src/providers/image/image-provider.js";

// Execute the real worker entry point without importing its top-level worker registration,
// IndexedDB, or model services. Keep portrait assembly real: this catches dropped scene/request
// fields and wrong reference wiring between the worker and the image renderer.
const source = ts.createSourceFile(
  "engine.worker.ts",
  readFileSync(join(__dirname, "engine.worker.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

type Reference = { bytes: ArrayBuffer; mimeType: string };
type ImageCall = Extract<ToolCall, { tool: "generate_image" }>;
type HandleChatTool = (
  requestId: number,
  call: ImageCall,
  refs?: Reference[],
  userText?: string,
) => Promise<void>;
type RenderOptions = {
  ipAdapterRefs?: (Reference & { weight: number })[];
  stepsOverride?: number;
  signal: AbortSignal;
  onProgress: (fraction: number) => void;
};

function workerHandler(bindings: Record<string, unknown>): HandleChatTool {
  const declaration = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "handleChatTool",
  );
  if (!declaration) throw new Error("Missing worker handler: handleChatTool");
  const { outputText } = ts.transpileModule(`const extracted = ${declaration.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  return new Function(...Object.keys(bindings), `${outputText}\nreturn extracted;`)(
    ...Object.values(bindings),
  ) as HandleChatTool;
}

const image = (id: number): Reference => ({
  bytes: new Uint8Array([id]).buffer,
  mimeType: "image/png",
});
const selfPhoto = image(1);
const readerPhoto = image(2);
const stalePhoto = image(3);
const notes = {
  self: [{ text: "Physical description: auburn hair, green eyes, a woman.", at: 1 }],
  user: [{ text: "Physical description: dark hair, brown eyes, a beard.", at: 1 }],
};
const referenceIds = (refs: Reference[] | undefined): number[] =>
  (refs ?? []).map((ref) => new Uint8Array(ref.bytes)[0]!);

function harness() {
  const chatAborts = new Map<number, AbortController>();
  const post = vi.fn();
  const warmChatModel = vi.fn();
  const provider = { id: "stub-image-provider" };
  const tier = { tier: "local", style: "none" };
  const renderFromText = vi.fn(async (
    _provider: unknown,
    _tier: unknown,
    _prompt: string,
    options: RenderOptions,
  ) => ({
    ...image(9),
    references: {
      supplied: options.ipAdapterRefs?.length ?? 0,
      used: options.ipAdapterRefs?.length ?? 0,
      how: "native" as const,
    },
  }));
  const handle = workerHandler({
    chatAborts,
    settings: { imageProvider: "local" },
    chatSettingsOf: (settings: unknown) => settings,
    corsFetch: () => undefined,
    buildProviders: () => ({ image: provider, tier, diagnostics: { image: { mock: false } } }),
    bookProviders: undefined,
    cancelChatWarm: vi.fn(),
    memoryStore: () => ({}),
    loadSoulName: async (_store: unknown, kind: "self" | "user") => kind === "self" ? "Aria" : "Nick",
    loadSoul: async (_store: unknown, kind: "self" | "user") => notes[kind],
    loadSoulRefs: async (_store: unknown, kind: "self" | "user") =>
      [kind === "self" ? selfPhoto : readerPhoto],
    currentBook: undefined,
    buildSoulPortraitRender,
    renderFromText,
    describeReferenceSources,
    referenceOutcome,
    post,
    warmChatModel,
  });
  return { handle, renderFromText, post, chatAborts, warmChatModel, provider, tier };
}

describe("worker Soul portrait render handoff", () => {
  it("sends only the assistant's appearance and references despite a mixed model prompt and stale reader photos", async () => {
    const worker = harness();
    const call: ImageCall = {
      tool: "generate_image",
      prompt: "Nick and Aria, a woman with dark hair, brown eyes and a beard",
      scene: { action: "SUBJECT walking", setting: "a seaside garden", clothing: "a red coat" },
      steps: 12,
    };
    await worker.handle(101, call, [readerPhoto, stalePhoto], "Draw yourself in a red coat beside the sea");

    expect(worker.renderFromText).toHaveBeenCalledTimes(1);
    const [provider, tier, prompt, options] = worker.renderFromText.mock.calls[0]!;
    expect(provider).toBe(worker.provider);
    expect(tier).toBe(worker.tier);
    expect(prompt).toContain("Appearance of Aria:");
    expect(prompt).toContain("auburn hair");
    expect(prompt).toContain("a seaside garden");
    expect(prompt).toContain("a red coat");
    expect(prompt).not.toMatch(/Nick|dark hair|brown eyes|beard/);
    expect(referenceIds(options.ipAdapterRefs)).toEqual([1]);
    expect(options.stepsOverride).toBe(12);
    expect(worker.post).toHaveBeenCalledWith(expect.objectContaining({
      type: "chatToolResult",
      requestId: 101,
      image: expect.objectContaining({ mimeType: "image/png" }),
      referenceNote: expect.objectContaining({ text: expect.stringContaining("Aria") }),
    }), expect.any(Array));
    expect(worker.chatAborts.size).toBe(0);
    expect(worker.warmChatModel).toHaveBeenCalledTimes(1);
  });

  it("preserves distinct per-call scenes when a portrait batch retains one original reader request", async () => {
    const worker = harness();
    const userText = "Draw two images of yourself, one on the beach and one in a snowy forest";
    for (const [index, setting] of ["a beach at sunset", "a snowy forest at dawn"].entries()) {
      await worker.handle(index + 1, {
        tool: "generate_image",
        prompt: "Aria and Nick with matching beards",
        scene: { action: "SUBJECT standing", setting },
      }, [readerPhoto], userText);
    }

    expect(worker.renderFromText).toHaveBeenCalledTimes(2);
    const [first, second] = worker.renderFromText.mock.calls;
    expect(first![2]).toContain("a beach at sunset");
    expect(first![2]).not.toContain("snowy forest");
    expect(second![2]).toContain("a snowy forest at dawn");
    expect(second![2]).not.toContain("beach");
    for (const [, , prompt, options] of worker.renderFromText.mock.calls) {
      expect(prompt).toContain("auburn hair");
      expect(prompt).not.toMatch(/Nick|beards|Draw two images/);
      expect(referenceIds(options.ipAdapterRefs)).toEqual([1]);
    }
  });

  it("returns actionable feedback instead of rendering a Soul portrait without a separate scene", async () => {
    const worker = harness();
    const call: ImageCall = { tool: "generate_image", prompt: "Nick and Aria with dark hair and beards" };
    await worker.handle(103, call, [readerPhoto], "Draw yourself");

    expect(worker.renderFromText).not.toHaveBeenCalled();
    expect(worker.post).toHaveBeenCalledTimes(1);
    expect(worker.post).toHaveBeenCalledWith(expect.objectContaining({
      type: "chatToolResult",
      requestId: 103,
      call,
      error: expect.stringMatching(/Retry generate_image with scene/),
    }));
    expect(worker.chatAborts.size).toBe(0);
    expect(worker.warmChatModel).toHaveBeenCalledTimes(1);
  });

  it("passes an ordinary image prompt and its existing session references through unchanged", async () => {
    const worker = harness();
    const call: ImageCall = { tool: "generate_image", prompt: "A watercolor castle on a cliff at sunset" };
    await worker.handle(104, call, [readerPhoto, stalePhoto], "Paint a watercolor castle");

    expect(worker.renderFromText).toHaveBeenCalledTimes(1);
    const [, , prompt, options] = worker.renderFromText.mock.calls[0]!;
    expect(prompt).toBe(call.prompt);
    expect(referenceIds(options.ipAdapterRefs)).toEqual([3, 2]);
    expect(worker.post).toHaveBeenCalledWith(expect.objectContaining({
      type: "chatToolResult",
      requestId: 104,
      image: expect.objectContaining({ mimeType: "image/png" }),
    }), expect.any(Array));
  });
});
