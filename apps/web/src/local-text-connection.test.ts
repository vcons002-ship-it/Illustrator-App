import { describe, expect, it, vi } from "vitest";
import { canStartLocalOllama, connectLocalText } from "./local-text-connection.js";

describe("local text connection", () => {
  it("discovers models through the supplied desktop bridge", async () => {
    const bridge = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "qwen" }] })));
    expect(await connectLocalText("ollama", "http://localhost:11434/v1", { desktopFetch: bridge })).toEqual([{ id: "qwen", label: "qwen" }]);
    expect(bridge).toHaveBeenCalledOnce();
  });

  it("starts a stopped installed loopback Ollama once, then retries discovery", async () => {
    const bridge = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "qwen" }] })));
    const ensureOllama = vi.fn(async () => {});
    await connectLocalText("ollama", "http://127.0.0.1:11434/v1", { desktopFetch: bridge, ensureOllama });
    expect(ensureOllama).toHaveBeenCalledOnce();
    expect(bridge).toHaveBeenCalledTimes(2);
  });

  it("does not start Ollama for a remote endpoint, another server, or the browser", async () => {
    for (const [server, url] of [["ollama", "https://example.com/v1"], ["ollama", "http://localhost:1234/v1"], ["lmstudio", "http://localhost:11434/v1"]] as const) {
      const ensureOllama = vi.fn(async () => {});
      await expect(connectLocalText(server, url, { desktopFetch: vi.fn().mockRejectedValue(new Error("offline")), ensureOllama })).rejects.toThrow("offline");
      expect(ensureOllama).not.toHaveBeenCalled();
    }
    expect(canStartLocalOllama("ollama", "http://localhost.evil.example:11434/v1")).toBe(false);
    expect(canStartLocalOllama("ollama", "http://u:p@localhost:11434/v1")).toBe(false);
    expect(canStartLocalOllama("ollama", "http://[::1]:11434/v1")).toBe(true);
  });
});
