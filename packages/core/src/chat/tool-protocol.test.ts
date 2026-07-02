import { describe, expect, it } from "vitest";
import {
  extractJsonObjects,
  normalizeToolShape,
  strArg,
  stripControlTokens,
  stripFences,
  stripTrailingCommas,
} from "./tool-protocol.js";

// Direct coverage of the shared tool-protocol primitives — one copy now serves BOTH
// buddy-tools.ts and chat-tools.ts, so a regression here would break both chats at once.

describe("strArg", () => {
  it("trims and returns a plain string", () => {
    expect(strArg("  Krebs cycle  ", 100)).toBe("Krebs cycle");
  });

  it("caps at max AFTER trimming (injection guard)", () => {
    expect(strArg("  abcdef  ", 3)).toBe("abc");
    expect(strArg("a".repeat(500), 200)).toHaveLength(200);
  });

  it("rejects non-strings and whitespace-only values", () => {
    expect(strArg(42, 10)).toBeUndefined();
    expect(strArg(undefined, 10)).toBeUndefined();
    expect(strArg(null, 10)).toBeUndefined();
    expect(strArg(["x"], 10)).toBeUndefined();
    expect(strArg("   ", 10)).toBeUndefined();
    expect(strArg("", 10)).toBeUndefined();
  });
});

describe("stripTrailingCommas", () => {
  it("drops a trailing comma before } and ]", () => {
    expect(JSON.parse(stripTrailingCommas('{"tool":"search_web","query":"x",}'))).toEqual({
      tool: "search_web",
      query: "x",
    });
    expect(JSON.parse(stripTrailingCommas("[1,2,]"))).toEqual([1, 2]);
  });

  it("drops a trailing comma separated from the brace by whitespace/newlines", () => {
    expect(JSON.parse(stripTrailingCommas('{"a":1,\n  \t}'))).toEqual({ a: 1 });
  });

  it("handles nested trailing commas in one pass", () => {
    expect(JSON.parse(stripTrailingCommas('{"a":[1,2,],"b":{"c":3,},}'))).toEqual({ a: [1, 2], b: { c: 3 } });
  });

  it("never touches commas inside string literals", () => {
    expect(JSON.parse(stripTrailingCommas('{"q":"a, ",}'))).toEqual({ q: "a, " });
    // A string that ENDS with ", }" must survive intact — only the structural comma goes.
    expect(JSON.parse(stripTrailingCommas('{"q":"end, }",}'))).toEqual({ q: "end, }" });
  });

  it("respects escaped quotes when tracking string state", () => {
    expect(JSON.parse(stripTrailingCommas('{"q":"say \\"hi, \\" now",}'))).toEqual({ q: 'say "hi, " now' });
  });

  it("leaves valid JSON unchanged", () => {
    const s = '{"a":[1,2],"b":"x, y"}';
    expect(stripTrailingCommas(s)).toBe(s);
  });
});

describe("stripFences", () => {
  it("unwraps a ```json fence", () => {
    expect(stripFences('```json\n{"tool":"search_web"}\n```')).toBe('{"tool":"search_web"}');
  });

  it("unwraps ANY language tag — tool_code (Gemma), python, bash", () => {
    for (const lang of ["tool_code", "python", "bash", "tool-call"]) {
      expect(stripFences(`\`\`\`${lang}\n{"a":1}\n\`\`\``)).toBe('{"a":1}');
    }
  });

  it("unwraps a bare fence with no language tag", () => {
    expect(stripFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("tolerates surrounding whitespace and trims the payload", () => {
    expect(stripFences('  ```json\n  {"a":1}  \n```  ')).toBe('{"a":1}');
  });

  it("leaves unfenced text untouched (aside from trimming)", () => {
    expect(stripFences('  {"a":1}  ')).toBe('{"a":1}');
    expect(stripFences("plain prose")).toBe("plain prose");
  });

  it("does NOT unwrap when the fence is only part of the reply", () => {
    const s = 'prose before\n```json\n{"a":1}\n```';
    expect(stripFences(s)).toBe(s.trim());
  });
});

describe("extractJsonObjects", () => {
  it("pulls a single object out of surrounding prose", () => {
    expect(extractJsonObjects('let me check: {"tool":"search_web","query":"x"} ok?')).toEqual([
      '{"tool":"search_web","query":"x"}',
    ]);
  });

  it("recovers a batch of objects on separate lines", () => {
    expect(extractJsonObjects('{"a":1}\n{"b":2}')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("keeps nested objects as ONE top-level object", () => {
    expect(extractJsonObjects('{"a":{"b":{"c":1}}}')).toEqual(['{"a":{"b":{"c":1}}}']);
  });

  it("ignores braces inside string literals (including escaped quotes)", () => {
    expect(extractJsonObjects('{"q":"curly } inside"}')).toEqual(['{"q":"curly } inside"}']);
    expect(extractJsonObjects('{"q":"esc \\" then }"}')).toEqual(['{"q":"esc \\" then }"}']);
  });

  it("returns nothing for prose or an unterminated object", () => {
    expect(extractJsonObjects("no json here")).toEqual([]);
    expect(extractJsonObjects('{"a":1')).toEqual([]);
  });
});

describe("stripControlTokens", () => {
  it("removes Hermes/Qwen/ChatML tool wrappers but keeps the JSON payload", () => {
    expect(stripControlTokens('<tool_call>{"tool":"x"}</tool_call>')).toBe('{"tool":"x"}');
    expect(stripControlTokens("<tool_response>ok</tool_response>")).toBe("ok");
  });

  it("removes gpt-oss harmony tokens", () => {
    expect(stripControlTokens('<|channel|>commentary<|message|>{"tool":"x"}<|call|>')).toBe(
      'commentary{"tool":"x"}',
    );
    expect(stripControlTokens("<|im_start|>hi<|im_end|>")).toBe("hi");
  });

  it("removes only KNOWN tokens, never content", () => {
    expect(stripControlTokens("a <custom> tag and <|weird|> stays")).toBe("a <custom> tag and <|weird|> stays");
  });
});

describe("normalizeToolShape", () => {
  it("passes the app's {tool, …flatArgs} shape through untouched", () => {
    const obj = { tool: "search_web", query: "x" };
    expect(normalizeToolShape(obj)).toBe(obj);
  });

  it("flattens {name, arguments} into {tool, …args}", () => {
    expect(normalizeToolShape({ name: "search_web", arguments: { query: "x" } })).toEqual({
      tool: "search_web",
      query: "x",
    });
  });

  it("accepts function/tool_name/action aliases and parameters/args/input/action_input", () => {
    expect(normalizeToolShape({ function: "a", parameters: { p: 1 } })).toEqual({ tool: "a", p: 1 });
    expect(normalizeToolShape({ tool_name: "b", args: { p: 2 } })).toEqual({ tool: "b", p: 2 });
    expect(normalizeToolShape({ action: "c", action_input: { p: 3 } })).toEqual({ tool: "c", p: 3 });
  });

  it("decodes double-encoded (stringified JSON) arguments", () => {
    expect(normalizeToolShape({ name: "generate_image", arguments: '{"prompt":"a cat"}' })).toEqual({
      tool: "generate_image",
      prompt: "a cat",
    });
  });

  it("drops arguments that are a non-JSON string instead of guessing", () => {
    expect(normalizeToolShape({ name: "x", arguments: "not json" })).toEqual({ tool: "x" });
  });

  it("treats sibling keys of `name` as the args when no arguments field exists", () => {
    expect(normalizeToolShape({ name: "search_web", query: "x" })).toEqual({ tool: "search_web", query: "x" });
  });

  it("returns the object unchanged when no tool name is present", () => {
    const obj = { data: 1 };
    expect(normalizeToolShape(obj)).toBe(obj);
  });
});
