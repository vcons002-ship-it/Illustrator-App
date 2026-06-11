import { useState } from "react";
import {
  IMAGE_PROVIDERS,
  IMAGE_STYLES,
  catalogEntryForModel,
  resolveModelFamily,
  samplerFor,
  LOCAL_TEXT_MODELS,
  LOCAL_TEXT_SERVER_DEFAULT_URL,
  LOCAL_TEXT_SERVER_LABEL,
  DEFAULT_LOCAL_TEXT_SERVER,
  TEXT_PROVIDERS,
  LOCAL_IMAGE_MODELS,
  OLLAMA_TEXT_MODELS,
  getImageStyle,
  getProvider,
  ollamaModelMatches,
  qualityProfile,
  resolveAssetName,
  resolveQuality,
  styleLoraDownload,
  type LocalTextServerId,
  type ProviderInfo,
} from "@visual-reader/core";

/**
 * Settings: pick a text provider and an image provider independently, each with
 * its own remembered key, plus the local-model picker when "On my computer" is
 * chosen. Keys are handed to the host to encrypt + persist. Provider lists come
 * from the core catalog so the UI and the engine wiring never drift.
 */

export type TextProviderId = "claude" | "gemini" | "openai" | "local";
export type ImageProviderId = "flux" | "gemini" | "openai" | "local";
/** Which local engine HTTP API to speak when the image provider is "local". */
export type LocalBackendId = "comfyui" | "a1111";

/** Default localhost URL for each local engine, used as the field placeholder. */
export const LOCAL_ENGINE_DEFAULT_URL: Record<LocalBackendId, string> = {
  comfyui: "http://127.0.0.1:8188",
  a1111: "http://127.0.0.1:7860",
};

const LOCAL_BACKEND_LABEL: Record<LocalBackendId, string> = {
  a1111: "AUTOMATIC1111",
  comfyui: "ComfyUI",
};

/** ComfyUI sampler / scheduler choices offered in Advanced (blank = per-model default). */
const SAMPLER_OPTIONS = [
  "euler",
  "euler_ancestral",
  "dpmpp_2m",
  "dpmpp_2m_sde",
  "res_multistep",
  "uni_pc",
] as const;
const SCHEDULER_OPTIONS = ["simple", "normal", "karras", "sgm_uniform", "beta"] as const;

export interface ReaderSettings {
  textProvider: TextProviderId;
  imageProvider: ImageProviderId;
  /** Per-provider API keys, keyed by provider id (e.g. keys.claude, keys.flux). */
  keys: Record<string, string>;
  /** Chosen local image checkpoint. */
  localModel?: string;
  /** On-device text model id (WebLLM) when textProvider is "local". */
  localTextModel?: string;
  /** Under textProvider "local": run on-device (WebGPU) or via a local server. */
  localTextBackend?: "webgpu" | "server";
  /** Which local LLM server kind (sets the default URL/label), for the server path. */
  localTextServer?: LocalTextServerId;
  /** Base URL of the local LLM server you run yourself (persisted). */
  localServerTextUrl?: string;
  /** Chosen model id reported by the local LLM server. */
  localServerTextModel?: string;
  /** Art style id applied to every illustration (see catalog IMAGE_STYLES). */
  imageStyle?: string;
  /**
   * Manual style-LoRA choice for the local engine, overriding the style's automatic
   * mapping: "" / undefined = automatic, "none" = prompt-only (no LoRA), or an installed
   * LoRA filename to force that one. Lets you use any LoRA in the engine's folder.
   */
  styleLoraOverride?: string;
  /**
   * Force the local image model family for prompt formatting when auto-detection
   * from the checkpoint name is wrong. "auto" (default) detects it. SD families get
   * quality tags + a negative prompt; Flux gets plain natural language.
   */
  imageModelFamily?: "auto" | "sd15" | "sdxl" | "flux" | "flux2" | "zimage" | "qwenimage";
  /**
   * How many pages share one illustration: any positive number, or a whole
   * "chapter". A group never crosses a chapter boundary, so a number larger than
   * a chapter's page count just yields one image for that chapter. Fewer pages →
   * frequent, draftier images; more → rarer, higher-quality. Default 3.
   */
  pagesPerImage?: number | "chapter";
  /**
   * Image quality: "auto" scales with pagesPerImage; or pick a level explicitly.
   * Higher levels use more steps + resolution (slower). Default "auto".
   */
  imageQuality?: "auto" | "draft" | "standard" | "high" | "ultra";
  /**
   * Canvas orientation: "square" (1:1, default), "portrait" (2:3), or "landscape" (3:2).
   * Portrait/landscape keep the same pixel area as the square at that quality level.
   */
  aspectRatio?: "square" | "portrait" | "landscape";
  /**
   * Reader-only multi-panel comic view: compose this many consecutive unit images into
   * one comic-page grid (chapter-aware). 1 (default) = today's single image; 4/6/9 grids.
   */
  panelsPerView?: 1 | 4 | 6 | 9;
  /**
   * Prompt the model to draw a SINGLE image laid out as a multi-panel comic page (comic/
   * manga styles only). Independent of `panelsPerView`. Off by default.
   */
  drawAsComicPage?: boolean;
  /**
   * When to start illustrating: "book" reads the whole book first so prompts have
   * full context (best images, slower start); "chapter" starts as each chapter is
   * analysed (faster first image). Default "book".
   */
  illustrateAfter?: "book" | "chapter";
  /** Manual override of a split-file model's text-encoder / VAE file (Flux.2 etc.) when
   * auto-detection picks the wrong one. Exact filename as the engine lists it; "" = auto. */
  localTextEncoder?: string;
  localVae?: string;
  /** Advanced manual sampler overrides for local ComfyUI: step count and CFG/guidance
   * scale. Unset/undefined = the family/catalog default. */
  localSteps?: number | undefined;
  localCfg?: number | undefined;
  /** Advanced manual sampler / scheduler choice for local ComfyUI; "" = per-model default. */
  localSampler?: string;
  localScheduler?: string;
  /**
   * Detected primary-GPU VRAM in MB (desktop only; transient — set at runtime, not
   * persisted). Caps Auto image-quality to a canvas the card can render.
   */
  gpuVramMb?: number;
  /**
   * Scientific sources (technical books). `searchEngineId` is the Programmable Search
   * Engine id ("cx") paired with a Custom Search API key stored as `keys.search`;
   * together they enable retrieving REAL figures/diagrams before generating one.
   * `groundFacts` grounds Gemini's technical analysis in Google Search (same Gemini key).
   */
  searchEngineId?: string;
  groundFacts?: boolean;
  /** Which local engine API to talk to (browser "your own server" path). */
  localBackend?: LocalBackendId;
  /** Base URL of a local engine you run yourself (browser path; persisted). */
  localServerUrl?: string;
  /**
   * "One API" native mode (opt-in): when the same vendor (Gemini/OpenAI) drives both
   * text and images, render through that vendor's MULTIMODAL endpoint so character
   * reference photos condition cloud renders. Only takes effect when the slots match.
   */
  nativeIllustration?: boolean;
  /** Experimental: under native mode, let the model read the passage and draw it in one
   * step (passage text → image) instead of rendering the pre-written scene prompt. */
  nativeOneShot?: boolean;
  /** Advanced: pin a specific cloud image model id (e.g. a newer Gemini image model).
   * Empty/unset = auto-select the best model the key can access. */
  imageModel?: string;
  /** True once the first-run wizard has been completed. */
  configured?: boolean;
  /** Transient: base URL of the app-managed local engine (desktop; not persisted). */
  engineBaseUrl?: string;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  textProvider: "claude",
  imageProvider: "flux",
  keys: {},
};

/** A downloaded local model reported by the running engine. */
export interface InstalledModel {
  id: string;
  label: string;
}

export interface SettingsPanelProps {
  value: ReaderSettings;
  onChange: (next: ReaderSettings) => void;
  /** True when running inside the desktop app (enables the local GPU engine). */
  isDesktop?: boolean;
  /** Models the running engine has downloaded. */
  installedModels?: InstalledModel[];
  /** Start downloading a curated model; desktop only. */
  onDownloadModel?: (id: string) => void;
  /** Download a checkpoint from a pasted URL into the managed engine. */
  onDownloadModelUrl?: (url: string) => void;
  /** Download progress 0..100 per catalog model/LoRA id (desktop). */
  downloadProgress?: Record<string, number>;
  /** Which component file of a split-file model is downloading (per catalog id). */
  downloadStage?: Record<string, string>;
  /** Status line for the app-managed engine setup (desktop), e.g. "Starting…". */
  engineStatus?: string;
  /** LoRA filenames installed in the managed engine (style auto-download). */
  installedLoras?: string[];
  /** Detected base-model family per installed LoRA filename (desktop), for mismatch flags. */
  loraFamilies?: Record<string, string>;
  /** Download the matching LoRA for a style; optional URL overrides the catalog. */
  onDownloadStyleLora?: (styleId: string, url?: string) => void;
  /** Connect to a self-hosted engine and load its model list (browser path). */
  onConnectLocalServer?: (backend: LocalBackendId, url: string) => void;
  /** True while a connection attempt is in flight. */
  connectingLocal?: boolean;
  /** Models reported by the local LLM text server (separate from image models). */
  textModels?: InstalledModel[];
  /** Connect to a local LLM server and load its model list. */
  onConnectLocalTextServer?: (server: LocalTextServerId, url: string) => void;
  /** True while a local-text-server connection attempt is in flight. */
  connectingLocalText?: boolean;
  /** Download a text model INTO Ollama (`/api/pull`) — no terminal needed. */
  onPullTextModel?: (model: string) => void;
  /** Live pull progress per Ollama model id. */
  pullProgress?: Record<string, { status: string; percent?: number }>;
}

export function SettingsPanel({
  value,
  onChange,
  isDesktop = false,
  installedModels = [],
  onDownloadModel,
  onDownloadModelUrl,
  downloadProgress = {},
  downloadStage = {},
  engineStatus = "",
  installedLoras = [],
  loraFamilies = {},
  onDownloadStyleLora,
  onConnectLocalServer,
  connectingLocal = false,
  textModels = [],
  onConnectLocalTextServer,
  connectingLocalText = false,
  onPullTextModel,
  pullProgress = {},
}: SettingsPanelProps) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<ReaderSettings>) => onChange({ ...value, ...patch });
  const setKey = (id: string, key: string) => set({ keys: { ...value.keys, [id]: key } });

  const textInfo = getProvider("text", value.textProvider);
  const imageInfo = getProvider("image", value.imageProvider);

  // Resolved per-model sampler defaults, surfaced in the Advanced "auto = …" placeholders
  // so the user can see what blank actually does (mirrors the backend's resolution order:
  // catalog entry's own sampler → family default).
  const localFamily = resolveModelFamily(
    value.imageModelFamily && value.imageModelFamily !== "auto" ? value.imageModelFamily : undefined,
    value.localModel ?? "",
  );
  const localBaseSampler = catalogEntryForModel(value.localModel ?? "")?.sampler ?? samplerFor(localFamily);
  const defaultCfg = localBaseSampler.guidance ?? localBaseSampler.cfg;

  return (
    <div style={{ fontSize: 13 }}>
      <button onClick={() => setOpen((o) => !o)} style={buttonStyle}>
        {open ? "Hide settings" : "Settings"}
      </button>
      {open && (
        <div style={panelStyle}>
          <div style={sectionHeaderStyle}>
            <span>1 · Read &amp; analyse — text model</span>
            <span style={sectionHintStyle}>
              Reads the book, learns characters/places, writes the illustration prompts. Changes
              apply via ↻ Redo → Story analysis (or → Prompts).
            </span>
          </div>
          <label style={rowStyle}>
            <span>Text (story understanding)</span>
            <select
              value={value.textProvider}
              onChange={(e) => set({ textProvider: e.target.value as TextProviderId })}
            >
              {TEXT_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {textInfo?.needsKey && <KeyField info={textInfo} value={value.keys[textInfo.id] ?? ""} onChange={(k) => setKey(textInfo.id, k)} />}
          {value.textProvider === "local" && (
            <div style={rowStyle}>
              <span>How to run it</span>
              <select
                value={value.localTextBackend ?? "webgpu"}
                onChange={(e) => set({ localTextBackend: e.target.value as "webgpu" | "server" })}
              >
                <option value="webgpu">On-device (WebGPU, no install)</option>
                <option value="server">Local server (Ollama / LM Studio / llama.cpp)</option>
              </select>
              {(value.localTextBackend ?? "webgpu") === "webgpu" ? (
                <label style={rowStyle}>
                  <span>On-device text model</span>
                  <select
                    value={value.localTextModel ?? LOCAL_TEXT_MODELS[0]!.id}
                    onChange={(e) => set({ localTextModel: e.target.value })}
                  >
                    {LOCAL_TEXT_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} · {m.downloadGB} GB{m.note ? ` · ${m.note}` : ""}
                      </option>
                    ))}
                  </select>
                  <span style={{ opacity: 0.6, fontSize: 12 }}>
                    Runs on your GPU (WebGPU); the model downloads once on first use. No
                    WebGPU → falls back to demo text. Tip: keep Text on a cloud key for
                    the best story understanding while images run locally.
                  </span>
                </label>
              ) : (
                <LocalTextServer
                  server={value.localTextServer ?? DEFAULT_LOCAL_TEXT_SERVER}
                  url={value.localServerTextUrl ?? ""}
                  selected={value.localServerTextModel}
                  textModels={textModels}
                  connecting={connectingLocalText}
                  onSet={set}
                  onSelect={(id) => set({ localServerTextModel: id })}
                  onConnect={onConnectLocalTextServer}
                  onPull={onPullTextModel}
                  pullProgress={pullProgress}
                />
              )}
            </div>
          )}

          <label style={rowStyle}>
            <span>Illustrate after</span>
            <select
              value={value.illustrateAfter ?? "book"}
              onChange={(e) =>
                set({ illustrateAfter: e.target.value as "book" | "chapter" })
              }
              title="Whole book: read everything first for the most relevant images. Each chapter: faster first image."
            >
              <option value="book">Reading whole book (best context)</option>
              <option value="chapter">Each chapter done (faster)</option>
            </select>
          </label>

          <div style={sectionHeaderStyle}>
            <span>2 · Paint — image model</span>
            <span style={sectionHintStyle}>
              New paintings always use these settings. Apply them to already-painted pictures
              with ↻ Redo → All images (or → This image).
            </span>
          </div>
          <label style={rowStyle}>
            <span>Images</span>
            <select
              value={value.imageProvider}
              onChange={(e) => set({ imageProvider: e.target.value as ImageProviderId })}
            >
              {IMAGE_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {imageInfo?.needsKey && <KeyField info={imageInfo} value={value.keys[imageInfo.id] ?? ""} onChange={(k) => setKey(imageInfo.id, k)} />}

          <label style={rowStyle}>
            <span>Art style</span>
            <select value={value.imageStyle ?? "auto"} onChange={(e) => set({ imageStyle: e.target.value })}>
              {IMAGE_STYLES.map((s) => (
                <option key={s.id} value={s.id} title={s.description}>
                  {s.label}
                </option>
              ))}
            </select>
            <span style={{ opacity: 0.55, fontSize: 11 }}>
              {getImageStyle(value.imageStyle).description}
            </span>
          </label>

          {value.imageProvider === "local" && (
            <label style={rowStyle}>
              <span>Model family (local)</span>
              <select
                value={value.imageModelFamily ?? "auto"}
                onChange={(e) =>
                  set({
                    imageModelFamily: e.target.value as
                      | "auto"
                      | "sd15"
                      | "sdxl"
                      | "flux"
                      | "flux2"
                      | "zimage"
                      | "qwenimage",
                  })
                }
                title="How prompts are formatted and the model is loaded. Auto detects from the checkpoint name. SD1.5/SDXL get quality tags + a negative prompt; the newer families get plain natural language. Flux.2 / Z-Image / Qwen-Image load via their separate text encoder + VAE (ComfyUI only). Override if auto-detection is wrong."
              >
                <option value="auto">Auto-detect</option>
                <option value="sd15">Stable Diffusion 1.5</option>
                <option value="sdxl">SDXL</option>
                <option value="flux">Flux.1</option>
                <option value="flux2">Flux.2</option>
                <option value="zimage">Z-Image</option>
                <option value="qwenimage">Qwen-Image</option>
              </select>
            </label>
          )}

          <div style={rowStyle}>
            <span>Pages per image</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="number"
                min={1}
                step={1}
                style={{ width: 80 }}
                value={value.pagesPerImage === "chapter" ? "" : String(value.pagesPerImage ?? 3)}
                disabled={value.pagesPerImage === "chapter"}
                onChange={(e) => {
                  const n = Math.max(1, Math.floor(Number(e.target.value) || 1));
                  set({ pagesPerImage: n });
                }}
                title="How many pages share one illustration. Fewer = frequent/draftier; more = rarer/higher quality. Never crosses a chapter (a bigger number than the chapter just makes one image for it)."
              />
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={value.pagesPerImage === "chapter"}
                  onChange={(e) => set({ pagesPerImage: e.target.checked ? "chapter" : 3 })}
                />
                <span>Whole chapter (one image per chapter)</span>
              </label>
            </div>
          </div>

          <label style={rowStyle}>
            <span>Image quality</span>
            <select
              value={value.imageQuality ?? "auto"}
              onChange={(e) =>
                set({
                  imageQuality: e.target.value as "auto" | "draft" | "standard" | "high" | "ultra",
                })
              }
              title="Auto scales with pages-per-image. Higher levels use more steps + a larger canvas (slower, more VRAM). Override to save time or fit your GPU."
            >
              <option value="auto">
                Auto → {autoQualityLabel(value.pagesPerImage ?? 3)} (scales with pages-per-image)
              </option>
              <option value="draft">Draft · {qualityProfile("draft").width}px · fastest</option>
              <option value="standard">Standard · {qualityProfile("standard").width}px</option>
              <option value="high">High · {qualityProfile("high").width}px</option>
              <option value="ultra">Ultra · {qualityProfile("ultra").width}px · slowest</option>
            </select>
            <span style={{ opacity: 0.55, fontSize: 11 }}>
              Auto by pages-per-image: 1 → Draft, 2–4 → Standard, 5–7 → High, 8+ or whole chapter →
              Ultra. Pick a fixed level to render faster or if a big canvas is too much for your GPU.
              Local models cap the canvas to what they handle well (Flux/Flux.2/Qwen ≤ 1536, Z-Image
              ≤ 1280, SDXL ≤ 1024, SD1.5 ≤ 768).
            </span>
          </label>

          <label style={rowStyle}>
            <span>Aspect ratio</span>
            <select
              value={value.aspectRatio ?? "square"}
              onChange={(e) =>
                set({ aspectRatio: e.target.value as "square" | "portrait" | "landscape" })
              }
              title="Canvas shape. Portrait/landscape keep the same pixel area (and render time) as the square at the same quality level."
            >
              <option value="square">Square · 1:1</option>
              <option value="portrait">Portrait · 2:3 (tall)</option>
              <option value="landscape">Landscape · 3:2 (wide)</option>
            </select>
          </label>

          <label style={rowStyle}>
            <span>Comic panels per view</span>
            <select
              value={String(value.panelsPerView ?? 1)}
              onChange={(e) =>
                set({ panelsPerView: Number(e.target.value) as 1 | 4 | 6 | 9 })
              }
              title="Show several consecutive illustrations together as one comic page (a 2×2 / 2×3 / 3×3 grid). Each panel is still its own image — grids never cross a chapter, and the current panel highlights as you read. Manga style reads right-to-left."
            >
              <option value="1">Single image (off)</option>
              <option value="4">4 panels · 2×2</option>
              <option value="6">6 panels · 2×3</option>
              <option value="9">9 panels · 3×3</option>
            </select>
            <span style={{ opacity: 0.55, fontSize: 11 }}>
              A reading view only — composes images you already render into a comic page.
              Works with every model and keeps characters consistent panel-to-panel.
            </span>
          </label>

          {(value.imageStyle === "comic" || value.imageStyle === "manga") && (
            <label style={{ ...rowStyle, flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={value.drawAsComicPage ?? false}
                onChange={(e) => set({ drawAsComicPage: e.target.checked })}
              />
              <span>
                Draw each image as a multi-panel comic page
                <span style={{ display: "block", opacity: 0.55, fontSize: 11 }}>
                  Asks the model to lay out one image as several panels with gutters. Best on
                  natural-language / cloud models; results vary on SD checkpoints.
                </span>
              </span>
            </label>
          )}

          <details style={rowStyle}>
            <summary style={{ cursor: "pointer", fontSize: 13, opacity: 0.85 }}>
              Scientific sources (technical books)
            </summary>
            <p style={{ opacity: 0.6, fontSize: 11, margin: "4px 0 8px" }}>
              For books imported as <em>technical</em>: retrieve REAL figures/diagrams (correct
              labels and data) before generating one, and ground the analysis in Google Search.
              Image retrieval needs a <b>Custom Search API key</b> (Google Cloud console →
              enable “Custom Search API” → credentials) and a <b>Programmable Search Engine
              id</b> (programmablesearchengine.google.com → create an engine → enable “Image
              search” + “Search the entire web” → copy its ID). Free tier: 100 searches/day.
              Already using a Gemini key? It can double as the search key — enable “Custom
              Search API” on that key’s Google Cloud project and leave the key field blank.
              The engine ID (cx) is still required either way.
            </p>
            <label style={rowStyle}>
              <span>Custom Search API key</span>
              <input
                type="password"
                value={value.keys.search ?? ""}
                placeholder="AIza… (blank = reuse the Gemini key, if Custom Search API is enabled on it)"
                onChange={(e) => setKey("search", e.target.value.trim())}
              />
            </label>
            <label style={rowStyle}>
              <span>Search engine ID (cx)</span>
              <input
                value={value.searchEngineId ?? ""}
                placeholder="e.g. a1b2c3d4e5f6g7h8i"
                onChange={(e) => set({ searchEngineId: e.target.value.trim() })}
              />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={value.groundFacts ?? false}
                onChange={(e) => set({ groundFacts: e.target.checked })}
              />
              <span>
                Ground analysis in real sources (cited in the book’s glossary). With the
                Gemini text provider this uses its built-in Google Search; with any other
                reader — including a local LLM — it uses the Search engine above, so the
                facts are sourced regardless of which model reads the book.
              </span>
            </label>
          </details>

          {sameVendorNative(value) && <NativeModeRow value={value} set={set} />}

          {isDesktop && value.imageProvider === "local" && (
            <StyleLoraRow
              styleId={value.imageStyle ?? "auto"}
              family={localFamily}
              installedLoras={installedLoras}
              progress={downloadProgress}
              onDownload={onDownloadStyleLora}
            />
          )}

          {value.imageProvider === "local" && installedLoras.length > 0 && (
            (() => {
              // Flag a chosen LoRA whose detected base architecture differs from the active
              // model — it won't load. (Detection reads the LoRA's safetensors header; an
              // unknown/undetected LoRA is never flagged.)
              const chosen = value.styleLoraOverride;
              const chosenFamily = chosen ? loraFamilies[chosen] : undefined;
              const mismatch =
                chosenFamily && localFamily !== "unknown" && chosenFamily !== localFamily;
              const fam = (name: string): string =>
                loraFamilies[name] ? ` · ${loraFamilies[name]!.toUpperCase()}` : "";
              return (
                <label style={rowStyle}>
                  <span>Style LoRA (override)</span>
                  <select
                    value={value.styleLoraOverride ?? ""}
                    onChange={(e) => set({ styleLoraOverride: e.target.value })}
                    title="Pick any LoRA installed in the engine's loras folder to use with the current style, or turn LoRAs off. Overrides the style's automatic pack. The tag shows each LoRA's detected base model."
                  >
                    <option value="">Automatic (match the art style)</option>
                    <option value="none">None — prompt-only styling</option>
                    {installedLoras.map((name) => (
                      <option key={name} value={name}>
                        {name}
                        {fam(name)}
                      </option>
                    ))}
                  </select>
                  {mismatch ? (
                    <span style={{ opacity: 0.85, fontSize: 11, color: "#e0716f" }}>
                      ⚠ This LoRA is {chosenFamily!.toUpperCase()} but your model is{" "}
                      {localFamily.toUpperCase()} — it won’t load. Pick a {localFamily.toUpperCase()}
                      -compatible LoRA, or the prompt style alone will be used.
                    </span>
                  ) : (
                    <span style={{ opacity: 0.55, fontSize: 11 }}>
                      A LoRA must match your model’s family (the tag shows each one’s detected base
                      model). The art-style prompt is always applied regardless.
                    </span>
                  )}
                </label>
              );
            })()
          )}

          {value.imageProvider === "local" && (
            <LocalEngine
              isDesktop={isDesktop}
              installedModels={installedModels}
              backend={value.localBackend ?? "a1111"}
              serverUrl={value.localServerUrl ?? ""}
              selected={value.localModel}
              connecting={connectingLocal}
              downloadProgress={downloadProgress}
              downloadStage={downloadStage}
              engineStatus={engineStatus}
              onSet={set}
              onSelect={(id) => set({ localModel: id })}
              onDownload={onDownloadModel}
              onDownloadModelUrl={onDownloadModelUrl}
              onConnect={onConnectLocalServer}
            />
          )}

          {value.imageProvider === "local" && (
            <details style={rowStyle}>
              <summary style={{ cursor: "pointer", fontSize: 13, opacity: 0.85 }}>
                Advanced: model files &amp; sampler (local engine)
              </summary>
              <p style={{ opacity: 0.6, fontSize: 11, margin: "4px 0 8px" }}>
                Split-file models (Flux.2 / Z-Image / Qwen-Image) load a separate text encoder +
                VAE — the app auto-detects them, but you can pin the exact filename (as ComfyUI
                lists it in <code>models/text_encoders</code> / <code>models/vae</code>). The
                sampler fields override the per-model defaults. Leave any field blank to auto.
              </p>
              <label style={rowStyle}>
                <span>Text encoder file</span>
                <input
                  value={value.localTextEncoder ?? ""}
                  placeholder="auto — e.g. qwen_3_8b_fp8mixed.safetensors"
                  onChange={(e) => set({ localTextEncoder: e.target.value.trim() })}
                />
              </label>
              <label style={rowStyle}>
                <span>VAE file</span>
                <input
                  value={value.localVae ?? ""}
                  placeholder="auto — e.g. full_encoder_small_decoder.safetensors"
                  onChange={(e) => set({ localVae: e.target.value.trim() })}
                />
              </label>
              <label style={rowStyle}>
                <span>Sampler steps</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={value.localSteps ?? ""}
                  placeholder={`auto = ${localBaseSampler.steps} steps (per model)`}
                  onChange={(e) =>
                    set({ localSteps: e.target.value === "" ? undefined : Math.max(1, Math.floor(Number(e.target.value) || 1)) })
                  }
                />
                <span style={{ opacity: 0.55, fontSize: 11 }}>
                  How many denoising passes. More = more detail/coherence but slower; too many
                  rarely helps. Flux ≈ 20–28, SDXL ≈ 25–35, turbo models ≈ 6–10.
                </span>
              </label>
              <label style={rowStyle}>
                <span>CFG / guidance</span>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={value.localCfg ?? ""}
                  placeholder={`auto = ${defaultCfg} (per model)`}
                  onChange={(e) => set({ localCfg: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value) || 0) })}
                />
                <span style={{ opacity: 0.55, fontSize: 11 }}>
                  How strictly the image follows the prompt. Higher = more literal but can look
                  over-cooked; lower = looser/softer. Flux/Flux.2-dev use embedded guidance ≈ 3–5;
                  Klein/SDXL use real CFG ≈ 4–7. This sets whichever your model uses.
                </span>
              </label>
              <label style={rowStyle}>
                <span>Sampler</span>
                <select
                  value={value.localSampler ?? ""}
                  onChange={(e) => set({ localSampler: e.target.value })}
                  title="The denoising algorithm. Blank uses the per-model default. dpmpp_2m / dpmpp_2m_sde are strong all-rounders; euler is the safe baseline."
                >
                  <option value="">auto = {localBaseSampler.sampler} (per model)</option>
                  {SAMPLER_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label style={rowStyle}>
                <span>Scheduler</span>
                <select
                  value={value.localScheduler ?? ""}
                  onChange={(e) => set({ localScheduler: e.target.value })}
                  title="How the noise level steps down. Blank uses the per-model default. karras is a common choice for SD; flux/turbo models prefer simple."
                >
                  <option value="">auto = {localBaseSampler.scheduler} (per model)</option>
                  {SCHEDULER_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            </details>
          )}

          <p style={{ opacity: 0.6, margin: "4px 0 0" }}>
            Keys are stored encrypted on this device only.
          </p>
        </div>
      )}
    </div>
  );
}

function KeyField({ info, value, onChange }: { info: ProviderInfo; value: string; onChange: (k: string) => void }) {
  const saved = value.trim().length > 0;
  return (
    <label style={rowStyle}>
      <span style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <span>
          {info.label} key {saved && <span style={{ color: "#7dd87f" }}>✓ saved</span>}
        </span>
        {info.keyUrl && (
          <a href={info.keyUrl} target="_blank" rel="noreferrer" style={{ color: "#9db4ff" }}>
            Get a key ↗
          </a>
        )}
      </span>
      <input
        type="password"
        value={value}
        placeholder={info.keyHint ? `Paste your key (${info.keyHint})` : "Paste your key"}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      {info.keyBlurb && <span style={{ opacity: 0.6, fontSize: 12 }}>{info.keyBlurb}</span>}
    </label>
  );
}

/** A small "paste a URL and fetch" control, reused for models and LoRAs. */
function PasteUrl({ placeholder, onSubmit }: { placeholder: string; onSubmit: (url: string) => void }) {
  const [url, setUrl] = useState("");
  const go = () => {
    if (url.trim()) {
      onSubmit(url.trim());
      setUrl("");
    }
  };
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
      <input
        style={{ flex: 1 }}
        value={url}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setUrl(e.target.value)}
      />
      <button style={buttonStyle} disabled={!url.trim()} onClick={go}>
        Get
      </button>
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div style={{ height: 4, background: "rgba(255,255,255,0.15)", borderRadius: 2, marginTop: 4 }}>
      <div style={{ width: `${pct}%`, height: "100%", background: "#4663d6", borderRadius: 2 }} />
    </div>
  );
}

/**
 * Desktop: get the LoRA that matches the selected style. Three ways — it shows
 * "✓ installed" if a matching LoRA is already in the engine's folder; a
 * "Download style pack" button when the catalog has a source; and always a
 * paste-a-URL field so any LoRA can be fetched for this style.
 */
/** What "Auto" image quality resolves to at the given cadence, e.g. "Ultra (1536px)". */
function autoQualityLabel(pagesPerImage: number | "chapter"): string {
  const level = resolveQuality("auto", pagesPerImage);
  const name = level.charAt(0).toUpperCase() + level.slice(1);
  return `${name} (${qualityProfile(level).width}px)`;
}

/** True when one vendor (Gemini/OpenAI) drives BOTH text and images with a key set —
 * the only situation where "one API" native mode can engage. */
function sameVendorNative(v: ReaderSettings): boolean {
  return (
    v.textProvider === v.imageProvider &&
    (v.imageProvider === "gemini" || v.imageProvider === "openai") &&
    Boolean(v.keys[v.imageProvider])
  );
}

/**
 * "One API" native mode controls, shown only when the same vendor serves text + images.
 * Opt-in because it switches the image MODEL to the vendor's multimodal endpoint (which
 * accepts character reference photos). The experimental one-shot sub-toggle appears once
 * native is on.
 */
function NativeModeRow({
  value,
  set,
}: {
  value: ReaderSettings;
  set: (patch: Partial<ReaderSettings>) => void;
}) {
  const vendor = getProvider("image", value.imageProvider)?.label ?? value.imageProvider;
  return (
    <div style={rowStyle}>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={value.nativeIllustration === true}
          onChange={(e) => set({ nativeIllustration: e.target.checked })}
        />
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span>Native “one API” mode</span>
          <span style={{ opacity: 0.6, fontSize: 11 }}>
            Render through {vendor}’s multimodal model so your uploaded character reference
            photos guide the art (cloud equivalent of local IP-Adapter). Uses a different
            image model than the default.
          </span>
        </span>
      </label>
      {value.nativeIllustration === true && (
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginLeft: 24 }}>
          <input
            type="checkbox"
            checked={value.nativeOneShot === true}
            onChange={(e) => set({ nativeOneShot: e.target.checked })}
          />
          <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span>One-shot drawing (experimental)</span>
            <span style={{ opacity: 0.6, fontSize: 11 }}>
              Let the model read each passage and draw it directly, instead of rendering the
              pre-written scene prompt. Fewer steps, less control over the exact moment.
            </span>
          </span>
        </label>
      )}
    </div>
  );
}

function StyleLoraRow({
  styleId,
  family,
  installedLoras,
  progress,
  onDownload,
}: {
  styleId: string;
  /** The active model's family, so an architecture-incompatible pack isn't offered. */
  family?: string;
  installedLoras: string[];
  progress: Record<string, number>;
  onDownload: ((styleId: string, url?: string) => void) | undefined;
}) {
  const lora = getImageStyle(styleId).local?.lora;
  if (!lora) return null; // style has no LoRA mapping (e.g. "auto")
  const label = getImageStyle(styleId).label;
  const catalog = styleLoraDownload(styleId); // present when the catalog has a URL
  // A curated pack only loads on its own architecture. Offer the one-click download
  // when the active model matches (or we can't tell); otherwise the pack is for a
  // different family — point the user to the override dropdown / paste-a-URL path.
  const packFamily = lora.family;
  const compatible = !packFamily || !family || family === "unknown" || family === packFamily;
  const installed = resolveAssetName(new Set(installedLoras), lora.name) !== undefined;
  const pct = progress[lora.name];
  const downloading = pct !== undefined && pct < 100;
  return (
    <div style={rowStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <span style={{ opacity: 0.8, fontSize: 12 }}>
          {label} style pack (LoRA){catalog?.sizeMB ? ` · ${catalog.sizeMB} MB` : ""}
        </span>
        {installed ? (
          <span style={{ color: "#7dd87f" }}>✓ installed</span>
        ) : downloading ? (
          <span style={{ opacity: 0.7 }}>{Math.round(pct)}%</span>
        ) : catalog && compatible ? (
          <button style={buttonStyle} onClick={() => onDownload?.(styleId)}>
            Download style pack
          </button>
        ) : null}
      </div>
      {downloading && <ProgressBar pct={pct} />}
      {!installed && catalog && !compatible && (
        <span style={{ opacity: 0.7, fontSize: 11, color: "#e0b870" }}>
          The bundled {label} pack is built for {packFamily!.toUpperCase()} and won’t load on your{" "}
          {family!.toUpperCase()} model. Install a {family!.toUpperCase()}-compatible LoRA below (paste a
          URL or drop the file in), then pick it under “Style LoRA (override)”.
        </span>
      )}
      {!installed && !downloading && (
        <PasteUrl
          placeholder={`Or paste a .safetensors LoRA URL for ${label}`}
          onSubmit={(url) => onDownload?.(styleId, url)}
        />
      )}
      <span style={{ opacity: 0.55, fontSize: 11 }}>
        Or drop a LoRA named “{lora.name}.safetensors” into the engine’s loras folder.
      </span>
    </div>
  );
}

/**
 * Local-engine settings. Two ways to generate on your own hardware:
 *  - Desktop: the app-managed engine, with a curated one-click model download.
 *  - Anywhere (incl. the browser): connect to a Stable Diffusion server you run
 *    yourself — AUTOMATIC1111 or ComfyUI — and pick from its installed models.
 */
function LocalEngine({
  isDesktop,
  installedModels,
  backend,
  serverUrl,
  selected,
  connecting,
  downloadProgress,
  downloadStage,
  engineStatus,
  onSet,
  onSelect,
  onDownload,
  onDownloadModelUrl,
  onConnect,
}: {
  isDesktop: boolean;
  installedModels: InstalledModel[];
  backend: LocalBackendId;
  serverUrl: string;
  selected: string | undefined;
  connecting: boolean;
  downloadProgress: Record<string, number>;
  downloadStage: Record<string, string>;
  engineStatus: string;
  onSet: (patch: Partial<ReaderSettings>) => void;
  onSelect: (id: string) => void;
  onDownload: ((id: string) => void) | undefined;
  onDownloadModelUrl: ((url: string) => void) | undefined;
  onConnect: ((backend: LocalBackendId, url: string) => void) | undefined;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {isDesktop && (
        <ManagedEngine
          installedModels={installedModels}
          selected={selected}
          downloadProgress={downloadProgress}
          downloadStage={downloadStage}
          engineStatus={engineStatus}
          onSelect={onSelect}
          onDownload={onDownload}
          onDownloadModelUrl={onDownloadModelUrl}
        />
      )}

      <div style={rowStyle}>
        <span>{isDesktop ? "Or use your own server" : "Your Stable Diffusion server"}</span>
        <select value={backend} onChange={(e) => onSet({ localBackend: e.target.value as LocalBackendId })}>
          {(["a1111", "comfyui"] as LocalBackendId[]).map((id) => (
            <option key={id} value={id}>
              {LOCAL_BACKEND_LABEL[id]}
            </option>
          ))}
        </select>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            style={{ flex: 1 }}
            value={serverUrl}
            placeholder={LOCAL_ENGINE_DEFAULT_URL[backend]}
            onChange={(e) => onSet({ localServerUrl: e.target.value })}
          />
          <button
            style={buttonStyle}
            disabled={connecting}
            onClick={() => onConnect?.(backend, serverUrl.trim() || LOCAL_ENGINE_DEFAULT_URL[backend])}
          >
            {connecting ? "Connecting…" : "Connect"}
          </button>
        </div>
        <ModelSelect installedModels={installedModels} selected={selected} onSelect={onSelect} />
        <span style={{ opacity: 0.6, fontSize: 12 }}>
          Start {LOCAL_BACKEND_LABEL[backend]} with its API and allow this app's origin —
          {backend === "a1111"
            ? " e.g. ./webui.sh --api --cors-allow-origins=" + location.origin
            : " e.g. python main.py --enable-cors-header " + location.origin}
          .
        </span>
      </div>
    </div>
  );
}

/** Desktop app-managed engine: pick a downloaded model or grab a curated one. */
function ManagedEngine({
  installedModels,
  selected,
  downloadProgress,
  downloadStage,
  engineStatus,
  onSelect,
  onDownload,
  onDownloadModelUrl,
}: {
  installedModels: InstalledModel[];
  selected: string | undefined;
  downloadProgress: Record<string, number>;
  downloadStage: Record<string, string>;
  engineStatus: string;
  onSelect: (id: string) => void;
  onDownload: ((id: string) => void) | undefined;
  onDownloadModelUrl: ((url: string) => void) | undefined;
}) {
  // Installed list reports model filenames; match the catalog by (main) filename.
  const installedNames = new Set(installedModels.map((m) => m.id));
  return (
    <div style={rowStyle}>
      <span>Local model (app-managed)</span>
      {engineStatus && <span style={{ opacity: 0.7, fontSize: 12 }}>{engineStatus}</span>}
      <ModelSelect installedModels={installedModels} selected={selected} onSelect={onSelect} />
      <span style={{ opacity: 0.7, fontSize: 12, marginTop: 4 }}>Download a model — we set up the engine:</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
        {LOCAL_IMAGE_MODELS.map((m) => {
          const progress = downloadProgress[m.id];
          const downloading = progress !== undefined && progress < 100;
          const installed = installedNames.has(m.filename);
          return (
            <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                <span style={{ opacity: 0.85 }}>
                  {m.label} · {m.sizeGB} GB{m.note ? ` · ${m.note}` : ""}
                </span>
                {installed ? (
                  <span style={{ color: "#7dd87f" }}>✓ Installed</span>
                ) : downloading ? (
                  <span style={{ opacity: 0.7 }}>{Math.round(progress)}%</span>
                ) : m.url ? (
                  <button style={buttonStyle} onClick={() => onDownload?.(m.id)}>
                    Download
                  </button>
                ) : (
                  // No hosted URL for this one — paste a URL below or drop the file in manually.
                  <span style={{ opacity: 0.6, fontSize: 12 }} title={`Get ${m.filename} yourself and paste its URL below, or drop it into models/checkpoints.`}>
                    manual install
                  </span>
                )}
              </div>
              {downloading && (
                <>
                  {downloadStage[m.id] && (
                    <span style={{ opacity: 0.6, fontSize: 11 }}>{downloadStage[m.id]}</span>
                  )}
                  <div style={{ height: 4, background: "rgba(255,255,255,0.15)", borderRadius: 2 }}>
                    <div style={{ width: `${progress}%`, height: "100%", background: "#4663d6", borderRadius: 2 }} />
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      <span style={{ opacity: 0.7, fontSize: 12, marginTop: 4 }}>Or paste a checkpoint URL:</span>
      <PasteUrl placeholder="Paste a .safetensors checkpoint URL" onSubmit={(url) => onDownloadModelUrl?.(url)} />
      <span style={{ opacity: 0.55, fontSize: 11 }}>
        You can also drop a checkpoint into the engine’s models/checkpoints folder.
      </span>
    </div>
  );
}

/** Connect to an OpenAI-compatible local LLM server and pick one of its models. */
function LocalTextServer({
  server,
  url,
  selected,
  textModels,
  connecting,
  onSet,
  onSelect,
  onConnect,
  onPull,
  pullProgress,
}: {
  server: LocalTextServerId;
  url: string;
  selected: string | undefined;
  textModels: InstalledModel[];
  connecting: boolean;
  onSet: (patch: Partial<ReaderSettings>) => void;
  onSelect: (id: string) => void;
  onConnect: ((server: LocalTextServerId, url: string) => void) | undefined;
  onPull: ((model: string) => void) | undefined;
  pullProgress: Record<string, { status: string; percent?: number }>;
}) {
  const placeholder = LOCAL_TEXT_SERVER_DEFAULT_URL[server];
  return (
    <div style={rowStyle}>
      <span>Local LLM server</span>
      <select value={server} onChange={(e) => onSet({ localTextServer: e.target.value as LocalTextServerId })}>
        {(Object.keys(LOCAL_TEXT_SERVER_LABEL) as LocalTextServerId[]).map((id) => (
          <option key={id} value={id}>
            {LOCAL_TEXT_SERVER_LABEL[id]}
          </option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          style={{ flex: 1 }}
          value={url}
          placeholder={placeholder}
          onChange={(e) => onSet({ localServerTextUrl: e.target.value })}
        />
        <button
          style={buttonStyle}
          disabled={connecting}
          onClick={() => onConnect?.(server, url.trim() || placeholder)}
        >
          {connecting ? "Connecting…" : "Connect"}
        </button>
      </div>
      <ModelSelect installedModels={textModels} selected={selected} onSelect={onSelect} />
      {server === "ollama" && onPull && (
        <OllamaModelMenu textModels={textModels} pullProgress={pullProgress} onPull={onPull} />
      )}
      <span style={{ opacity: 0.6, fontSize: 12 }}>
        {server === "ollama" ? (
          <>
            First time? Run <code>ollama-setup.bat</code> (Windows) or install Ollama from
            ollama.com, then download a model above. In a browser, Ollama needs{" "}
            <code>OLLAMA_ORIGINS={location.origin}</code> (the setup script sets it).
          </>
        ) : (
          <>
            Start {LOCAL_TEXT_SERVER_LABEL[server]} with a model loaded; it allows browser
            requests by default.
          </>
        )}
      </span>
    </div>
  );
}

/**
 * Curated one-click text-model downloads INTO Ollama (`/api/pull` — server-side
 * resumable, so re-clicking after an interruption continues). Plus a free-text
 * field for any other model name from ollama.com/library.
 */
function OllamaModelMenu({
  textModels,
  pullProgress,
  onPull,
}: {
  textModels: InstalledModel[];
  pullProgress: Record<string, { status: string; percent?: number }>;
  onPull: (model: string) => void;
}) {
  return (
    <>
      <span style={{ opacity: 0.7, fontSize: 12, marginTop: 4 }}>Download a text model:</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
        {OLLAMA_TEXT_MODELS.map((m) => {
          const installed = textModels.some((t) => ollamaModelMatches(t.id, m.id));
          const pull = pullProgress[m.id];
          return (
            <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                <span style={{ opacity: 0.85 }}>
                  {m.label} · {m.sizeGB} GB{m.note ? ` · ${m.note}` : ""}
                </span>
                {installed ? (
                  <span style={{ color: "#7dd87f" }}>✓ Installed</span>
                ) : pull ? (
                  <span style={{ opacity: 0.7 }}>
                    {pull.percent !== undefined ? `${Math.round(pull.percent)}%` : pull.status}
                  </span>
                ) : (
                  <button style={buttonStyle} onClick={() => onPull(m.id)}>
                    Download
                  </button>
                )}
              </div>
              {pull?.percent !== undefined && <ProgressBar pct={pull.percent} />}
            </div>
          );
        })}
      </div>
      <PasteUrl placeholder="Or any model name from ollama.com/library" onSubmit={onPull} />
    </>
  );
}

/** Checkpoint dropdown; always includes the current selection so it survives reloads. */
function ModelSelect({
  installedModels,
  selected,
  onSelect,
}: {
  installedModels: InstalledModel[];
  selected: string | undefined;
  onSelect: (id: string) => void;
}) {
  const options = [...installedModels];
  if (selected && !options.some((m) => m.id === selected)) options.unshift({ id: selected, label: selected });
  if (options.length === 0) {
    return <span style={{ opacity: 0.6, fontSize: 12 }}>Connect to load the available models.</span>;
  }
  return (
    <select value={selected ?? ""} onChange={(e) => onSelect(e.target.value)}>
      <option value="" disabled>
        Choose a model…
      </option>
      {options.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </select>
  );
}

const buttonStyle = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.3)",
  color: "inherit",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
} as const;

const panelStyle = {
  marginTop: 8,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  paddingRight: 16, // room for the internal scrollbar so it doesn't overlap inputs
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 8,
  maxWidth: 340,
  // The panel lives in the sticky header; bound its height to the viewport so it
  // gets its OWN scrollbar instead of overflowing the screen (you no longer have
  // to scroll the book to the bottom to reach the last settings).
  maxHeight: "min(70vh, calc(100vh - 96px))",
  overflowY: "auto",
} as const;

const rowStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
} as const;

/** Workflow-stage section header (matches the header bar: 1 Read → 2 Paint). */
const sectionHeaderStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  marginTop: 6,
  paddingTop: 8,
  borderTop: "1px solid rgba(255,255,255,0.12)",
  fontWeight: 600,
} as const;

const sectionHintStyle = {
  fontWeight: 400,
  fontSize: 11,
  opacity: 0.6,
} as const;
