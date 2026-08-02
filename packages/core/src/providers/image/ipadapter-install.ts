/**
 * What a local ComfyUI needs on disk before a reference photo can condition a render.
 *
 * The reference-image workflow was BUILT and never SET UP. The backend detects the nodes, builds the
 * graph, allocates a per-character weight budget and degrades gracefully when they're absent — but
 * nothing in the app ever put the nodes or the weights on disk, so every local render quietly fell
 * back to seed-only and the only trace was a console line no reader sees. This module is the missing
 * half: the file list, in the same shape the video-model downloader already takes.
 *
 * TWO PARTS, and both are needed. The node pack (installed by the desktop, which shells out to git)
 * provides the graph nodes; these files are the weights those nodes load. Nodes without weights is
 * the worse of the two failures — the nodes ARE detected, so the app builds the IP-Adapter chain and
 * ComfyUI then fails on a missing model instead of degrading.
 */
import type { ModelFamily } from "./sd-prompt.js";

/** One downloadable IP-Adapter file, with the ComfyUI models subfolder it belongs in. */
export interface IpAdapterDownload {
  filename: string;
  url: string;
  folder: "ipadapter" | "clip_vision";
  /** Roughly how big, for the "this is a big download" line. */
  sizeMB: number;
  /** What it's for, in the reader's terms. */
  note: string;
}

const IPADAPTER_REPO = "https://huggingface.co/h94/IP-Adapter/resolve/main";

/**
 * The smallest set that makes reference photos work on both SD families.
 *
 * One CLIP-Vision encoder (ViT-H) serves both adapters — it's the piece that READS the photo, and
 * it's also the biggest single file, so it is deliberately shared rather than fetched per family.
 * The SDXL adapter is the one most installs need; the SD 1.5 one is small enough that splitting the
 * download into two buttons would cost more in confusion than it saves in bytes.
 */
export const IPADAPTER_DOWNLOADS: readonly IpAdapterDownload[] = [
  {
    filename: "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors",
    url: `${IPADAPTER_REPO}/models/image_encoder/model.safetensors`,
    folder: "clip_vision",
    sizeMB: 2528,
    note: "Reads the reference photo (shared by both adapters)",
  },
  {
    filename: "ip-adapter_sdxl_vit-h.safetensors",
    url: `${IPADAPTER_REPO}/sdxl_models/ip-adapter_sdxl_vit-h.safetensors`,
    folder: "ipadapter",
    sizeMB: 700,
    note: "For SDXL checkpoints",
  },
  {
    filename: "ip-adapter_sd15.safetensors",
    url: `${IPADAPTER_REPO}/models/ip-adapter_sd15.safetensors`,
    folder: "ipadapter",
    sizeMB: 44,
    note: "For SD 1.5 checkpoints",
  },
];

/** Total download size in GB, rounded up to one decimal — for the button's warning. */
export function ipAdapterDownloadSizeGB(files: readonly IpAdapterDownload[] = IPADAPTER_DOWNLOADS): number {
  return Math.round((files.reduce((n, f) => n + f.sizeMB, 0) / 1024) * 10) / 10;
}

/**
 * Which checkpoint families a local reference photo can condition, stated where the INSTALLER can
 * see it as well as the backend.
 *
 * IP-Adapter resolves its weights from the base model's architecture and the weights that exist are
 * the SD ones — so offering the download beside a Flux-only install would be selling something that
 * cannot work. `ipAdapterSupports` in the backend is the enforcement; this is the same fact, phrased
 * for a person.
 */
export const IPADAPTER_SUPPORTED_FAMILIES: readonly ModelFamily[] = ["sd15", "sdxl"];

/**
 * Is a reference photo usable with this local setup, and if not, why not? PURE.
 *
 * Three different "no"s that the reader used to experience as one silent nothing: no nodes, no
 * weights, or a checkpoint IP-Adapter can't attach to. Each needs a different action, so each gets
 * its own answer rather than a shared "not working".
 */
export function ipAdapterReadiness(state: {
  nodesInstalled: boolean;
  modelsInstalled: boolean;
  family?: ModelFamily;
}): { ready: boolean; reason?: "nodes" | "models" | "family" } {
  if (state.family && !IPADAPTER_SUPPORTED_FAMILIES.includes(state.family))
    return { ready: false, reason: "family" };
  if (!state.nodesInstalled) return { ready: false, reason: "nodes" };
  if (!state.modelsInstalled) return { ready: false, reason: "models" };
  return { ready: true };
}

/** The one-line explanation for a readiness reason, in the reader's terms. PURE. */
export function ipAdapterReadinessMessage(reason: "nodes" | "models" | "family" | undefined): string {
  switch (reason) {
    case "nodes":
      return "Reference photos need the IP-Adapter nodes — install them below, then restart the engine.";
    case "models":
      return "The IP-Adapter nodes are installed but their models aren't — download them below.";
    case "family":
      return "This checkpoint can't use reference photos locally (IP-Adapter attaches to SD 1.5 and SDXL only). Gemini and gpt-image-1 can use them on any of their models.";
    default:
      return "Reference photos are ready — add them per character in the Characters panel.";
  }
}
