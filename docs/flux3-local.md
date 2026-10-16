# FLUX 3 Image Klein (experimental integration)

Prepared against the official BFL model card and ComfyUI distilled image-edit/t2i
templates, 2026-10-16. **Not locally generation-validated yet:** gated access was
approved in the user's browser, but Chrome blocked the authenticated CDN download
with ERR_BLOCKED_BY_CLIENT. The user has been asked to complete that download;
no browser protection was disabled and no access credential was extracted.
Do not interpret graph unit tests as successful inference or deployment.

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

The existing September ComfyUI checkout predates FLUX 3. Back up its revision,
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

Before merging/deploying this feature, run real text-to-image, single-image edit,
multi-reference composition, Soul portrait and marked-search-reference tests.
Verify pre-existing Flux 2 and Qwen recipes still work after any ComfyUI upgrade.
