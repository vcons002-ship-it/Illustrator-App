/**
 * Single source of truth for which providers exist and what the UI should show.
 *
 * The Settings panel renders its dropdowns from these arrays and the factory
 * resolves the same ids, so the UI and the wiring can never drift. Adding a
 * provider = one entry here + one case in the factory.
 */

export type ProviderSlot = "text" | "image";

export interface ProviderInfo {
  id: string;
  label: string;
  slot: ProviderSlot;
  /** Whether this provider needs a BYO API key. */
  needsKey: boolean;
  /** Where to get a key (for the "Get a key" link). */
  keyUrl?: string;
  /** Placeholder shown in the key field. */
  keyHint?: string;
  /** One-line hint shown under the key field on where to find the key. */
  keyBlurb?: string;
  /** True for the on-device / app-managed local option. */
  local?: boolean;
}

export const TEXT_PROVIDERS: ProviderInfo[] = [
  {
    id: "claude",
    label: "Claude (Anthropic)",
    slot: "text",
    needsKey: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    keyBlurb: "console.anthropic.com → Settings → API Keys → Create Key",
  },
  {
    id: "gemini",
    label: "Gemini (Google)",
    slot: "text",
    needsKey: true,
    keyUrl: "https://aistudio.google.com/app/apikey",
    keyHint: "AIza…",
    keyBlurb: "aistudio.google.com → Get API key → Create API key",
  },
  {
    id: "openai",
    label: "OpenAI",
    slot: "text",
    needsKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-…",
    keyBlurb: "platform.openai.com → API keys → Create new secret key",
  },
  { id: "local", label: "On my computer (free)", slot: "text", needsKey: false, local: true },
];

export const IMAGE_PROVIDERS: ProviderInfo[] = [
  // Note: Claude has no image model, so it is intentionally absent here.
  {
    id: "flux",
    label: "Flux (Black Forest Labs)",
    slot: "image",
    needsKey: true,
    keyUrl: "https://api.bfl.ai/auth/profile/keys",
    keyHint: "bfl-…",
    keyBlurb: "api.bfl.ai → sign in → Keys → Add key",
  },
  {
    id: "gemini",
    label: "Imagen (Google)",
    slot: "image",
    needsKey: true,
    keyUrl: "https://aistudio.google.com/app/apikey",
    keyHint: "AIza…",
    keyBlurb: "Same Gemini key as text — aistudio.google.com → Get API key",
  },
  {
    id: "openai",
    label: "OpenAI (gpt-image-1)",
    slot: "image",
    needsKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-…",
    keyBlurb: "Same OpenAI key as text — platform.openai.com → API keys",
  },
  { id: "local", label: "On my computer (free)", slot: "image", needsKey: false, local: true },
];

export function getProvider(slot: ProviderSlot, id: string): ProviderInfo | undefined {
  return (slot === "text" ? TEXT_PROVIDERS : IMAGE_PROVIDERS).find((p) => p.id === id);
}

/**
 * Curated catalog of local image models the desktop app can download on demand.
 * The live "already downloaded" list comes from the running engine; this is the
 * "available to download" half of the model picker. Each entry is a single-file
 * checkpoint that ComfyUI loads from `models/checkpoints`.
 *
 * `id` is our stable catalog key; `filename` is what's saved on disk and what the
 * engine reports back as the checkpoint name. URLs point at the canonical
 * hosting; the desktop downloader streams them with progress and fails
 * gracefully (the user can always drop a checkpoint in by hand).
 */
export interface LocalModelCatalogEntry {
  id: string;
  label: string;
  sizeGB: number;
  note?: string;
  /** Checkpoint filename saved into models/checkpoints (and the engine's name for it). */
  filename: string;
  /** Direct download URL for the .safetensors checkpoint. */
  url: string;
}

export const LOCAL_IMAGE_MODELS: LocalModelCatalogEntry[] = [
  {
    id: "sd15",
    label: "Stable Diffusion 1.5",
    sizeGB: 2,
    note: "Fastest · runs on modest GPUs",
    filename: "v1-5-pruned-emaonly-fp16.safetensors",
    url: "https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors",
  },
  {
    id: "sdxl",
    label: "Stable Diffusion XL",
    sizeGB: 6.6,
    note: "Balanced quality",
    filename: "sd_xl_base_1.0.safetensors",
    url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors",
  },
  {
    id: "sdxl-turbo",
    label: "SDXL-Turbo",
    sizeGB: 6.9,
    note: "Fast SDXL · few-step",
    filename: "sd_xl_turbo_1.0_fp16.safetensors",
    url: "https://huggingface.co/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors",
  },
  {
    id: "flux-schnell",
    label: "Flux-schnell (fp8)",
    sizeGB: 12,
    note: "Highest quality · needs a strong GPU",
    filename: "flux1-schnell-fp8.safetensors",
    url: "https://huggingface.co/Comfy-Org/flux1-schnell/resolve/main/flux1-schnell-fp8.safetensors",
  },
];

/**
 * Art-style catalog for the image style selector. The chosen style's
 * `promptSuffix` is appended to every image prompt (in the render pipeline), so it
 * applies uniformly across all image providers — cloud APIs, the local engine, and
 * the mock. "auto" adds nothing (let the passage drive the look).
 *
 * `local` additionally maps a style to a **LoRA and/or checkpoint** for the local
 * engine (ComfyUI / AUTOMATIC1111). By convention the LoRA name matches the style
 * id (drop `<style>.safetensors` into the engine's `loras` folder). The backend
 * applies it **only when that asset is installed**, falling back to the prompt
 * style otherwise — so this never breaks generation on an engine that lacks it.
 */
export interface StyleLoraRef {
  name: string;
  strength: number;
  trigger?: string;
}

export interface ImageStyleLocal {
  /** Prefer this checkpoint for the style when installed (else keep the user's model). */
  checkpoint?: string;
  /** Apply this LoRA when installed. */
  lora?: StyleLoraRef;
}

export interface ImageStyle {
  id: string;
  label: string;
  /** Appended to the image prompt; empty for "auto". */
  promptSuffix: string;
  /** Optional local-engine LoRA/checkpoint mapping (applied when installed). */
  local?: ImageStyleLocal;
}

export const IMAGE_STYLES: ImageStyle[] = [
  { id: "auto", label: "Auto (match the writing)", promptSuffix: "" },
  {
    id: "photorealistic",
    label: "Photorealistic",
    promptSuffix:
      "photorealistic, ultra-detailed, natural lighting, sharp focus, professional photography",
    local: { lora: { name: "photorealistic", strength: 0.6 } },
  },
  {
    id: "anime",
    label: "Anime",
    promptSuffix: "anime illustration, cel shading, clean line art, vibrant colors, expressive",
    local: { lora: { name: "anime", strength: 0.8, trigger: "anime" } },
  },
  {
    id: "manga",
    label: "Manga (black & white)",
    promptSuffix: "black-and-white manga, ink linework, screentone shading, dynamic composition",
    local: { lora: { name: "manga", strength: 0.8, trigger: "manga, monochrome, greyscale" } },
  },
  {
    id: "animation-3d",
    label: "Realistic animation (3D)",
    promptSuffix:
      "3D animated film still, stylized realism, soft global illumination, subtle subsurface detail",
    local: { lora: { name: "animation-3d", strength: 0.8, trigger: "3d render" } },
  },
  {
    id: "watercolor",
    label: "Watercolor",
    promptSuffix: "watercolor painting, soft washes, textured paper, painterly, delicate",
    local: { lora: { name: "watercolor", strength: 0.8, trigger: "watercolor" } },
  },
  {
    id: "comic",
    label: "Comic book",
    promptSuffix: "western comic book art, bold ink outlines, halftone shading, dramatic",
    local: { lora: { name: "comic", strength: 0.8, trigger: "comic book style" } },
  },
  {
    id: "oil-painting",
    label: "Oil painting",
    promptSuffix: "classical oil painting, visible brushstrokes, rich color, chiaroscuro lighting",
    local: { lora: { name: "oil-painting", strength: 0.8, trigger: "oil painting" } },
  },
  {
    id: "storybook",
    label: "Storybook",
    promptSuffix: "children's storybook illustration, soft gouache, warm and whimsical",
    local: { lora: { name: "storybook", strength: 0.8, trigger: "storybook illustration" } },
  },
];

export const DEFAULT_IMAGE_STYLE = "auto";

/** Resolve a style by id, falling back to "auto" (so an unknown/undefined id is safe). */
export function getImageStyle(id: string | undefined): ImageStyle {
  return IMAGE_STYLES.find((s) => s.id === id) ?? IMAGE_STYLES[0]!;
}
