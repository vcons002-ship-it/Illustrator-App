/** Per-image staging only. Names and permanent appearance are supplied from the selected Soul. */
export interface PortraitScene {
  action?: string;
  setting?: string;
  clothing?: string;
  composition?: string;
}

export const MAX_PORTRAIT_SCENE_FIELD_CHARS = 1_200;
const SCENE_FIELDS = ["action", "setting", "clothing", "composition"] as const;

/** Accept only the staging fields; an absent/empty scene lets the renderer request a corrected call. */
export function parsePortraitScene(value: unknown): PortraitScene | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const scene: PortraitScene = {};
  for (const field of SCENE_FIELDS) {
    const raw = input[field];
    if (typeof raw !== "string") continue;
    const text = raw.trim().slice(0, MAX_PORTRAIT_SCENE_FIELD_CHARS).trim();
    if (text) scene[field] = text;
  }
  return Object.keys(scene).length ? scene : undefined;
}

export const PORTRAIT_SCENE_GUIDANCE =
  'For assistant/reader portraits, "scene" is REQUIRED: an object with nonempty action, setting, clothing ' +
  "and/or composition strings (max 1200 chars each). Give each call its own scene resolved from the request/plan, " +
  "including batch differences. Use SUBJECT, or ASSISTANT and READER for pairs. Omit names and permanent appearance; " +
  'the app supplies Soul identity. Ordinary images keep "prompt"; scene is optional.';

export const PORTRAIT_REFERENCE_GUIDANCE =
  "REFERENCE PHOTOS: Soul portraits default to selected Soul photos (both for pairs). Use chat photos only if " +
  "the reader explicitly requests them: singular means newest, plural means the set. Ordinary images retain " +
  "session references; book/story characters retain their references. References supply likeness.";

/** Shared by native tool calling and grammar-constrained retries. */
export const PORTRAIT_SCENE_SCHEMA = {
  type: "object",
  description: PORTRAIT_SCENE_GUIDANCE,
  additionalProperties: false,
  minProperties: 1,
  properties: Object.fromEntries(SCENE_FIELDS.map((field) => [field, {
    type: "string",
    minLength: 1,
    maxLength: MAX_PORTRAIT_SCENE_FIELD_CHARS,
    description: {
      action: "What SUBJECT is doing; for a pair, distinguish ASSISTANT and READER.",
      setting: "This image's location, background, time of day, and lighting.",
      clothing: "This image's clothing and accessories, without permanent physical traits.",
      composition: "This image's framing, pose, camera angle, and arrangement of the subjects.",
    }[field],
  }])),
};
