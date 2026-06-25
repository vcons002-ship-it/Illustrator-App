import { describe, expect, it } from "vitest";
import {
  ALWAYS_GATED_TOOLS,
  MAX_BUDDY_TOOL_ROUNDS,
  buildBuddySystemPrompt,
  describeBuddyToolActivity,
  formatBuddyToolResult,
  isRetryableError,
  looksLikeToolJson,
  normalizeBuddyPersona,
  parseBuddyToolCall,
  parseBuddyToolCalls,
  progressNudge,
  stripToolCallJson,
  toolFailureDirective,
  toolLimitNudge,
} from "./buddy-tools.js";

describe("parseBuddyToolCall", () => {
  it("parses the search tools", () => {
    expect(parseBuddyToolCall('{"tool":"search_books","query":"frankenstein"}')).toEqual({
      tool: "search_books",
      query: "frankenstein",
    });
    expect(parseBuddyToolCall('{"tool":"search_web","query":"citric acid cycle"}')).toEqual({
      tool: "search_web",
      query: "citric acid cycle",
    });
  });

  it("parses open_library_book with a defaulted visuals flag", () => {
    expect(parseBuddyToolCall('{"tool":"open_library_book","id":"text-abc123"}')).toEqual({
      tool: "open_library_book",
      id: "text-abc123",
      visuals: false,
    });
    expect(
      parseBuddyToolCall('{"tool":"open_library_book","id":"text-abc123","visuals":true}'),
    ).toEqual({ tool: "open_library_book", id: "text-abc123", visuals: true });
  });

  it("parses open_web_text and defaults mode to fiction", () => {
    expect(
      parseBuddyToolCall(
        '{"tool":"open_web_text","url":"https://example.org/book.txt","title":"A Book","visuals":true}',
      ),
    ).toEqual({
      tool: "open_web_text",
      url: "https://example.org/book.txt",
      title: "A Book",
      mode: "fiction",
      visuals: true,
    });
    expect(
      parseBuddyToolCall('{"tool":"open_web_text","url":"https://example.org/a","mode":"technical"}'),
    ).toMatchObject({ mode: "technical", visuals: false });
  });

  it("rejects non-http URLs", () => {
    expect(
      parseBuddyToolCall('{"tool":"open_web_text","url":"file:///etc/passwd"}'),
    ).toBeUndefined();
    expect(
      parseBuddyToolCall('{"tool":"open_web_text","url":"javascript:alert(1)"}'),
    ).toBeUndefined();
  });

  it("normalizes the single open_content tool into the internal open_* shapes by source", () => {
    expect(parseBuddyToolCall('{"tool":"open_content","source":"library","id":"text-1"}')).toEqual({
      tool: "open_library_book",
      id: "text-1",
      visuals: false,
    });
    expect(
      parseBuddyToolCall('{"tool":"open_content","source":"web","url":"https://x.test/a","title":"A"}'),
    ).toMatchObject({ tool: "open_web_text", url: "https://x.test/a", title: "A" });
    expect(
      parseBuddyToolCall('{"tool":"open_content","source":"pasted","text":"Once upon a time"}'),
    ).toMatchObject({ tool: "open_pasted_text", text: "Once upon a time", mode: "fiction" });
    expect(
      parseBuddyToolCall('{"tool":"open_content","source":"code","text":"const x=1","language":"ts"}'),
    ).toMatchObject({ tool: "open_code", code: "const x=1", language: "ts" });
    // Invalid / incomplete open_content is rejected (no source, bad url).
    expect(parseBuddyToolCall('{"tool":"open_content","source":"web"}')).toBeUndefined();
    expect(parseBuddyToolCall('{"tool":"open_content"}')).toBeUndefined();
  });

  it("auto-detects fiction vs technical for open_content when mode is omitted", () => {
    expect(parseBuddyToolCall('{"tool":"open_content","source":"web","url":"https://x.test/a-short-story"}')).toMatchObject({
      mode: "fiction",
    });
    expect(
      parseBuddyToolCall('{"tool":"open_content","source":"web","url":"https://arxiv.org/abs/1234"}'),
    ).toMatchObject({ mode: "technical" });
    // An explicit mode always wins over the heuristic.
    expect(
      parseBuddyToolCall('{"tool":"open_content","source":"web","url":"https://arxiv.org/abs/1","mode":"fiction"}'),
    ).toMatchObject({ mode: "fiction" });
  });

  it("the prompt advertises ONE open_content tool, not the four separate open_* tools", () => {
    const p = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(p).toContain('"tool":"open_content"');
    expect(p).not.toContain('{"tool":"open_web_text"');
    expect(p).not.toContain('{"tool":"open_library_book"');
    expect(p).not.toContain('{"tool":"open_pasted_text"');
  });

  it("parses the assistant-side tools (images, random picks, style, render)", () => {
    expect(parseBuddyToolCall('{"tool":"search_images","query":"thermodynamic cycle diagram"}')).toEqual({
      tool: "search_images",
      query: "thermodynamic cycle diagram",
    });
    expect(parseBuddyToolCall('{"tool":"random_books"}')).toEqual({ tool: "random_books" });
    expect(parseBuddyToolCall('{"tool":"calculate","expression":"sqrt(144) * 2"}')).toEqual({
      tool: "calculate",
      expression: "sqrt(144) * 2",
    });
    expect(parseBuddyToolCall('{"tool":"calculate"}')).toBeUndefined();
    expect(
      parseBuddyToolCall(
        '{"tool":"set_visual_style","style":"oil painting","pagesPerImage":"chapter","illustrateAfter":"chapter"}',
      ),
    ).toEqual({
      tool: "set_visual_style",
      style: "oil painting",
      pagesPerImage: "chapter",
      illustrateAfter: "chapter",
    });
    expect(parseBuddyToolCall('{"tool":"set_visual_style","pagesPerImage":3}')).toEqual({
      tool: "set_visual_style",
      pagesPerImage: 3,
    });
    // No-op style call (no field) is rejected; page counts clamp; bad cadence dropped.
    expect(parseBuddyToolCall('{"tool":"set_visual_style"}')).toBeUndefined();
    expect(parseBuddyToolCall('{"tool":"set_visual_style","illustrateAfter":"weekly"}')).toBeUndefined();
    expect(parseBuddyToolCall('{"tool":"set_visual_style","pagesPerImage":99}')).toEqual({
      tool: "set_visual_style",
      pagesPerImage: 10,
    });
    expect(
      parseBuddyToolCall('{"tool":"generate_image","prompt":"an apple","steps":20,"style":"watercolor"}'),
    ).toEqual({ tool: "generate_image", prompt: "an apple", steps: 20, style: "watercolor" });
  });

  it("parses open_pasted_text (defaults title/mode) and remove_library_book", () => {
    expect(
      parseBuddyToolCall('{"tool":"open_pasted_text","text":"Two roads diverged…","visuals":true}'),
    ).toEqual({
      tool: "open_pasted_text",
      text: "Two roads diverged…",
      title: "Pasted text",
      mode: "fiction",
      visuals: true,
    });
    // Empty/whitespace text is rejected (nothing to open).
    expect(parseBuddyToolCall('{"tool":"open_pasted_text","text":"   "}')).toBeUndefined();
    expect(parseBuddyToolCall('{"tool":"remove_library_book","id":"text-abc"}')).toEqual({
      tool: "remove_library_book",
      id: "text-abc",
    });
    expect(parseBuddyToolCall('{"tool":"remove_library_book"}')).toBeUndefined();
  });

  it("recovers a tool call even when the model writes PROSE before it (the briefing bug)", () => {
    // The model often narrates ("let me check…") then appends the call — run it, don't leak it.
    expect(parseBuddyToolCall('Sure! {"tool":"search_books","query":"dracula"}')).toEqual({
      tool: "search_books",
      query: "dracula",
    });
    expect(parseBuddyToolCall('### Tasks\nLet me pull that up now…\n\n{"tool":"list_tasks","max":20}')).toEqual({
      tool: "list_tasks",
      max: 20,
    });
    expect(parseBuddyToolCall("just prose")).toBeUndefined();
    expect(parseBuddyToolCall('{"tool":"unknown_tool","query":"x"}')).toBeUndefined(); // unknown tool ignored
  });

  it("stripToolCallJson leaves the prose, drops the tool JSON", () => {
    expect(stripToolCallJson('Here is your briefing.\n\n{"tool":"list_tasks","max":20}')).toBe("Here is your briefing.");
    expect(stripToolCallJson("plain answer, no tools")).toBe("plain answer, no tools");
  });

  it("accepts a fenced JSON reply and caps argument lengths", () => {
    expect(parseBuddyToolCall('```json\n{"tool":"search_books","query":"poe"}\n```')).toEqual({
      tool: "search_books",
      query: "poe",
    });
    const long = "q".repeat(500);
    expect(parseBuddyToolCall(`{"tool":"search_web","query":"${long}"}`)?.tool === "search_web").toBe(
      true,
    );
    const parsed = parseBuddyToolCall(`{"tool":"search_web","query":"${long}"}`);
    expect(parsed && "query" in parsed ? parsed.query.length : 0).toBe(200);
  });
});

describe("formatBuddyToolResult", () => {
  it("numbers book hits with their text URLs", () => {
    const text = formatBuddyToolResult(
      { tool: "search_books", query: "frankenstein" },
      {
        books: [
          {
            title: "Frankenstein",
            author: "Mary Shelley",
            textUrl: "https://gutenberg.org/files/84.txt",
            pageUrl: "https://gutenberg.org/ebooks/84",
          },
        ],
      },
    );
    expect(text).toContain("[1] Frankenstein — Mary Shelley");
    expect(text).toContain("https://gutenberg.org/files/84.txt");
    expect(text).toContain("open_web_text");
  });

  it("reports an open with structure and the visuals state", () => {
    const started = formatBuddyToolResult(
      { tool: "open_library_book", id: "x", visuals: true },
      { opened: { title: "Dracula", chapters: 27, pages: 310, visuals: true } },
    );
    expect(started).toContain('"Dracula"');
    expect(started).toContain("27 chapters");
    expect(started).toContain("generation has started");
    const waiting = formatBuddyToolResult(
      { tool: "open_library_book", id: "x", visuals: false },
      { opened: { title: "Dracula", chapters: 1, pages: 1, visuals: false } },
    );
    expect(waiting).toContain("presses Start");
  });

  it("formats the assistant-side results (random picks, images, style, render)", () => {
    const random = formatBuddyToolResult(
      { tool: "random_books" },
      {
        books: [
          {
            title: "Dracula",
            author: "Bram Stoker",
            textUrl: "https://g.test/345.txt",
            subjects: ["Horror tales", "Vampires"],
          },
        ],
      },
    );
    expect(random).toContain("random classics");
    expect(random).toContain("[1] Dracula — Bram Stoker [Horror tales, Vampires]");
    const figures = formatBuddyToolResult(
      { tool: "search_images", query: "carnot cycle" },
      { imageHits: [{ link: "https://img.test/c.png", title: "Carnot cycle.png" }] },
    );
    expect(figures).toContain("already shown to the reader inline");
    const style = formatBuddyToolResult(
      { tool: "set_visual_style", style: "oil painting", pagesPerImage: "chapter", illustrateAfter: "chapter" },
      { applied: { style: "Oil painting", pagesPerImage: "chapter", illustrateAfter: "chapter" } },
    );
    expect(style).toContain('art style "Oil painting"');
    expect(style).toContain("per chapter");
    expect(style).toContain("as each chapter finishes");
    expect(
      formatBuddyToolResult({ tool: "generate_image", prompt: "an apple" }, { image: { ok: true } }),
    ).toContain("shown to the reader");
    expect(
      formatBuddyToolResult(
        { tool: "calculate", expression: "sqrt(144) * 2" },
        { calc: { expression: "sqrt(144) * 2", result: "24" } },
      ),
    ).toContain("sqrt(144) * 2 = 24");
  });

  it("formats remove_library_book (hit and miss)", () => {
    expect(
      formatBuddyToolResult({ tool: "remove_library_book", id: "x" }, { removed: "Dune" }),
    ).toContain('removed "Dune"');
    expect(
      formatBuddyToolResult({ tool: "remove_library_book", id: "x" }, {}),
    ).toContain("nothing matched");
  });

  it("formats failures with a recovery instruction", () => {
    const text = formatBuddyToolResult(
      { tool: "open_web_text", url: "https://x.test", mode: "fiction", visuals: false },
      { error: "CORS blocked" },
    );
    expect(text).toContain("failed: CORS blocked");
    expect(text).toContain("pasting/uploading");
  });
});

describe("buildBuddySystemPrompt", () => {
  it("tells the buddy that created docs (spreadsheets/code/text) are auto-saved to the library", () => {
    // Guards against the buddy hallucinating "I can't save a created document to your library".
    const prompt = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(prompt).toMatch(/SAVED TO THE LIBRARY AUTOMATICALLY/);
    expect(prompt).toMatch(/NEVER tell the reader you can't save a created/i);
    expect(prompt).toMatch(/Excel \(\.xlsx\)/);
  });

  it("lists the library with ids", () => {
    const prompt = buildBuddySystemPrompt({
      persona: "assistant",
      library: [{ id: "text-1", title: "Dune", author: "Frank Herbert", addedAt: 1 }],
    });
    expect(prompt).toContain('"Dune" by Frank Herbert — id: text-1');
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [] })).toContain("LIBRARY is empty");
  });

  it("the assistant leads as a general one-stop assistant and never steers toward books", () => {
    const prompt = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(prompt).toContain("general conversational assistant");
    expect(prompt).toContain("ONE-STOP AI workspace");
    expect(prompt).toContain("ON REQUEST");
    // The single voice must not carry the old reading/research-buddy framing.
    expect(prompt).not.toContain("reading buddy");
    expect(prompt).not.toContain("research buddy");
    expect(prompt).toContain("NEVER steer the chat toward opening");
  });

  it("planning mode adds the planning playbook (coding project + complex deliverable)", () => {
    const p = buildBuddySystemPrompt({ persona: "planning", library: [] });
    expect(p).toContain("PLANNING partner");
    expect(p).toContain("CODING PROJECT");
    expect(p).toContain("COMPLEX DELIVERABLE");
    expect(p).toContain("PLANNING MODE"); // the appended playbook
    expect(p).toMatch(/clarifying questions/i); // understand-first step
    // The planning playbook is exclusive to planning mode.
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [] })).not.toContain("PLANNING MODE");
  });

  it("opens with a tool-routing guide that resolves the look-alike choices", () => {
    const p = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(p).toContain("HOW TO PICK A TOOL");
    // The routing guide precedes the full tool catalog so it's read first.
    expect(p.indexOf("HOW TO PICK A TOOL")).toBeLessThan(p.indexOf("TOOLS — use one"));
    // Confusable pairs are disambiguated.
    expect(p).toMatch(/read \(source:"url"\).*open_web_text/s);
    expect(p).toMatch(/search_images.*generate_image/s);
  });

  it("routing guide only mentions desktop/run/google tools when those are available", () => {
    const base = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(base).not.toContain("find_files"); // no filesystem → no find_files routing line
    const files = buildBuddySystemPrompt({ persona: "assistant", library: [], canSearchFiles: true });
    expect(files).toContain("find it by NAME → find_files");
    const cmds = buildBuddySystemPrompt({ persona: "assistant", library: [], canRunCommands: true });
    expect(cmds).toContain("write_file it then run_command");
    const g = buildBuddySystemPrompt({ persona: "assistant", library: [], canGoogle: true });
    expect(g).toContain("draft_email");
  });

  it("carries the show-me-vs-generate image-tool rule in both modes", () => {
    for (const persona of ["assistant", "planning"] as const) {
      const prompt = buildBuddySystemPrompt({ persona, library: [] });
      expect(prompt).toContain("PICKING THE IMAGE TOOL");
      expect(prompt).toContain("search_images");
      // The persona text itself must not bias toward generation.
      expect(prompt).not.toContain("offer concept art");
    }
  });

  it("normalizeBuddyPersona maps legacy voices forward to the single assistant", () => {
    for (const legacy of ["freeform", "entertainment", "technical", "", undefined, null, "bogus"]) {
      expect(normalizeBuddyPersona(legacy)).toBe("assistant");
    }
    expect(normalizeBuddyPersona("planning")).toBe("planning");
  });

  it("advertises find_files only when filesystem access is available (desktop)", () => {
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [] })).not.toContain("find_files");
    const desktop = buildBuddySystemPrompt({ persona: "assistant", library: [], canSearchFiles: true });
    expect(desktop).toContain('"tool":"find_files"');
    expect(desktop).toContain("OWN COMPUTER");
  });

  it("routes a compose-the-steps request (research + files + drafting) to plan_task", () => {
    const g = buildBuddySystemPrompt({ persona: "assistant", library: [], canGoogle: true, canTaskTools: true });
    expect(g).toContain('"tool":"plan_task"');
    // It should tell the model to hand a multi-source job (e.g. job posting + resume on disk) to
    // plan_task in ONE call instead of doing it inline and giving up.
    expect(g).toMatch(/resume/i);
    expect(g).toMatch(/in ONE call|the WHOLE thing/);
  });

  it("gates the task-orchestrator tools (plan_task + scheduling) behind canTaskTools", () => {
    const off = buildBuddySystemPrompt({ persona: "assistant", library: [], canGoogle: true });
    expect(off).not.toContain('"tool":"plan_task"');
    expect(off).not.toContain('"tool":"schedule_task"');
    const on = buildBuddySystemPrompt({ persona: "assistant", library: [], canTaskTools: true });
    expect(on).toContain('"tool":"plan_task"');
    expect(on).toContain('"tool":"schedule_task"');
    expect(on).toContain('"tool":"cancel_scheduled"');
  });

  it("gates the sub-agent fan-out tools (delegate + spawn_agents) behind canSubAgents", () => {
    const off = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(off).not.toContain('"tool":"delegate"');
    expect(off).not.toContain('"tool":"spawn_agents"');
    const on = buildBuddySystemPrompt({ persona: "assistant", library: [], canSubAgents: true });
    expect(on).toContain('"tool":"delegate"');
    expect(on).toContain('"tool":"spawn_agents"');
  });

  it("gates the keyless markets suite behind canMarkets", () => {
    const off = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(off).not.toContain('"tool":"stock_quote"');
    expect(off).not.toContain('"tool":"market_analysis"');
    expect(off).not.toContain('"tool":"trading_script"');
    expect(off).not.toContain('"tool":"set_price_alert"');
    const on = buildBuddySystemPrompt({ persona: "assistant", library: [], canMarkets: true });
    expect(on).toContain('"tool":"stock_quote"');
    expect(on).toContain('"tool":"market_analysis"');
    expect(on).toContain('"tool":"trading_script"');
    expect(on).toContain('"tool":"set_price_alert"');
  });

  it("planning persona is NOT required for task tools, but does not itself leak markets/sub-agents", () => {
    // canTaskTools is driven at the call site (planning mode / active task / opt-in); the prompt itself
    // just honors the flag. Markets + sub-agents stay independent.
    const planning = buildBuddySystemPrompt({ persona: "planning", library: [] });
    expect(planning).not.toContain('"tool":"stock_quote"');
    expect(planning).not.toContain('"tool":"spawn_agents"');
  });

  it("advertises GitHub repo work only when a token is configured (canGithub)", () => {
    const off = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(off).not.toContain("GITHUB:");
    expect(off).not.toContain("gh repo clone");
    const on = buildBuddySystemPrompt({ persona: "assistant", library: [], canGithub: true });
    expect(on).toContain("GITHUB:");
    expect(on).toContain("gh pr create");
    expect(on).toContain("gh auth setup-git");
    expect(on).toContain("authenticated"); // gh is authed (token OR local gh login)
    expect(on).toContain("default branch"); // gh targets it automatically
    expect(on).toContain("git checkout -b"); // work on a NEW branch, not the default
    expect(on).toMatch(/cd <repo>/); // the per-command working-dir caveat
    expect(on).toMatch(/never.*print|NEVER print/i); // the token-safety rule
  });

  it("explains WHERE code runs whenever commands are on, and names the chosen folder when set", () => {
    // No command access → no execution-context note at all.
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [] })).not.toContain("WHERE YOUR CODE RUNS");
    // Commands on, no folder chosen → still explains the default workspace (so the model knows where
    // its code runs) and the non-interactive caveat.
    const cmds = buildBuddySystemPrompt({ persona: "assistant", library: [], canRunCommands: true });
    expect(cmds).toContain("WHERE YOUR CODE RUNS");
    expect(cmds).toMatch(/workspace/i);
    expect(cmds).toMatch(/NON-INTERACTIVE/i);
    expect(cmds).toMatch(/cd.*does NOT carry|cd.*not carry/i); // the per-command caveat
    // A chosen folder is named explicitly.
    const folder = buildBuddySystemPrompt({ persona: "assistant", library: [], canRunCommands: true, workingDir: "/home/u/projects/site" });
    expect(folder).toContain("/home/u/projects/site");
  });

  it("advertises run_command + screenshot only when explicitly enabled (opt-in)", () => {
    const off = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(off).not.toContain("run_command");
    expect(off).not.toContain("screenshot");
    const on = buildBuddySystemPrompt({ persona: "assistant", library: [], canRunCommands: true });
    expect(on).toContain('"tool":"run_command"');
    expect(on).toContain('"tool":"screenshot"');
    expect(on).toContain("APPROVE");
    expect(on).toContain("NEVER run");
    // The pandas/code-interpreter workflow rides on run_command, so it appears with it.
    expect(on).toMatch(/pandas/i);
    expect(on).toContain("python");
  });

  it("tells the buddy to FOLLOW THROUGH by chaining tools, with the write+run clause only when commands are on", () => {
    // The chaining principle (act on a clear intent, e.g. call generate_image) is always present.
    const base = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(base).toContain("FOLLOW THROUGH");
    expect(base).toMatch(/CALL generate_image/);
    // The write-code-then-run-it clause only makes sense (and only appears) with command access.
    expect(base).not.toMatch(/write_file a Python script and run_command/);
    const cmds = buildBuddySystemPrompt({ persona: "assistant", library: [], canRunCommands: true });
    expect(cmds).toMatch(/write_file a Python script and run_command/);
  });
});

describe("skill tools", () => {
  it("parses read_skill / save_skill / forget_skill and rejects empties", () => {
    expect(parseBuddyToolCall('{"tool":"read_skill","name":"deploy"}')).toEqual({ tool: "read_skill", name: "deploy" });
    expect(
      parseBuddyToolCall('{"tool":"save_skill","name":"deploy","description":"ship it","body":"1. build\\n2. push"}'),
    ).toEqual({ tool: "save_skill", name: "deploy", description: "ship it", body: "1. build\n2. push" });
    // description is optional → defaults to ""
    expect(parseBuddyToolCall('{"tool":"save_skill","name":"x","body":"do the thing"}')).toEqual({
      tool: "save_skill",
      name: "x",
      description: "",
      body: "do the thing",
    });
    expect(parseBuddyToolCall('{"tool":"forget_skill","match":"deploy"}')).toEqual({ tool: "forget_skill", match: "deploy" });
    expect(parseBuddyToolCall('{"tool":"save_skill","name":"x"}')).toBeUndefined(); // no body
    expect(parseBuddyToolCall('{"tool":"read_skill","name":"  "}')).toBeUndefined();
  });

  it("feeds a read skill back as the assistant's OWN notes (not reader instructions)", () => {
    const hit = formatBuddyToolResult(
      { tool: "read_skill", name: "deploy" },
      { skill: { action: "read", name: "deploy", body: "1. build\n2. push" } },
    );
    expect(hit).toContain("deploy");
    expect(hit).toContain("1. build");
    expect(hit).toContain("not the reader's instructions");
    expect(
      formatBuddyToolResult({ tool: "read_skill", name: "ghost" }, { skill: { action: "missing", name: "ghost" } }),
    ).toContain("no saved skill");
  });

  it("confirms a save / forget with the kept count", () => {
    expect(
      formatBuddyToolResult({ tool: "save_skill", name: "deploy", description: "", body: "b" }, { skill: { action: "saved", name: "deploy", count: 3 } }),
    ).toContain("saved");
    expect(
      formatBuddyToolResult({ tool: "forget_skill", match: "deploy" }, { skill: { action: "forgot", name: "deploy", count: 2 } }),
    ).toContain("forgotten");
  });

  it("always advertises the skill tools and the grounded-in-truth rule", () => {
    const p = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(p).toContain('"tool":"read_skill"');
    expect(p).toContain('"tool":"save_skill"');
    expect(p).toContain("GROUNDED IN TRUTH");
  });

  it("tells the model to ACT (emit the tool JSON) instead of promising a search/read it never runs", () => {
    const p = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(p).toMatch(/ACT, DON'T NARRATE/);
    expect(p).toMatch(/search_web to find sources/);
    expect(p).toMatch(/read \(source:"url"\) to pull a specific page's text/);
    expect(p).toMatch(/open_web_text to open a page/);
    expect(p).toMatch(/NEVER state specific facts you have not verified/i);
  });
});

describe("update_setting tool", () => {
  it("parses a settings change (toggle, enum, numeric) and rejects an empty field", () => {
    expect(parseBuddyToolCall('{"tool":"update_setting","field":"mature mode","value":true}')).toEqual({
      tool: "update_setting",
      field: "mature mode",
      value: true,
    });
    expect(parseBuddyToolCall('{"tool":"update_setting","field":"image quality","value":"high"}')).toEqual({
      tool: "update_setting",
      field: "image quality",
      value: "high",
    });
    expect(parseBuddyToolCall('{"tool":"update_setting","field":"comic panels","value":4}')).toEqual({
      tool: "update_setting",
      field: "comic panels",
      value: 4,
    });
    expect(parseBuddyToolCall('{"tool":"update_setting","field":"  ","value":true}')).toBeUndefined();
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [] })).toContain('"tool":"update_setting"');
  });

  it("confirms an applied change (flagging sensitive ones) and reports a bad one", () => {
    const ok = formatBuddyToolResult(
      { tool: "update_setting", field: "mature mode", value: true },
      { settingChange: { label: "mature mode", valueLabel: "on", sensitive: true } },
    );
    expect(ok).toContain("mature mode → on");
    expect(ok).toMatch(/confirm/i);
    expect(ok).toMatch(/sensitive/i);
    const bad = formatBuddyToolResult(
      { tool: "update_setting", field: "quality", value: "supreme" },
      { settingChange: { error: '"image quality" must be one of: auto, draft, standard, high, ultra.' } },
    );
    expect(bad).toContain("couldn't change that setting");
    expect(bad).toContain("auto, draft");
  });
});

describe("stock_quote tool", () => {
  it("parses + advertises stock_quote, and feeds the quote back for analysis", () => {
    expect(parseBuddyToolCall('{"tool":"stock_quote","symbol":"AAPL"}')).toEqual({ tool: "stock_quote", symbol: "AAPL" });
    expect(parseBuddyToolCall('{"tool":"stock_quote","symbol":"  "}')).toBeUndefined();
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [], canMarkets: true })).toContain('"tool":"stock_quote"');
    const out = formatBuddyToolResult({ tool: "stock_quote", symbol: "AAPL" }, { quote: { symbol: "AAPL", close: 204, open: 200 } });
    expect(out).toContain("AAPL: 204");
    expect(out).toMatch(/financial advice/i);
    expect(formatBuddyToolResult({ tool: "stock_quote", symbol: "ZZ" }, {})).toMatch(/no keyless quote/i);
  });

  it("parses + advertises market_analysis and feeds indicators back with watch levels", () => {
    expect(parseBuddyToolCall('{"tool":"market_analysis","symbol":"AAPL","interval":"5m","range":"1d"}')).toEqual({
      tool: "market_analysis",
      symbol: "AAPL",
      interval: "5m",
      range: "1d",
    });
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [], canMarkets: true })).toContain('"tool":"market_analysis"');
    const out = formatBuddyToolResult(
      { tool: "market_analysis", symbol: "AAPL" },
      { indicators: { symbol: "AAPL", bars: 78, last: 204, vwap: 202, rsi14: 61 } },
    );
    expect(out).toContain("VWAP 202");
    expect(out).toMatch(/watch levels/i);
  });

  it("parses + advertises trading_script and returns it in a fenced block", () => {
    expect(parseBuddyToolCall('{"tool":"trading_script","platform":"pine","kind":"rsi","level":80,"length":9}')).toEqual({
      tool: "trading_script",
      platform: "pine",
      kind: "rsi",
      level: 80,
      length: 9,
    });
    expect(parseBuddyToolCall('{"tool":"trading_script","platform":"pine","kind":"bogus"}')).toBeUndefined();
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [], canMarkets: true })).toContain('"tool":"trading_script"');
    const out = formatBuddyToolResult(
      { tool: "trading_script", platform: "thinkscript", kind: "vwap_cross" },
      { tradingScript: { lang: "ts", script: "# VWAP\nAlert(...)", where: "thinkorswim → Studies" } },
    );
    expect(out).toContain("```ts");
    expect(out).toContain("thinkorswim → Studies");
  });
});

describe("create_spreadsheet tool", () => {
  it("parses a column/row spec, coercing cells and dropping invalid columns", () => {
    const call = parseBuddyToolCall(
      JSON.stringify({
        tool: "create_spreadsheet",
        title: "Budget",
        columns: [{ name: "Category" }, { name: "Budget", type: "number" }, { name: "" }, { bad: 1 }],
        rows: [["Rent", 1500, "=B2"], "nope", [{}, true, 9]],
      }),
    );
    expect(call).toEqual({
      tool: "create_spreadsheet",
      title: "Budget",
      columns: [{ name: "Category" }, { name: "Budget", type: "number" }],
      rows: [
        ["Rent", 1500],
        [null, null],
      ],
    });
  });

  it("requires at least one valid column, and is advertised", () => {
    expect(parseBuddyToolCall('{"tool":"create_spreadsheet","title":"x","columns":[]}')).toBeUndefined();
    expect(parseBuddyToolCall('{"tool":"create_spreadsheet","title":"x"}')).toBeUndefined();
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [] })).toContain('"tool":"create_spreadsheet"');
  });
});

describe("story as you go tools", () => {
  it("parses start_story (opening required; cast accepts names or {name,description})", () => {
    expect(
      parseBuddyToolCall(
        JSON.stringify({
          tool: "start_story",
          title: "The Lantern Road",
          opening: "Mira lit the last lantern as Toll watched from the bridge.",
          style: "storybook illustration",
          characters: ["Mira", { name: "Toll", description: "tall, salt-and-pepper beard" }, "", { name: "" }],
          roleplay: { you: "Mira", me: "Toll" },
        }),
      ),
    ).toEqual({
      tool: "start_story",
      title: "The Lantern Road",
      opening: "Mira lit the last lantern as Toll watched from the bridge.",
      style: "storybook illustration",
      characters: [{ name: "Mira" }, { name: "Toll", description: "tall, salt-and-pepper beard" }],
      roleplay: { you: "Mira", me: "Toll" },
    });
    // No opening → not a valid start.
    expect(parseBuddyToolCall('{"tool":"start_story","title":"x"}')).toBeUndefined();
  });

  it("documents the role-play loop once a story is open (not before)", () => {
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [] })).not.toMatch(/ROLE-PLAY/);
    const active = buildBuddySystemPrompt({ persona: "assistant", library: [], storyActive: true });
    expect(active).toMatch(/ROLE-PLAY/i);
    expect(active).toMatch(/continue_story/);
  });

  it("parses continue_story / render_scene / set_story_cadence", () => {
    expect(parseBuddyToolCall('{"tool":"continue_story","text":"They pressed on."}')).toEqual({
      tool: "continue_story",
      text: "They pressed on.",
    });
    expect(parseBuddyToolCall('{"tool":"continue_story","text":"  "}')).toBeUndefined();
    expect(parseBuddyToolCall('{"tool":"render_scene","from":3,"to":5}')).toEqual({ tool: "render_scene", from: 3, to: 5 });
    expect(parseBuddyToolCall('{"tool":"render_scene"}')).toEqual({ tool: "render_scene" }); // defaults to latest
    expect(parseBuddyToolCall('{"tool":"set_story_cadence","mode":"every-n","n":4}')).toEqual({
      tool: "set_story_cadence",
      mode: "every-n",
      n: 4,
    });
    expect(parseBuddyToolCall('{"tool":"set_story_cadence","mode":"bogus"}')).toEqual({
      tool: "set_story_cadence",
      mode: "per-response",
    });
  });

  it("formats the story outcomes for the model", () => {
    const started = formatBuddyToolResult(
      { tool: "start_story", title: "Tale", opening: "x" },
      { opened: { title: "Tale", chapters: 1, pages: 1, visuals: true }, story: { beats: 1, illustrated: true } },
    );
    expect(started).toMatch(/started the story "Tale"/);

    const beat = formatBuddyToolResult(
      { tool: "continue_story", text: "next" },
      { opened: { title: "Tale", chapters: 2, pages: 2, visuals: true }, story: { beats: 2, illustrated: true } },
    );
    expect(beat).toMatch(/beat 2/);
    expect(beat).toMatch(/illustration of the new scene is generating/);

    const manualBeat = formatBuddyToolResult(
      { tool: "continue_story", text: "next" },
      { opened: { title: "Tale", chapters: 3, pages: 3, visuals: false }, story: { beats: 3, illustrated: false } },
    );
    expect(manualBeat).toMatch(/no image this beat/);

    expect(
      formatBuddyToolResult({ tool: "render_scene", from: 2, to: 3 }, { story: { rendered: 2, from: 2, to: 3 } }),
    ).toMatch(/illustrating 2 beats \(2–3\)/);
    expect(
      formatBuddyToolResult({ tool: "set_story_cadence", mode: "manual" }, { story: { cadence: { mode: "manual" } } }),
    ).toMatch(/only when you ask/);
  });

  it("never advertises start_story (stories are started by a click, not a tool)", () => {
    const idle = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(idle).not.toContain('"tool":"start_story"');
    expect(idle).not.toContain('"tool":"continue_story"'); // nothing to continue when no story is open
    // It points the reader at the Open Book → Story as you go click instead.
    expect(idle).toContain("Story as you go");
    const active = buildBuddySystemPrompt({ persona: "assistant", library: [], storyActive: true });
    expect(active).not.toContain('"tool":"start_story"'); // still never a tool
    expect(active).toContain('"tool":"continue_story"'); // continuation tools appear once a story is open
    expect(active).toContain('"tool":"set_story_cadence"');
    expect(active).toMatch(/STORY MODE/);
  });
});

describe("setup_help tool", () => {
  it("parses setup_help and always advertises it", () => {
    expect(parseBuddyToolCall('{"tool":"setup_help","topic":"image generation"}')).toEqual({
      tool: "setup_help",
      topic: "image generation",
    });
    expect(parseBuddyToolCall('{"tool":"setup_help","topic":"  "}')).toBeUndefined();
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [] })).toContain('"tool":"setup_help"');
  });

  it("feeds a matched guide back as a walkthrough, and falls back to a topic list", () => {
    const g = formatBuddyToolResult(
      { tool: "setup_help", topic: "connect google" },
      {
        setupHelp: {
          guide: { id: "google", title: "Connect Gmail, Calendar & Tasks", aliases: [], when: "w", steps: ["Step one", "Step two"] },
        },
      },
    );
    expect(g).toContain("one step at a time");
    expect(g).toContain("1. Step one");
    const miss = formatBuddyToolResult(
      { tool: "setup_help", topic: "teleporter" },
      { setupHelp: { topics: ["Turn on real image generation", "Connect Gmail, Calendar & Tasks"] } },
    );
    expect(miss).toContain("which they meant");
    expect(miss).toContain("Connect Gmail");
  });
});

describe("google tools", () => {
  it("parses the gmail/calendar/tasks calls and rejects missing required fields", () => {
    expect(parseBuddyToolCall('{"tool":"gmail_search","query":"is:unread","max":5}')).toEqual({
      tool: "gmail_search",
      query: "is:unread",
      max: 5,
    });
    // An empty/missing query means "newest emails" → defaults to in:inbox instead of being rejected.
    expect(parseBuddyToolCall('{"tool":"gmail_search","query":""}')).toEqual({ tool: "gmail_search", query: "in:inbox" });
    expect(parseBuddyToolCall('{"tool":"gmail_search"}')).toEqual({ tool: "gmail_search", query: "in:inbox" });
    expect(parseBuddyToolCall('{"tool":"read_email","id":"abc"}')).toEqual({ tool: "read_email", id: "abc" });
    expect(parseBuddyToolCall('{"tool":"list_events"}')).toEqual({ tool: "list_events" });
    expect(
      parseBuddyToolCall('{"tool":"create_event","summary":"Dentist","start":"2026-06-18T14:00:00-04:00","end":"2026-06-18T15:00:00-04:00"}'),
    ).toEqual({ tool: "create_event", summary: "Dentist", start: "2026-06-18T14:00:00-04:00", end: "2026-06-18T15:00:00-04:00" });
    expect(parseBuddyToolCall('{"tool":"create_event","summary":"x","start":"t"}')).toBeUndefined(); // no end
    expect(parseBuddyToolCall('{"tool":"create_task","title":"File taxes","due":"2026-04-15T00:00:00Z"}')).toEqual({
      tool: "create_task",
      title: "File taxes",
      due: "2026-04-15T00:00:00Z",
    });
    expect(parseBuddyToolCall('{"tool":"create_task"}')).toBeUndefined(); // no title
  });

  it("parses add_task_group (parent + sub-tasks) and rejects it without a title or sub-tasks", () => {
    expect(
      parseBuddyToolCall('{"tool":"add_task_group","title":"Iowa trip","due":"2026-07-14T00:00:00Z","subtasks":[{"title":"Book outbound flight","due":"2026-06-30T00:00:00Z"},{"title":"Book return flight"}]}'),
    ).toEqual({
      tool: "add_task_group",
      title: "Iowa trip",
      due: "2026-07-14T00:00:00Z",
      subtasks: [{ title: "Book outbound flight", due: "2026-06-30T00:00:00Z" }, { title: "Book return flight" }],
    });
    expect(parseBuddyToolCall('{"tool":"add_task_group","title":"x","subtasks":[]}')).toBeUndefined(); // no sub-tasks
    expect(parseBuddyToolCall('{"tool":"add_task_group","subtasks":[{"title":"a"}]}')).toBeUndefined(); // no title
    const out = formatBuddyToolResult(
      { tool: "add_task_group", title: "Iowa trip", subtasks: [{ title: "a" }, { title: "b" }] },
      { taskGroup: { title: "Iowa trip", count: 2 } },
    );
    expect(out).toContain("Iowa trip");
    expect(out).toContain("2 sub-tasks");
  });

  it("parses read_attachment and rejects it without both ids", () => {
    expect(parseBuddyToolCall('{"tool":"read_attachment","messageId":"m1","attachmentId":"att-1","filename":"itinerary.pdf"}')).toEqual({
      tool: "read_attachment",
      messageId: "m1",
      attachmentId: "att-1",
      filename: "itinerary.pdf",
    });
    expect(parseBuddyToolCall('{"tool":"read_attachment","messageId":"m1"}')).toBeUndefined(); // no attachmentId
  });

  it("read_email lists attachments with the ids needed to pull them in", () => {
    const out = formatBuddyToolResult(
      { tool: "read_email", id: "m1" },
      { emailFull: { id: "m1", from: "United", subject: "Your itinerary", date: "d", snippet: "", body: "see attached", attachments: [{ attachmentId: "att-1", filename: "itinerary.pdf", mimeType: "application/pdf" }] } },
    );
    expect(out).toContain("ATTACHMENTS");
    expect(out).toContain("itinerary.pdf");
    expect(out).toContain("attachmentId=att-1");
  });

  it("formats a pulled text attachment as prep data, and notes a binary one", () => {
    const text = formatBuddyToolResult(
      { tool: "read_attachment", messageId: "m1", attachmentId: "att-1" },
      { attachment: { filename: "details.txt", mimeType: "text/plain", text: "Confirmation #ABC123", bytesLen: 20 } },
    );
    expect(text).toContain("Confirmation #ABC123");
    const binary = formatBuddyToolResult(
      { tool: "read_attachment", messageId: "m1", attachmentId: "att-2" },
      { attachment: { filename: "scan.pdf", mimeType: "application/pdf", bytesLen: 99000 } },
    );
    expect(binary).toMatch(/can't be extracted inline|reference it by name/i);
  });

  it("parses a date-scoped list_events for 'this week / today' schedule questions", () => {
    expect(
      parseBuddyToolCall('{"tool":"list_events","timeMin":"2026-06-15T00:00:00-04:00","timeMax":"2026-06-22T00:00:00-04:00"}'),
    ).toEqual({ tool: "list_events", timeMin: "2026-06-15T00:00:00-04:00", timeMax: "2026-06-22T00:00:00-04:00" });
    // The window is echoed back in the tool result so the model frames its answer.
    const out = formatBuddyToolResult(
      { tool: "list_events", timeMin: "2026-06-15T00:00:00-04:00", timeMax: "2026-06-22T00:00:00-04:00" },
      { events: [{ summary: "Standup", start: "2026-06-16T09:00:00-04:00", end: "2026-06-16T09:15:00-04:00" }] },
    );
    expect(out).toContain("Standup");
    expect(out).toContain("2026-06-15T00:00:00-04:00");
  });

  it("injects the current date/time and advertises schedule/mail lookups when connected", () => {
    const dated = buildBuddySystemPrompt({ persona: "assistant", library: [], now: "Sunday, June 15, 2026, 4:58 PM (UTC-04:00)" });
    expect(dated).toContain("CURRENT DATE & TIME: Sunday, June 15, 2026");
    const g = buildBuddySystemPrompt({ persona: "assistant", library: [], canGoogle: true });
    expect(g).toContain("this week");
    expect(g).toMatch(/when did I last pay/i);
    expect(g).toContain("timeMin");
  });

  it("parses plan_task (natural-language planning) and advertises it when task tools are on", () => {
    expect(parseBuddyToolCall('{"tool":"plan_task","request":"plan my car registration renewal"}')).toEqual({
      tool: "plan_task",
      request: "plan my car registration renewal",
    });
    expect(parseBuddyToolCall('{"tool":"plan_task","request":"  "}')).toBeUndefined();
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [], canTaskTools: true })).toContain('"tool":"plan_task"');
  });

  it("parses the task-execution tools and shows them only with an active task", () => {
    expect(parseBuddyToolCall('{"tool":"mark_step_done","planId":"t1","stepId":"s1"}')).toEqual({
      tool: "mark_step_done",
      planId: "t1",
      stepId: "s1",
    });
    expect(parseBuddyToolCall('{"tool":"update_task_step","planId":"t1","stepId":"s1","status":"blocked","notes":"waiting"}')).toEqual({
      tool: "update_task_step",
      planId: "t1",
      stepId: "s1",
      status: "blocked",
      notes: "waiting",
    });
    expect(parseBuddyToolCall('{"tool":"list_task_plans"}')).toEqual({ tool: "list_task_plans" });
    expect(parseBuddyToolCall('{"tool":"mark_step_done","planId":"t1"}')).toBeUndefined(); // no stepId
    // The step tools + the plan context appear only when a task is active.
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [] })).not.toContain('"tool":"mark_step_done"');
    const active = buildBuddySystemPrompt({ persona: "assistant", library: [], activeTask: "ACTIVE TASK: Renew (plan id: t1)" });
    expect(active).toContain("ACTIVE TASK: Renew");
    expect(active).toContain('"tool":"mark_step_done"');
    // With a task active, "plan/redo this" re-plans THAT task in place (no fork), and an
    // all-done task gets offered options instead of a generic "which task?" question.
    expect(active).toMatch(/re-plan THIS task in place/i);
    expect(active).toMatch(/all steps are done/i);
  });

  it("tells the model that plan_task refines the ACTIVE task in place (no duplicate fork)", () => {
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [], canTaskTools: true })).toMatch(
      /re-plans THAT task in place/i,
    );
  });

  it("feeds an email back as the reader's DATA, and confirms a created event/task", () => {
    const email = formatBuddyToolResult(
      { tool: "read_email", id: "m1" },
      { emailFull: { id: "m1", from: "a@x", subject: "Hi", date: "today", snippet: "", body: "the body" } },
    );
    expect(email).toContain("the body");
    expect(email).toContain("NOT instructions");
    expect(
      formatBuddyToolResult(
        { tool: "create_event", summary: "Dentist", start: "2026-06-18T14:00:00-04:00", end: "2026-06-18T15:00:00-04:00" },
        { eventCreated: { summary: "Dentist", start: "2026-06-18T14:00:00-04:00", end: "2026-06-18T15:00:00-04:00" } },
      ),
    ).toContain("created calendar event");
    expect(
      formatBuddyToolResult({ tool: "create_task", title: "File taxes" }, { taskCreated: { title: "File taxes" } }),
    ).toContain("added to-do");
  });

  it("advertises the Google tools only when connected (canGoogle), with the confirm-before-create rule", () => {
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [] })).not.toContain('"tool":"gmail_search"');
    const on = buildBuddySystemPrompt({ persona: "assistant", library: [], canGoogle: true });
    expect(on).toContain('"tool":"gmail_search"');
    expect(on).toContain('"tool":"create_event"');
    expect(on).toContain('"tool":"create_task"');
    expect(on).toMatch(/confirm the details/i);
    expect(on).toContain("cannot send email or delete");
  });

  it("when Google is NOT connected, tells the model so it can't fabricate a connection or data", () => {
    const off = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(off).toMatch(/GOOGLE IS NOT CONNECTED/);
    expect(off).toMatch(/NEVER invent emails, events, or to-dos/i);
    expect(off).toMatch(/setup_help/); // offers the real reconnect path
    // The disconnected guard must NOT smuggle the read tools back in.
    expect(off).not.toContain('"tool":"gmail_search"');
    // ...and the connected build must NOT carry the "not connected" warning.
    expect(buildBuddySystemPrompt({ persona: "assistant", library: [], canGoogle: true })).not.toMatch(/GOOGLE IS NOT CONNECTED/);
  });

  it("swaps the confirm rule for auto-approval when canAutomateTasks is on", () => {
    const auto = buildBuddySystemPrompt({ persona: "assistant", library: [], canGoogle: true, canAutomateTasks: true });
    expect(auto).toContain("Task automation is ON");
    expect(auto).toContain("without asking each time");
    expect(auto).toMatch(/NEVER submit forms, pay, or send/);
    expect(auto).not.toMatch(/confirm the details/i); // the confirm sentence is replaced
  });
});

describe("ALWAYS_GATED_TOOLS (the full-autonomy danger floor)", () => {
  it("always gates running a command/executable and placing a trade — never the medium-risk tools", () => {
    expect(ALWAYS_GATED_TOOLS.has("run_command")).toBe(true); // could run a downloaded .exe
    expect(ALWAYS_GATED_TOOLS.has("prep_order")).toBe(true); // places a financial trade
    expect(ALWAYS_GATED_TOOLS.has("send_email")).toBe(true); // sends mail from the reader's account
    expect(ALWAYS_GATED_TOOLS.has("generate_image")).toBe(false);
    expect(ALWAYS_GATED_TOOLS.has("find_files")).toBe(false);
    expect(ALWAYS_GATED_TOOLS.has("read_attachment")).toBe(false);
    expect(ALWAYS_GATED_TOOLS.has("draft_email")).toBe(false); // a draft just sits in Gmail
  });
});

describe("parseBuddyToolCall: draft_email / send_email", () => {
  it("parses recipients (array or string), keeps cc/bcc only when present", () => {
    // A single recipient may arrive as a bare string.
    expect(parseBuddyToolCall('{"tool":"draft_email","to":"a@b.com","subject":"Hi","body":"Hello"}')).toEqual({
      tool: "draft_email",
      to: ["a@b.com"],
      subject: "Hi",
      body: "Hello",
    });
    expect(
      parseBuddyToolCall('{"tool":"send_email","to":["a@b.com","c@d.com"],"cc":["e@f.com"],"subject":"S","body":"B"}'),
    ).toEqual({ tool: "send_email", to: ["a@b.com", "c@d.com"], subject: "S", body: "B", cc: ["e@f.com"] });
  });

  it("rejects an email with no recipient / subject / body", () => {
    expect(parseBuddyToolCall('{"tool":"draft_email","to":[],"subject":"S","body":"B"}')).toBeUndefined();
    expect(parseBuddyToolCall('{"tool":"draft_email","to":["a@b.com"],"body":"B"}')).toBeUndefined();
    expect(parseBuddyToolCall('{"tool":"send_email","to":["a@b.com"],"subject":"S"}')).toBeUndefined();
  });
});

describe("parseBuddyToolCalls (batched tool calls)", () => {
  it("recovers EVERY tool call when the model emits several JSON objects in one message", () => {
    // The exact shape that leaked as raw text before: multiple objects, one per line.
    const batched =
      '{"tool":"create_task","title":"Book Outbound Flight to Iowa City","due":"2026-06-30T23:59:59Z"}\n' +
      '{"tool":"create_task","title":"Book Return Flight","due":"2026-06-30T23:59:59Z"}\n' +
      '{"tool":"search_web","query":"nonstop flights DC to Iowa City"}';
    const calls = parseBuddyToolCalls(batched);
    expect(calls.map((c) => c.tool)).toEqual(["create_task", "create_task", "search_web"]);
    expect(calls[0]).toEqual({ tool: "create_task", title: "Book Outbound Flight to Iowa City", due: "2026-06-30T23:59:59Z" });
    expect(parseBuddyToolCall(batched)).toEqual(calls[0]); // singular helper = first
  });

  it("handles a fenced batch and skips an unparseable object", () => {
    const fenced = '```json\n{"tool":"list_tasks"}\n{"tool":"create_task"}\n{"tool":"search_web","query":"x"}\n```';
    // create_task with no title is dropped; the other two survive.
    expect(parseBuddyToolCalls(fenced).map((c) => c.tool)).toEqual(["list_tasks", "search_web"]);
  });

  it("still parses a single object and ignores prose", () => {
    expect(parseBuddyToolCalls('{"tool":"search_web","query":"x"}')).toHaveLength(1);
    expect(parseBuddyToolCalls("just a normal sentence")).toEqual([]);
  });

  it("tolerates the TRAILING COMMAS weaker local models emit (which strict JSON drops)", () => {
    // A single trailing comma before } used to make JSON.parse throw → the tool call was silently
    // dropped → the buddy "couldn't string together tools" / fell back to "I didn't catch that".
    expect(parseBuddyToolCalls('{"tool":"search_web","query":"VA SOL Algebra 1 standards",}')).toEqual([
      { tool: "search_web", query: "VA SOL Algebra 1 standards" },
    ]);
    // A batch where each object has a trailing comma still recovers all of them.
    const batched = '{"tool":"list_tasks",}\n{"tool":"search_web","query":"x",}';
    expect(parseBuddyToolCalls(batched).map((c) => c.tool)).toEqual(["list_tasks", "search_web"]);
    // A comma INSIDE a quoted value is never touched (the repair is string-aware).
    expect(parseBuddyToolCalls('{"tool":"search_web","query":"apples, oranges, and pears"}')).toEqual([
      { tool: "search_web", query: "apples, oranges, and pears" },
    ]);
  });

  it("accepts the {name, arguments} tool shape that Hermes/Qwen/ChatML models emit", () => {
    // The exact failure from the transcript: the model "called" write_file but nothing was written,
    // because the app only parsed {"tool":X,…} — not {"name":X,"arguments":{…}} — so the call vanished.
    expect(parseBuddyToolCalls('{"name":"write_file","arguments":{"path":"count_rs.py","content":"print(1)"}}')).toEqual([
      { tool: "write_file", path: "count_rs.py", content: "print(1)" },
    ]);
    // Wrapped in <tool_call>…</tool_call> control tags, with code containing braces (string-aware).
    const tagged = '<tool_call>\n{"name":"run_command","arguments":{"command":"python count_rs.py"}}\n</tool_call>';
    expect(parseBuddyToolCalls(tagged)).toEqual([{ tool: "run_command", command: "python count_rs.py" }]);
    // Double-encoded arguments (a JSON STRING) — also common from local models.
    expect(parseBuddyToolCalls('{"name":"search_web","arguments":"{\\"query\\":\\"strawberry\\"}"}')).toEqual([
      { tool: "search_web", query: "strawberry" },
    ]);
  });

  it("strips tool-call control tokens from the displayed prose", () => {
    expect(stripToolCallJson('All set.<tool_call>{"name":"list_tasks","arguments":{}}</tool_call>')).toBe("All set.");
    expect(looksLikeToolJson('<tool_call>{"name":"write_file","arguments":{"path":"a","content":"b"}}</tool_call>')).toBe(true);
  });

  it("describeBuddyToolActivity names the specific action for the status line", () => {
    expect(describeBuddyToolActivity({ tool: "search_web", query: "Virginia SOL Algebra 1" })).toMatch(
      /Searching the web for .*Algebra 1/,
    );
    expect(describeBuddyToolActivity({ tool: "read_url", url: "https://doe.virginia.gov/standards" })).toBe(
      "Reading doe.virginia.gov…",
    );
    expect(describeBuddyToolActivity({ tool: "calculate", expression: "2+2" })).toBe("Calculating…");
    // An uncommon tool still gets a sane generic line (never blank).
    expect(describeBuddyToolActivity({ tool: "set_visual_style", style: "watercolor" })).toBe("Working on it…");
  });

  it("looksLikeToolJson flags a tool-shaped reply so raw JSON isn't shown as prose", () => {
    expect(looksLikeToolJson('{"tool":"create_task","title":"x"}')).toBe(true);
    expect(looksLikeToolJson("hello there, here is my answer")).toBe(false);
  });
});

describe("read_file tool", () => {
  it("parses read_file and formats its text (or a couldn't-read note)", () => {
    expect(parseBuddyToolCall('{"tool":"read_file","path":"/home/u/form.txt"}')).toEqual({ tool: "read_file", path: "/home/u/form.txt" });
    expect(parseBuddyToolCall('{"tool":"read_file"}')).toBeUndefined();
    expect(formatBuddyToolResult({ tool: "read_file", path: "/home/u/form.txt" }, { fileText: "Policy #123" })).toContain("Policy #123");
    expect(formatBuddyToolResult({ tool: "read_file", path: "/x" }, {})).toMatch(/couldn't read/i);
  });
  it("find_files now surfaces paths so read can target a result", () => {
    const out = formatBuddyToolResult(
      { tool: "find_files", query: "passport" },
      { files: [{ name: "passport.pdf", path: "/home/u/docs/passport.pdf" }] },
    );
    expect(out).toContain("/home/u/docs/passport.pdf");
    expect(out).toMatch(/read with source:"file"/);
  });
});

describe("open_image tool", () => {
  it("parses open_image and formats a shown-inline note (or a couldn't-open note)", () => {
    expect(parseBuddyToolCall('{"tool":"open_image","path":"/home/u/shot.png"}')).toEqual({ tool: "open_image", path: "/home/u/shot.png" });
    expect(parseBuddyToolCall('{"tool":"open_image"}')).toBeUndefined();
    const ok = formatBuddyToolResult(
      { tool: "open_image", path: "/home/u/shot.png" },
      { openedImage: { name: "shot.png", mimeType: "image/png", base64: "AAAA" } },
    );
    expect(ok).toMatch(/shown inline/i);
    expect(ok).toContain("shot.png");
    expect(ok).not.toContain("AAAA"); // the bytes never enter the model-facing turn
    expect(formatBuddyToolResult({ tool: "open_image", path: "/x" }, {})).toMatch(/couldn't open/i);
  });
});

describe("screenshot tool", () => {
  it("parses screenshot with question and/or a target window", () => {
    expect(parseBuddyToolCall('{"tool":"screenshot","question":"is the game showing?"}')).toEqual({
      tool: "screenshot",
      question: "is the game showing?",
    });
    expect(parseBuddyToolCall('{"tool":"screenshot","window":"Pygame","question":"player visible?"}')).toEqual({
      tool: "screenshot",
      question: "player visible?",
      window: "Pygame",
    });
    expect(parseBuddyToolCall('{"tool":"screenshot"}')).toEqual({ tool: "screenshot" });
  });

  it("feeds the vision observation back to the model", () => {
    const text = formatBuddyToolResult(
      { tool: "screenshot", question: "is the player visible?" },
      { observation: "A platformer with a red sprite and score 0 is shown." },
    );
    expect(text).toContain("red sprite");
    expect(text).toContain("is the player visible?");
    expect(text).toContain("propose the fix");
    expect(formatBuddyToolResult({ tool: "screenshot" }, {})).toContain("couldn't be captured");
  });
});

describe("run_command tool", () => {
  it("parses a run_command call and caps its length", () => {
    expect(parseBuddyToolCall('{"tool":"run_command","command":"npm test"}')).toEqual({
      tool: "run_command",
      command: "npm test",
    });
    const long = parseBuddyToolCall(`{"tool":"run_command","command":"${"x".repeat(2000)}"}`);
    expect(long?.tool === "run_command" && long.command.length).toBe(1000);
    expect(parseBuddyToolCall('{"tool":"run_command","command":"  "}')).toBeUndefined();
  });

  it("feeds the command's output back to the model with exit code", () => {
    const ok = formatBuddyToolResult(
      { tool: "run_command", command: "npm test" },
      { command: { stdout: "5 passing", stderr: "", code: 0 } },
    );
    expect(ok).toContain("exit code 0");
    expect(ok).toContain("5 passing");
    expect(ok).toContain("React to this");
    const fail = formatBuddyToolResult(
      { tool: "run_command", command: "node x.js" },
      { command: { stdout: "", stderr: "SyntaxError", code: 1, timedOut: false } },
    );
    expect(fail).toContain("exit code 1");
    expect(fail).toContain("SyntaxError");
  });
});

describe("write_file tool", () => {
  it("parses a write_file call (path + content) and requires both", () => {
    expect(parseBuddyToolCall('{"tool":"write_file","path":"a.py","content":"print(1)"}')).toEqual({
      tool: "write_file",
      path: "a.py",
      content: "print(1)",
    });
    // Empty content is valid (an empty file); a missing path is not.
    expect(parseBuddyToolCall('{"tool":"write_file","path":"a.py","content":""}')).toEqual({
      tool: "write_file",
      path: "a.py",
      content: "",
    });
    expect(parseBuddyToolCall('{"tool":"write_file","content":"x"}')).toBeUndefined();
  });

  it("advertises write_file whenever commands are on (so it can save-then-run), but the autonomy note only when Autonomous workspace is on", () => {
    const none = buildBuddySystemPrompt({ persona: "assistant", library: [] });
    expect(none).not.toContain('"tool":"write_file"');
    // Commands on (but not autonomous): write_file IS available — it saves into the workspace so the
    // buddy can run its own file — but the no-click autonomy note is not shown.
    const cmds = buildBuddySystemPrompt({ persona: "assistant", library: [], canRunCommands: true });
    expect(cmds).toContain('"tool":"write_file"');
    expect(cmds).not.toMatch(/AUTONOMOUS WORKSPACE is ON/);
    const auto = buildBuddySystemPrompt({ persona: "assistant", library: [], canRunCommands: true, canAutonomousWorkspace: true });
    expect(auto).toContain('"tool":"write_file"');
    expect(auto).toMatch(/AUTONOMOUS WORKSPACE is ON/);
  });

  it("feeds the saved path back so the model can run it", () => {
    const ok = formatBuddyToolResult({ tool: "write_file", path: "a.py", content: "x" }, { writeFile: { path: "/ws/a.py", ok: true } });
    expect(ok).toContain("/ws/a.py");
    expect(ok).toContain("run_command");
    const bad = formatBuddyToolResult({ tool: "write_file", path: "a.py", content: "x" }, { writeFile: { path: "a.py", ok: false, error: "denied" } });
    expect(bad).toContain("failed");
  });
});

describe("find_files tool", () => {
  it("parses a find_files call and caps the query", () => {
    expect(parseBuddyToolCall('{"tool":"find_files","query":"thermo notes"}')).toEqual({
      tool: "find_files",
      query: "thermo notes",
    });
    const long = parseBuddyToolCall(`{"tool":"find_files","query":"${"x".repeat(500)}"}`);
    expect(long?.tool === "find_files" && long.query.length).toBe(200);
    expect(parseBuddyToolCall('{"tool":"find_files","query":"  "}')).toBeUndefined();
  });

  it("formats the found-file list back to the model (and an empty result)", () => {
    const hit = formatBuddyToolResult(
      { tool: "find_files", query: "krebs" },
      { files: [{ path: "/u/krebs.pdf", name: "krebs.pdf" }, { path: "/u/notes.txt", name: "notes.txt" }] },
    );
    expect(hit).toContain("found 2 file");
    expect(hit).toContain("1. krebs.pdf");
    expect(hit).toContain("Don't invent file names");
    const miss = formatBuddyToolResult({ tool: "find_files", query: "x" }, { files: [] });
    expect(miss).toContain("found nothing");
  });
});

describe("failure feedback helpers", () => {
  it("toolFailureDirective names the tool + error and asks for a next step", () => {
    const d = toolFailureDirective("run_command", "ENOENT: no such file");
    expect(d).toContain("run_command failed: ENOENT: no such file");
    expect(d).toMatch(/next step/i);
    expect(d).toMatch(/do not silently retry/i);
  });

  it("toolLimitNudge fires only at the backstop, and is RESUMABLE (not a dead stop)", () => {
    expect(toolLimitNudge(0)).toBe("");
    expect(toolLimitNudge(MAX_BUDDY_TOOL_ROUNDS - 2)).toBe("");
    expect(toolLimitNudge(MAX_BUDDY_TOOL_ROUNDS - 1)).toMatch(/tool-call limit/i);
    expect(toolLimitNudge(MAX_BUDDY_TOOL_ROUNDS)).toMatch(/tool-call limit/i);
    // It must invite continuation + a progress summary, never just "stop".
    expect(toolLimitNudge(MAX_BUDDY_TOOL_ROUNDS - 1)).toMatch(/continue/i);
    expect(toolLimitNudge(MAX_BUDDY_TOOL_ROUNDS - 1)).toMatch(/progress/i);
  });

  it("the round cap is a generous backstop, not a real task limit", () => {
    // Real agentic work re-arms the budget per host-tool step; this only caps an unbroken auto-run
    // streak. It must be high enough never to cut a genuine task short.
    expect(MAX_BUDDY_TOOL_ROUNDS).toBeGreaterThanOrEqual(24);
  });

  it("progressNudge surfaces a progress chunk on the interval, asking for prose-before-tool", () => {
    expect(progressNudge(0, 6)).toBe(""); // never on round 0
    expect(progressNudge(1, 6)).toBe(""); // off-interval
    expect(progressNudge(6, 6)).toMatch(/progress/i);
    expect(progressNudge(12, 6)).toMatch(/progress/i);
    // It must tell the model to narrate IN THE SAME message as the next tool (prose first), so the
    // update shows without ending the turn.
    expect(progressNudge(6, 6)).toMatch(/same message/i);
    expect(progressNudge(6, 6)).toMatch(/pick the task back up|fails/i);
  });

  it("isRetryableError catches transient blips but not logic errors", () => {
    expect(isRetryableError("fetch failed")).toBe(true);
    expect(isRetryableError("Request timed out")).toBe(true);
    expect(isRetryableError("429 Too Many Requests")).toBe(true);
    expect(isRetryableError("ETIMEDOUT")).toBe(true);
    expect(isRetryableError("connection refused")).toBe(true);
    expect(isRetryableError("Schwab isn't connected")).toBe(false);
    expect(isRetryableError("invalid symbol")).toBe(false);
  });
});
