/**
 * Natural-language control of the app's user-facing SETTINGS for the chat buddy:
 * a curated, validated table of settings the reader can change by asking ("turn on
 * mature mode", "set image quality to high", "use portrait orientation"), plus a
 * pure `parseSettingChange` that coerces a free-text field+value into a concrete,
 * type-safe patch (or a helpful error listing the valid options).
 *
 * Deliberately a SUBSET of ReaderSettings — only reversible, self-contained
 * toggles/choices that make sense to set by name. Providers, API keys, model ids,
 * and server URLs are NOT here: those need the Settings UI (pick an installed
 * model, paste a key), so the buddy walks the reader through them with setup_help
 * instead. The host owns ReaderSettings (it lives in the UI package), so keys are
 * plain strings here and the host applies the patch.
 *
 * "Sensitive" settings (mature mode, command execution, task automation) carry a
 * flag so the prompt can tell the buddy to make sure that's really what the reader
 * wants before flipping them — the rest just apply and confirm.
 */

export interface SettingOption {
  /** The concrete value committed to ReaderSettings. */
  value: string | number;
  /** Human label shown back to the reader. */
  label: string;
  /** Extra phrases that should resolve to this option. */
  match: string[];
}

export interface ControllableSetting {
  /** The ReaderSettings key to write. */
  key: string;
  /** Human label ("image quality", "mature mode"). */
  label: string;
  /** Phrases that identify this setting in a request. */
  aliases: string[];
  /** boolean toggle, or a fixed set of options. */
  kind: { type: "boolean" } | { type: "enum"; options: SettingOption[] };
  /** Adult content / shell execution / automation — confirm intent first. */
  sensitive?: boolean;
  /** One-liner for the prompt. */
  describe: string;
}

const ENUM = (options: SettingOption[]) => ({ type: "enum" as const, options });
const BOOL = { type: "boolean" as const };

export const CONTROLLABLE_SETTINGS: ControllableSetting[] = [
  {
    key: "imageQuality",
    label: "image quality",
    aliases: ["image quality", "quality", "render quality"],
    kind: ENUM([
      { value: "auto", label: "auto", match: ["automatic"] },
      { value: "draft", label: "draft", match: ["fast", "low"] },
      { value: "standard", label: "standard", match: ["normal", "medium"] },
      { value: "high", label: "high", match: [] },
      { value: "ultra", label: "ultra", match: ["max", "maximum", "best"] },
    ]),
    describe: "image quality: auto/draft/standard/high/ultra",
  },
  {
    key: "aspectRatio",
    label: "aspect ratio",
    aliases: ["aspect ratio", "orientation", "canvas shape", "image shape"],
    kind: ENUM([
      { value: "square", label: "square", match: ["1:1"] },
      { value: "portrait", label: "portrait", match: ["tall", "vertical", "2:3"] },
      { value: "landscape", label: "landscape", match: ["wide", "horizontal", "3:2"] },
    ]),
    describe: "aspect ratio: square/portrait/landscape",
  },
  {
    key: "panelsPerView",
    label: "comic panels per view",
    aliases: ["panels per view", "comic panels", "panels", "panel grid"],
    kind: ENUM([
      { value: 1, label: "single image", match: ["1", "one", "off", "none"] },
      { value: 4, label: "4-panel grid", match: ["4", "four"] },
      { value: 6, label: "6-panel grid", match: ["6", "six"] },
      { value: 9, label: "9-panel grid", match: ["9", "nine"] },
    ]),
    describe: "comic panels per view: 1 (single)/4/6/9",
  },
  {
    key: "drawAsComicPage",
    label: "comic-page layout",
    aliases: ["comic page", "comic-page layout", "draw as comic", "comic layout", "manga page"],
    kind: BOOL,
    describe: "draw each image as a multi-panel comic page (on/off)",
  },
  {
    key: "allowMature",
    label: "mature mode",
    aliases: ["mature mode", "mature", "adult mode", "nsfw", "content filter", "uncensored"],
    kind: BOOL,
    sensitive: true,
    describe: "mature mode — adults-only, relaxes content filtering (on/off)",
  },
  {
    key: "allowCommands",
    label: "command execution",
    aliases: ["command execution", "run commands", "commands", "shell", "terminal access"],
    kind: BOOL,
    sensitive: true,
    describe: "command execution — let the assistant propose shell commands, desktop, each still approved (on/off)",
  },
  {
    key: "allowTaskAutomation",
    label: "automatic task scheduling",
    aliases: ["task automation", "auto scheduling", "automatic task", "auto task", "task assistant automation", "auto-pilot", "auto pilot"],
    kind: BOOL,
    sensitive: true,
    describe: "automatic task scheduling — let the task assistant schedule/prep without a click each (on/off)",
  },
  {
    key: "nativeIllustration",
    label: "native cloud illustration",
    aliases: ["native illustration", "native mode", "native cloud", "one-api"],
    kind: BOOL,
    describe: "native cloud illustration — render through the text vendor's multimodal model (on/off)",
  },
  {
    key: "groundFacts",
    label: "ground facts in search",
    aliases: ["ground facts", "grounding", "fact grounding", "search grounding"],
    kind: BOOL,
    describe: "ground technical facts in web search (on/off)",
  },
  {
    key: "lowVram",
    label: "low-VRAM mode",
    aliases: ["low vram", "low-vram mode", "lowvram", "low memory"],
    kind: BOOL,
    describe: "low-VRAM mode for the local image engine (on/off)",
  },
  {
    key: "hires",
    label: "high-resolution rendering",
    aliases: ["high resolution", "high-res", "hires", "hi-res", "high res mode", "two-pass upscale", "high detail"],
    kind: BOOL,
    describe: "high-resolution two-pass rendering for the local image engine — renders native then upscales for more detail (on/off)",
  },
];

/** Normalize for matching: lower-case, collapse non-alphanumerics to single spaces. */
function norm(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/** Find the controllable setting a free-text field names (alias phrase match). */
function findControllable(field: string): ControllableSetting | undefined {
  const f = norm(field);
  let best: ControllableSetting | undefined;
  let bestLen = 0;
  for (const s of CONTROLLABLE_SETTINGS) {
    for (const a of [s.key, s.label, ...s.aliases]) {
      const an = norm(a);
      // The longest alias that the field contains (or that contains the field) wins,
      // so "task automation" beats a bare "task" and "image quality" beats "image".
      if ((f.includes(an.trim()) || an.includes(f.trim())) && an.length > bestLen) {
        best = s;
        bestLen = an.length;
      }
    }
  }
  return best;
}

/** Coerce a free-text/boolean/number value to a real boolean, or undefined. */
function coerceBoolean(value: string | number | boolean): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  const v = value.trim().toLowerCase();
  if (["true", "on", "yes", "enable", "enabled", "1", "y"].includes(v)) return true;
  if (["false", "off", "no", "disable", "disabled", "0", "n"].includes(v)) return false;
  return undefined;
}

export type SettingChange =
  | { ok: true; key: string; value: boolean | number | string; label: string; valueLabel: string; sensitive: boolean }
  | { ok: false; error: string };

/**
 * Validate a requested settings change. Returns the concrete patch (key + coerced
 * value + human labels) or a helpful error listing the valid options.
 */
export function parseSettingChange(field: string, value: string | number | boolean): SettingChange {
  const setting = findControllable(field);
  if (!setting) {
    return { ok: false, error: `no controllable setting matches "${field}". You can set: ${CONTROLLABLE_SETTINGS.map((s) => s.label).join(", ")}.` };
  }
  if (setting.kind.type === "boolean") {
    const b = coerceBoolean(value);
    if (b === undefined) return { ok: false, error: `"${setting.label}" is a toggle — set it to on or off.` };
    return { ok: true, key: setting.key, value: b, label: setting.label, valueLabel: b ? "on" : "off", sensitive: !!setting.sensitive };
  }
  const want = norm(String(value));
  const opt = setting.kind.options.find(
    (o) => norm(String(o.value)) === want || norm(o.label) === want || o.match.some((m) => norm(m) === want),
  );
  if (!opt) {
    return { ok: false, error: `"${setting.label}" must be one of: ${setting.kind.options.map((o) => o.label).join(", ")}.` };
  }
  return { ok: true, key: setting.key, value: opt.value, label: setting.label, valueLabel: opt.label, sensitive: !!setting.sensitive };
}

/** A compact list of controllable settings for the system prompt. */
export function controllableSettingsIndex(): string {
  return CONTROLLABLE_SETTINGS.map((s) => s.describe).join("; ");
}
