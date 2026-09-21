import { expect, it } from "vitest";
import { PORTRAIT_SCENE_REPAIR_SYSTEM, parsePortraitSceneReply } from "./portrait-scene.js";

// Opt-in smoke test against an already installed local model, using synthetic identities only.
it.skipIf(!process.env.PORTRAIT_TEST_MODEL)("extracts staging with the local model without carrying mixed identity", async () => {
  const response = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.PORTRAIT_TEST_MODEL, stream: false, think: false, keep_alive: 0,
      options: { num_ctx: 4096, num_predict: 400, temperature: 0 },
      messages: [
        { role: "system", content: PORTRAIT_SCENE_REPAIR_SYSTEM },
        { role: "user", content: JSON.stringify({
          request: "Draw yourself sitting in a cafe in a red coat",
          imagePrompt: "Aria with Nick's dark hair, brown eyes and beard sitting in a cafe wearing a red coat",
          pair: false,
        }) },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  expect(response.ok).toBe(true);
  const result = await response.json() as { message: { content: string } };
  const scene = parsePortraitSceneReply(result.message.content);
  expect(scene).toBeDefined();
  const text = JSON.stringify(scene);
  expect(text).toMatch(/caf[eé]/i);
  expect(text).toMatch(/red coat/i);
  expect(text).not.toMatch(/Aria|Nick|hair|eyes|beard/i);
}, 70_000);
