import { describe, expect, it } from "vitest";
import { buildLtx2I2VWorkflow, ComfyUIBackend } from "./comfyui-backend.js";
import { resolveVideoModelFiles } from "../video-models.js";
import type { Ltx25VideoFiles } from "../image-provider.js";
import { DirectTransport, type Transport } from "../../transport/transport.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Opt in only: schema mode never queues work; generate mode uses a short bounded
// smoke test on the existing loopback server and refuses someone else's queue.
const mode = process.env.LTX25_LIVE;
const suite = mode ? describe : describe.skip;
suite("local LTX-2.5 evaluation", () => {
  it("checks native contracts and optionally renders through the production backend", async () => {
    expect(["schema", "generate"]).toContain(mode);
    const baseUrl = process.env.LTX25_URL ?? "http://127.0.0.1:8188";
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Loopback ComfyUI only");
    const models = resolveVideoModelFiles("ltx2.5-i2v-22b", {
      ...(process.env.LTX25_DIFFUSION_MODEL ? { diffusionModel: process.env.LTX25_DIFFUSION_MODEL } : {}),
    }) as Ltx25VideoFiles;
    const transport = new DirectTransport();
    const objectInfo = await transport.send({ url: `${baseUrl}/object_info`, method: "GET" })
      .then((response) => response.json<Record<string, { input: { required?: Record<string, unknown>; optional?: Record<string, unknown> }; output: string[] }>>());
    const graph = buildLtx2I2VWorkflow({
      models, prompt: "A small wooden toy fox turns its head slowly. Gentle wind and birdsong.", negative: "watermark, text, blurry",
      startImage: "schema-only.png", width: 512, height: 320, frames: 25, fps: 24,
      steps: 8, cfg: 1, seed: 25025, highRes: process.env.LTX25_HIGH_RES === "1", audio: process.env.LTX25_AUDIO !== "0",
    }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    for (const node of Object.values(graph)) {
      const schema = objectInfo[node.class_type];
      expect(schema, `missing native ${node.class_type}`).toBeTruthy();
      for (const key of Object.keys(schema!.input.required ?? {})) expect(node.inputs, `${node.class_type}.${key}`).toHaveProperty(key);
      for (const [key, value] of Object.entries(node.inputs)) {
        expect({ ...schema!.input.required, ...schema!.input.optional }, `${node.class_type}.${key}`).toHaveProperty(key);
        if (Array.isArray(value)) {
          const upstream = graph[value[0] as string]!;
          expect(objectInfo[upstream.class_type]!.output[value[1] as number], `invalid output ${JSON.stringify(value)}`).toBeTruthy();
        }
      }
    }
    if (mode === "schema") return;
    const queue = await transport.send({ url: `${baseUrl}/queue`, method: "GET" })
      .then((response) => response.json<{ queue_running: unknown[]; queue_pending: unknown[] }>());
    if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending) || queue.queue_running.length || queue.queue_pending.length) throw new Error("ComfyUI has active work; nothing was interrupted");
    const reference = process.env.LTX25_REFERENCE;
    const paths: string[] = [];
    const traced: Transport = { send: async (request) => { paths.push(new URL(request.url).pathname); return transport.send(request); } };
    const output = await new ComfyUIBackend({ baseUrl, transport: traced, clientId: "visual-reader-ltx25-evaluation" }).generateVideo({
      prompt: "A small wooden toy fox turns its head slowly. Gentle wind and birdsong.",
      width: 512, height: 320, frames: 25, fps: 24, seed: 25025,
      highRes: process.env.LTX25_HIGH_RES === "1", audio: process.env.LTX25_AUDIO !== "0",
      ...(reference ? { image: { bytes: new Uint8Array(await readFile(reference)).buffer, mimeType: "image/png" } } : {}),
    }, models);
    expect(output.bytes.byteLength).toBeGreaterThan(0);
    expect(paths).toContain("/prompt");
    const directory = process.env.LTX25_OUT_DIR;
    if (directory) {
      await mkdir(directory, { recursive: true });
      const stem = `ltx25-${reference ? "i2v" : "t2v"}-${process.env.LTX25_HIGH_RES === "1" ? "hires" : "single"}-${Date.now()}`;
      const ext = output.mimeType === "video/mp4" ? "mp4" : "webp";
      await writeFile(join(directory, `${stem}.${ext}`), new Uint8Array(output.bytes));
      await writeFile(join(directory, `${stem}.json`), JSON.stringify({ model: models, mimeType: output.mimeType, bytes: output.bytes.byteLength, paths }, null, 2));
    }
  }, 20 * 60_000);
});
