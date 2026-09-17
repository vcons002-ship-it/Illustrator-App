import { describe, expect, it } from "vitest";
import { CHAT_TOOLS_SYSTEM, parseToolCall } from "./chat-tools.js";
import { buildBuddySystemPrompt, buildImageReferenceBlock, buildToolCallFormat, nativeToolCallsToText, ollamaToolSchemas, parseBuddyToolCall } from "./buddy-tools.js";
import { MAX_PORTRAIT_SCENE_FIELD_CHARS, parsePortraitScene, PORTRAIT_REFERENCE_GUIDANCE, PORTRAIT_SCENE_GUIDANCE, PORTRAIT_SCENE_SCHEMA } from "./portrait-scene.js";

describe("parsePortraitScene", () => {
  it("keeps only trimmed per-image staging, never a separate identity or appearance field", () => {
    expect(parsePortraitScene({
      action: "  SUBJECT reading  ",
      setting: "sunlit garden",
      clothing: "blue coat",
      composition: "medium shot",
      identity: "the wrong person",
      appearance: "the other Soul's physical description",
      name: "someone else",
    })).toEqual({ action: "SUBJECT reading", setting: "sunlit garden", clothing: "blue coat", composition: "medium shot" });
  });

  it.each([undefined, null, "a scene", [], {}, { action: "  " }, { identity: "the reader" }, { setting: 42, clothing: [] }])(
    "rejects a missing or empty scene: %j",
    (value) => expect(parsePortraitScene(value)).toBeUndefined(),
  );

  it("bounds each accepted field and ignores invalid sibling values", () => {
    const long = "x".repeat(MAX_PORTRAIT_SCENE_FIELD_CHARS + 100);
    expect(parsePortraitScene({ action: long, setting: long, clothing: true, composition: { prompt: "do this" } })).toEqual({
      action: "x".repeat(MAX_PORTRAIT_SCENE_FIELD_CHARS),
      setting: "x".repeat(MAX_PORTRAIT_SCENE_FIELD_CHARS),
    });
  });
});

describe.each([
  { name: "book chat", parse: parseToolCall },
  { name: "buddy chat", parse: parseBuddyToolCall },
])("$name portrait scene protocol", ({ parse }) => {
  it("carries a scene through an ordinary JSON call and the native arguments envelope", () => {
    const scene = { action: "ASSISTANT hands READER a book", setting: "a library", composition: "two distinct people" };
    const args = { prompt: "A shared reading scene", scene, steps: 20 };
    const expected = { tool: "generate_image", ...args };
    expect(parse(JSON.stringify(expected))).toEqual(expected);
    expect(parse(JSON.stringify({ name: "generate_image", arguments: args }))).toEqual(expected);
  });

  it("preserves each batch image's distinct resolved scene", () => {
    const scenes = [
      { action: "SUBJECT reading a book", setting: "a garden" },
      { action: "SUBJECT sailing a boat", setting: "a quiet lake" },
      { action: "SUBJECT painting a canvas", setting: "an art studio" },
    ];
    const calls = scenes.map((scene) => parse(JSON.stringify({ tool: "generate_image", prompt: "A portrait of the assistant", scene })));
    expect(calls.map((call) => call?.tool === "generate_image" ? call.scene : undefined)).toEqual(scenes);
  });

  it("leaves legacy image calls and malformed optional scenes for the render boundary to handle", () => {
    const legacy = { tool: "generate_image", prompt: "a red castle" };
    expect(parse(JSON.stringify(legacy))).toEqual(legacy);
    expect(parse(JSON.stringify({ ...legacy, scene: { identity: "someone", action: " " } }))).toEqual(legacy);
  });
});

describe("portrait scene tool guidance and schemas", () => {
  it("gives both chats the same per-image Soul portrait contract", () => {
    const buddy = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(CHAT_TOOLS_SYSTEM).toContain(PORTRAIT_SCENE_GUIDANCE);
    expect(buddy).toContain(PORTRAIT_SCENE_GUIDANCE);
    expect(PORTRAIT_SCENE_GUIDANCE).toContain('"scene" is REQUIRED');
    expect(PORTRAIT_SCENE_GUIDANCE).toContain("each call its own scene");
    expect(PORTRAIT_SCENE_GUIDANCE).toContain("ASSISTANT and READER");
    expect(PORTRAIT_SCENE_GUIDANCE).toContain("Omit names and permanent appearance");
    expect(CHAT_TOOLS_SYSTEM).toContain(PORTRAIT_REFERENCE_GUIDANCE);
    expect(buddy).toContain(PORTRAIT_REFERENCE_GUIDANCE);
    expect(buddy).not.toContain("REFERENCE PHOTOS ARE AUTOMATIC");
    expect(buildImageReferenceBlock(["old reader portrait"])).toContain("unless the reader explicitly asks");
  });

  it("advertises a bounded nested scene in native calls and grammar-constrained retries", () => {
    const native = ollamaToolSchemas({}).find((schema) => schema.function.name === "generate_image")!;
    expect(native.function.description).toContain(PORTRAIT_SCENE_GUIDANCE);
    expect(native.function.parameters.properties.scene).toEqual(PORTRAIT_SCENE_SCHEMA);
    expect(native.function.parameters.required).toEqual(["prompt"]); // Ordinary legacy images still work.
    expect(PORTRAIT_SCENE_SCHEMA).toMatchObject({ type: "object", minProperties: 1, additionalProperties: false });
    expect(Object.keys(PORTRAIT_SCENE_SCHEMA.properties)).toEqual(["action", "setting", "clothing", "composition"]);
    for (const field of Object.values(PORTRAIT_SCENE_SCHEMA.properties)) {
      expect(field).toMatchObject({ type: "string", minLength: 1, maxLength: MAX_PORTRAIT_SCENE_FIELD_CHARS });
    }
    expect(buildToolCallFormat(["generate_image"])).toMatchObject({ properties: { scene: PORTRAIT_SCENE_SCHEMA } });
  });

  it("round-trips the structured scene through native tool-call serialization", () => {
    const scene = { action: "SUBJECT playing a guitar", setting: "a stage at dusk" };
    const text = nativeToolCallsToText([{ function: { name: "generate_image", arguments: { prompt: "Concert portrait", scene } } }]);
    expect(parseBuddyToolCall(text)).toEqual({ tool: "generate_image", prompt: "Concert portrait", scene });
    expect(parseToolCall(text)).toEqual({ tool: "generate_image", prompt: "Concert portrait", scene });
  });
});
