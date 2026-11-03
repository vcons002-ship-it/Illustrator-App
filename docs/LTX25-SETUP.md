# Local LTX-2.5 video

LTX-2.5 replaces the app's LTX-2.3 catalog entry. Saved `ltx2.3-i2v-22b`
selections migrate to `ltx2.5-i2v-22b`, including old model IDs in tool requests.
This changes video selection only: chats, Souls, projects, provider keys, image
models, and video duration/size/audio preferences are not reset.

## Install the official split weights

Request access and accept the license at
<https://huggingface.co/Lightricks/LTX-2.5>. The repository is gated; an
authenticated browser and the command-line Hugging Face client have separate
login sessions. The app does not bypass gating or substitute third-party mirrors.
If automatic downloading fails, use the signed-in browser or an authenticated
Hugging Face CLI and place these files in the selected ComfyUI's model folders:

| Folder under `ComfyUI/models` | Filename |
| --- | --- |
| `diffusion_models` | `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors` |
| `text_encoders` | `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors` |
| `vae` | `ltx-2.5-video-vae-bf16.safetensors` |
| `vae` | `ltx-2.5-audio-vae-bf16.safetensors` |
| `latent_upscale_models` | `ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors` |

The complete default set is approximately 40 GB on disk. Leave additional room
for downloads, temporary files, and generated video. Do not delete the old set
until replacements are available and tested, unless the reader explicitly
approves clearing it earlier for space. Never delete shared models automatically.

An official NVFP4 distilled transformer can be selected through the **Diffusion
model** override on compatible Blackwell hardware. That file is an alternative to,
not an additional requirement alongside, the default INT8 transformer. The other
four components are still required (the upscaler only for high-resolution renders).

The old combined LTX-2.3 checkpoint, Gemma-3 text encoder, distilled speed LoRA,
and 2.3 spatial upscaler are not the corresponding 2.5 components. Migration
discards obsolete fixed overrides rather than wiring those files into the new
graph. Extra custom LoRAs remain available; validate their compatibility yourself.

## Workflow and controls

- Text-to-video starts from an empty video latent; image-to-video conditions
  each stage on the uploaded source frame.
- The distilled transformer uses the official eight-step sigma schedule, CFG 1
  for video and audio, and `euler_ancestral`. The UI does not pretend legacy Steps
  or CFG overrides control this fixed distilled recipe.
- High resolution generates at half size, upsamples spatially by 2x, then refines
  with the official three-step schedule. Turning it off skips that second stage.
- Audio/video are sampled jointly. With audio enabled, the result is an MP4 with
  synchronized audio. With audio disabled, audio decoding/muxing is omitted and
  the app saves its usual silent animated WEBP; the joint latent is still sampled.
- Dimensions are aligned to the model's 32-pixel grid; a two-stage render uses a
  half-resolution grid. Use `8*n+1` frames (for example 121 at 24 FPS).
- First/last-frame conditioning remains the existing Wan-only app feature. This
  integration is the native LTX-2.5 T2V/I2V recipe, not its separate FLF2V or DFR
  workflow. The optional prompt enhancer, duration head, temporal upscaler and
  DFR detailing adapter are not downloaded by this setup.

ComfyUI is checked before image upload or prompt submission. Missing native
support or missing split files produces an actionable error naming the files and
official source. A missing high-resolution upscaler does not block a single-stage
render.

## Verification

```powershell
# Read-only graph/schema compatibility against the existing local engine:
$env:LTX25_LIVE = 'schema'
pnpm exec vitest run packages/core/src/providers/image/local-engine/ltx25.live.test.ts

# Opt-in short generation, only when the files are installed and the queue is idle:
$env:LTX25_LIVE = 'generate'
$env:LTX25_OUT_DIR = 'C:\path\to\test-output'
pnpm exec vitest run packages/core/src/providers/image/local-engine/ltx25.live.test.ts
```

The smoke test renders 25 frames at 512x320/24 FPS through the production backend.
`LTX25_REFERENCE` adds a local PNG for I2V, `LTX25_HIGH_RES=1` exercises the second
stage, and `LTX25_AUDIO=0` tests silent output. It refuses a non-loopback server or
a nonempty/unverifiable queue. Schema verification alone is not proof that model
weights load or a video renders.

Reference: [official ComfyUI LTX-2.5 guide](https://docs.comfy.org/tutorials/video/ltx/ltx-2-5)
and [official model files](https://huggingface.co/Lightricks/LTX-2.5).
