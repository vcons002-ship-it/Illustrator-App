/**
 * Built-in, keyless setup walkthroughs for the app's features, so the chat buddy
 * can guide the reader through turning anything on ("how do I set up image
 * generation?", "connect my calendar", "enable the task assistant"). The content
 * mirrors SETUP.md but lives here as structured data — pure and testable — and is
 * surfaced through the `setup_help` buddy tool: the model looks up the matching
 * guide and walks the reader through it conversationally, one step at a time.
 *
 * No I/O, no host dependency: a lookup over a static table. The guides are concise
 * and provider-agnostic on purpose — the buddy can search_web for a vendor's exact
 * current screen if a detail has drifted, but the steps here are the reliable spine.
 */

export interface SetupGuide {
  /** Stable handle (kebab-case). */
  id: string;
  /** Human title, e.g. "Connect Gmail, Calendar & Tasks". */
  title: string;
  /** Extra keywords/phrases that should match this guide. */
  aliases: string[];
  /** One line: when/why a reader wants this. */
  when: string;
  /** Ordered, plain-language steps. */
  steps: string[];
  /** Optional closing caveat (platform limits, privacy, cost). */
  note?: string;
}

export const SETUP_GUIDES: SetupGuide[] = [
  {
    id: "api-keys",
    title: "Add an AI provider key (Claude / Gemini / OpenAI)",
    aliases: ["api key", "add a key", "claude", "gemini", "openai", "chatgpt", "anthropic", "provider", "cloud model"],
    when: "You want the highest-quality reading/chat (or cloud images) without running anything locally.",
    steps: [
      "Open Settings (the ⚙ button on the home screen).",
      "Get a key: Claude → console.anthropic.com, Gemini → aistudio.google.com/app/apikey (one key does text AND images), OpenAI → platform.openai.com/api-keys.",
      "Paste the key into the matching provider field in Settings. Keys are encrypted on your device and never leave it except to call that provider.",
      "Pick that provider for the reader (and, if it does images, for image generation). Gemini and OpenAI can serve both text and images from one key.",
    ],
    note: "No key needed to try the app — click Load sample for the whole flow with placeholder art. Cloud calls are billed by the provider.",
  },
  {
    id: "image-generation",
    title: "Turn on real image generation (cloud or your own GPU)",
    aliases: ["images", "image generation", "generate images", "comfyui", "automatic1111", "stable diffusion", "flux", "gpu", "draw", "art"],
    when: "You want real illustrations instead of placeholder art.",
    steps: [
      "Easiest (cloud): add a Gemini or OpenAI key (one key does text + images) or a Flux-style image API key in Settings, then choose it under Images.",
      "Free & private (your GPU): install ComfyUI — on the desktop app choose Images → On my computer and it downloads/launches ComfyUI for you; on the web app run comfyui-setup.bat (Windows) or point it at your own ComfyUI URL.",
      "Pick a model in Settings → Images. Z-Image Turbo is the recommended local default; SDXL/Flux.1/Flux.2 Klein/Qwen-Image also work on bigger GPUs, SD 1.5 on ~4 GB VRAM.",
      "Set an art style and cadence (or just ask the chat: \"illustrate in oil painting style, one image per chapter\").",
    ],
    note: "The desktop app can auto-manage ComfyUI (download + start/stop); in the browser a tab can't start a GPU process, so run.bat or your own ComfyUI must be running.",
  },
  {
    id: "local-text-model",
    title: "Run the text model locally (free & private)",
    aliases: ["local model", "local llm", "ollama", "webgpu", "on-device", "lm studio", "llama", "offline", "private"],
    when: "You want reading/chat to run on your machine with no key and nothing leaving it.",
    steps: [
      "On-device (no install): Settings → Text → On-device (WebGPU) and pick a small model (Llama 3.2 1B/3B, Qwen2.5 3B). Runs in the browser; best on a recent GPU.",
      "Local server (better prompts): install Ollama (ollama.com) or LM Studio. Ollama models download straight from Settings with a progress bar — no terminal.",
      "Point the app at it: Settings → Text → Local server, choose the running model. Qwen 3 14B / Gemma 3 12B give the best prompts.",
      "For the chat buddy's own model, set it under Settings → Book chat (it can differ from the reader's model).",
    ],
    note: "Local vision (for screenshots / \"what's in this image?\") needs a vision model — Ollama llama3.2-vision / llava / qwen2-vl, or an LM Studio vision model. Settings flags which of your models can see.",
  },
  {
    id: "google",
    title: "Connect Gmail, Calendar & Tasks",
    aliases: ["google", "gmail", "calendar", "tasks", "email", "connect google", "oauth"],
    when: "You want the assistant to read your email, see/create calendar events, and manage to-dos — and to power the Task Orchestrator + Calendar view.",
    steps: [
      "Go to the Google Cloud Console (console.cloud.google.com) and create a project.",
      "APIs & Services → Enable APIs → enable the Gmail API, Google Calendar API, and Google Tasks API.",
      "OAuth consent screen → choose External, fill in the app name/email, and add your own Google account as a Test user (so Google needn't verify the app — you'll click through an \"unverified app\" screen at sign-in, which is expected).",
      "Credentials → Create credentials → OAuth client ID → Desktop app. Copy the client ID and client secret.",
      "In the app: Settings → 📧 Google → paste the client ID + secret → Connect Google, then approve in the browser window that opens.",
    ],
    note: "The token stays on your device and is refreshed automatically. The app's Google access is read-and-create only — it can never send email, pay, or delete anything. Best in the desktop app.",
  },
  {
    id: "task-workflow",
    title: "Set up the agentic Task Orchestrator",
    aliases: ["task", "tasks orchestrator", "task assistant", "agentic", "auto plan", "automation", "auto-pilot", "schedule", "plan tasks", "reminders"],
    when: "You want the assistant to plan multi-step real-world tasks end to end — research, steps, reminders, prepped docs — and pre-plan actionable items it finds.",
    steps: [
      "Connect Google first (Gmail/Calendar/Tasks) — that's what scheduling, inbox scanning, and the Calendar view use. (Research-only plans work without it.)",
      "Optional but recommended: Settings → \"Let the Task Assistant schedule & prep automatically\" (off by default). On = the safe steps (research, drafts, creating Google Tasks/Calendar reminders) run without a click each, and the idle inbox scan turns on.",
      "Plan something: in chat say \"plan my car registration renewal\" — or open an email and say \"plan this\". Watch it research → plan → prep, then open the plan.",
      "Use the 📋 Tasks panel (open & work a plan in a preloaded chat, mark steps done) and the 📅 Calendar button (your Google calendars + planned deadlines).",
      "Leave the desktop app open and idle (auto-pilot on) and it quietly pre-plans actionable items; dismiss junk with \"Ignore sender\" so it never returns.",
    ],
    note: "It only ever PREPS irreversible actions (submitting, paying, sending) for you to finalize — it never does them itself. The app must be open to scan (no background daemon yet).",
  },
  {
    id: "scientific-sources",
    title: "Whole-web figures & sourced facts (technical books)",
    aliases: ["scientific sources", "figures", "diagrams", "custom search", "programmable search", "google search key", "technical", "citations", "grounding"],
    when: "You read non-fiction/technical books and want real diagrams from the whole web plus web-sourced, cited facts.",
    steps: [
      "Works keyless already: free Wikimedia Commons figures + Wikipedia grounding, no setup.",
      "For whole-web figures/facts, create a Programmable Search Engine (programmablesearchengine.google.com) set to search the entire web — copy its Search engine ID (cx).",
      "In the Google Cloud console, enable the Custom Search API and create an API key (your existing Gemini key's project works — just enable the API on it).",
      "Paste both (the cx and the Custom Search key) into Settings → Scientific sources.",
    ],
    note: "With the Gemini reader you also get its built-in Google Search grounding from the Gemini key alone; the Custom Search key adds whole-web figures for any reader, including local ones.",
  },
  {
    id: "wolfram",
    title: "Add Wolfram|Alpha (real-world data & computation)",
    aliases: ["wolfram", "wolfram alpha", "appid", "computation", "facts"],
    when: "You want authoritative real-world values and step-by-step computation in chat.",
    steps: [
      "Get a free Wolfram|Alpha AppID at developer.wolframalpha.com (Get an AppID).",
      "Paste it into Settings → Wolfram|Alpha.",
      "Ask the chat anything factual/computational — it'll use the wolfram tool when an authoritative value helps.",
    ],
  },
  {
    id: "github",
    title: "Connect GitHub for repo work (desktop)",
    aliases: ["github", "git", "repo", "pull request", "gh", "code", "clone"],
    when: "You want the assistant to clone repos, make changes on a branch, and open pull requests for you.",
    steps: [
      "Use the desktop app and enable the command tool (Settings → allow commands) — repo work runs through run_command in the VisualReader workspace.",
      "Authenticate git: either run `gh auth login` yourself once, or add a GitHub token in Settings.",
      "Ask the assistant to clone and work on a repo by name; it branches, commits, pushes, and opens a PR into the repo's default branch.",
    ],
    note: "It won't force-push, delete history, or change repo settings unless you explicitly ask, and it never prints or commits your token.",
  },
  {
    id: "hands-on-tools",
    title: "Enable the hands-on desktop tools",
    aliases: ["hands-on", "run command", "commands", "screenshot", "find files", "desktop tools", "terminal", "vision"],
    when: "You want the desktop assistant to find files on your computer, run commands, and look at your screen.",
    steps: [
      "Use the desktop app (a browser tab can't touch the filesystem, run a process, or capture the screen).",
      "Settings → turn on the command tool (and screenshots) — these are off by default behind a flag.",
      "Each action is still approval-gated: you approve filesystem access once per session, and every command/first capture waits for your click.",
    ],
    note: "It never acts on its own and won't run a command or open a file just because some web page or book text said to.",
  },
  {
    id: "mature-mode",
    title: "Mature mode (adults only)",
    aliases: ["mature", "adult", "nsfw", "explicit", "safety filter", "uncensored"],
    when: "You're intentionally reading/illustrating adult fiction and want the models to engage with it faithfully.",
    steps: [
      "Settings → toggle Mature mode (off by default).",
      "This relaxes the adjustable safety filters (Gemini text+image, Flux) and tells the models to depict/discuss adult material faithfully.",
    ],
    note: "Claude/OpenAI expose no such control and keep their own policies; fully local models have no external filter at all.",
  },
];

/**
 * Score how well a guide matches a free-text topic. Matches only the curated
 * KEYWORDS (id + aliases), not the prose title — whole-word for single words (so
 * "art" doesn't fire on "started") and phrase-substring for multi-word aliases
 * (so "image generation" beats a lone word). This keeps generic words in a
 * question ("how", "the", "my") from matching anything.
 */
function guideMatches(g: SetupGuide, q: string): number {
  const norm = ` ${q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const words = new Set(norm.trim().split(" ").filter(Boolean));
  if (words.size === 0) return 0;
  let score = 0;
  for (const key of [g.id.replace(/-/g, " "), ...g.aliases]) {
    const k = key.toLowerCase();
    if (k.includes(" ")) {
      if (norm.includes(` ${k} `)) score += 2; // a full multi-word phrase hit is strong
    } else if (words.has(k)) {
      score += 1;
    }
  }
  return score;
}

/** Find the single best-matching setup guide for a free-text topic, or undefined. */
export function findSetupGuide(query: string): SetupGuide | undefined {
  let best: SetupGuide | undefined;
  let bestScore = 0;
  for (const g of SETUP_GUIDES) {
    const s = guideMatches(g, query);
    if (s > bestScore) {
      best = g;
      bestScore = s;
    }
  }
  return bestScore > 0 ? best : undefined;
}

/** Every guide's title (for the prompt + a "which one?" fallback). */
export function setupGuideTopics(): string[] {
  return SETUP_GUIDES.map((g) => g.title);
}

/** A compact, comma-joined topic list for the system prompt / tool description. */
export function setupGuidesIndex(): string {
  return SETUP_GUIDES.map((g) => g.id).join(", ");
}

/** Render a guide as the walkthrough text the buddy narrates from. */
export function formatSetupGuide(g: SetupGuide): string {
  return (
    `${g.title}\n${g.when}\n` +
    g.steps.map((s, i) => `${i + 1}. ${s}`).join("\n") +
    (g.note ? `\nNote: ${g.note}` : "")
  );
}
