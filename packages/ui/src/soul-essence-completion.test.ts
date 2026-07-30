import { describe, expect, it, vi } from "vitest";
import {
  SOUL_ESSENCE_FACETS,
  SOUL_ESSENCE_SCHEMA_VERSION,
  LocalServerLLMProvider,
  buildSoulEssenceDistillationPrompt,
  soulNoteSources,
  soulSourceFingerprint,
  type ChatOptions,
  type ChatTurn,
  type LLMProvider,
  type SoulNote,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "@visual-reader/core";
import { completeSoulEssenceWithRepair } from "../../../apps/web/src/soul-essence-completion.js";

const notes: SoulNote[] = [
  { text: "Patiently connects ideas across difficult systems.", at: 1 },
  { text: "Values candour more than reflexive agreement.", at: 2 },
];

function payload(sourceIds = soulNoteSources(notes).map((source) => source.id)): Record<string, unknown> {
  return {
    schemaVersion: SOUL_ESSENCE_SCHEMA_VERSION,
    kind: "self",
    sourceFingerprint: soulSourceFingerprint(notes),
    facets: Object.fromEntries(
      SOUL_ESSENCE_FACETS.map((key) => [
        key,
        key === "coreDisposition"
          ? { text: "Patient, systems-minded, and candid.", sourceIds }
          : { text: "", sourceIds: [] },
      ]),
    ),
    exactAppearance: [],
  };
}

function fakeLlm(
  chat: (messages: ChatTurn[], opts: ChatOptions) => Promise<string>,
): LLMProvider {
  return {
    id: "local-server",
    chat,
  } as unknown as LLMProvider;
}

describe("completeSoulEssenceWithRepair", () => {
  it("sends known-ID grammar and gives the second pass the exact missing evidence", async () => {
    const sources = soulNoteSources(notes);
    const calls: Array<{ messages: ChatTurn[]; opts: ChatOptions }> = [];
    const llm = fakeLlm(async (messages, opts) => {
      calls.push({ messages, opts });
      opts.onComplete?.({ truncated: false });
      return JSON.stringify(
        calls.length === 1
          ? payload([sources[0]!.id])
          : payload(),
      );
    });
    const onRepair = vi.fn();
    const result = await completeSoulEssenceWithRepair({
      llm,
      kind: "self",
      notes,
      prompt: buildSoulEssenceDistillationPrompt("self", notes),
      maxTokens: 1400,
      onRepair,
    });

    expect(result.essence?.facets.coreDisposition.sourceIds).toEqual(
      sources.map((source) => source.id),
    );
    expect(calls).toHaveLength(2);
    expect(onRepair).toHaveBeenCalledWith(
      expect.stringContaining(sources[1]!.id),
      false,
    );
    expect(calls[1]!.messages[0]!.content).toContain(sources[1]!.id);
    const schema = calls[0]!.opts.jsonSchema as {
      properties: {
        facets: {
          properties: {
            coreDisposition: {
              properties: { sourceIds: { items: { enum: string[] } } };
            };
          };
        };
      };
    };
    expect(
      schema.properties.facets.properties.coreDisposition.properties.sourceIds.items.enum,
    ).toEqual(sources.map((source) => source.id));
  });

  it("repairs a safely truncated JSON envelope before spending a second model call", async () => {
    const complete = JSON.stringify(payload());
    const chat = vi.fn(async () => complete.slice(0, -1));
    const result = await completeSoulEssenceWithRepair({
      llm: fakeLlm(chat),
      kind: "self",
      notes,
      prompt: buildSoulEssenceDistillationPrompt("self", notes),
      maxTokens: 1400,
    });

    expect(result.essence).toBeDefined();
    expect(chat).toHaveBeenCalledOnce();
  });

  it("requires a second pass when a cutoff omitted later semantic facets", async () => {
    const complete = JSON.stringify(payload());
    const cutoff = complete.indexOf(',"conversationalVoice"');
    expect(cutoff).toBeGreaterThan(0);
    let calls = 0;
    const onRepair = vi.fn();
    const result = await completeSoulEssenceWithRepair({
      llm: fakeLlm(async (_messages, opts) => {
        calls += 1;
        opts.onComplete?.({ truncated: calls === 1 });
        return calls === 1 ? complete.slice(0, cutoff) : complete;
      }),
      kind: "self",
      notes,
      prompt: buildSoulEssenceDistillationPrompt("self", notes),
      maxTokens: 1400,
      onRepair,
    });

    expect(result.essence).toBeDefined();
    expect(calls).toBe(2);
    expect(onRepair).toHaveBeenCalledWith(
      expect.stringContaining("conversationalVoice"),
      true,
    );
  });

  it("reports a provider cutoff to the informed repair pass", async () => {
    const sources = soulNoteSources(notes);
    let calls = 0;
    const onRepair = vi.fn();
    const result = await completeSoulEssenceWithRepair({
      llm: fakeLlm(async (_messages, opts) => {
        calls += 1;
        opts.onComplete?.({ truncated: calls === 1 });
        return JSON.stringify(
          calls === 1 ? payload([sources[0]!.id]) : payload(),
        );
      }),
      kind: "self",
      notes,
      prompt: buildSoulEssenceDistillationPrompt("self", notes),
      maxTokens: 1400,
      onRepair,
    });

    expect(result.essence).toBeDefined();
    expect(onRepair).toHaveBeenCalledWith(
      expect.stringContaining("output-token limit"),
      true,
    );
  });

  it("repairs a buffered llama.cpp cutoff through the real provider path", async () => {
    const complete = JSON.stringify(payload());
    const cutoff = complete.indexOf(',"conversationalVoice"');
    const requests: TransportRequest[] = [];
    const transport: Transport = {
      send: async (request): Promise<TransportResponse> => {
        requests.push(request);
        const first = requests.length === 1;
        const body = {
          choices: [
            {
              message: {
                content: first ? complete.slice(0, cutoff) : complete,
              },
              finish_reason: first ? "length" : "stop",
            },
          ],
        };
        return {
          ok: true,
          status: 200,
          json: async <T>() => body as T,
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      },
    };
    const onRepair = vi.fn();
    const result = await completeSoulEssenceWithRepair({
      llm: new LocalServerLLMProvider({
        baseUrl: "http://x/v1",
        model: "m",
        serverType: "llamacpp",
        transport,
      }),
      kind: "self",
      notes,
      prompt: buildSoulEssenceDistillationPrompt("self", notes),
      maxTokens: 1400,
      onRepair,
    });

    expect(result.essence).toBeDefined();
    expect(requests).toHaveLength(2);
    expect(onRepair).toHaveBeenCalledWith(
      expect.stringContaining("output-token limit"),
      true,
    );
  });
});
