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
 * "available to download" half of the model picker.
 *
 * Two shapes:
 *  - **single-file** (SD / SDXL / Flux.1): just `url` — one checkpoint into
 *    `models/checkpoints`.
 *  - **split-file** (the current generation: Z-Image, Flux.2, Qwen-Image): `files`
 *    lists every component (diffusion model + text encoder + VAE) with the ComfyUI
 *    models subfolder each belongs in; the desktop downloader fetches them all.
 *
 * `id` is our stable catalog key; `filename` is the main (diffusion/checkpoint)
 * file on disk — what the engine reports and what `localModel` selects. URLs point
 * at the canonical hosting (taken from the official Comfy-Org workflow templates);
 * downloads fail gracefully (files can always be dropped in by hand).
 */
export type ModelFileFolder = "checkpoints" | "diffusion_models" | "text_encoders" | "vae";

export interface ModelComponentFile {
  url: string;
  filename: string;
  /** ComfyUI models subfolder this file belongs in. */
  folder: ModelFileFolder;
  /** Approximate size, for the UI. */
  sizeGB?: number;
}

export type CatalogModelFamily = "sd15" | "sdxl" | "flux" | "flux2" | "zimage" | "qwenimage";

export interface LocalModelCatalogEntry {
  id: string;
  label: string;
  /** Approximate TOTAL download size (all files). */
  sizeGB: number;
  note?: string;
  /** Main model filename (checkpoint or diffusion model) — the engine's name for it. */
  filename: string;
  /** Direct download URL for the main file ("" = no hosted source). */
  url: string;
  /** Model family — authoritative for prompt formatting (SD tags vs natural language). */
  family: CatalogModelFamily;
  /** All component files for a split-file model (includes the main file). */
  files?: ModelComponentFile[];
  /** CLIPLoader `type` for the separate text encoder (split-file models). */
  clipType?: string;
  /**
   * Sampler settings override for THIS model when its family's defaults don't fit
   * (e.g. Flux.2 Klein base uses real CFG 5, unlike guidance-distilled Flux.2-dev).
   * Shape matches sd-prompt's SamplerSettings.
   */
  sampler?: {
    cfg: number;
    sampler: string;
    scheduler: string;
    steps: number;
    guidance?: number;
    shift?: number;
  };
}

export const LOCAL_IMAGE_MODELS: LocalModelCatalogEntry[] = [
  {
    id: "sd15",
    label: "Stable Diffusion 1.5",
    sizeGB: 2,
    note: "Fastest · runs on modest GPUs",
    filename: "v1-5-pruned-emaonly-fp16.safetensors",
    url: "https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors",
    family: "sd15",
  },
  {
    id: "sdxl",
    label: "Stable Diffusion XL",
    sizeGB: 6.6,
    note: "Balanced quality",
    filename: "sd_xl_base_1.0.safetensors",
    url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors",
    family: "sdxl",
  },
  {
    id: "sdxl-turbo",
    label: "SDXL-Turbo",
    sizeGB: 6.9,
    note: "Fast SDXL · few-step",
    filename: "sd_xl_turbo_1.0_fp16.safetensors",
    url: "https://huggingface.co/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors",
    family: "sdxl",
    // Distilled turbo: ~6 steps, CFG 1 (no classifier-free guidance). The explicit
    // low step count trips the backend's turbo guard so the SD step ladder never
    // pushes it to 40 (which would waste time and degrade the image).
    sampler: { cfg: 1, sampler: "euler", scheduler: "normal", steps: 6 },
  },
  {
    id: "juggernaut-xl",
    label: "Juggernaut XL (action / realism)",
    sizeGB: 7,
    note: "SDXL · strong dynamic action scenes & anatomy",
    filename: "juggernaut-xl.safetensors",
    // Best-effort community mirror; downloads fail gracefully if it moves.
    url: "https://huggingface.co/RunDiffusion/Juggernaut-XL-v9/resolve/main/Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors",
    family: "sdxl",
  },
  {
    id: "flux-schnell",
    label: "Flux-schnell (fp8)",
    sizeGB: 12,
    note: "Highest quality · needs a strong GPU",
    filename: "flux1-schnell-fp8.safetensors",
    url: "https://huggingface.co/Comfy-Org/flux1-schnell/resolve/main/flux1-schnell-fp8.safetensors",
    family: "flux",
  },
  // --- Split-file models (the current generation). Filenames, URLs, clip types and
  // sampler settings are taken from the official Comfy-Org workflow templates
  // (github.com/Comfy-Org/workflow_templates: image_z_image_turbo,
  // image_flux2_text_to_image_9b, image_qwen_image). Sizes are approximate.
  {
    id: "z-image-turbo",
    label: "Z-Image Turbo",
    sizeGB: 20.5,
    note: "Recommended · top quality in seconds (8-step turbo)",
    filename: "z_image_turbo_bf16.safetensors",
    url: "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors",
    family: "zimage",
    clipType: "lumina2",
    files: [
      {
        filename: "z_image_turbo_bf16.safetensors",
        folder: "diffusion_models",
        url: "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors",
        sizeGB: 12.3,
      },
      {
        filename: "qwen_3_4b.safetensors",
        folder: "text_encoders",
        url: "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors",
        sizeGB: 7.9,
      },
      {
        filename: "ae.safetensors",
        folder: "vae",
        url: "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors",
        sizeGB: 0.4,
      },
    ],
  },
  {
    id: "flux2-klein-9b",
    label: "Flux.2 Klein 9B (fp8)",
    sizeGB: 19.5,
    note: "Official open Flux.2 — excellent quality, strong GPU",
    filename: "flux-2-klein-base-9b-fp8.safetensors",
    // Comfy-Org's repack mirror — the black-forest-labs repos are GATED on Hugging
    // Face (401 without an accepted license + login), which the app's keyless
    // downloader can't satisfy. Same files, ungated host.
    url: "https://huggingface.co/Comfy-Org/flux2-klein-9B/resolve/main/split_files/diffusion_models/flux-2-klein-base-9b-fp8.safetensors",
    family: "flux2",
    clipType: "flux2",
    // Klein base is NOT guidance-distilled (unlike Flux.2-dev): real CFG 5, no
    // FluxGuidance node — per the official image_flux2_text_to_image_9b template.
    sampler: { cfg: 5, sampler: "euler", scheduler: "simple", steps: 20 },
    files: [
      {
        filename: "flux-2-klein-base-9b-fp8.safetensors",
        folder: "diffusion_models",
        url: "https://huggingface.co/Comfy-Org/flux2-klein-9B/resolve/main/split_files/diffusion_models/flux-2-klein-base-9b-fp8.safetensors",
        sizeGB: 9.7,
      },
      {
        filename: "qwen_3_8b_fp8mixed.safetensors",
        folder: "text_encoders",
        url: "https://huggingface.co/Comfy-Org/flux2-klein-9B/resolve/main/split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors",
        sizeGB: 9.1,
      },
      {
        filename: "full_encoder_small_decoder.safetensors",
        folder: "vae",
        url: "https://huggingface.co/Comfy-Org/flux2-klein-9B/resolve/main/split_files/vae/full_encoder_small_decoder.safetensors",
        sizeGB: 0.7,
      },
    ],
  },
  {
    id: "qwen-image",
    label: "Qwen-Image (fp8)",
    sizeGB: 30,
    note: "Best detail & in-image text · biggest download",
    filename: "qwen_image_fp8_e4m3fn.safetensors",
    url: "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_fp8_e4m3fn.safetensors",
    family: "qwenimage",
    clipType: "qwen_image",
    files: [
      {
        filename: "qwen_image_fp8_e4m3fn.safetensors",
        folder: "diffusion_models",
        url: "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_fp8_e4m3fn.safetensors",
        sizeGB: 20.4,
      },
      {
        filename: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
        folder: "text_encoders",
        url: "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
        sizeGB: 9.4,
      },
      {
        filename: "qwen_image_vae.safetensors",
        folder: "vae",
        url: "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors",
        sizeGB: 0.25,
      },
    ],
  },
];

/** The catalog entry for a model, matched by id or main filename (else undefined). */
export function catalogEntryForModel(name: string): LocalModelCatalogEntry | undefined {
  const n = name.toLowerCase();
  return LOCAL_IMAGE_MODELS.find(
    (m) => m.id.toLowerCase() === n || m.filename.toLowerCase() === n,
  );
}

/** Family of a managed catalog model, matched by id or filename (else undefined). */
export function catalogModelFamily(name: string): CatalogModelFamily | undefined {
  return catalogEntryForModel(name)?.family;
}

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
  /**
   * Direct `.safetensors` download URL so the managed (desktop) engine can fetch
   * this LoRA on demand. Optional — when absent there's no auto-download (the
   * style still works via its prompt text, or a LoRA you install yourself).
   *
   * NOTE: URLs below are best-effort community sources and are NOT verified in
   * this environment; downloads fail gracefully, and this is the one place to
   * fix/add a source. Saved locally as `${name}.safetensors` to match the
   * by-style-id lookup the backends use.
   */
  url?: string;
  /** Saved filename (defaults to `${name}.safetensors`). */
  filename?: string;
  /** Approximate download size in MB, for the UI. */
  sizeMB?: number;
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
    id: "dynamic-action",
    label: "Dynamic action",
    promptSuffix:
      "dynamic action pose, intense motion, sense of speed and impact, cinematic action shot, motion blur on movement",
    // No bundled download — the prompt emphasis drives it; drop a LoRA named
    // dynamic-action.safetensors into the engine's loras folder to boost it.
    local: { lora: { name: "dynamic-action", strength: 0.7, trigger: "dynamic action" } },
  },
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
    local: {
      lora: {
        name: "animation-3d",
        strength: 0.8,
        trigger: "3D Render Style, 3DRenderAF",
        url: "https://huggingface.co/artificialguybr/3DRedmond-V1/resolve/main/3DRedmond-3DRenderStyle-3DRenderAF.safetensors",
        filename: "animation-3d.safetensors",
        sizeMB: 170,
      },
    },
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
    local: {
      lora: {
        name: "comic",
        strength: 0.8,
        trigger: "Comic Book",
        url: "https://huggingface.co/artificialguybr/ComicBookRedmond-V2/resolve/main/ComicBookRedmond-V2-Comic-ComicRedmAF.safetensors",
        filename: "comic.safetensors",
        sizeMB: 170,
      },
    },
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
    local: {
      lora: {
        name: "storybook",
        strength: 0.8,
        trigger: "Storybook Redmond",
        url: "https://huggingface.co/artificialguybr/StoryBookRedmond/resolve/main/StoryBookRedmond.safetensors",
        filename: "storybook.safetensors",
        sizeMB: 170,
      },
    },
  },
];

/** A style LoRA the managed engine can fetch on demand. */
export interface DownloadableLora {
  /** Progress key + on-disk LoRA name (matches the style id by convention). */
  id: string;
  filename: string;
  url: string;
  sizeMB?: number;
}

/** The downloadable LoRA for a style, or undefined when the style has no source. */
export function styleLoraDownload(styleId: string | undefined): DownloadableLora | undefined {
  const lora = getImageStyle(styleId).local?.lora;
  if (!lora?.url) return undefined;
  return {
    id: lora.name,
    filename: lora.filename ?? `${lora.name}.safetensors`,
    url: lora.url,
    ...(lora.sizeMB !== undefined ? { sizeMB: lora.sizeMB } : {}),
  };
}

export const DEFAULT_IMAGE_STYLE = "auto";

/** Resolve a style by id, falling back to "auto" (so an unknown/undefined id is safe). */
export function getImageStyle(id: string | undefined): ImageStyle {
  return IMAGE_STYLES.find((s) => s.id === id) ?? IMAGE_STYLES[0]!;
}

/**
 * On-device text models (run locally via WebLLM/WebGPU) for the "Text → On my
 * computer" path. Ids are WebLLM prebuilt model ids; `downloadGB` is the
 * one-time weight download (cached by the browser afterwards).
 */
export interface LocalTextModel {
  id: string;
  label: string;
  downloadGB: number;
  note?: string;
}

/**
 * Local LLM **server** kinds for the "Text → On my computer → Local server" path:
 * an OpenAI-compatible server the user runs themselves (Ollama / LM Studio /
 * llama.cpp). The default URLs are the conventional ports each exposes at `/v1`.
 * The app POSTs `/v1/chat/completions` and GETs `/v1/models`.
 */
export type LocalTextServerId = "ollama" | "lmstudio" | "llamacpp";

export const LOCAL_TEXT_SERVER_DEFAULT_URL: Record<LocalTextServerId, string> = {
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
  llamacpp: "http://localhost:8000/v1",
};

export const LOCAL_TEXT_SERVER_LABEL: Record<LocalTextServerId, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
};

export const DEFAULT_LOCAL_TEXT_SERVER: LocalTextServerId = "ollama";
export const DEFAULT_LOCAL_SERVER_TEXT_MODEL = "llama3.2";

/**
 * Curated text models the app can pull INTO Ollama on demand (via `POST
 * /api/pull` — see `LocalServerLLMProvider.pullModel`), so no terminal `ollama
 * pull` is needed. Ids are Ollama model:tag names; sizes are the download size.
 */
export interface OllamaTextModel {
  id: string;
  label: string;
  sizeGB: number;
  note?: string;
}

export const OLLAMA_TEXT_MODELS: OllamaTextModel[] = [
  {
    id: "qwen3:8b",
    label: "Qwen 3 8B",
    sizeGB: 5.2,
    note: "Recommended · best extraction for the size",
  },
  { id: "qwen3:14b", label: "Qwen 3 14B", sizeGB: 9.3, note: "Higher quality · needs ~12 GB VRAM" },
  { id: "gemma3:12b", label: "Gemma 3 12B", sizeGB: 8.1, note: "Strong prose understanding" },
  { id: "llama3.2:3b", label: "Llama 3.2 3B", sizeGB: 2.0, note: "Fastest · modest hardware" },
];

/**
 * Does a server-reported model id satisfy a catalog id? Ollama reports exact
 * `name:tag` ids, but tolerate a bare-name match ("llama3.2" ⊇ "llama3.2:3b" is
 * NOT assumed — only exact, `:latest`, or the same untagged name).
 */
export function ollamaModelMatches(installedId: string, wantedId: string): boolean {
  const a = installedId.toLowerCase();
  const b = wantedId.toLowerCase();
  return a === b || a === `${b}:latest` || a.split(":")[0] === b;
}

export const LOCAL_TEXT_MODELS: LocalTextModel[] = [
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2 3B",
    downloadGB: 2.0,
    note: "Balanced · recommended",
  },
  {
    id: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    label: "Qwen2.5 3B",
    downloadGB: 2.0,
    note: "Best at structured extraction",
  },
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2 1B",
    downloadGB: 0.9,
    note: "Fastest · low VRAM",
  },
  {
    id: "Phi-3.5-mini-instruct-q4f16_1-MLC",
    label: "Phi-3.5 mini (3.8B)",
    downloadGB: 2.2,
    note: "Strong reasoning",
  },
];
