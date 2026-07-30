import { describe, expect, it } from "vitest";
import {
  chunkDocument,
  chunkExtractionPrompt,
  emptyExtraction,
  extractFromDocument,
  formatExtraction,
  mergeFindings,
  noteChunkFailure,
  parseChunkFindings,
  type DocumentFinding,
} from "./document-extraction.js";

/** A document of `n` numbered lines, so a chunk's anchors can be checked against its content. */
function doc(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1} of the document`).join("\n");
}

describe("chunkDocument", () => {
  it("splits on line boundaries and anchors each chunk to its real line range", () => {
    // Anchors have to survive a round trip through read_file, so a chunk never starts mid-line.
    const chunks = chunkDocument(doc(100), 400);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.fromLine).toBe(1);
    expect(chunks[0]!.text.startsWith("line 1 of")).toBe(true);
    for (const c of chunks) {
      expect(c.text.split("\n")).toHaveLength(c.toLine - c.fromLine + 1);
      expect(c.text.split("\n")[0]).toBe(`line ${c.fromLine} of the document`);
    }
    expect(chunks[chunks.length - 1]!.toLine).toBe(100);
  });

  it("overlaps consecutive chunks, so a finding across a boundary is whole somewhere", () => {
    const chunks = chunkDocument(doc(100), 400);
    expect(chunks[1]!.fromLine).toBeLessThanOrEqual(chunks[0]!.toLine);
  });

  it("covers every line — no gap between one chunk and the next", () => {
    const chunks = chunkDocument(doc(250), 300);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.fromLine).toBeLessThanOrEqual(chunks[i - 1]!.toLine + 1);
    }
  });

  it("keeps a single over-long line whole rather than cutting it to a position that doesn't exist", () => {
    const chunks = chunkDocument(`short\n${"x".repeat(5_000)}\nshort`, 500);
    expect(chunks.some((c) => c.text.includes("x".repeat(5_000)))).toBe(true);
  });

  it("terminates on an empty document and a nonsense budget", () => {
    expect(chunkDocument("", 100)).toHaveLength(1);
    expect(chunkDocument(doc(10), 0)).toEqual([]);
  });
});

describe("mergeFindings", () => {
  const f = (text: string, line: number): DocumentFinding => ({ text, line });

  it("keeps the earliest sighting and drops the overlap's duplicate", () => {
    // The chunk overlap means the same thing is genuinely seen twice; the first has the anchor a
    // reader wants.
    let state = mergeFindings(emptyExtraction(), 0, [f("Deadline: 3 March", 12)]);
    state = mergeFindings(state, 1, [f("  deadline:   3 MARCH ", 96), f("Deadline: 4 April", 130)]);
    expect(state.findings).toEqual([
      { text: "Deadline: 3 March", line: 12 },
      { text: "Deadline: 4 April", line: 130 },
    ]);
  });

  it("records the chunk as done, once", () => {
    let state = mergeFindings(emptyExtraction(), 2, []);
    state = mergeFindings(state, 2, []);
    expect(state.done).toEqual([2]);
  });

  it("caps the findings so a runaway can't produce a result too big to return", () => {
    const many = Array.from({ length: 500 }, (_, i) => f(`finding ${i}`, i + 1));
    expect(mergeFindings(emptyExtraction(), 0, many).findings).toHaveLength(200);
  });
});

describe("parseChunkFindings", () => {
  it("reads a plain reply, a fenced one, and ignores junk entries", () => {
    expect(parseChunkFindings('{"findings":[{"text":"a","line":3}]}')).toEqual([{ text: "a", line: 3 }]);
    expect(parseChunkFindings('```json\n{"findings":[{"text":"b","line":9,"note":"n"}]}\n```')).toEqual([
      { text: "b", line: 9, note: "n" },
    ]);
    expect(parseChunkFindings('{"findings":[{"text":"  "},null,{"line":4}]}')).toEqual([]);
  });

  it("salvages a reply cut off at the token ceiling", () => {
    // Same failure the chapter analysis hit — and the same answer: keep what arrived.
    const cut = '{"findings":[{"text":"first","line":1},{"text":"second","line":2},{"text":"thi';
    expect(parseChunkFindings(cut)).toEqual([
      { text: "first", line: 1 },
      { text: "second", line: 2 },
    ]);
  });

  it("treats an unusable reply as no findings rather than throwing", () => {
    expect(parseChunkFindings("I couldn't find anything, sorry!")).toEqual([]);
    expect(parseChunkFindings("")).toEqual([]);
  });
});

describe("chunkExtractionPrompt", () => {
  const chunk = chunkDocument(doc(20), 10_000)[0]!;

  it("numbers the lines absolutely, so a reported line means something", () => {
    const prompt = chunkExtractionPrompt("find dates", { ...chunk, fromLine: 501, toLine: 520 }, []);
    expect(prompt).toContain("501| line 1 of the document");
  });

  it("carries what is already known, bounded", () => {
    // Without this every chunk re-reports the same recurring item; unbounded, this block becomes the
    // thing that overflows the window instead of the document.
    const known = Array.from({ length: 100 }, (_, i) => ({ text: `known ${i}`.repeat(50), line: i + 1 }));
    const prompt = chunkExtractionPrompt("find dates", chunk, known);
    expect(prompt).toContain("do NOT repeat these");
    expect(prompt).toContain("known 99");
    expect(prompt).not.toContain("known 0\n");
    expect(prompt.length).toBeLessThan(10_000);
  });

  it("says an empty answer is a real answer", () => {
    expect(chunkExtractionPrompt("find dates", chunk, [])).toContain("empty answer is a real");
  });
});

describe("extractFromDocument (the loop)", () => {
  /** A model that answers per chunk from a script, recording what it was asked. */
  function scripted(replies: string[]) {
    const prompts: string[] = [];
    let n = 0;
    return {
      prompts,
      async chat(messages: { content: string }[]) {
        prompts.push(messages[messages.length - 1]!.content);
        return replies[Math.min(n++, replies.length - 1)]!;
      },
    };
  }

  it("walks every chunk and accumulates across them", async () => {
    const model = scripted([
      '{"findings":[{"text":"alpha","line":2}]}',
      '{"findings":[{"text":"beta","line":40}]}',
      '{"findings":[{"text":"gamma","line":80}]}',
    ]);
    const state = await extractFromDocument({ text: doc(90), question: "find the greek", model, chunkChars: 400 });
    expect(state.findings.map((f) => f.text)).toEqual(["alpha", "beta", "gamma"]);
    expect(state.notes).toEqual([]);
    // Cost is flat in document size: one bounded call per chunk, never the whole document at once.
    for (const p of model.prompts) expect(p.length).toBeLessThan(2_000);
  });

  it("reports progress as it goes", async () => {
    const seen: [number, number][] = [];
    await extractFromDocument({
      text: doc(90),
      question: "q",
      model: scripted(['{"findings":[]}']),
      chunkChars: 400,
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen[0]![0]).toBe(0);
    expect(seen[seen.length - 1]![0]).toBe(seen[seen.length - 1]![1]);
  });

  it("retries a failed chunk once, then records WHICH lines are missing and carries on", async () => {
    // One bad chunk is one bad chunk — not a dead run, and not a silent hole either.
    let calls = 0;
    const model = {
      async chat() {
        calls++;
        if (calls <= 2) throw new Error("server busy");
        return '{"findings":[{"text":"later","line":50}]}';
      },
    };
    const state = await extractFromDocument({ text: doc(90), question: "q", model, chunkChars: 400 });
    expect(calls).toBeGreaterThan(2);
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0]).toMatch(/lines 1–\d+ could not be read: server busy/);
    expect(state.findings.map((f) => f.text)).toEqual(["later"]);
  });

  it("resumes from where a stopped run got to instead of starting over", async () => {
    const first = scripted(['{"findings":[{"text":"one","line":1}]}']);
    const ac = new AbortController();
    const chunks = chunkDocument(doc(300), 400).length;
    // Stop immediately: nothing done, nothing lost.
    ac.abort();
    const stopped = await extractFromDocument({
      text: doc(300),
      question: "q",
      model: first,
      chunkChars: 400,
      signal: ac.signal,
    });
    expect(stopped.done).toEqual([]);
    expect(first.prompts).toEqual([]);

    // A resumed run skips what a previous one finished.
    const second = scripted(['{"findings":[{"text":"rest","line":99}]}']);
    const resumed = await extractFromDocument({
      text: doc(300),
      question: "q",
      model: second,
      chunkChars: 400,
      state: { findings: [{ text: "one", line: 1 }], done: [0, 1], notes: [] },
    });
    expect(second.prompts).toHaveLength(chunks - 2);
    expect(resumed.findings[0]).toEqual({ text: "one", line: 1 });
  });

  it("an abort partway keeps what it already found", async () => {
    const ac = new AbortController();
    let n = 0;
    const model = {
      async chat() {
        if (++n === 2) ac.abort();
        return '{"findings":[{"text":`x${n}`,"line":1}]}'.replace("`x${n}`", `"x${n}"`);
      },
    };
    const state = await extractFromDocument({
      text: doc(300),
      question: "q",
      model,
      chunkChars: 400,
      signal: ac.signal,
    });
    expect(state.findings.length).toBeGreaterThan(0);
    expect(state.notes).toEqual([]); // stopped, not failed
    expect(state.done.length).toBeLessThan(chunkDocument(doc(300), 400).length);
  });
});

describe("formatExtraction", () => {
  it("lists findings with the anchors needed to go and look", () => {
    const state = mergeFindings(emptyExtraction(), 0, [{ text: "Deadline: 3 March", line: 12, note: "clause 4" }]);
    const out = formatExtraction("every deadline", state, 3);
    expect(out).toContain("line 12: Deadline: 3 March (clause 4)");
    expect(out).toContain('"from":<line>');
  });

  it("SAYS a partial answer is partial", () => {
    // 9 of 10 sections read reads exactly like a document with 9 sections, and the difference
    // matters when someone acts on it.
    const chunk = chunkDocument(doc(50), 400)[0]!;
    const state = noteChunkFailure(mergeFindings(emptyExtraction(), 0, []), chunk, "out of memory");
    const out = formatExtraction("q", state, 2);
    expect(out).toContain("INCOMPLETE");
    expect(out).toContain("out of memory");
  });

  it("says plainly when nothing matched", () => {
    expect(formatExtraction("q", emptyExtraction(), 2)).toContain("Nothing in the document matched");
  });
});
