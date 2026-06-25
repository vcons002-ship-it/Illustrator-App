import type {
  ChapterDataset,
  ChapterInfographic,
  InfographicSpec,
  Character,
  CharacterAppearance,
  ChapterScene,
  Creature,
  KeyEvent,
  Outfit,
  ScenePrompt,
  VisualBible,
} from "../../types/bible.js";
import { emptyAppearance } from "../../types/bible.js";
import type { EntityExtractionInput } from "./llm-provider.js";
import type { VisualRequest } from "../../types/content.js";
import { deterministicSeed } from "./mock-llm-provider.js";
import { resolveKeyEvent } from "../../visual-bible/key-events.js";
import { sanitizeWorldStyle } from "../image/bible-injection.js";

/**
 * Shared building blocks for the cloud LLM providers (Claude / Gemini / OpenAI).
 *
 * Every provider does the same two jobs — Visual-Bible extraction and image-prompt
 * building — differing only in transport/SDK. Keeping the prompt text, the JSON
 * shape, the merge logic, and the prompt-context builder here means the providers
 * stay thin and behave identically, so swapping providers never changes results.
 */

/** Provider-neutral shape returned by every extraction call before merging. */
export interface RawExtraction {
  characters: {
    name: string;
    aliases: string[];
    /** Structured physical appearance; optional for back-compat with older mocks. */
    appearance?: Partial<CharacterAppearance>;
    persistentTraits: string[];
    /** @deprecated legacy single clothing list; still accepted from old fixtures. */
    clothing?: string[];
    /** Distinct outfits the character is described wearing. */
    outfits?: { label: string; description: string }[];
  }[];
  environments: { name: string; description: string[]; aliases?: string[] }[];
  /** Named/notable non-human creatures (dragons, beasts…). Optional for back-compat. */
  creatures?: { name: string; aliases: string[]; kind: string; description: string[] }[];
  spoilers: { label: string }[];
  /** Recurring world facts/defining context to apply by default in every prompt. */
  glossary?: { term: string; definition: string }[];
  /** What occurs in this chapter (the storyboard summary). Optional for back-compat. */
  summary?: string;
  /** The single most important action/moment to illustrate this chapter. */
  keyMoment?: string;
  /** Where the chapter takes place (by environment name). */
  location?: string;
  /** "" if the chapter stays in one place, else where/when the setting shifts. */
  locationChange?: string;
  /**
   * Ordered Layer-1 scene prompts — one per illustration the chapter is split into,
   * in reading order. Produced WITH the extraction (no extra LLM call); the engine
   * maps them onto the chapter's render units by position. Optional for back-compat.
   */
  keyEvents?: {
    subject: string;
    action: string;
    environment: string;
    mood: string;
    composition: string;
    /** Beat-level setting: the ONE location name where this scene happens. */
    location?: string;
  }[];
  /** One concise genre/art-direction line for the whole book, applied to every prompt. */
  worldStyle?: string;
  /**
   * Numeric series stated in THIS chapter's text (technical books) — real values only,
   * never invented. The app renders these itself as computed SVG charts, so unlike a
   * generated image the axes and numbers are exact. Optional for back-compat; fiction
   * extraction leaves it empty.
   */
  datasets?: {
    title: string;
    unit: string;
    xLabel: string;
    yLabel: string;
    /** Suggested chart form; validated at merge (unknown values coerce to "bar"). */
    kind: string;
    points: { label: string; x?: number; y: number }[];
    source?: string;
  }[];
  /** Structured info-graphics (flat shape for strict schemas; fields for the unused kind are empty). */
  infographics?: {
    kind: string; // "flowchart" | "diagram" | "summary" | "gantt"
    title: string;
    anchor: string;
    bullets: string[];
    nodes: { id: string; label: string; shape: string }[];
    edges: { from: string; to: string; label: string }[];
    parts: { label: string; note: string }[];
    caption: string;
    /** gantt only — the axis unit ("weeks"/"days"/"phases") and its dated tasks. */
    unit?: string;
    tasks?: { id: string; label: string; start: number; end: number }[];
  }[];
}

export const EXTRACTION_SYSTEM =
  "You are building a 'Visual Bible' and storyboard for illustrating a novel as you " +
  "read it chapter by chapter. You are given the characters, creatures, and locations " +
  "already recorded from earlier chapters. Work INCREMENTALLY: capture what THIS chapter " +
  "adds, and do NOT repeat what is already recorded. " +
  "Capture EVERY named character who is given a physical or appearance description here " +
  "that is NOT already recorded — including minor and one-off characters. " +
  "Do NOT limit yourself to the main cast; only skip bare name-drops that carry no " +
  "description at all. A capitalized word used as a person's NAME or nickname is a character " +
  "(a human), even when it is also a common noun or animal word — e.g. a person called 'Cat', " +
  "'Hawk', 'Wren', or 'Fox' is a human character, NOT an animal. For each character fill the structured 'appearance' fields " +
  "(hair, eyes, gender, build/physique, height, skinTone, age, distinguishingMarks; use " +
  "an empty string for anything the text doesn't state) and put extra persistent details " +
  "in persistentTraits. Capture each DISTINCT outfit a character is described wearing as a " +
  "separate entry in 'outfits' — a short 'label' and a detailed 'description' (garments, fabric, " +
  "colour, accessories, era/style), e.g. label 'flight leathers', description 'fitted black hide " +
  "with buckled straps'. Add new outfits as they appear across chapters; do NOT merge different " +
  "outfits into one. " +
  "Reuse a character's ESTABLISHED name across chapters: if " +
  "the same person is referred to by a first name, full name, title, or nickname, keep ONE " +
  "entry and put the other forms in 'aliases' — never create a second character for the same " +
  "person (e.g. 'Violet' and 'Violet Sorrengail' are one character). " +
  "Capture EVERY named location with a detailed visual " +
  "description (architecture, materials, layout, lighting, palette, mood) AND its world's " +
  "fashion and aesthetic; always refer to a location you already know by its established name. " +
  "Record each location's 'aliases': the epithets and indirect names the TEXT uses for it " +
  "('the fortress', 'the white city', 'the academy') — these let a scene that says 'the " +
  "fortress' resolve to the right place; [] when the text only ever uses the proper name. " +
  "Capture notable non-human 'creatures' — dragons, beasts, monsters, mounts — separately " +
  "from human characters (do NOT put them in 'characters'). For each give its name (or a " +
  "descriptive label if unnamed, e.g. 'the black dragon'), any aliases, its 'kind' (dragon, " +
  "griffin…), and a detailed visual 'description' (size, colour, scales/fur, wings, horns, " +
  "eyes, distinguishing marks). Reuse an established creature's name (e.g. 'Tairn' is a massive " +
  "midnight-black dragon). NEVER create a " +
  "creature from a person's name or nickname — only from a LITERAL animal/beast in the text (a " +
  "character nicknamed 'Cat' is a person, not an animal). " +
  "INCREMENTAL RULE (important — keeps your output small): for a character, creature, or " +
  "location that is ALREADY in the known lists, only include it if THIS chapter reveals " +
  "genuinely NEW visual detail (a newly-described feature, a new outfit, a new aspect of a " +
  "place) — and then include ONLY that new detail. OMIT every already-known entity that this " +
  "chapter adds nothing new about (it is already remembered and will be kept automatically). " +
  "Output brand-NEW entities in full; never repeat an entity just to restate what's known. " +
  "Build a 'glossary' of recurring world facts / defining context that should be assumed " +
  "by default unless a passage says otherwise — e.g. customary attire ('dragon riders wear " +
  "fitted black flight leathers'), technology level, materials, or social norms; each NEW entry " +
  "is a short term and its definition (omit terms already listed). Flag any NEW spoilers that " +
  "would spoil the plot if shown before the reader reaches them (a short label each). " +
  "Also write a 'summary' of what happens in THIS chapter, " +
  "and a single 'keyMoment': the most important, most visual action of the chapter to " +
  "illustrate (one concrete sentence). Determine WHERE the chapter takes place: set " +
  "'location' to the primary setting (use the established environment name), and keep the " +
  "keyMoment's place explicit. If the setting moves during the chapter, set 'locationChange' " +
  "to a short note of where/when it shifts (otherwise an empty string). " +
  "Write 'keyEvents': the chapter is illustrated as a fixed number of images covering " +
  "consecutive stretches of the chapter in READING ORDER — you are told how many. Produce EXACTLY " +
  "that many keyEvents, in order, each describing the single most important visual SCENE of its " +
  "stretch as five natural-language fields: 'subject' (who/what is the focus), 'action' (what they " +
  "are doing), 'environment' (where/how it looks), 'mood' (tone), 'composition' (camera angle/" +
  "framing) — plus 'location': the established location NAME where THAT scene's moment happens. " +
  "CHOOSING THE MOMENT (this is the storyboard): for each stretch pick its most CONSEQUENTIAL, " +
  "visually distinct beat — a turning point, a decisive or dramatic action, a vivid reveal or first " +
  "appearance — NOT a quiet transition, and NOT a repeat of a moment an adjacent image already " +
  "shows (consecutive images should look clearly different). If the stretch is mostly dialogue or " +
  "inner thought, depict the most CONCRETE physical action or the most evocable image in it (a " +
  "character doing something, an object, the place) rather than people merely standing and talking. " +
  "'action' must name one specific, depictable thing happening — not a summary or an abstraction. " +
  "Track the setting beat by beat: each keyEvent gets ITS OWN location, so when the chapter moves " +
  "(tavern → road → castle) consecutive keyEvents change location accordingly. EXACTLY one place " +
  "per keyEvent — if a stretch itself moves between places, use the place of the depicted moment. " +
  "ALWAYS fill in 'location' (fall back to the chapter's primary setting if a beat's place is " +
  "implicit) — a blank here makes the image guess the setting from stray words in the prose and " +
  "get it wrong (e.g. drawing an indoor classroom scene as students outdoors). " +
  "Describe a scene with the characters acting in their setting — NOT a portrait. Refer to " +
  "characters/creatures by their EXACT bible name, to clothing by its outfit LABEL, and to a place " +
  "by its location NAME (the app expands each into its visual description), so do NOT describe their " +
  "permanent looks. No weighting syntax, no tags, just prose; keep each field concise. " +
  "Finally, set 'worldStyle': one concise line capturing the book's overall genre and visual " +
  "art direction to apply to EVERY illustration — e.g. 'high-fantasy military academy, dark, " +
  "painterly, dramatic lighting' or 'cosy contemporary romance, warm, soft watercolour'. Cover " +
  "genre, era/setting, mood, and a rendering style. Refine it as the book reveals more (keep the " +
  "most specific version). Leave 'datasets' and 'infographics' as empty lists (non-fiction only).";

/**
 * Extraction system prompt for TECHNICAL / non-fiction books (papers, textbooks,
 * articles). Reuses the SAME output schema as fiction, remapped: 'environments' hold
 * recurring STRUCTURES/SYSTEMS (so naming one in a prompt injects its visual
 * description), 'glossary' holds key terms/data/findings, and 'keyEvents' become a
 * per-stretch VISUALIZATION PLAN — the creative pass that decides what's worth
 * drawing and how. Characters/creatures/outfits/spoilers stay empty.
 */
export const TECHNICAL_EXTRACTION_SYSTEM =
  "You are building a 'Visual Atlas' for illustrating a NON-FICTION text (a paper, " +
  "textbook, or article) as it is read, chapter by chapter. You are given what was " +
  "already recorded from earlier chapters. Work INCREMENTALLY: capture what THIS chapter " +
  "adds and do NOT repeat what is already recorded. " +
  "This is not a story: leave 'characters', 'creatures', and 'spoilers' as EMPTY lists " +
  "(do not invent people), and give characters no outfits. Instead: " +
  "Use 'environments' for every recurring STRUCTURE, SYSTEM, APPARATUS, ORGANISM, or " +
  "PLACE the text describes (a mitochondrion, a transformer architecture, a reactor " +
  "core, a trial cohort…) — name it by its established term and give a detailed VISUAL " +
  "description (shape, parts, scale, materials, spatial arrangement, what it connects " +
  "to), so later illustrations of it stay consistent. Reuse established names; only add " +
  "NEW detail for known entries. " +
  "Build the 'glossary' as the chapter's KEY CONCEPTS: essential terms, named methods, " +
  "important quantities/data points with their values and units, and central findings — " +
  "each as a short term plus a definition written as a PLAIN-LANGUAGE explanation (1–3 " +
  "sentences a newcomer to the field could follow: what it is, why it matters here — " +
  "keep the precise values/units, drop the jargon-heavy phrasing). These definitions are " +
  "shown to the reader beside the text as study aids, so make each one genuinely " +
  "explanatory, not a circular restatement (omit entries already listed). " +
  "Write a 'summary' of what THIS chapter explains, and a 'keyMoment': the single most " +
  "important idea of the chapter stated as one concrete, visualizable sentence. Set " +
  "'location' to the chapter's primary subject system (established environment name) " +
  "and 'locationChange' to '' unless the subject shifts mid-chapter. " +
  "Write 'keyEvents' as the chapter's VISUALIZATION PLAN: the chapter is illustrated as " +
  "a fixed number of images covering consecutive stretches in READING ORDER — you are " +
  "told how many. For each stretch, choose the ONE most illustration-worthy item, in " +
  "this priority: (1) a quantitative result, trend, or comparison — show magnitude and " +
  "relationship visually (relative sizes, before/after, side-by-side); (2) a mechanism " +
  "or process — show its stages flowing left-to-right or top-to-bottom; (3) a structure " +
  "— show a cutaway, cross-section, or exploded view; (4) an abstract concept — invent " +
  "ONE concrete visual metaphor that makes it tangible. Pick a DIFFERENT item for each " +
  "stretch so consecutive images don't re-illustrate the same idea. Fill the five fields: 'subject' " +
  "(the concept/data/structure being shown), 'action' (what the visual demonstrates — " +
  "the change, flow, comparison, or relationship), 'environment' (the visual FORM: " +
  "cutaway diagram, step-by-step process view, scale comparison, annotated-style " +
  "scene…), 'mood' (palette and clarity, e.g. 'clean, high-contrast, neutral " +
  "background'), 'composition' (layout/viewpoint) — plus 'location': the established " +
  "system/structure name this stretch concerns (empty if none). Never request rendered " +
  "text or labels — image models draw text poorly; the imagery itself must carry the " +
  "meaning. " +
  "Capture 'datasets': every coherent numeric SERIES this chapter's text actually " +
  "states — a table, a results list, a comparison of 3+ related values with consistent " +
  "units (e.g. measurements across conditions, quantities over years). For each give a " +
  "'title', the y 'unit' ('' if unitless), 'xLabel'/'yLabel', a suggested 'kind' (bar | " +
  "line | scatter), the 'points' (each a short 'label' and its numeric 'y'; set 'x' ONLY " +
  "when the text gives a real numeric x like a year — repeat the point's position index " +
  "otherwise), and 'source' (a short locating quote). STRICT RULES: use ONLY numbers " +
  "stated in the text — never invent, estimate, or interpolate values; at most ~20 points " +
  "per dataset; emit an EMPTY list when the chapter has no clean numeric series (most " +
  "chapters don't — an empty list is the normal answer). " +
  "Capture 'infographics': up to 3 STRUCTURED visuals the chapter's text directly supports. " +
  "Each has a 'kind' ('flowchart' | 'diagram' | 'summary'), a short 'title', and an 'anchor' (a " +
  "few words quoted from the text where it belongs, for placement). For a 'flowchart' (a process, " +
  "algorithm, or cycle described step by step), fill 'nodes' (each a short 'id', a concise 'label', " +
  "and a 'shape': 'start' | 'step' | 'decision' | 'end') and 'edges' (each 'from'/'to' a node id, " +
  "with an optional short 'label' like 'yes'/'no'); leave 'bullets', 'parts', and 'caption' empty. " +
  "For a 'diagram' (the named parts/components of one structure), fill 'parts' (each a 'label' and a " +
  "short 'note') and optionally 'caption'; leave the others empty. For a 'summary' (a section's key " +
  "takeaways), fill 'bullets' (3–6 concise points); leave the others empty. For a 'gantt' (a timeline, " +
  "schedule, roadmap, or phased plan the text lays out), set 'unit' to the axis unit ('weeks' | 'days' | " +
  "'phases' | 'months') and fill 'tasks' (each a short 'id', a concise 'label', and INCLUSIVE numeric " +
  "'start'/'end' positions on that axis — e.g. a phase running weeks 2–4 is start:2, end:4); leave the " +
  "others empty. Use ONLY what the text states; emit an EMPTY list when nothing fits (common). " +
  "Finally set 'worldStyle': one concise art-direction line applied to EVERY " +
  "illustration of this text — e.g. 'clean modern scientific illustration, precise " +
  "linework, soft studio lighting, neutral background, restrained technical palette'. " +
  "Keep it consistent with the field (medicine, astronomy, engineering…).";

export const CODE_EXTRACTION_SYSTEM =
  "You are building a 'Code Atlas' for SOURCE CODE being read file-section by section, to help a " +
  "developer understand it. You are given what was already recorded from earlier sections. Work " +
  "INCREMENTALLY: capture what THIS section adds; do NOT repeat what is already recorded. " +
  "This is not a story: leave 'characters', 'creatures', and 'spoilers' as EMPTY lists, and give no " +
  "outfits. Also leave 'datasets' EMPTY (code has no numeric series). " +
  "Use 'environments' for every recurring STRUCTURAL UNIT — a module/file, a class, a major " +
  "component or subsystem — named by its identifier, with a short description of its responsibility " +
  "and how it connects to the others (what it imports/exports, calls, or is called by). Reuse names; " +
  "only add NEW detail for known entries. " +
  "Build the 'glossary' as the section's KEY SYMBOLS: the important functions/methods, types, and " +
  "constants — each a short term (the identifier, e.g. `parsePlan()`) plus a PLAIN-LANGUAGE " +
  "explanation (1–3 sentences: what it does, its inputs/outputs, and why it matters here). These are " +
  "shown beside the code as study aids, so make each genuinely explanatory (omit ones already listed). " +
  "Write a 'summary' of what THIS section does, and a 'keyMoment': its single most important idea as " +
  "one concrete, visualizable sentence. Set 'location' to the section's primary unit (file/class name) " +
  "and 'locationChange' to '' unless it shifts mid-section. " +
  "Write 'keyEvents' as the VISUALIZATION PLAN: the section is illustrated as a fixed number of " +
  "images over consecutive stretches in READING ORDER — you are told how many. For each, choose the " +
  "ONE most illustration-worthy item: (1) CONTROL FLOW or an algorithm — show its steps/branches " +
  "flowing top-to-bottom; (2) DATA FLOW or a call/dependency relationship — show what passes between " +
  "units; (3) a STRUCTURE — show a module/class's parts and how they relate; (4) an abstract idea — one " +
  "concrete visual metaphor. Fill 'subject' (the function/structure shown), 'action' (the flow/branch/" +
  "relationship demonstrated), 'environment' (the visual FORM: control-flow diagram, call graph, module " +
  "map, layered-architecture view…), 'mood' ('clean, high-contrast, neutral background'), 'composition', " +
  "and 'location' (the unit this stretch concerns). Never request rendered text/labels in the image. " +
  "Capture 'infographics': up to 3 STRUCTURED visuals the code directly supports, each with a 'kind' " +
  "('flowchart' | 'diagram' | 'summary'), a 'title', and an 'anchor' (a few words quoted from the code " +
  "where it belongs). Prefer a 'flowchart' for a function's control flow or an algorithm (fill 'nodes' " +
  "with 'shape' start/step/decision/end and 'edges' with yes/no labels), a 'diagram' for a module/class's " +
  "parts (fill 'parts' label+note), and a 'summary' for a file's responsibilities (3–6 'bullets'). Leave " +
  "the unused fields empty; emit an EMPTY list when nothing fits. " +
  "Finally set 'worldStyle': one art-direction line for every diagram — e.g. 'clean software-architecture " +
  "diagram, monospace-labelled boxes and arrows, flat muted palette, high contrast, neutral background'.";

/** The entity-extraction system prompt for a book's content mode. */
export function extractionSystemFor(contentMode?: string): string {
  if (contentMode === "code") return CODE_EXTRACTION_SYSTEM;
  return contentMode === "technical" ? TECHNICAL_EXTRACTION_SYSTEM : EXTRACTION_SYSTEM;
}

export const PROMPT_SYSTEM =
  "You write one vivid, concrete image-generation prompt for a single illustration of a " +
  "book chapter. Write it as a single paragraph of natural, descriptive language (NOT a " +
  "list of tags, no weighting syntax, no markdown) — lead with the subject and action, " +
  "then the setting, then mood/lighting. Depict the single most important action shown in " +
  "THIS passage specifically — each illustration covers a different stretch of the chapter, " +
  "so describe what happens in THIS passage and never reuse another illustration's moment or " +
  "fall back on the chapter's overall climax. Frame it as a SCENE that shows the action and the " +
  "setting around the characters — a wide or medium shot of the moment, NOT a tight close-up, " +
  "headshot, or centered character portrait, unless the passage is deliberately intimate. Show " +
  "what the characters are DOING, with their environment visible. Set the image in ONE coherent " +
  "location — the place where the passage's action occurs; if the chapter or passage moves " +
  "between places, choose the single location of the depicted moment and NEVER combine two " +
  "settings into one picture. " +
  "IMPORTANT — refer to each character and creature by their EXACT name from the supplied " +
  "Visual Bible, to clothing by its exact outfit LABEL, and to a place by its exact location " +
  "NAME; the app expands each of those into the correct visual description automatically, so do " +
  "NOT describe a character's permanent physical features (hair, eyes, build, face, scars), the " +
  "full details of a garment, or a location's architecture yourself — just name them and " +
  "describe what is happening, their pose, expression, and the composition. The listed characters " +
  "are PEOPLE — depict them as humans; NEVER render a character as an animal even if their name " +
  "is also a common word (a person named 'Cat' is a woman, not a cat). For each character, pick " +
  "the SINGLE outfit LABEL from their listed options that best fits this scene and name only that " +
  "label (never combine outfits). For action scenes, convey dynamic movement — a dynamic pose, " +
  "motion, energy, a sense of speed or impact. Output only the prompt text, no preamble.";

/**
 * Image-prompt system prompt for TECHNICAL / non-fiction content (papers, textbooks,
 * articles): illustrate the passage's central CONCEPT, mechanism, or process as a clean
 * explanatory visual instead of a story scene. Experimental — entity extraction still
 * runs the fiction pass (its character/outfit fields are simply sparse for non-fiction).
 */
export const TECHNICAL_PROMPT_SYSTEM =
  "You write one clear, concrete image-generation prompt for a single EXPLANATORY " +
  "illustration of a non-fiction passage (a paper, textbook, or article). Write a single " +
  "paragraph of natural, descriptive language (NOT a list of tags, no weighting syntax, no " +
  "markdown). Depict the single most important concept, mechanism, structure, or process " +
  "in THIS passage — each illustration covers a different stretch of the text, so depict " +
  "what THIS passage explains, never repeating another illustration's subject. Prefer a " +
  "clean scientific/technical illustration: a clear focal subject, simple uncluttered " +
  "composition, neutral background, accurate proportions and spatial relationships — like " +
  "a high-quality textbook figure or museum exhibit visual. For a process, show its stages " +
  "or flow visually (left to right or top to bottom); for a structure, show a clear " +
  "cutaway, cross-section, or labeled-style view (but do NOT ask for rendered text or " +
  "labels — image models draw text poorly; convey meaning through the imagery itself). " +
  "No people unless the passage is about people. Output only the prompt text, no preamble.";

/** The image-prompt system prompt for a request's content kind. */
export function promptSystemFor(kind: string): string {
  return kind === "technical_illustration" ? TECHNICAL_PROMPT_SYSTEM : PROMPT_SYSTEM;
}

/**
 * JSON Schema for the extraction result. Gemini (`responseSchema`) and OpenAI
 * (`response_format: json_schema`) both consume this so the model returns
 * validated JSON; Claude expresses the same shape via its Zod helper.
 */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    characters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          appearance: {
            type: "object",
            additionalProperties: false,
            properties: {
              hair: { type: "string" },
              eyes: { type: "string" },
              gender: { type: "string" },
              build: { type: "string" },
              height: { type: "string" },
              skinTone: { type: "string" },
              age: { type: "string" },
              distinguishingMarks: { type: "string" },
              notes: { type: "string" },
            },
            required: [
              "hair",
              "eyes",
              "gender",
              "build",
              "height",
              "skinTone",
              "age",
              "distinguishingMarks",
              "notes",
            ],
          },
          persistentTraits: { type: "array", items: { type: "string" } },
          outfits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                label: { type: "string" },
                description: { type: "string" },
              },
              required: ["label", "description"],
            },
          },
        },
        required: ["name", "aliases", "appearance", "persistentTraits", "outfits"],
      },
    },
    glossary: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          term: { type: "string" },
          definition: { type: "string" },
        },
        required: ["term", "definition"],
      },
    },
    environments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          description: { type: "array", items: { type: "string" } },
        },
        required: ["name", "aliases", "description"],
      },
    },
    creatures: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          kind: { type: "string" },
          description: { type: "array", items: { type: "string" } },
        },
        required: ["name", "aliases", "kind", "description"],
      },
    },
    spoilers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
        },
        required: ["label"],
      },
    },
    summary: { type: "string" },
    keyMoment: { type: "string" },
    location: { type: "string" },
    locationChange: { type: "string" },
    keyEvents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          subject: { type: "string" },
          action: { type: "string" },
          environment: { type: "string" },
          mood: { type: "string" },
          composition: { type: "string" },
          location: { type: "string" },
        },
        required: ["subject", "action", "environment", "mood", "composition", "location"],
      },
    },
    worldStyle: { type: "string" },
    datasets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          unit: { type: "string" },
          xLabel: { type: "string" },
          yLabel: { type: "string" },
          kind: { type: "string" },
          points: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                label: { type: "string" },
                // Strict schemas (OpenAI/Gemini) require every property, so `x` is
                // always present: the model repeats the point's index when the text
                // gives no real numeric x, and the merge treats x===index as positional.
                x: { type: "number" },
                y: { type: "number" },
              },
              required: ["label", "x", "y"],
            },
          },
          source: { type: "string" },
        },
        required: ["title", "unit", "xLabel", "yLabel", "kind", "points", "source"],
      },
    },
    infographics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string" },
          title: { type: "string" },
          anchor: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
          nodes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { id: { type: "string" }, label: { type: "string" }, shape: { type: "string" } },
              required: ["id", "label", "shape"],
            },
          },
          edges: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { from: { type: "string" }, to: { type: "string" }, label: { type: "string" } },
              required: ["from", "to", "label"],
            },
          },
          parts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { label: { type: "string" }, note: { type: "string" } },
              required: ["label", "note"],
            },
          },
          caption: { type: "string" },
          unit: { type: "string" },
          tasks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                start: { type: "number" },
                end: { type: "number" },
              },
              required: ["id", "label", "start", "end"],
            },
          },
        },
        required: ["kind", "title", "anchor", "bullets", "nodes", "edges", "parts", "caption", "unit", "tasks"],
      },
    },
  },
  required: [
    "characters",
    "glossary",
    "environments",
    "creatures",
    "spoilers",
    "summary",
    "keyMoment",
    "location",
    "locationChange",
    "keyEvents",
    "worldStyle",
    "datasets",
    "infographics",
  ],
} as const;

/**
 * The user message for one chapter's extraction. Includes the "story so far"
 * (prior chapters' summaries from the bible being built) so the model has the
 * cumulative context when summarising this chapter and picking its key moment.
 */
/**
 * The "known so far" context fed back to the model exists only so it REUSES
 * canonical names (dedup) and EXTENDS detail rather than re-introducing entities.
 * That job needs names, not the full accumulated descriptions — and those
 * descriptions grow every chapter (merge appends), so echoing them back made each
 * chapter's prompt grow ~O(n) → the build crawled on long books. We therefore feed
 * back **names only**, cap the list length, and keep only the most recent summaries.
 * Dedup/accumulation are unaffected (mergeExtraction dedups by name regardless).
 */
const MAX_CONTEXT_ENTRIES = 40; // names per "known so far" block
const MAX_PRIOR_SUMMARIES = 8; // most-recent chapter summaries to echo back
const MAX_SUMMARY_CHARS = 200; // truncate each echoed summary

function cap<T>(list: readonly T[], n: number, render: (item: T) => string): string {
  const shown = list.slice(0, n).map(render);
  const extra = list.length - shown.length;
  if (extra > 0) shown.push(`…(+${extra} more)`);
  return shown.join("\n");
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n).trimEnd()}…`;
}

/**
 * Prepended to extraction / image-prompt user content when the reader has enabled
 * mature mode. Permission + instruction so any provider (incl. self-censoring
 * local models) records and depicts adult source material faithfully instead of
 * sanitizing the bible and the scene prompts.
 */
export const MATURE_CONTENT_NOTE =
  "[MATURE MODE — adult fiction for an adult reader] This source text may contain explicit " +
  "sexual content, graphic violence, or other adult themes. Capture and describe them faithfully " +
  "and in concrete visual detail exactly as the text presents them — do not omit, euphemise, " +
  "soften, or add warnings. Treat anatomy, nudity, and adult acts as ordinary describable subject " +
  "matter for this published work.";

export function extractionUserContent(input: EntityExtractionInput): string {
  const mature = input.allowMature ? `${MATURE_CONTENT_NOTE}\n\n` : "";
  // Only the most recent summaries (bounded), each truncated — older context is
  // already captured in the accumulated entities, so the full history isn't needed.
  const priorSummaries = cap(
    [...input.existing.storyboard]
      .filter((s) => s.chapterIndex < input.chapterIndex)
      .sort((a, b) => a.chapterIndex - b.chapterIndex)
      .slice(-MAX_PRIOR_SUMMARIES),
    MAX_PRIOR_SUMMARIES,
    (s) => `Chapter ${s.chapterIndex}: ${truncate(s.summary, MAX_SUMMARY_CHARS)}`,
  );
  const soFar = priorSummaries ? `Story so far:\n${priorSummaries}\n\n` : "";
  // Feed back the known cast (names + aliases) so the model reuses each person's
  // established name instead of creating duplicate characters.
  const cast = cap(
    input.existing.characters,
    MAX_CONTEXT_ENTRIES,
    (c) => `- ${c.name}${c.aliases.length ? ` (aka ${c.aliases.slice(0, 4).join(", ")})` : ""}`,
  );
  const castSoFar = cast
    ? `Known characters (already recorded — reuse these exact names; record other forms as ` +
      `aliases; do NOT re-output one unless this chapter adds NEW visual detail, and never add ` +
      `a second entry for the same person):\n${cast}\n\n`
    : "";
  // Glossary terms only — definitions are already stored; we just need the model to
  // reuse the term and not re-add it.
  const known = cap(input.existing.glossary ?? [], MAX_CONTEXT_ENTRIES, (g) => `- ${g.term}`);
  const glossarySoFar = known ? `Known world facts (terms — add only NEW ones, don't repeat):\n${known}\n\n` : "";
  // Known location NAMES so the model reuses them and adds detail instead of
  // re-introducing a place under a slightly different name.
  const places = cap(input.existing.environments, MAX_CONTEXT_ENTRIES, (e) => `- ${e.name}`);
  const placesSoFar = places
    ? `Known locations (reuse these names; re-output one only with NEW visual detail):\n${places}\n\n`
    : "";
  // Known creature NAMES (+ kind) so a recurring beast keeps one name.
  const beasts = cap(input.existing.creatures ?? [], MAX_CONTEXT_ENTRIES, (c) => `- ${c.name} (${c.kind})`);
  const beastsSoFar = beasts
    ? `Known creatures (reuse these names; re-output one only with NEW visual detail):\n${beasts}\n\n`
    : "";
  // Tell the model how many scene prompts to emit (one per illustration of this chapter).
  const k = input.sceneCount ?? input.unitRanges?.length ?? 0;
  const scenes = k > 0
    ? `This chapter is illustrated as ${k} image${k === 1 ? "" : "s"} in reading order — ` +
      `produce EXACTLY ${k} keyEvents, in order.\n\n`
    : "";
  // Provider-agnostic grounding: web-search snippets fetched for THIS chapter's topic
  // (any text provider, incl. local). Placed last, just before the chapter text, so the
  // model leans on these real sources for definitions/quantities over its recollection.
  const grounding = input.groundingContext?.trim() ? `${input.groundingContext.trim()}\n\n` : "";
  return `${mature}${castSoFar}${beastsSoFar}${placesSoFar}${glossarySoFar}${soFar}${scenes}${grounding}Chapter ${input.chapterIndex} text:\n\n${input.chapterText}`;
}

/**
 * Merge a raw extraction into the existing Bible, deduplicating by (lowercased)
 * name and assigning each new character a deterministic identity seed. Idempotent
 * per chapter, so re-running a chapter never duplicates entities.
 */
/**
 * Map an ordered list of raw scene prompts onto a chapter's render units by position:
 * `keyEvents[i]` → `unitRanges[i]`. Tolerant of a count mismatch (uses the shorter of
 * the two), and skips a scene whose five fields are all empty (that unit then falls
 * back to the live LLM at render).
 */
function mapKeyEventsToUnits(
  events: RawExtraction["keyEvents"],
  unitRanges: [number, number][] | undefined,
  chapterLocation = "",
): KeyEvent[] {
  if (!events || !unitRanges || unitRanges.length === 0) return [];
  const out: KeyEvent[] = [];
  const n = Math.min(events.length, unitRanges.length);
  const fallback = chapterLocation.trim();
  for (let i = 0; i < n; i++) {
    const e = events[i]!;
    const imagePrompt: ScenePrompt = {};
    for (const key of ["subject", "action", "environment", "mood", "composition"] as const) {
      const v = (e[key] ?? "").trim();
      if (v) imagePrompt[key] = v;
    }
    if (Object.keys(imagePrompt).length === 0) continue;
    // Beat-level location is authoritative for the render's "Setting" line. When the model left
    // it blank, inherit the chapter's location so the beat is never location-less (which is what
    // forced the live prompt path to scan the passage text and sometimes pick a wrong place).
    const location = (e.location ?? "").trim() || fallback;
    out.push({ pageRange: unitRanges[i]!, imagePrompt, ...(location ? { location } : {}) });
  }
  return out;
}

/**
 * Validate one chapter's raw datasets into the stored shape: real series only
 * (≥ 2 finite points), unknown chart kinds coerced to "bar", point count capped,
 * and an `x` that just repeats the point's index dropped — strict JSON schemas
 * force the model to always emit `x`, so a positional echo isn't a real axis.
 */
function sanitizeDatasets(
  raw: RawExtraction["datasets"],
  chapterIndex: number,
): ChapterDataset[] {
  const MAX_DATASETS = 10;
  const MAX_POINTS = 100;
  const out: ChapterDataset[] = [];
  for (const d of (raw ?? []).slice(0, MAX_DATASETS)) {
    const title = (d.title ?? "").trim();
    if (!title) continue;
    const rawPoints = (d.points ?? []).slice(0, MAX_POINTS);
    const positionalX = rawPoints.every((p, i) => p.x === undefined || p.x === i);
    const points = rawPoints
      .filter((p) => Number.isFinite(p.y))
      .map((p) => ({
        label: (p.label ?? "").trim(),
        y: p.y,
        ...(!positionalX && typeof p.x === "number" && Number.isFinite(p.x) ? { x: p.x } : {}),
      }));
    if (points.length < 2) continue;
    const kind = d.kind === "line" || d.kind === "scatter" ? d.kind : "bar";
    out.push({
      id: `data-${chapterIndex}-${slug(title) || out.length}`,
      chapterIndex,
      title,
      unit: (d.unit ?? "").trim(),
      xLabel: (d.xLabel ?? "").trim(),
      yLabel: (d.yLabel ?? "").trim(),
      kind,
      points,
      source: (d.source ?? "").trim(),
    });
  }
  return out;
}

function nodeShape(s: string | undefined): "start" | "step" | "decision" | "end" {
  return s === "start" || s === "decision" || s === "end" ? s : "step";
}

/** Validate one chapter's raw info-graphics into the stored discriminated shape (flowchart needs
 * ≥2 nodes; summary needs bullets; diagram needs parts; otherwise dropped). */
function sanitizeInfographics(raw: RawExtraction["infographics"], chapterIndex: number): ChapterInfographic[] {
  const MAX = 4, MAX_NODES = 24, MAX_PARTS = 20, MAX_BULLETS = 8, MAX_TASKS = 30, CAP = 160;
  const out: ChapterInfographic[] = [];
  for (const g of (raw ?? []).slice(0, MAX)) {
    const title = (g.title ?? "").trim();
    if (!title) continue;
    const kind = (g.kind ?? "").toLowerCase();
    let spec: InfographicSpec | undefined;
    if (kind === "summary") {
      const bullets = (g.bullets ?? []).map((b) => (b ?? "").trim()).filter(Boolean).slice(0, MAX_BULLETS).map((b) => b.slice(0, 300));
      if (bullets.length > 0) spec = { kind: "summary", bullets };
    } else if (kind === "flowchart") {
      const nodes = (g.nodes ?? [])
        .slice(0, MAX_NODES)
        .map((n) => ({ id: (n.id ?? "").trim(), label: (n.label ?? "").trim().slice(0, CAP), shape: nodeShape(n.shape) }))
        .filter((n) => n.id && n.label);
      const ids = new Set(nodes.map((n) => n.id));
      const edges = (g.edges ?? [])
        .map((e) => {
          const label = (e.label ?? "").trim().slice(0, 40);
          return { from: (e.from ?? "").trim(), to: (e.to ?? "").trim(), ...(label ? { label } : {}) };
        })
        .filter((e) => ids.has(e.from) && ids.has(e.to));
      if (nodes.length >= 2) spec = { kind: "flowchart", nodes, edges };
    } else if (kind === "diagram") {
      const parts = (g.parts ?? [])
        .slice(0, MAX_PARTS)
        .map((p) => {
          const note = (p.note ?? "").trim().slice(0, 300);
          return { label: (p.label ?? "").trim().slice(0, CAP), ...(note ? { note } : {}) };
        })
        .filter((p) => p.label);
      const caption = (g.caption ?? "").trim().slice(0, 300);
      if (parts.length > 0) spec = { kind: "diagram", parts, ...(caption ? { caption } : {}) };
    } else if (kind === "gantt") {
      const tasks = (g.tasks ?? [])
        .slice(0, MAX_TASKS)
        .map((t, i) => {
          const start = Number.isFinite(t.start) ? Math.round(t.start) : 0;
          const end = Number.isFinite(t.end) ? Math.round(t.end) : start;
          return { id: (t.id ?? "").trim() || `t${i}`, label: (t.label ?? "").trim().slice(0, CAP), start, end: Math.max(start, end) };
        })
        .filter((t) => t.label);
      if (tasks.length >= 2) spec = { kind: "gantt", unit: (g.unit ?? "").trim().slice(0, 24), tasks };
    }
    if (!spec) continue;
    out.push({ id: `info-${chapterIndex}-${slug(title) || out.length}`, chapterIndex, title, anchor: (g.anchor ?? "").trim().slice(0, 200), spec });
  }
  return out;
}

export function mergeExtraction(
  existing: VisualBible,
  raw: RawExtraction,
  chapterIndex: number,
  unitRanges?: [number, number][],
): VisualBible {
  const bible: VisualBible = {
    ...existing,
    characters: [...existing.characters],
    environments: [...existing.environments],
    creatures: [...(existing.creatures ?? [])],
    spoilers: [...existing.spoilers],
    storyboard: [...(existing.storyboard ?? [])],
    glossary: [...(existing.glossary ?? [])],
    datasets: [...(existing.datasets ?? [])],
    infographics: [...(existing.infographics ?? [])],
    processedChapters: [...existing.processedChapters],
  };
  const knownTerms = new Set(bible.glossary.map((g) => g.term.toLowerCase()));

  for (const c of raw.characters) {
    // Upsert by exact name (accumulating aliases/appearance on a re-mention); the
    // consolidation pass below collapses alias/partial-name duplicates.
    const at = bible.characters.findIndex((ex) => ex.name.toLowerCase() === c.name.toLowerCase());
    if (at >= 0) {
      bible.characters[at] = mergeRawIntoCharacter(bible.characters[at]!, c);
    } else {
      bible.characters.push({
        id: `char-${slug(c.name)}`,
        name: c.name,
        aliases: c.aliases,
        appearance: { ...emptyAppearance(), ...(c.appearance ?? {}) },
        persistentTraits: c.persistentTraits,
        clothing: c.clothing ?? [],
        outfits: dedupeOutfits(c.outfits ?? []),
        anchor: { seed: deterministicSeed(c.name) },
        firstSeenChapter: chapterIndex,
      });
    }
  }
  bible.characters = consolidateCharacters(bible.characters);
  for (const g of raw.glossary ?? []) {
    const term = g.term.trim();
    if (!term || knownTerms.has(term.toLowerCase())) continue;
    knownTerms.add(term.toLowerCase());
    bible.glossary.push({ term, definition: g.definition });
  }
  for (const e of raw.environments) {
    const key = e.name.toLowerCase();
    const rawAliases = (e.aliases ?? []).map((a) => a.trim()).filter(Boolean);
    // Match by canonical name OR alias, in both directions — a later chapter
    // re-extracting "the fortress" must merge into Basgiliath, not fork it.
    const allNames = (env: (typeof bible.environments)[number]) =>
      [env.name, ...(env.aliases ?? [])].map((n) => n.toLowerCase());
    const at = bible.environments.findIndex(
      (env) =>
        allNames(env).includes(key) || rawAliases.some((a) => allNames(env).includes(a.toLowerCase())),
    );
    if (at >= 0) {
      // Known location → ACCUMULATE new description lines (so a chapter that adds
      // detail enriches it, and a name-only mention later still has the full look)
      // and any newly-heard aliases.
      const existingEnv = bible.environments[at]!;
      const have = new Set(existingEnv.description.map((d) => d.toLowerCase()));
      const merged = [...existingEnv.description];
      for (const d of e.description) {
        if (d.trim() && !have.has(d.toLowerCase())) {
          merged.push(d);
          have.add(d.toLowerCase());
        }
      }
      // Add the canonical name + any newly-heard aliases, deduping against both the
      // existing forms AND each other (the batch can carry "The Fortress"/"the fortress").
      const known = new Set(allNames(existingEnv));
      const aliases = [...(existingEnv.aliases ?? [])];
      for (const a of [e.name, ...rawAliases]) {
        if (!known.has(a.toLowerCase())) {
          known.add(a.toLowerCase());
          aliases.push(a);
        }
      }
      bible.environments[at] = {
        ...existingEnv,
        description: merged,
        ...(aliases.length ? { aliases } : {}),
      };
    } else {
      bible.environments.push({
        id: `env-${slug(e.name)}`,
        name: e.name,
        ...(rawAliases.length ? { aliases: rawAliases } : {}),
        description: e.description,
        firstSeenChapter: chapterIndex,
      });
    }
  }
  for (const cr of raw.creatures ?? []) {
    const name = cr.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const at = bible.creatures.findIndex((x) => x.name.toLowerCase() === key);
    if (at >= 0) {
      // Known creature → ACCUMULATE description (so a beast named once later still
      // has its full look, and recurring detail enriches it).
      const existingCr = bible.creatures[at]!;
      const have = new Set(existingCr.description.map((d) => d.toLowerCase()));
      const merged = [...existingCr.description];
      for (const d of cr.description) {
        if (d.trim() && !have.has(d.toLowerCase())) {
          merged.push(d);
          have.add(d.toLowerCase());
        }
      }
      bible.creatures[at] = {
        ...existingCr,
        description: merged,
        ...(existingCr.kind ? {} : { kind: cr.kind }),
      };
    } else {
      const creature: Creature = {
        id: `creature-${slug(name)}`,
        name,
        aliases: cr.aliases,
        kind: cr.kind,
        description: cr.description,
        anchor: { seed: deterministicSeed(`creature:${name}`) },
        firstSeenChapter: chapterIndex,
      };
      bible.creatures.push(creature);
    }
  }
  for (const s of raw.spoilers) {
    bible.spoilers.push({
      id: `spoiler-${slug(s.label)}-${chapterIndex}`,
      label: s.label,
      // Deprecated: reveal timing is derived from where the label appears on the page
      // (see visual-bible/reveal.ts), not a precomputed id. Kept "" for the cached shape.
      revealParagraphId: "",
    });
  }

  // Cross-chapter location carry-forward (the best practice the as-you-go story tracker
  // proved): when THIS chapter names no location, the scene almost always continues in the
  // place already established — inherit the most recent prior chapter's location so a unit is
  // never left location-less (which let the render drift to a different setting). A real move
  // sets a fresh `location`, which always wins. Within-chapter fallback (the chapter location
  // folded into each beat) was already handled by mapKeyEventsToUnits; this extends the same
  // idea ACROSS chapters, unifying book + story scene tracking.
  const carriedLocation =
    (raw.location ?? "").trim() ||
    (() => {
      for (let i = chapterIndex - 1; i >= 0; i--) {
        const loc = bible.storyboard.find((s) => s.chapterIndex === i)?.location?.trim();
        if (loc) return loc;
      }
      return "";
    })();
  // Upsert this chapter's storyboard scene (idempotent re-run replaces it). Fold in the
  // per-scene image prompts: map raw.keyEvents[i] → the chapter's unitRanges[i].
  const incoming = mapKeyEventsToUnits(raw.keyEvents, unitRanges, carriedLocation);
  if (raw.summary || raw.keyMoment || carriedLocation || incoming.length > 0) {
    const at = bible.storyboard.findIndex((s) => s.chapterIndex === chapterIndex);
    const prev = at >= 0 ? bible.storyboard[at] : undefined;
    const scene: ChapterScene = {
      chapterIndex,
      summary: raw.summary ?? "",
      keyMoment: raw.keyMoment ?? "",
      location: carriedLocation,
      locationChange: raw.locationChange ?? "",
      // Fresh keyEvents win; if none came back this run, keep any prior ones.
      ...(incoming.length > 0
        ? { keyEvents: incoming }
        : prev?.keyEvents
          ? { keyEvents: prev.keyEvents }
          : {}),
    };
    if (at >= 0) bible.storyboard[at] = scene;
    else bible.storyboard.push(scene);
    bible.storyboard.sort((a, b) => a.chapterIndex - b.chapterIndex);
  }

  // Datasets: upsert per chapter, mirroring the storyboard — a re-run REPLACES this
  // chapter's series (idempotent) but keeps nothing stale when the re-run finds none.
  const incomingData = sanitizeDatasets(raw.datasets, chapterIndex);
  if (incomingData.length > 0 || (raw.datasets?.length ?? 0) > 0) {
    bible.datasets = [
      ...(bible.datasets ?? []).filter((d) => d.chapterIndex !== chapterIndex),
      ...incomingData,
    ].sort((a, b) => a.chapterIndex - b.chapterIndex);
  }

  const incomingInfo = sanitizeInfographics(raw.infographics, chapterIndex);
  if (incomingInfo.length > 0 || (raw.infographics?.length ?? 0) > 0) {
    bible.infographics = [
      ...(bible.infographics ?? []).filter((g) => g.chapterIndex !== chapterIndex),
      ...incomingInfo,
    ].sort((a, b) => a.chapterIndex - b.chapterIndex);
  }

  // World style: adopt it, preferring the most specific (longest) version seen so far so
  // a later chapter can enrich it but a terse mention never overwrites a richer one.
  const newStyle = sanitizeWorldStyle(raw.worldStyle);
  if (newStyle && newStyle.length > (bible.worldStyle ?? "").trim().length) {
    bible.worldStyle = newStyle;
  }

  if (!bible.processedChapters.includes(chapterIndex)) {
    bible.processedChapters.push(chapterIndex);
  }
  return bible;
}

/**
 * The user message for building one unit's image prompt. Scoped to THIS chapter: the
 * bible already encodes accumulated state, so prior chapters are not dumped in. Names
 * (not descriptions) are listed — the writer refers to characters/creatures/outfits/
 * locations by name, and the app expands those into visual descriptors at render time.
 */
export function promptUserContent(request: VisualRequest, bible: VisualBible): string {
  const chars = bible.characters.filter((c) => request.characterIds.includes(c.id));
  const envs = bible.environments.filter((e) => request.environmentIds.includes(e.id));
  const creatures = (bible.creatures ?? []).filter((c) => request.creatureIds.includes(c.id));
  // Grounding citations ("References (chapter N)" = bare source URLs) are kept in the
  // glossary for the bible/export, but they're useless to a prompt writer — and one
  // accrues per chapter, so they'd grow every image-prompt request for nothing.
  const facts = (bible.glossary ?? []).filter((g) => !g.term.startsWith("References (chapter"));
  const scene = (bible.storyboard ?? []).find((s) => s.chapterIndex === request.chapterIndex);
  // Beat-level setting: this unit's stored keyEvent (if any) knows where ITS moment
  // happens — more exact than the chapter's single location when the chapter moves.
  const beatLocation = resolveKeyEvent(bible, request.chapterIndex, request.pageRange)?.location;
  return [
    request.allowMature ? MATURE_CONTENT_NOTE : "",
    request.bookTitle ? `Book: ${request.bookTitle}.` : "",
    `Illustrate the single most important action in THIS passage (below): its most consequential, ` +
      `visually striking moment — a decisive action or vivid image, NOT people merely standing and ` +
      `talking. Quoted speech describes what characters SAY, not what to draw — never depict the literal ` +
      `content of dialogue (a line like "look at the dragon" is NOT a dragon in the scene); draw only the ` +
      `physical action and the characters actually present. Each illustration covers a DIFFERENT stretch ` +
      `of the chapter, so depict ONLY what happens in THIS passage — not the chapter's overall climax, ` +
      `and not a previous illustration's moment.`,
    `Passage:\n${request.sourceText}`,
    settingLine(scene, envs, request.sourceText, beatLocation),
    chars.length
      ? `Characters present — refer to each by their EXACT name; do NOT describe their looks ` +
        `(auto-applied). They are PEOPLE (a name like 'Cat' is a person). Where a character has ` +
        `outfit options, name the ONE label that fits this scene:\n${chars
          .map((c) => `- ${characterNameLine(c)}`)
          .join("\n")}`
      : "",
    creatures.length
      ? `Creatures present — refer to each by their EXACT name (look auto-applied):\n${creatures
          .map((c) => `- ${c.name}${c.kind ? ` (${c.kind})` : ""}`)
          .join("\n")}`
      : "",
    envs.length
      ? `Locations available — refer to a place by its EXACT name (look auto-applied):\n${envs
          .map((e) => `- ${e.name}`)
          .join("\n")}`
      : "",
    facts.length
      ? `World facts (apply as defaults unless the passage says otherwise):\n${facts
          .map((g) => `- ${g.term}: ${g.definition}`)
          .join("\n")}`
      : "",
    scene?.summary
      ? `This chapter (continuity only — illustrate the passage, not this): ${scene.summary}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A present-character line for the prompt context: name + alias hint + outfit LABELS only. */
function characterNameLine(c: Character): string {
  const aka = c.aliases.length ? ` (aka ${c.aliases.slice(0, 3).join(", ")})` : "";
  const labels = (c.outfits ?? []).map((o) => o.label).filter(Boolean);
  const outfits = labels.length ? ` — outfit labels: ${labels.join(", ")}` : "";
  return `${c.name}${aka}${outfits}`;
}

/**
 * The single location this image must commit to, by preference: (1) the unit's
 * beat-level location from its stored keyEvent (exact, tracked per image even
 * when the chapter moves); (2) a known environment the passage actually names;
 * (3) the chapter scene's primary `location`. `locationChange` is passed as
 * context so the writer knows the chapter moves and must still pick ONE setting.
 */
function settingLine(
  scene: { location?: string; locationChange?: string } | undefined,
  envs: { name: string }[],
  sourceText: string,
  beatLocation?: string,
): string {
  const haystack = sourceText.toLowerCase();
  const named = envs.find((e) => e.name && haystack.includes(e.name.toLowerCase()));
  // Precedence: the beat's own location (most exact) → the chapter's EXTRACTED location (the model
  // already decided where this chapter happens) → only as a last resort, an environment NAME that
  // literally appears in the passage. The passage scan used to outrank the chapter location, which
  // is the "inside a classroom" → "outside at desks" bug: a stray place-name in the prose would win
  // over the real setting. It's now the fallback, used only when nothing authoritative is known.
  const place = (beatLocation ?? "").trim() || (scene?.location ?? "").trim() || named?.name || "";
  if (!place) return "";
  const change = scene?.locationChange ? ` (note: the chapter moves — ${scene.locationChange})` : "";
  return `Setting for this image (use this ONE location, do not blend places): ${place}${change}`;
}

// --- Character de-duplication -------------------------------------------------

/** Case-insensitive union of two string lists, trimmed, blanks dropped, order kept. */
function unionStrings(a: string[], b: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of [...a, ...b]) {
    const t = s.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

/**
 * Accumulate appearance details: keep adding NEW information per field across
 * chapters rather than only filling blanks. If `extra` adds detail not already
 * present, append it ("brown" + "fades to silver at the tips"); if `extra` is a
 * richer superset of `base`, replace; exact/contained repeats are ignored.
 */
function accumulateAppearance(
  base: CharacterAppearance,
  extra: Partial<CharacterAppearance> | undefined,
): CharacterAppearance {
  if (!extra) return base;
  const out = { ...base };
  (Object.keys(out) as (keyof CharacterAppearance)[]).forEach((k) => {
    const cur = out[k].trim();
    const add = (extra[k] ?? "").trim();
    if (!add) return;
    if (!cur) {
      out[k] = add;
      return;
    }
    const lc = cur.toLowerCase();
    const la = add.toLowerCase();
    if (lc.includes(la)) return; // already have this detail
    if (la.includes(lc)) {
      out[k] = add; // new value is a richer superset
      return;
    }
    out[k] = `${cur}; ${add}`; // genuinely new detail → append
  });
  return out;
}

/** An outfit as it may arrive (extraction no longer sends `context`; cached data may). */
type PartialOutfit = { label?: string; description?: string; context?: string };

/** Distinct outfits by (lowercased) label, order preserved, blanks dropped. `context`
 * is no longer extracted (unused at render) but kept on the stored shape for back-compat. */
function dedupeOutfits(list: readonly PartialOutfit[]): Outfit[] {
  const out: Outfit[] = [];
  const seen = new Set<string>();
  for (const o of list) {
    const label = o.label?.trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push({ label, description: o.description ?? "", context: o.context ?? "" });
  }
  return out;
}
function unionOutfits(a: readonly PartialOutfit[] | undefined, b: readonly PartialOutfit[] | undefined): Outfit[] {
  return dedupeOutfits([...(a ?? []), ...(b ?? [])]);
}

/** Merge a raw extraction's character into an existing one (same exact name). */
function mergeRawIntoCharacter(ex: Character, raw: RawExtraction["characters"][number]): Character {
  return {
    ...ex,
    aliases: unionStrings(ex.aliases, [raw.name, ...raw.aliases]).filter(
      (a) => a.toLowerCase() !== ex.name.toLowerCase(),
    ),
    appearance: accumulateAppearance(ex.appearance, raw.appearance),
    persistentTraits: unionStrings(ex.persistentTraits, raw.persistentTraits),
    clothing: unionStrings(ex.clothing, raw.clothing ?? []),
    outfits: unionOutfits(ex.outfits, raw.outfits ?? []),
  };
}

/** Merge two known characters into one (keeping `canon` as the canonical entry). */
function mergeCharacters(canon: Character, other: Character): Character {
  return {
    ...canon,
    aliases: unionStrings([...canon.aliases, other.name, ...other.aliases], []).filter(
      (a) => a.toLowerCase() !== canon.name.toLowerCase(),
    ),
    appearance: accumulateAppearance(canon.appearance, other.appearance),
    persistentTraits: unionStrings(canon.persistentTraits, other.persistentTraits),
    clothing: unionStrings(canon.clothing, other.clothing),
    outfits: unionOutfits(canon.outfits, other.outfits),
    firstSeenChapter: Math.min(canon.firstSeenChapter, other.firstSeenChapter),
  };
}

/** Lowercased name + aliases. */
function charKeys(c: Character): Set<string> {
  return new Set([c.name, ...c.aliases].map((s) => s.trim().toLowerCase()).filter(Boolean));
}
/**
 * Same person only when one character's primary NAME appears in the other's
 * name/alias set. A mere alias↔alias overlap is deliberately NOT enough: models
 * hand out the same generic alias ("the rider", "her brother", "the lieutenant")
 * to several people, and treating that as identity chain-merged whole casts into
 * one entry (each merge unions the alias sets, intersecting ever more characters).
 * A primary name is the specific, deliberate form — safe to merge on.
 */
function sameNamedPerson(a: Character, b: Character): boolean {
  const an = a.name.trim().toLowerCase();
  const bn = b.name.trim().toLowerCase();
  if (!an || !bn) return false;
  return charKeys(b).has(an) || charKeys(a).has(bn);
}
function nameTokens(name: string): Set<string> {
  return new Set(name.toLowerCase().split(/\s+/).filter(Boolean));
}
function isStrictSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || a.size >= b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}
/** The fuller name wins (more tokens); ties broken by earliest appearance. */
function pickCanonical(a: Character, b: Character): [Character, Character] {
  const ta = nameTokens(a.name).size;
  const tb = nameTokens(b.name).size;
  if (ta !== tb) return ta > tb ? [a, b] : [b, a];
  return a.firstSeenChapter <= b.firstSeenChapter ? [a, b] : [b, a];
}

/**
 * Collapse duplicate characters: (1) one's primary NAME appears in the other's
 * name/alias set (alias↔alias overlap alone is NOT identity — see
 * `sameNamedPerson`); (2) a partial name is merged into its UNIQUE fuller name
 * ("Violet" → "Violet Sorrengail"). Ambiguous partials (a bare "Anne" when both
 * "Anne Boleyn" and "Anne Frank" exist) are left alone. Idempotent.
 */
export function consolidateCharacters(list: Character[]): Character[] {
  let chars = [...list];

  // Pass 1 — a primary name matching the other's name/alias set (same person).
  for (let again = true; again; ) {
    again = false;
    for (let i = 0; i < chars.length && !again; i++) {
      for (let j = i + 1; j < chars.length; j++) {
        if (sameNamedPerson(chars[i]!, chars[j]!)) {
          const [canon, other] = pickCanonical(chars[i]!, chars[j]!);
          chars = chars.filter((_, k) => k !== i && k !== j);
          chars.push(mergeCharacters(canon, other));
          again = true;
          break;
        }
      }
    }
  }

  // Pass 2 — a partial name with exactly one fuller-name superset.
  for (let again = true; again; ) {
    again = false;
    for (let i = 0; i < chars.length && !again; i++) {
      const partial = chars[i]!;
      const ti = nameTokens(partial.name);
      const supers = chars.filter((c) => c !== partial && isStrictSubset(ti, nameTokens(c.name)));
      if (supers.length === 1) {
        const sup = supers[0]!;
        chars = chars.filter((c) => c !== partial && c !== sup);
        chars.push(mergeCharacters(sup, partial));
        again = true;
      }
    }
  }

  return chars;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * True when an extraction carries no signal at all — no entities, no storyboard
 * fields, no scene prompts. A REAL chapter never extracts to this (the schema
 * requires at least a summary/keyMoment/keyEvents even when every entity is
 * already known), so it means the model's response didn't parse (truncated or
 * malformed JSON). Callers treat it as a failure so the chapter is retried
 * instead of silently committed with nothing to render from.
 */
export function isEmptyExtraction(raw: RawExtraction): boolean {
  return (
    raw.characters.length === 0 &&
    raw.environments.length === 0 &&
    (raw.creatures?.length ?? 0) === 0 &&
    raw.spoilers.length === 0 &&
    (raw.glossary?.length ?? 0) === 0 &&
    !(raw.summary ?? "").trim() &&
    !(raw.keyMoment ?? "").trim() &&
    (raw.keyEvents?.length ?? 0) === 0
  );
}

/**
 * Strip a reasoning model's chain-of-thought preamble before parsing its answer.
 * Hybrid "thinking" models (e.g. Qwen 3, with thinking on) emit a `<think>…</think>`
 * (or `<thinking>…</thinking>`) block first; left in, it inflates output, breaks the
 * JSON parse, and can leak reasoning into an image prompt. A non-thinking model has no
 * such tags, so this is a no-op for them. Handles a paired block and the truncated
 * case where the opening tag is missing but a stray `</think>` precedes the answer.
 */
export function stripThink(s: string): string {
  return s
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "") // paired reasoning blocks
    .replace(/^[\s\S]*?<\/think(?:ing)?>/i, "") // opener-omitted leading reasoning, up to its close
    .trim();
}
