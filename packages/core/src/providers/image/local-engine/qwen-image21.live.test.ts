import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogEntryForModel } from "../../catalog.js";
import { DirectTransport } from "../../transport/transport.js";
import type { Transport, TransportRequest } from "../../transport/transport.js";
import { ComfyUIBackend } from "./comfyui-backend.js";
import { ManagedEngineImageProvider } from "./managed-engine-provider.js";

/** Explicit opt-in only. Ordinary unit-test runs neither contact ComfyUI nor use the GPU.
 * RUN_QWEN21_LIVE=connect validates installed files + native node (GET requests only).
 * RUN_QWEN21_LIVE=generate runs one real 25-step render through the APP provider/backend.
 * QWEN21_URL defaults to http://127.0.0.1:8188. QWEN21_SIZE defaults to 1024 (or 512).
 * QWEN21_OUTPUT_DIR optionally saves PNG + receipt into a new timestamped subdirectory.
 * This does not restart engines, alter browser settings, or free/interrupt anyone's jobs. */
const mode = process.env.RUN_QWEN21_LIVE;
const model = "qwen_image_2.1_int8_convrot.safetensors";

describe.skipIf(!mode)("Qwen Image 2.1 opt-in live app-provider evaluation", () => {
  it("validates the real engine and optionally renders through ManagedEngineImageProvider", async () => {
    expect(["connect", "generate"]).toContain(mode);
    const baseUrl = (process.env.QWEN21_URL ?? "http://127.0.0.1:8188").replace(/\/$/, "");
    const endpoint = new URL(baseUrl);
    if (endpoint.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) {
      throw new Error("This local evaluation harness only accepts an http:// loopback ComfyUI endpoint.");
    }
    const size = Number(process.env.QWEN21_SIZE ?? "1024");
    if (size !== 512 && size !== 1024) throw new Error("QWEN21_SIZE must be 512 or 1024 for the bounded smoke test.");
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const direct = new DirectTransport();
    const requests: { method: string; path: string }[] = [];
    let submittedWorkflow: unknown;
    const transport: Transport = {
      send: async (request: TransportRequest) => {
        const path = new URL(request.url).pathname;
        requests.push({ method: request.method ?? "POST", path });
        if (path === "/prompt") submittedWorkflow = request.body;
        return direct.send(request);
      },
    };
    const backend = new ComfyUIBackend({ baseUrl, transport, clientId: "visual-reader-qwen21-evaluation" });
    const [models, components, native, stats] = await Promise.all([
      backend.listModels(),
      backend.listComponents(),
      transport.send({ url: `${baseUrl}/object_info/TextEncodeQwenImage21`, method: "GET" }).then((r) => r.json<Record<string, unknown>>()),
      transport.send({ url: `${baseUrl}/system_stats`, method: "GET" }).then((r) => r.json()),
    ]);
    expect(models.some((m) => m.id === model)).toBe(true);
    expect(components.textEncoders).toContain("qwen3vl_8b_int8_convrot.safetensors");
    expect(components.vaes).toContain("qwen_image_2.1_vae_bf16.safetensors");
    expect(native.TextEncodeQwenImage21).toBeTruthy();
    const receipt: Record<string, unknown> = {
      mode, startedAt, endpoint: baseUrl, model, licenseScope: "research/evaluation only",
      nativeNodePresent: true, modelPresent: true, components, systemStats: stats,
      catalog: catalogEntryForModel(model),
      generationAttempted: mode === "generate", generationCompleted: false,
    };
    let png: Uint8Array | undefined;
    if (mode === "generate") {
      // Never queue a smoke test behind another person's active work or replace it.
      const queue = await transport.send({ url: `${baseUrl}/queue`, method: "GET" })
        .then((r) => r.json<{ queue_running?: unknown[]; queue_pending?: unknown[] }>());
      if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending) || queue.queue_running.length || queue.queue_pending.length) {
        throw new Error("ComfyUI has queued/running work (or its queue could not be verified). Wait before running this evaluation; nothing was interrupted.");
      }
      const provider = new ManagedEngineImageProvider(backend, model);
      const output = await provider.generate({
        prompt: "A small red fox sitting beside a blue ceramic teapot on a wooden table, soft window light, detailed storybook illustration. No text.",
        anchors: [], quality: "standard", renderQuality: "standard",
        width: size, height: size, seed: 21092026,
        stepsOverride: 25, cfgOverride: 1, lowVram: true,
      });
      expect(output.mimeType).toBe("image/png");
      png = new Uint8Array(output.bytes);
      expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const header = new DataView(output.bytes);
      expect(header.getUint32(16)).toBe(size);
      expect(header.getUint32(20)).toBe(size);
      Object.assign(receipt, {
        generationCompleted: true, provider: provider.id, mimeType: output.mimeType,
        width: size, height: size, bytes: png.byteLength,
        sha256: createHash("sha256").update(png).digest("hex"),
        actualPromptRecord: output.prompt, submittedWorkflow,
      });
    }
    Object.assign(receipt, { completedAt: new Date().toISOString(), durationMs: Date.now() - startedMs, requests });
    if (process.env.QWEN21_OUTPUT_DIR) {
      const outDir = join(resolve(process.env.QWEN21_OUTPUT_DIR), `qwen21-${startedAt.replace(/[:.]/g, "-")}`);
      await mkdir(outDir, { recursive: true });
      if (png) await writeFile(join(outDir, "image.png"), png, { flag: "wx" });
      await writeFile(join(outDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
      console.info(`Qwen Image 2.1 ${mode} evidence: ${outDir}`);
    }
    console.info(`Qwen Image 2.1 ${mode}: verified${png ? `; ${size}x${size} PNG via the real app provider` : "; no GPU generation requested"}.`);
  }, 30 * 60 * 1000);
});
