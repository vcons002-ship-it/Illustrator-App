import { describe, expect, it } from "vitest";
import { decodeEntities } from "./page-text.js";

describe("decodeEntities", () => {
  it("decodes common + numeric entities and survives out-of-range code points", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot;")).toBe('a & b <c> "d"');
    expect(decodeEntities("caf&#233; &#x2014; ok")).toBe("café — ok");
    // > 0x10FFFF would throw String.fromCodePoint — must not crash the parse
    // (each bad entity drops to "", leaving the surrounding spaces).
    expect(decodeEntities("x &#1114112; &#x110000; y")).toBe("x   y");
  });
});
import type { Transport, TransportRequest } from "./transport/transport.js";
import { fetchPageText } from "./page-text.js";

function fakeTransport(body: string | unknown, ok = true, status = 200): Transport & { requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  return {
    requests,
    async send(request) {
      requests.push(request);
      return {
        ok,
        status,
        json: async <T>() => body as T,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      };
    },
  };
}

describe("fetchPageText", () => {
  it("routes Wikipedia article URLs through the plaintext extracts API", async () => {
    const transport = fakeTransport({
      query: { pages: { "123": { title: "Citric acid cycle", extract: "The cycle is…" } } },
    });
    const page = await fetchPageText("https://en.wikipedia.org/wiki/Citric_acid_cycle", { transport });
    expect(page).toEqual({ title: "Citric acid cycle", text: "The cycle is…" });
    const api = transport.requests[0]!.url;
    expect(api).toContain("en.wikipedia.org/w/api.php");
    expect(api).toContain("explaintext=1");
    expect(api).toContain("origin=*");
    expect(api).toContain(encodeURIComponent("Citric acid cycle"));
  });

  it("returns plain-text responses as-is", async () => {
    const transport = fakeTransport("CHAPTER I.\n\nIt was a dark and stormy night.");
    const page = await fetchPageText("https://g.test/84.txt", { transport });
    expect(page.text).toContain("dark and stormy");
    expect(page.title).toBeUndefined();
  });

  it("strips HTML pages down to readable text with the page title", async () => {
    const html = `<!doctype html><html><head><title>The &amp; Article</title>
      <style>p { color: red }</style></head>
      <body><nav>Menu Junk</nav><script>track();</script>
      <h1>The Article</h1><p>First paragraph.</p><p>Second &quot;quoted&quot; one.</p></body></html>`;
    const page = await fetchPageText("https://example.test/article", { transport: fakeTransport(html) });
    expect(page.title).toBe("The & Article");
    expect(page.text).toContain("First paragraph.");
    expect(page.text).toContain('Second "quoted" one.');
    expect(page.text).not.toContain("track()");
    expect(page.text).not.toContain("Menu Junk");
    expect(page.text).not.toContain("color: red");
    // Block boundaries became line breaks.
    expect(page.text.indexOf("First paragraph.")).toBeGreaterThan(page.text.indexOf("The Article"));
  });

  it("caps the returned text length", async () => {
    const transport = fakeTransport("x".repeat(5000));
    const page = await fetchPageText("https://g.test/big.txt", { transport, maxChars: 1000 });
    expect(page.text).toHaveLength(1000);
  });

  it("surfaces HTTP failures and empty articles", async () => {
    await expect(
      fetchPageText("https://blocked.test/a", { transport: fakeTransport("", false, 403) }),
    ).rejects.toThrow("status 403");
    await expect(
      fetchPageText("https://en.wikipedia.org/wiki/Nope", {
        transport: fakeTransport({ query: { pages: { "-1": {} } } }),
      }),
    ).rejects.toThrow("no readable article");
  });
});
