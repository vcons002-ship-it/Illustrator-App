/**
 * Shared PRIMITIVES of the provider-agnostic tool-call protocol used by BOTH
 * chats — the landing-page buddy (buddy-tools.ts) and the in-book reading
 * companion (chat-tools.ts). Both speak the same system-prompt-instructed JSON
 * convention (the model replies with a JSON object to use a tool), so the
 * envelope plumbing lives here ONCE: fence/control-token stripping, JSON-object
 * extraction, trailing-comma repair, tool-shape normalization, and argument
 * coercion. These helpers had drifted between the two files before (a
 * prompt-length cap differed until an audit realigned them) — keeping one copy
 * is the point.
 *
 * Each chat's TOOL UNION, per-tool validation, and result formatting stay in
 * their own files on purpose: the two chats genuinely do different jobs, and
 * widening one union would let each chat call the other's tools.
 *
 * NOTE: this module is intentionally NOT star-exported from chat/index.ts.
 * The names that were public before the extraction (extractJsonObjects,
 * stripControlTokens, normalizeToolShape) are re-exported from buddy-tools.ts,
 * their original home — star-exporting them from here too would make the
 * `export *` in index.ts ambiguous and silently drop them from the package
 * surface.
 */

/** Trim + length-cap one string tool argument (injection guard: book/web text
 * can't smuggle essays through a tool field). Returns undefined for non-strings
 * and empty/whitespace-only values. */
export function strArg(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

/** Drop commas that sit right before a closing `}`/`]` (ignoring whitespace), but NEVER inside a
 * string literal — so `{"q":"a, ",}` loses only the structural trailing comma, not the one in "a, ".
 * Weaker local models routinely emit trailing commas, which strict JSON rejects — without this
 * repair an otherwise-valid tool call is silently dropped. */
export function stripTrailingCommas(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (j < s.length && (s[j] === "}" || s[j] === "]")) continue; // structural trailing comma → drop
    }
    out += c;
  }
  return out;
}

/**
 * ESCAPE THE RAW CONTROL CHARACTERS A MODEL LEAVES INSIDE A JSON STRING.
 *
 * Reported as the assistant being "stuck in a loop just trying to edit a single line — it identifies
 * the fix, then can't seem to figure out how to use the edit_file tool, then the thinking ends and it
 * starts over."
 *
 * A literal newline or tab inside a JSON string is INVALID JSON, and `edit_file` is where source code
 * gets put inside JSON strings: the tool's own instructions say to copy enough surrounding lines
 * VERBATIM to make the match unique. Copy two indented lines out of a file and emit them without
 * re-escaping — which is what a small local model does, because it is transcribing rather than
 * encoding — and the whole call fails to parse. There is then no tool call and no prose (a reply
 * opening with `{` is muted on purpose), so the round produces nothing, the turn's empty-reply
 * recovery asks for the answer again, and the model re-derives the same correct fix forever.
 *
 * Nothing about that is visible: the failure is in a parser, and what the reader sees is a model that
 * cannot work its own tools. Escaping is unambiguous here — a raw control character can never be
 * legal at that position — so a repair costs nothing and cannot change a call that already parsed.
 *
 * String-aware, like stripTrailingCommas: the newlines BETWEEN JSON tokens are fine and stay.
 */
export function escapeRawControlChars(s: string): string {
  const ESCAPES: Readonly<Record<string, string>> = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (!inStr) {
      out += c;
      if (c === '"') inStr = true;
      continue;
    }
    if (esc) {
      out += c;
      esc = false;
      continue;
    }
    if (c === "\\") {
      out += c;
      esc = true;
      continue;
    }
    if (c === '"') {
      out += c;
      inStr = false;
      continue;
    }
    // Anything below U+0020 has to be escaped to be legal inside a JSON string.
    out += ESCAPES[c] ?? (c < " " ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : c);
  }
  return out;
}

/** Unwrap a reply that is ONE fenced block. Accepts ANY fence language tag — models wrap tool JSON
 * in ```json but also ```tool_code (Gemma), ```python, ```bash, etc. Only the OPENING tag is a bare
 * word; without this those calls leak into the chat as prose. */
export function stripFences(s: string): string {
  const t = s.trim();
  const m = /^```[a-zA-Z0-9_-]*\s*([\s\S]*?)```$/.exec(t);
  return (m ? m[1]! : t).trim();
}

/** Pull every top-level JSON object out of a string (brace-matched, string-aware), so a batch
 * of tool calls the model put on separate lines is recovered individually. */
export function extractJsonObjects(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/** Strip the wrapper CONTROL tokens that common local-model tool formats emit AROUND their JSON —
 * Hermes/Qwen/ChatML `<tool_call>…</tool_call>` (+ `<tool_response>`) and gpt-oss "harmony"
 * `<|channel|>…<|message|>…<|call|>` — so they never leak into the chat as garbage. The JSON payload
 * is left in place (extractJsonObjects still finds it). Only known tokens are removed, never content. */
export function stripControlTokens(s: string): string {
  return s
    .replace(/<\/?tool_call>/gi, "")
    .replace(/<\/?tool_response>/gi, "")
    .replace(/<\|(?:im_start|im_end|channel|message|start|end|call|return|constrain|tool_call|tool_response)\|>/gi, "");
}

/** Accept the `{"name":X,"arguments":{…}}` tool shape that Hermes/Qwen/ChatML-tools models emit (inside
 * `<tool_call>…`), not just the app's `{"tool":X, …flatArgs}`. Without this, those very common local
 * models' tool calls are silently ignored — the model "calls" write_file but nothing is written, so a
 * follow-up run_command finds no file. `arguments` may be an object, a double-encoded JSON string, or
 * siblings of `name`. */
export function normalizeToolShape(obj: Record<string, unknown>): Record<string, unknown> {
  if (typeof obj.tool === "string") return obj;
  // `action`/`action_input` is the ReAct/LangChain shape capable models fall into; treat it like name/args.
  const name = obj.name ?? obj.function ?? obj.tool_name ?? obj.action;
  if (typeof name !== "string") return obj;
  const rawArgs = obj.arguments ?? obj.parameters ?? obj.args ?? obj.input ?? obj.action_input;
  let args: Record<string, unknown> = {};
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>;
  } else if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      /* not double-encoded JSON — leave args empty */
    }
  } else {
    const { name: _n, function: _f, tool_name: _t, action: _a, ...rest } = obj; // args as siblings of `name`
    args = rest;
  }
  return { tool: name, ...args };
}
