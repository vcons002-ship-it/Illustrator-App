# FLUX 3 Image Klein (experimental integration)

Implemented against the official BFL model card and ComfyUI distilled image-edit/t2i
templates, 2026-10-16. Real inference validated on an RTX 5090 with ComfyUI 0.41.0:
768-square text-to-image, single-image instruction edit, and two-reference composition
all passed through `ComfyUIBackend.generate`, with visual inspection of each output.
The three jobs took about 141 seconds total, including captioning/loading/offloading.
This is backend/runtime evidence, not a claim that every chat/book UI was manually exercised.

Model: https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy
Templates: https://github.com/Comfy-Org/workflow_templates/tree/main/templates

Use the distilled int8 preset on a 5090. It needs approximately 20.8 GB of downloads
including the caption model; total runtime VRAM also includes activations/caches.
These are open weights under BFL's FLUX Kommunity License, not Apache/MIT weights.
The human must review and accept the terms; do not substitute an unverified mirror.

After access is approved, place these official files under the existing model root
(on this PC `D:\ComfyUI-models`):

- `diffusion_models/flux3_image_klein_sd_int8_convrot.safetensors`
- `text_encoders/qwen3vl_4b_int8_convrot.safetensors`
- `text_encoders/qwen3.5_9b_flux3_prompt_upsampler_int8_convrot.safetensors`
- `vae/flux2-vae.safetensors` (reuse if already present)

ComfyUI versions before native FLUX 3 support need updating (validated: 0.41.0).
Back up the revision,
requirements and custom nodes before updating; do not replace the Qwen/Flux 2
models. Check CLIPLoader type `flux3`, TextGenerate, ReferenceMultiLatent,
BatchImagesNode and EmptyFlux2LatentImage in the running engine's object_info.

The new backend connects the shared reference-photo inputs (Soul portraits, book
references, user attachments and marked search references) to both the caption
model and native reference conditioning. Instruction edits use the edit image as
the first reference, with up to 10 images total, and full denoising. Upload errors
fail visibly rather than silently dropping identity images. Caption upsampling
is always run; text-to-image and image editing use the same checkpoint.

Legacy two-pass hires, style LoRAs and character-region masks fail explicitly for
this preset. Native bounding-box UI and base/fine-tuning workflows are not added
by this initial integration. BFL's boxes guide layout, not hard-mask preservation.

Local verification:

- The three downloaded model/encoder SHA-256 hashes matched official BFL metadata.
- Existing `flux2-vae.safetensors` matched the Comfy-Org Flux 2 VAE hash and worked
  for all three new jobs; no replacement VAE was necessary.
- Existing Qwen Image 2.1 reference generation passed at 512 square / 25 steps.
- Existing Flux 2 Klein 4B reference generation passed at 512 square / 4 steps after
  correcting its pre-existing encoder-selection bug (4B requires Qwen-3 4B, not 8B).
- Shared chat/Soul/book/reference resolution and graph routing have automated coverage;
  the live smoke test exercises the resolved reference-byte input, not an internet image search.

Reproduce explicitly against an idle local engine (these use the GPU and create scratch images):

```powershell
$env:VR_FLUX3_LIVE = '1'
$env:VR_FLUX3_OUTPUT = 'C:\\path\\to\\scratch-output'
pnpm exec vitest run packages/core/src/providers/image/local-engine/flux3.live.test.ts
```

For existing-engine regression jobs, unset `VR_FLUX3_LIVE`, set `VR_IMAGE_REGRESSION=1`,
and use the same output directory (the regression jobs read `01-teapot.png`). These
tests are skipped in the normal suite and never download models or change settings.
