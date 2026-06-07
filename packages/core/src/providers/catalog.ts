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
