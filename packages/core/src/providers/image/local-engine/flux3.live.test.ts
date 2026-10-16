/** Opt-in GPU smoke tests. Never run against a busy/shared engine. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ComfyUIBackend } from "./comfyui-backend.js";
import { DirectTransport } from "../../transport/transport.js";

const enabled = process.env.VR_FLUX3_LIVE === "1";
const output = process.env.VR_FLUX3_OUTPUT;
const model = "flux3_image_klein_sd_int8_convrot.safetensors";

describe.skipIf(!enabled)("FLUX 3 real local engine (opt-in)", () => {
  it("generates, instruction-edits, and composes two reference images through the app backend", async () => {
    if (!output) throw new Error("Set VR_FLUX3_OUTPUT to a scratch output directory.");
    await mkdir(output, { recursive: true });
    const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: new DirectTransport() });
    const common = { anchors: [], quality: "standard" as const, width: 768, height: 768, seed: 634, lowVram: true };
    const first = await backend.generate({ ...common,
      prompt: "Product photograph of a single small red ceramic teapot with a round body, curved spout and loop handle on a plain pale gray tabletop. Soft studio lighting. No people or text.",
    }, model);
    expect(first.bytes.byteLength).toBeGreaterThan(10_000);
    await writeFile(join(output, "01-teapot.png"), Buffer.from(first.bytes));
    console.log("FLUX3_LIVE text-to-image", first.bytes.byteLength, first.prompt);
    const edited = await backend.generate({ ...common,
      prompt: "Change only the ceramic teapot from red to cobalt blue. Keep the same teapot shape, handle, spout, tabletop, viewpoint and lighting. No people or text.",
      initImage: { bytes: first.bytes, mimeType: "image/png" },
    }, model);
    expect(edited.bytes.byteLength).toBeGreaterThan(10_000);
    await writeFile(join(output, "02-blue-edit.png"), Buffer.from(edited.bytes));
    console.log("FLUX3_LIVE instruction-edit", edited.bytes.byteLength, edited.prompt);
    const pair = await backend.generate({ ...common,
      prompt: "Product photograph showing both reference teapots side by side on the same pale gray tabletop: the red teapot from image 1 on the left, the cobalt blue teapot from image 2 on the right. Preserve their shapes and colors. Exactly two teapots. Soft studio lighting. No people or text.",
      ipAdapterRefs: [first, edited].map(image => ({ bytes: image.bytes, mimeType: image.mimeType, weight: 1 })),
    }, model);
    expect(pair.references?.used).toBe(2);
    await writeFile(join(output, "03-two-references.png"), Buffer.from(pair.bytes));
    await writeFile(join(output, "results.json"), JSON.stringify({
      model, generated: first.prompt, edited: edited.prompt, composed: pair.prompt, references: pair.references,
    }, null, 2));
    console.log("FLUX3_LIVE two references", pair.bytes.byteLength, pair.references);
  }, 1_800_000);
});

describe.skipIf(process.env.VR_IMAGE_REGRESSION !== "1")("existing image engines after ComfyUI upgrade (opt-in)", () => {
  for (const checkpoint of ["flux-2-klein-4b-fp8.safetensors", "qwen_image_2.1_int8_convrot.safetensors"]) {
    it(`still renders a reference image with ${checkpoint}`, async () => {
      if (!output) throw new Error("Set VR_FLUX3_OUTPUT to the smoke-test output directory.");
      const source = await readFile(join(output, "01-teapot.png"));
      const backend = new ComfyUIBackend({ baseUrl: "http://127.0.0.1:8188", transport: new DirectTransport() });
      const result = await backend.generate({
        prompt: "A product photograph of the same red ceramic teapot from the reference on a light gray tabletop. No text or people.",
        anchors: [], quality: "standard", width: 512, height: 512, seed: 634, lowVram: true,
        ...(checkpoint.startsWith("flux-2") ? { stepsOverride: 4 } : {}),
        ipAdapterRefs: [{ bytes: source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer, mimeType: "image/png", weight: 1 }],
      }, checkpoint);
      expect(result.bytes.byteLength).toBeGreaterThan(10_000);
      expect(result.references?.used).toBe(1);
      await writeFile(join(output, `${checkpoint}.png`), Buffer.from(result.bytes));
      console.log("IMAGE_REGRESSION", checkpoint, result.bytes.byteLength, result.references);
    }, 1_800_000);
  }
});
