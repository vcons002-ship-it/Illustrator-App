# Qwen Image 2.1 local evaluation

Qwen Image 2.1 is **research/evaluation-only** under the
[Qwen Research License](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE).
Commercial use requires a separate license. This integration is opt-in; it does
not change the selected model or replace the original Qwen-Image preset.

## Engine and files

Use your existing ComfyUI installation. Native 2.1 support requires a recent
engine with `TextEncodeQwenImage21`; stable 0.36.0 predates it. The setup verified
here uses ComfyUI commit `c194dd00cd42aa18d9dbf27d977bf6b85d9ea565` (0.37.0)
and its pinned requirements. Back up the engine's Python environment, config,
and **user database** before upgrading: upstream database migrations can rebuild
the asset catalog and discard its manual metadata. Keep custom nodes/workflows.

Download the official Comfy-Org files with size and SHA-256 verification:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/download-qwen-image21.ps1 -ModelRoot D:\ComfyUI-models -AcceptResearchLicense
```

The flag acknowledges the license scope above. Downloads are resumable, use a
pinned upstream revision, and retain incomplete files as `.partial` until verified.
An existing file is verified rather than overwritten. Total download: 17,283,091,112 bytes.

| Folder | File |
| --- | --- |
| diffusion_models | qwen_image_2.1_int8_convrot.safetensors |
| text_encoders | qwen3vl_8b_int8_convrot.safetensors |
| vae | qwen_image_2.1_vae_bf16.safetensors |

If models live outside ComfyUI, append a distinct entry to `extra_model_paths.yaml`
(preserve existing entries), then start/restart only when the engine is idle:

```yaml
qwen_image21_evaluation:
  base_path: D:/ComfyUI-models
  diffusion_models: diffusion_models
  text_encoders: text_encoders
  vae: vae
```

No custom nodes, hosted inference service, or paid API key are required. Keep
ComfyUI bound to loopback. For a browser client, enable the existing local CORS
configuration; do not expose the engine to the public network.

## Test in Illustrator

Run `qwen-image21-test.bat` from the evaluation checkout, or:

```powershell
pnpm.cmd --filter @visual-reader/web dev --host 127.0.0.1 --port 5181 --strictPort
```

Open `http://127.0.0.1:5181`. This serves the actual Illustrator app and its shared
image provider, not a separate image-generation demo. The alternate browser
origin isolates its settings/library from the normal app origin.

1. Settings: select **Local** images and **ComfyUI** as the local engine.
2. Set the server to `http://127.0.0.1:8188`, then **Connect**.
3. Select `qwen_image_2.1_int8_convrot.safetensors`. Leave model family and
   text-encoder/VAE selection on Auto (clear component overrides from other models).
4. Turn off two-pass High resolution, character regions and style LoRAs; clear
   sampler overrides. The standard recipe is 25 steps, CFG 1, Euler/simple.
5. Use the app's **Test image** action. Start with a simple prompt and 1024 square,
   or 512 square for a bounded first smoke test. Ensure other GPU jobs are idle.

Example: `A small red fox sitting beside a blue ceramic teapot on a wooden table,
soft window light, detailed storybook illustration. No text.`

The same configured provider is used by normal chat and reader illustration
requests. This first integration supports **text-to-image only**. The model's
native image editing, transparency controls, two-pass hires, regional conditioning,
and style LoRAs are not exposed here. Unsupported edit modes fail explicitly;
reference-image skipping uses the app's existing diagnostic rather than claiming
identity-reference support.

## Repeatable live verification

Ordinary tests do not contact ComfyUI. Opt in to GET-only connection verification:

```powershell
$env:RUN_QWEN21_LIVE = 'connect'
$env:QWEN21_URL = 'http://127.0.0.1:8188'
$env:QWEN21_OUTPUT_DIR = 'D:\QwenImage21-eval\evidence'
pnpm.cmd exec vitest run packages/core/src/providers/image/local-engine/qwen-image21.live.test.ts
```

For one actual 25-step image through `ManagedEngineImageProvider` ->
`ComfyUIBackend` -> `/prompt`, `/history`, `/view`, change the mode to `generate`
and optionally set `$env:QWEN21_SIZE = '512'`. The harness refuses an occupied or
unverifiable ComfyUI queue. It never interrupts other work, unloads other services,
or changes app settings. A timestamped output folder records the PNG, its hash,
dimensions, submitted workflow, API request paths, and engine information.

Passing `connect` does **not** prove that image inference succeeds. Verify an
actual generation and inspect the output before treating a hardware configuration
as validated. Clear `RUN_QWEN21_LIVE` after testing.

Sources: [official model package](https://huggingface.co/Comfy-Org/Qwen-Image-2.1),
[official text-to-image workflow](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_2_1_t2i.json).
