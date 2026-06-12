import { describe, expect, it } from "vitest";
import type { Transport, TransportRequest } from "./transport/transport.js";
import { GutenbergSearch } from "./book-search.js";

function fakeTransport(payload: unknown, ok = true, status = 200): Transport & { requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  return {
    requests,
    async send(request) {
      requests.push(request);
      return {
        ok,
        status,
        json: async <T>() => payload as T,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => JSON.stringify(payload),
      };
    },
  };
}

const gutendex = {
  results: [
    {
      id: 84,
      title: "Frankenstein; Or, The Modern Prometheus",
      authors: [{ name: "Shelley, Mary Wollstonecraft" }],
      formats: {
        "application/epub+zip": "https://www.gutenberg.org/ebooks/84.epub",
        "text/plain; charset=us-ascii": "https://www.gutenberg.org/files/84/84-0.txt",
        "text/html": "https://www.gutenberg.org/ebooks/84.html.images",
      },
    },
    {
      id: 85,
      // No usable text format → skipped.
      title: "Zip Only",
      authors: [],
      formats: { "text/plain; charset=us-ascii": "https://www.gutenberg.org/files/85.zip" },
    },
    {
      id: 86,
      title: "HTML Fallback",
      authors: [{ name: "Stoker, Bram" }],
      formats: { "text/html; charset=utf-8": "https://www.gutenberg.org/files/86/86-h.htm" },
    },
  ],
};

describe("GutenbergSearch", () => {
  it("maps hits, flips catalog names, and prefers plain text over HTML", async () => {
    const transport = fakeTransport(gutendex);
    const hits = await new GutenbergSearch({ transport }).search("frankenstein");
    expect(transport.requests[0]!.url).toContain("gutendex.com/books?search=frankenstein");
    expect(hits).toEqual([
      {
        title: "Frankenstein; Or, The Modern Prometheus",
        author: "Mary Wollstonecraft Shelley",
        textUrl: "https://www.gutenberg.org/files/84/84-0.txt",
        pageUrl: "https://www.gutenberg.org/ebooks/84",
      },
      {
        title: "HTML Fallback",
        author: "Bram Stoker",
        textUrl: "https://www.gutenberg.org/files/86/86-h.htm",
        pageUrl: "https://www.gutenberg.org/ebooks/86",
      },
    ]);
  });

  it("random() pulls a deterministic page of the popularity shelf and shuffles it", async () => {
    const shelf = {
      results: Array.from({ length: 8 }, (_, i) => ({
        id: i,
        title: `Classic ${i}`,
        authors: [],
        formats: { "text/plain": `https://g.test/${i}.txt` },
      })),
    };
    const transport = fakeTransport(shelf);
    // rng=0.5 → page 16; subsequent calls drive the shuffle deterministically.
    const hits = await new GutenbergSearch({ transport }).random(3, () => 0.5);
    expect(transport.requests[0]!.url).toContain("?page=16");
    expect(hits).toHaveLength(3);
    for (const h of hits) expect(h.title).toMatch(/^Classic \d$/);
  });

  it("respects the count cap and surfaces HTTP failures", async () => {
    const many = {
      results: Array.from({ length: 10 }, (_, i) => ({
        id: i,
        title: `Book ${i}`,
        authors: [],
        formats: { "text/plain": `https://g.test/${i}.txt` },
      })),
    };
    const hits = await new GutenbergSearch({ transport: fakeTransport(many) }).search("x", 3);
    expect(hits).toHaveLength(3);
    await expect(
      new GutenbergSearch({ transport: fakeTransport({}, false, 503) }).search("x"),
    ).rejects.toThrow("status 503");
  });
});
