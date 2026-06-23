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
    label: "Google Gemini (Nano Banana / Flash)",
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

export type CatalogModelFamily =
  | "sd15"
  | "sdxl"
  | "flux"
  | "flux2"
  | "zimage"
  | "qwenimage"
  | "hidream";

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

/**
 * HiDream's four text encoders + the Flux VAE, shared by every HiDream catalog entry
 * (the diffusion model differs by variant/precision, these don't). Hosted in the same
 * Comfy-Org repack; the downloader skips files already on disk so they're fetched once.
 */
const HIDREAM_TE_BASE =
  "https://huggingface.co/Comfy-Org/HiDream-I1_ComfyUI/resolve/main/split_files/text_encoders";
const HIDREAM_SHARED_FILES: ModelComponentFile[] = [
  { filename: "clip_l_hidream.safetensors", folder: "text_encoders", url: `${HIDREAM_TE_BASE}/clip_l_hidream.safetensors`, sizeGB: 0.25 },
  { filename: "clip_g_hidream.safetensors", folder: "text_encoders", url: `${HIDREAM_TE_BASE}/clip_g_hidream.safetensors`, sizeGB: 1.4 },
  { filename: "t5xxl_fp8_e4m3fn_scaled.safetensors", folder: "text_encoders", url: `${HIDREAM_TE_BASE}/t5xxl_fp8_e4m3fn_scaled.safetensors`, sizeGB: 4.9 },
  { filename: "llama_3.1_8b_instruct_fp8_scaled.safetensors", folder: "text_encoders", url: `${HIDREAM_TE_BASE}/llama_3.1_8b_instruct_fp8_scaled.safetensors`, sizeGB: 8.1 },
  { filename: "ae.safetensors", folder: "vae", url: "https://huggingface.co/Comfy-Org/HiDream-I1_ComfyUI/resolve/main/split_files/vae/ae.safetensors", sizeGB: 0.3 },
];

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
    sizeGB: 17.2,
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
    sizeGB: 18.5,
    note: "Official open Flux.2 — last file needs a free Hugging Face sign-in (browser download)",
    filename: "flux-2-klein-base-9b-fp8.safetensors",
    // Comfy-Org's repack repo no longer hosts the Klein DIFFUSION weights (it was
    // renamed to vae-text-encorder-for-flux-klein-9b and stripped to encoder+VAE);
    // the only canonical source is black-forest-labs, which is gated (401 without a
    // logged-in license acceptance). The ungated mirrors are zero-download personal
    // repos — not something an auto-downloader should trust. URLs below match the
    // current official image_flux2_text_to_image_9b template (verified 2026-06-11).
    url: "https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9b-fp8/resolve/main/flux-2-klein-base-9b-fp8.safetensors",
    family: "flux2",
    clipType: "flux2",
    // Klein base is NOT guidance-distilled (unlike Flux.2-dev): real CFG 5, no
    // FluxGuidance node — per the official image_flux2_text_to_image_9b template.
    sampler: { cfg: 5, sampler: "euler", scheduler: "simple", steps: 20 },
    // The gated diffusion file goes LAST: the ungated encoder + VAE download
    // unattended first, so after it fails with the "download it in your browser"
    // hint, dropping that one file into diffusion_models completes the model
    // (the downloader skips finished files on retry).
    files: [
      {
        filename: "qwen_3_8b_fp8mixed.safetensors",
        folder: "text_encoders",
        url: "https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-9b/resolve/main/split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors",
        sizeGB: 8.7,
      },
      {
        filename: "full_encoder_small_decoder.safetensors",
        folder: "vae",
        url: "https://huggingface.co/black-forest-labs/FLUX.2-small-decoder/resolve/main/full_encoder_small_decoder.safetensors",
        sizeGB: 0.25,
      },
      {
        filename: "flux-2-klein-base-9b-fp8.safetensors",
        folder: "diffusion_models",
        url: "https://huggingface.co/black-forest-labs/FLUX.2-klein-base-9b-fp8/resolve/main/flux-2-klein-base-9b-fp8.safetensors",
        sizeGB: 9.6,
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
  // --- HiDream-I1 (native ComfyUI). A 17B diffusion transformer that loads via a
  // QuadrupleCLIPLoader (clip_l + clip_g + t5xxl + llama_3.1_8b), a UNETLoader, the Flux
  // VAE (ae.safetensors), and a ModelSamplingSD3 shift node. Files + URLs + sampler
  // settings from the official Comfy-Org repack (Comfy-Org/HiDream-I1_ComfyUI) and the
  // ComfyUI HiDream workflow template. The four text encoders are shared between the Full
  // and Dev entries; the downloader skips files already present, so installing one after
  // the other reuses them. (HiDream has no `clipType` — QuadrupleCLIPLoader takes no type.)
  {
    id: "hidream-full",
    label: "HiDream-I1 Full (fp16)",
    sizeGB: 49,
    note: "Top quality · 4 text encoders + Flux VAE · needs ~27 GB+ VRAM",
    filename: "hidream_i1_full_fp16.safetensors",
    url: "https://huggingface.co/Comfy-Org/HiDream-I1_ComfyUI/resolve/main/split_files/diffusion_models/hidream_i1_full_fp16.safetensors",
    family: "hidream",
    // Full is CFG-based (real negative): uni_pc / simple / cfg 5 / 50 steps / SD3 shift 3.0.
    sampler: { cfg: 5, sampler: "uni_pc", scheduler: "simple", steps: 50, shift: 3.0 },
    files: [
      {
        filename: "hidream_i1_full_fp16.safetensors",
        folder: "diffusion_models",
        url: "https://huggingface.co/Comfy-Org/HiDream-I1_ComfyUI/resolve/main/split_files/diffusion_models/hidream_i1_full_fp16.safetensors",
        sizeGB: 34.2,
      },
      ...HIDREAM_SHARED_FILES,
    ],
  },
  {
    id: "hidream-dev",
    label: "HiDream-I1 Dev (fp8)",
    sizeGB: 32,
    note: "Fast · near-Full quality at 8-bit · ~16 GB VRAM",
    filename: "hidream_i1_dev_fp8.safetensors",
    url: "https://huggingface.co/Comfy-Org/HiDream-I1_ComfyUI/resolve/main/split_files/diffusion_models/hidream_i1_dev_fp8.safetensors",
    family: "hidream",
    // Dev runs at a light REAL CFG with a negative (NOT pure guidance-distillation): cfg 2,
    // lcm / normal / 28 steps / SD3 shift 5.5 — matching the Comfy-Org HiDream-dev template. An
    // empty negative here crashes ("linear(): … not NoneType"); resolveNegative supplies one.
    sampler: { cfg: 2, sampler: "lcm", scheduler: "normal", steps: 28, shift: 5.5 },
    files: [
      {
        filename: "hidream_i1_dev_fp8.safetensors",
        folder: "diffusion_models",
        url: "https://huggingface.co/Comfy-Org/HiDream-I1_ComfyUI/resolve/main/split_files/diffusion_models/hidream_i1_dev_fp8.safetensors",
        sizeGB: 17.1,
      },
      ...HIDREAM_SHARED_FILES,
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
 * Rough resident VRAM cost (GB) of a local image model — its total file size (diffusion
 * model + text encoder + VAE), which for the fp8 catalog files ≈ what sits in memory.
 * Returns 0 when the model isn't in the catalog, so callers don't force memory offload
 * for an unknown model. Used to decide whether ComfyUI needs `--lowvram` on a given card.
 */
export function imageModelVramCostGb(name: string): number {
  return catalogEntryForModel(name)?.sizeGB ?? 0;
}

/**
 * Rough resident VRAM cost (GB) of a LOCAL SERVER chat model (Ollama / LM Studio), estimated from
 * its name — Ollama tags embed the parameter count and usually the quantization (e.g. "gemma2:27b",
 * "qwen3:32b-q4_K_M", "llama3.1:70b-instruct-q8_0", "mixtral:8x7b"). There's no portable API to read
 * the loaded size, so this lets the engine decide whether a big chat model AND the image model both
 * fit at once — and so SKIP evicting the chat model for a render (which on a large model costs a
 * multi-minute cold reload on the next message).
 *
 * Conservative (rounds UP, generous KV allowance) so we only keep both resident when there's clearly
 * headroom — an under-estimate could OOM. Returns 0 when no parameter count is parseable, so callers
 * fall back to their existing "free it" behaviour (no regression for unknown names).
 */
export function serverModelVramCostGb(name: string): number {
  const lower = name.toLowerCase();
  // Parameter count in billions: an MoE "8x7b" (all experts are resident) takes precedence over the
  // plain "27b" / "3.8b" form so we don't read just the "7b" out of "8x7b".
  const moe = lower.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*b/);
  let params: number | undefined;
  if (moe) {
    params = Number(moe[1]) * Number(moe[2]);
  } else {
    const m = lower.match(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/); // "27b", "3.8b" — not "bf16"/"base"
    if (m) params = Number(m[1]);
  }
  if (!params || !Number.isFinite(params) || params <= 0) return 0;
  // Bytes per weight by quantization; Ollama defaults to a ~q4 mix when the tag omits one.
  const bytesPerParam = /f(p)?16|bf16/.test(lower)
    ? 2.0
    : /q8|int8|8bit/.test(lower)
      ? 1.1
      : /q6/.test(lower)
        ? 0.85
        : /q5/.test(lower)
          ? 0.72
          : /q3/.test(lower)
            ? 0.5
            : /q2/.test(lower)
              ? 0.42
              : 0.6; // q4 — the common default
  // Weights + a fixed allowance for the KV cache / runtime activations.
  return Math.ceil(params * bytesPerParam + 1.5);
}

/** Squashed lowercase alphanumerics ("Flux 2 Klein.safetensors" → "flux2klein"). */
function normalizeModelName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.(safetensors|ckpt|gguf)$/i, "")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Resolve a model the user NAMED IN CHAT ("flux 2", "z image", "juggernaut") to an
 * actually-installed file: exact normalized match, then substring, then a token
 * fallback (every word of the request appears somewhere in the name — "flux dev"
 * matches "FLUX.2-dev" even though "fluxdev" isn't contiguous). Installed names
 * only — a model that isn't downloaded can't render; a miss returns undefined and
 * the CALLER decides whether to keep the current model or surface the failure.
 */
export function resolveModelRequest(
  query: string,
  installed: readonly string[],
): string | undefined {
  const nq = normalizeModelName(query);
  if (!nq) return undefined;
  const exact = installed.find((m) => normalizeModelName(m) === nq);
  if (exact) return exact;
  const substring = installed.find((m) => normalizeModelName(m).includes(nq));
  if (substring) return substring;
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => normalizeModelName(t))
    .filter(Boolean);
  if (tokens.length < 2) return undefined; // single tokens had their substring shot
  // Shortest candidate wins — the least-decorated name is the least surprising.
  return installed
    .filter((m) => {
      const nm = normalizeModelName(m);
      return tokens.every((t) => nm.includes(t));
    })
    .sort((a, b) => a.length - b.length)[0];
}

/**
 * Resolve an art style the user named in chat ("oil painting", "noir") to a style id
 * from IMAGE_STYLES (exact id, then label/id substring). Undefined when nothing fits.
 */
export function resolveStyleRequest(query: string): string | undefined {
  const nq = normalizeModelName(query);
  if (!nq) return undefined;
  const match =
    IMAGE_STYLES.find((s) => normalizeModelName(s.id) === nq) ??
    IMAGE_STYLES.find(
      (s) => normalizeModelName(s.label).includes(nq) || normalizeModelName(s.id).includes(nq),
    );
  return match && match.id !== "auto" ? match.id : undefined;
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
   * NOTE: URLs below are best-effort community sources, live-verified 2026-06-11
   * (HEAD 200, anonymous); downloads fail gracefully if a host moves, and this is
   * the one place to fix/add a source. Saved locally as `${name}.safetensors` to
   * match the by-style-id lookup the backends use.
   */
  url?: string;
  /** Saved filename (defaults to `${name}.safetensors`). */
  filename?: string;
  /** Approximate download size in MB, for the UI. */
  sizeMB?: number;
  /**
   * The model family this curated download is BUILT FOR. A LoRA only loads on its own
   * architecture (an SDXL LoRA can't run on Flux/Z-Image), so the UI offers the one-click
   * download only when the active model matches — and points other families to the
   * manual override / paste-a-URL path instead. Undefined = architecture-agnostic prompt
   * helper (no real constraint).
   */
  family?: CatalogModelFamily;
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
  /** One-line "what it looks like + what it suits", shown in the style picker. */
  description: string;
  /** Appended to the image prompt; empty for "auto". */
  promptSuffix: string;
  /** Optional local-engine LoRA/checkpoint mapping (applied when installed). */
  local?: ImageStyleLocal;
}

/**
 * The art-style catalog. Each style is primarily PROMPT-driven (the suffix steers any
 * model, cloud or local); `local.lora` additionally applies a LoRA of that name when one
 * is installed in the engine (only the entries with a `url` are downloadable in-app —
 * for the rest, drop a matching `<name>.safetensors` into the engine's loras folder).
 * Suffixes name a medium + technique + palette/lighting rather than artists, which
 * steers reliably across SD, Flux and the cloud models alike.
 */
export const IMAGE_STYLES: ImageStyle[] = [
  {
    id: "auto",
    label: "Auto (match the writing)",
    description: "No style is forced — the scene prompt and the book's own genre decide the look.",
    promptSuffix: "",
  },
  {
    id: "dynamic-action",
    label: "Dynamic action",
    description: "High-energy cinematic shots with motion and impact — thrillers, battles, sports.",
    promptSuffix:
      "dynamic action pose, intense motion, sense of speed and impact, cinematic action shot, motion blur on movement, dramatic low camera angle",
    // No bundled download — the prompt emphasis drives it; drop a LoRA named
    // dynamic-action.safetensors into the engine's loras folder to boost it.
    local: { lora: { name: "dynamic-action", strength: 0.7, trigger: "dynamic action" } },
  },
  {
    id: "photorealistic",
    label: "Photorealistic",
    description: "Looks like a photograph — contemporary fiction, memoirs, true stories.",
    promptSuffix:
      "photorealistic, ultra-detailed, natural lighting, sharp focus, realistic materials and skin texture, professional photography",
    local: { lora: { name: "photorealistic", strength: 0.6 } },
  },
  {
    id: "cinematic",
    label: "Cinematic film still",
    description: "A frame from a movie — moody color grading and shallow focus; fits most novels.",
    promptSuffix:
      "cinematic film still, dramatic lighting, shallow depth of field, moody color grading, anamorphic framing, subtle film grain",
    local: { lora: { name: "cinematic", strength: 0.7 } },
  },
  {
    id: "anime",
    label: "Anime",
    description: "Crisp cel-shaded anime with vivid colors — light novels, YA, adventure.",
    promptSuffix:
      "anime illustration, cel shading, clean line art, vibrant colors, expressive characters, detailed scenery",
    local: { lora: { name: "anime", strength: 0.8, trigger: "anime" } },
  },
  {
    id: "anime-film",
    label: "Anime film (painterly)",
    description: "Soft, hand-painted animation backgrounds and gentle light — cozy or wistful stories.",
    promptSuffix:
      "painterly anime film still, soft watercolor-tinted backgrounds, warm natural light, gentle pastel palette, hand-painted scenery, nostalgic atmosphere",
    local: { lora: { name: "anime-film", strength: 0.7 } },
  },
  {
    id: "manga",
    label: "Manga (black & white)",
    description: "Inked black-and-white manga with screentones — pairs with the comic-panel view, right-to-left.",
    promptSuffix:
      "black-and-white manga, ink linework, screentone shading, high contrast, speed lines, dynamic composition",
    local: { lora: { name: "manga", strength: 0.8, trigger: "manga, monochrome, greyscale" } },
  },
  {
    id: "comic",
    label: "Comic book",
    description: "Bold western comic art with inked outlines and halftones — pairs with the comic-panel view.",
    promptSuffix:
      "western comic book art, bold ink outlines, halftone shading, saturated flat colors, dramatic framing",
    // No bundled download since 2026-06: the ComicBookRedmond repos went private on
    // Hugging Face (anonymous fetch now 401s) and no reputable ungated SDXL comic
    // LoRA replaces them — the prompt suffix carries the style; drop a LoRA named
    // comic.safetensors into the engine's loras folder to boost it.
    local: { lora: { name: "comic", strength: 0.8, trigger: "Comic Book" } },
  },
  {
    id: "animation-3d",
    label: "Realistic animation (3D)",
    description: "Modern 3D-animated-film look with soft lighting — family stories and adventures.",
    promptSuffix:
      "3D animated film still, stylized realism, soft global illumination, subtle subsurface detail, expressive characters",
    local: {
      lora: {
        name: "animation-3d",
        strength: 0.8,
        trigger: "3D Render Style, 3DRenderAF",
        url: "https://huggingface.co/artificialguybr/3DRedmond-V1/resolve/main/3DRedmond-3DRenderStyle-3DRenderAF.safetensors",
        filename: "animation-3d.safetensors",
        sizeMB: 170,
        family: "sdxl",
      },
    },
  },
  {
    id: "watercolor",
    label: "Watercolor",
    description: "Soft translucent washes on textured paper — literary fiction, poetry, quiet drama.",
    promptSuffix:
      "watercolor painting, soft translucent washes, textured paper, loose expressive brushwork, delicate color bleeds, painterly",
    local: { lora: { name: "watercolor", strength: 0.8, trigger: "watercolor" } },
  },
  {
    id: "oil-painting",
    label: "Oil painting",
    description: "Classical canvas with rich color and dramatic light — historical fiction and epics.",
    promptSuffix:
      "classical oil painting, visible impasto brushstrokes, rich color, chiaroscuro lighting, canvas texture, old-master composition",
    local: { lora: { name: "oil-painting", strength: 0.8, trigger: "oil painting" } },
  },
  {
    id: "pencil-sketch",
    label: "Pencil sketch",
    description: "Hand-drawn graphite with crosshatching — a classic illustrated-novel feel.",
    promptSuffix:
      "detailed graphite pencil sketch, hand-drawn linework, crosshatching and soft smudged shading, monochrome, sketchbook illustration",
    local: { lora: { name: "pencil-sketch", strength: 0.8, trigger: "pencil sketch" } },
  },
  {
    id: "vintage-engraving",
    label: "Vintage engraving",
    description: "19th-century etched book plates, fine parallel lines — classics, gothic tales, fables.",
    promptSuffix:
      "antique book-plate engraving, fine etched parallel linework, woodcut hatching, monochrome ink, dramatic shading, 19th-century illustration",
    local: { lora: { name: "vintage-engraving", strength: 0.8 } },
  },
  {
    id: "storybook",
    label: "Storybook",
    description: "Warm, whimsical gouache for all ages — children's books and gentle fantasy.",
    promptSuffix:
      "children's storybook illustration, soft gouache, warm and whimsical, friendly rounded shapes, cozy colors",
    local: {
      lora: {
        name: "storybook",
        strength: 0.8,
        // V2 of the Redmond storybook LoRA (V1's published filename changed); the
        // trigger is the model's actual training tag, from the repo's README.
        trigger: "KidsRedmAF, Kids Book",
        url: "https://huggingface.co/artificialguybr/StoryBookRedmond-V2/resolve/main/StorybookRedmondV2-KidsBook-KidsRedmAF.safetensors",
        filename: "storybook.safetensors",
        sizeMB: 163,
        family: "sdxl",
      },
    },
  },
  {
    id: "art-nouveau",
    label: "Art nouveau",
    description: "Ornate flowing lines and decorative borders in muted gold — fairy tales, romance, myth.",
    promptSuffix:
      "art nouveau illustration, ornate flowing linework, decorative floral framing, flat muted gold and jewel tones, elegant poster composition",
    local: { lora: { name: "art-nouveau", strength: 0.8, trigger: "art nouveau" } },
  },
  {
    id: "dark-fantasy",
    label: "Dark fantasy",
    description: "Grim, shadowy painted fantasy with a desaturated palette — grimdark, horror, gothic.",
    promptSuffix:
      "dark fantasy painting, grim foreboding atmosphere, deep ominous shadows, desaturated muted palette, intricate gothic detail, faint cold rim light",
    local: { lora: { name: "dark-fantasy", strength: 0.8, trigger: "dark fantasy" } },
  },
  {
    id: "noir",
    label: "Film noir",
    description: "High-contrast black & white, hard shadows and silhouettes — mysteries and crime.",
    promptSuffix:
      "film noir style, high-contrast black and white, hard dramatic shadows, venetian-blind and street-lamp lighting, silhouettes, moody atmosphere",
    local: { lora: { name: "noir", strength: 0.8, trigger: "film noir" } },
  },
  {
    id: "pixel-art",
    label: "Pixel art",
    description: "Retro 16-bit game scenes with a limited palette — a playful take on any story.",
    promptSuffix:
      "detailed pixel art, 16-bit retro video game scene, limited color palette, crisp clean pixels, atmospheric dithering",
    local: { lora: { name: "pixel-art", strength: 0.8, trigger: "pixel art" } },
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

/**
 * The text model the DESKTOP app ships and auto-runs (the "built-in" backend):
 * a small GGUF served by a bundled llama.cpp `llama-server`, which the Rust shell
 * launches on first use (see `ensure_llm`). The renderer points the ordinary
 * `LocalServerProvider` at it (it's OpenAI-compatible), so no new provider is
 * needed. These values are the renderer-side facts (label, the model id the
 * server reports, a safe default context); the actual binary/GGUF URLs live in
 * the Rust shell + `llm-setup.bat`. Keep `model` in sync with what the server
 * loads (we name it explicitly so `/v1/models` is predictable).
 */
export const BUNDLED_LLM = {
  /** Model id passed to the local-server provider / reported by llama-server. */
  model: "Llama-3.2-3B-Instruct",
  /** Friendly label for Settings + provider diagnostics. */
  label: "Built-in: Llama 3.2 3B",
  /** Conservative context budget (the bundled server is launched with -c 8192). */
  contextTokens: 8192,
} as const;

