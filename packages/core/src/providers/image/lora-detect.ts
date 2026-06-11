import type { CatalogModelFamily } from "../catalog.js";

/**
 * Detect which base model architecture a LoRA was trained for, so the UI can warn before
 * a mismatched LoRA is applied (an SDXL LoRA silently does nothing on Flux/Z-Image).
 *
 * Two signals, in order of reliability:
 *  1. **Training metadata** — kohya/sd-scripts and the modelspec convention write the base
 *     model into the safetensors `__metadata__` (`ss_base_model_version`,
 *     `modelspec.architecture`). Present on most published LoRAs and authoritative.
 *  2. **Tensor key names** — when metadata is missing, the layer names still reveal the
 *     family: Flux uses `double_blocks`/`single_blocks`; SDXL has a second text encoder
 *     (`te2` / `text_model_2`); a plain SD UNet without a second encoder is SD1.5.
 *
 * Returns "unknown" when neither signal is conclusive (e.g. Flux.1 vs Flux.2, or
 * Z-Image/Qwen-Image, can't always be told from keys alone — metadata is needed there).
 */
export function detectLoraFamily(
  metadata: Record<string, string> | undefined,
  keys: readonly string[],
): CatalogModelFamily | "unknown" {
  const m = metadata ?? {};
  const hay = `${m["modelspec.architecture"] ?? ""} ${m["ss_base_model_version"] ?? ""} ${
    m["ss_base_model"] ?? ""
  }`.toLowerCase();
  if (/flux/.test(hay)) return /flux[._-]?2/.test(hay) ? "flux2" : "flux";
  if (/qwen[._-]?image/.test(hay)) return "qwenimage";
  if (/z[._-]?image|lumina/.test(hay)) return "zimage";
  if (/sdxl|sd[._-]?xl|xl[_-]?base/.test(hay)) return "sdxl";
  if (/sd[._-]?v?1|stable[-_]?diffusion[-_]?v?1|sd15/.test(hay)) return "sd15";

  // Fallback: tensor-key heuristics.
  const ks = keys.join("\n").toLowerCase();
  if (/double_blocks|single_blocks|single_transformer|guidance_in|txt_in/.test(ks)) return "flux";
  if (/qwen/.test(ks)) return "qwenimage";
  if (/_te2_|text_encoder_2|text_model_2|conditioner\.embedders\.1/.test(ks)) return "sdxl";
  if (/lora_unet|lora_te|down_blocks|input_blocks|mid_block/.test(ks)) return "sd15";
  return "unknown";
}

/**
 * Parse a safetensors header (the leading JSON object) into the metadata map + tensor key
 * names, then classify. The desktop shell reads only the header bytes off disk and hands
 * the JSON string here. Returns "unknown" on any malformed input (never throws).
 */
export function classifyLoraHeader(headerJson: string): CatalogModelFamily | "unknown" {
  try {
    const parsed = JSON.parse(headerJson) as Record<string, unknown>;
    const metadata = (parsed.__metadata__ ?? undefined) as Record<string, string> | undefined;
    const keys = Object.keys(parsed).filter((k) => k !== "__metadata__");
    return detectLoraFamily(metadata, keys);
  } catch {
    return "unknown";
  }
}
