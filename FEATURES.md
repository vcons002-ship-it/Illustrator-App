# Visual Reader — Features, How It Works & Roadmap

A plain-language guide to what the app does and where it's going. For install/setup,
see **[SETUP.md](./SETUP.md)**; for the technical architecture, see **[README.md](./README.md)**.

---

## What it is

**Visual Reader illustrates a book as you read it.** You open a book — an EPUB, a text
or Markdown file, a PDF, or text you paste in — and the app quietly reads the story,
learns the characters and places, and paints a picture for each stretch of pages —
keeping everyone looking consistent and never spoiling what's ahead. It runs on your own
machine and can work fully offline. Non-fiction (papers, textbooks) can be read in a
**technical mode** that illustrates concepts and diagrams instead of story scenes.

The home screen is a **chat assistant** that drives the whole app conversationally:
ask it anything, or tell it to *"open a random classic novel and illustrate it in oil
painting style"* and it finds the book, sets the style, opens it, and starts painting —
then follows you into the book to keep talking about it.

---

## Feature list

### 📖 Reading & illustrations
- **Open almost any document** — EPUB, plain text (`.txt`), Markdown, HTML, PDF, **Word
  (`.docx`)**, **Excel (`.xlsx`)**, **CSV/TSV**, **RTF**, and **JSON**; or **Paste text** to
  read/illustrate any article or excerpt. (Or click *Load sample* to try it instantly.)
  Spreadsheets and data files open in technical mode automatically.
- **Transform a photo** — drop an image file (`.png/.jpg/.webp/.gif`) and the app opens a
  **photo-transform** panel instead: restyle or reimagine that picture through your image
  model (cloud Gemini/OpenAI or your local ComfyUI) — it keeps the photo's composition and
  doesn't force the book's global art style onto it.
- **Export an illustrated copy** — save the open book (its text + the art rendered so far)
  as a **self-contained HTML page** or an **EPUB** — from the toolbar or just by asking the
  chat ("export this as an epub").
- **Test image** — type any prompt and render one image with the current model/style to
  quickly try providers, styles, and LoRAs without opening a book.
- **Clean reader** with chapter headings and page dividers.
- **One illustration per page-group** — you choose how many pages share an image
  (any number), or one image per chapter. Fewer pages = more frequent, quicker art;
  more pages = rarer, richer art.
- **Reveal as you read** — each picture gently un-blurs ("blooms") as you move through
  its pages, so the image arrives with the moment.
- **Click to reveal** — click any illustration to show it in full immediately; click
  again to hand control back to your reading. (Resets when you turn the page.)
- **On-image description** — each illustration shows the exact prompt it was rendered
  from (stored with the image, so it never changes afterwards — and doubles as prompt
  troubleshooting). Until it renders, the unit's pre-written scene prompt shows instead.
- **Bigger image panel** sized to your window.

### 🧠 Understanding the story (the "Visual Bible")
The app builds a structured memory of the book so art stays consistent:
- **Characters** with easy-to-read appearance fields (hair, eyes, gender, physique,
  height, skin tone, age, distinguishing marks) plus their outfits/fashion. **Every**
  named character with a description is tracked.
- **Locations** captured by name with detailed descriptions that **grow over the book** —
  so a place described once still looks right when a later chapter only mentions it.
- **Per-chapter storyboard** — what happens, the single key moment to illustrate, and
  **where** it happens — tracked **per image**, beat by beat, so even when a chapter
  moves between places each illustration knows the one place its own moment happens.
- **World glossary** — recurring world rules ("riders wear flight leathers", tech level,
  materials) applied as defaults in every picture.
- **World style** — one auto-derived genre/art-direction line for the whole book
  (e.g. "high-fantasy military academy, dark, painterly") applied to **every**
  illustration, so even a scene with no stated clothing or setting stays in-genre.
- **Illustration prompts written as it reads** — each chapter's analysis also produces
  that chapter's scene prompts (stored in the Bible), so images render from stored
  prompts and never wait on the AI mid-read.
- **Spoilers** flagged so their imagery stays hidden until you reach them.
- **Skips non-story pages** — title page, copyright, table of contents, dedication,
  "about the author", etc. are read past, not illustrated.

### 🔬 Technical / scientific mode (non-fiction)
Import a book as **technical** (a toggle on the Paste-text / file flow) and the app
switches from a story Visual Bible to a **Visual Atlas**:
- **Tracks structures, systems, and data** instead of characters/outfits — recurring
  apparatus get consistent visual descriptions, and key definitions, quantities, and
  findings are captured as a glossary.
- **A visualization plan** decides what's worth drawing per passage (quantitative results
  and comparisons → mechanisms/processes → structures → a visual metaphor for abstractions).
- **Real figures first** — fetches an authoritative existing diagram before generating
  one; falls back to AI generation. Works with **zero setup** via free Wikimedia Commons
  search; add a Google Programmable Search key for whole-web figures (your Gemini key can
  double as the search key — enable Custom Search API on its project).
- **Sourced facts** — grounds the analysis in a web search and cites the sources in the
  glossary. Keyless via free Wikipedia search, or whole-web with a Custom Search key.
  Works with the Gemini reader (built-in grounding) **or** any other reader, including a
  local LLM. See SETUP.md → *Scientific sources*.
- **Computed charts & statistics** — when a chapter states a real numeric series (a
  table, results, a comparison), the analysis captures it and the reader shows a true
  bar/line/scatter chart drawn by the app (exact axes and values — never an AI's
  imagined numbers) plus min/max/mean/median and the trend, in a collapsible **Data**
  section under the illustration.

### 🤝 Chat buddy (the home screen)
The landing page **is** a full-window chat assistant. Three voices — **Freeform**
(default: a general assistant that runs the app on request), **Entertainment** (book-club
companion), and **Technical** (research companion):
- **Talk about anything** — questions, brainstorming and invention help, working through
  ideas; it does **real math** with a built-in calculator tool (never guessed arithmetic).
- **Finds things to read**: your **library** (it knows your books), **Project Gutenberg**
  (~75k public-domain books — "open Frankenstein", or "surprise me" for a random classic),
  **web articles** by search or URL, or text you **paste straight into the chat** (a poem,
  an excerpt) — and opens any of them in the reader.
- **Runs the app by voice**: set the art style and illustration cadence ("…in oil painting
  style, one image per chapter"), start illustrating ("…and illustrate it"), generate
  one-off images (with your approval), find real figures/diagrams, manage the library
  ("remove Dune"). It knows your current default settings and only overrides them when
  you ask.
- **The conversation follows you** — when it opens a book, the discussion continues
  inside the reader's book chat, context intact.
- **Reads a page or repo for you** — point it at a URL (or a GitHub repo, where it reads
  the README + file list, or a single file) and it pulls the text into the chat to learn
  from before answering or writing code.
- **Remembers what you like** — tell it "I prefer watercolor" or "never spoil endings" and
  it keeps a **long-term memory** that applies in every future conversation and book (you
  can ask it to forget, too).
- **Asks instead of guessing** — if a request is ambiguous (which book, which window, which
  export format), it asks one short question or offers a couple of concrete options.
- **Type `/` for commands** — a slash-command menu runs any tool directly: `/web`, `/books`,
  `/random`, `/open`, `/images`, `/draw`, `/calc`, `/style`, `/remember`, and (desktop)
  `/find`. The book chat has its own set (`/bible`, `/book`, `/web`, `/draw`, …).
- **Makes files** — ask for a worksheet, a quiz, a CSV, or "code me a landing page" and it
  writes the complete content with a one-click **Save** button.
- **Searches the web keylessly** — Wikipedia out of the box; full-web DuckDuckGo where
  the platform allows it (extension / desktop); your Google Custom Search key upgrades it
  to whole-web everywhere.

### 🛠 Hands-on tools (desktop, opt-in & always approved)
On the desktop app the assistant can reach your machine to actually *do* things — every
step is shown and waits for your click, and the riskier tools are off until you turn them
on in Settings:
- **Find a file on your computer** — "open the PDF in my downloads" → it searches and shows
  the matches as clickable items (you approve filesystem access once per session).
- **Run a command and react to it** — install dependencies, run a build or tests, or execute
  a script it just wrote — in a dedicated `VisualReader` workspace folder. You approve each
  command; its output comes back so the assistant can **test code, see what failed, fix it,
  and try again** on its own.
- **Look at your screen** — it can take a screenshot (the whole screen, or just one window
  by name — handy for a running game) and **assess it with a vision model** to check whether
  what it built actually works. Vision can be a cloud model *or* a fully local one, so the
  picture never has to leave your machine. You approve the first capture and can allow the
  rest for the session.

### 💬 Book chat (reading companion)
Open **Chat** while reading to discuss the book with an AI that actually knows it:
- **Spoiler-safe by default** (fiction) — the chat only sees the book up to your current
  position and says so if you ask about later events; an *allow spoilers* toggle unlocks
  the whole book. Technical books are always fully visible.
- **Fast on simple requests, deep when asked** — the chat keeps the text around your
  position in view and **looks passages up on demand** (a `search the book` tool) when a
  question needs another chapter, instead of re-reading the whole book every message.
- **Knows the app's analysis** — the glossary, structures/locations, chapter summaries,
  the actual image prompts, and any extracted datasets (the "technical bible").
- **Can use the app's tools**: search the book, search the web for sources, **read a web
  page** into the chat (`read_url`), find real images/diagrams (shown inline with links),
  **generate images** with your image models (always with your approval), **export** the
  illustrated book, and keep a **long-term memory** of your preferences. Type `/` for the
  command menu (`/bible`, `/book`, `/web`, `/images`, `/draw`, `/remember`, …), or ask for a
  file/quiz/summary and it writes it with a Save button.
- **Ask for render settings in plain chat** — "draw a truck, 20 steps, flux 2" picks the
  named *installed* model, step count, and style for that one render — and if a name
  doesn't match anything installed, it tells you what is installed instead of silently
  using the default.
- **Its own model choice** — the chat defaults to a local model (free & private) and can
  use any downloaded Ollama/WebLLM model independently of the book reader, or an API
  provider; image generation likewise defaults to the local engine (Settings → *Book chat*).
- **Context you can see** — a "Context: ~N tokens" line above the chat expands into a
  donut showing exactly where the model's window is going (book text / visual bible /
  history / your message / instructions), with a warning as you near a small local
  model's limit. Local models are budgeted to their **actual** context window.
- **Manage the conversation** — per-book history that survives reloads, **delete any
  single message** (✕ on the bubble), or **Compact** the chat into a summary the model
  continues from (frees a small model's memory without losing the thread).

### ✏️ Control & correction
- **Begin generating** button — start illustrating when you're ready; reuses anything
  made in past sessions.
- **← Exit book** — close the reader back to the home screen anytime (generation stops;
  the book stays in your Library and reopens instantly).
- **Character Bible editor** — open *Characters*, see every character's appearance, and
  fix any mistake. Saved instantly (existing images stay until you re-render).
- **Pause / Resume** generation anytime.
- **Re-generate** in three scopes: the **storyboard** (re-run the analysis, e.g. after
  switching models), **all images**, or just **this image** (re-roll the one you're on).
- **Pre-render the whole book** in one go.
- **Pick frequency & quality** — pages-per-image, and Auto/Draft/Standard/High/Ultra
  (Auto scales quality up as pages-per-image grows: 1→Draft, 2–4→Standard, 5–7→High,
  8+/whole-chapter→Ultra). The picker shows what Auto resolves to and each level's
  canvas size, so you can drop to a faster level or one your GPU can handle; advanced
  users can also override sampler steps and CFG/guidance on a local engine.
- **Progress you can see** — "Building the Visual Bible… 3/12 chapters · 24% · pages
  40/210 · 23 characters", plus live token/percent feedback; illustration prompts
  advance chapter by chapter as the book is read.

### 🔌 Providers & privacy (bring your own, or run local)
- **Text (story understanding):** Claude, Gemini, or OpenAI with your key — **or local**:
  on-device (WebGPU, no key, nothing leaves your machine) or your own local LLM server
  (Ollama / LM Studio / llama.cpp). **Ollama models download from the Settings menu**
  with a live progress bar — no terminal.
- **Images:** a Flux-style API, Gemini, or OpenAI with your key — **or local** on your
  own GPU via ComfyUI or AUTOMATIC1111 (SD 1.5 / SDXL / Flux.1, plus **Z-Image Turbo**,
  **Flux.2 Klein** and **Qwen-Image** on ComfyUI). The **desktop app can auto-manage**
  ComfyUI and downloads every file a model needs (split files included, resumable).
- **Vision (seeing images):** the screenshot tool and "what's in this image?" need a
  vision-capable model. **Claude, Gemini, and OpenAI** all see images; **locally**, a vision
  model does too — Ollama `llama3.2-vision` / `llava` / `qwen2-vl`, or an LM Studio vision
  model — so screen assessment can stay fully offline. Settings calls out which of your
  models can see (text-only local models can't).
- **One-API native mode:** when the same vendor (Gemini/OpenAI) runs text **and** images,
  opt into its **multimodal** image model so your uploaded character reference photos guide
  cloud renders — the consistency a local IP-Adapter gives, with just a key.
- **What you need to run it:** **cloud** needs nothing but a key and any laptop. **Local
  text** ranges from tiny on-device models (Llama 3.2 1B/3B, Qwen2.5 3B) up to Qwen 3 14B /
  Gemma 3 12B for the best prompts; **local images** from SD 1.5 on ~4 GB VRAM up through
  SDXL, Flux.1, **Z-Image Turbo** (the recommended default), Flux.2 Klein, and Qwen-Image on
  bigger GPUs. See **[README → Minimum & recommended specs](./README.md#minimum--recommended-specs)**
  for the full breakdown.
- **No keys? Still works** — built-in placeholder art shows the whole flow.
- **Keys are encrypted** on your device; local/on-device options keep everything private.
- **Mature mode (adults only, off by default)** — a Settings toggle for intentionally
  adult fiction: relaxes the adjustable safety filters (Gemini text+image, Flux) and tells
  the models to illustrate and discuss explicit/violent source material faithfully instead
  of sanitising it. Claude/OpenAI expose no such control and keep their own policies; local
  models have no external filter at all.

### 💻 Where it runs
- **Web app** — the main reader.
- **Desktop app** (Tauri) — same reader, plus it can set up and launch a local GPU image
  engine for you, gives the chat buddy **unrestricted web access** (news front pages,
  DuckDuckGo search) that a browser tab's CORS rules would block, and unlocks the **hands-on
  tools** — finding files on your computer, running commands in a workspace, and taking
  screenshots for a vision model to assess (all approval-gated).
- **Chrome extension** — illustrates articles you read on the web (shares the same
  engine; its background worker provides the same CORS-free web access).

---

## How it works

```
 Open EPUB
    │
    ▼
 Split into chapters → pages → paragraphs   (front/back matter flagged, skipped)
    │
    ▼
 LLM pre-pass  ──►  VISUAL BIBLE  (cached on your device)
    reads the book      • characters (appearance + outfits)
    chapter by chapter  • locations (detailed, accumulated by name)
                        • storyboard (what happens · key moment · where, per image)
                        • world glossary · world style · spoilers
                        • one scene prompt per page-group (written as it reads —
                          stored, so rendering never calls the AI again)
    │
    ▼
 At render time, expand each stored prompt from the Bible:
    names → looks ("Violet rides Tairn" becomes the characters' actual appearance,
    outfit labels become garments, places get their architecture) · world style ·
    formatted for the image model's family (SD vs Flux vs Flux.2 / cloud)
    │
    ▼
 Image provider paints it  ──►  JIT buffer renders the current page-group and a few
                                ahead (and more when idle), so you rarely wait
    │
    ▼
 You read → the picture "blooms" in as you progress; spoilers stay blurred until you
            reach them; click any image to reveal it fully.
```

**A few ideas that make it work well:**
- **Whole-book vs. each-chapter** — by default the app reads the *whole* book first so
  every prompt has full context (best art). You can switch to "each chapter" for a faster
  first image.
- **One picture, one place** — the setting is tracked beat by beat, and each image
  commits to the single location where its own moment happens — even mid-chapter — so
  actions from different settings never get mashed into one frame.
- **Consistency** — characters get a stable identity seed, and their names in every
  prompt are expanded into their Bible appearance at render time (image models can't
  picture a name) — so they don't drift from page to page. You can also upload up to
  **three reference photos** per character in the Character Bible — different angles
  of the same face work best — for even tighter likeness (used by ComfyUI's
  IP-Adapter when installed).
- **It stays out of your way** — in the web app the whole engine runs in a background
  worker, so reading never stutters while art is generated.

---

## Roadmap

**Next up / under consideration**
- **Render web articles with their original layout** — today an opened article is
  converted to clean reader text; an optional sanitized-HTML view (keeping images and
  headings, with illustrations still anchored to paragraphs) is sketched but deferred.
- **Per-character LoRA styles** — pin a character with a dedicated LoRA for even tighter
  consistency (reference-image upload is in; the LoRA slot already exists).
- **Bring the newest reader UI to the Chrome extension** — bigger image, caption, and the
  Character Bible editor are in the web/desktop reader first.

**Designed-for, deliberately later**
- **Info-graphics** — diagrams, flowcharts, and summaries for non-fiction (the pipeline
  already has a slot for new output types).
- **Full on-device image generation** (WebGPU) — image models running entirely in-browser.
- **Hosted option** — an optional managed backend so you don't need your own keys/GPU.

**Done recently**
- **Hands-on desktop tools** — the assistant can (with per-step approval) find files on your
  computer, run commands in a `VisualReader` workspace to build/test code and fix it
  iteratively from the output, and take screenshots that a **cloud or local vision model**
  assesses — so it can verify a game or UI it just built. The command and screenshot tools
  are off by default behind a Settings flag.
- **Illustrated export** — save the open book as a self-contained **HTML page** or an
  **EPUB**, from the toolbar or by asking the chat.
- **More ways in** — open Word, Excel, CSV/TSV, RTF, and JSON files (data files default to
  technical mode); drop an image to **transform a photo** through your image model.
- **Slash commands, memory & read-a-page** — type `/` in either chat for a command menu;
  a **long-term memory** keeps your preferences across books; `read_url` pulls a web page or
  GitHub repo into the chat; and both chats **ask a clarifying question** instead of guessing
  when a request is ambiguous.
- **The chat buddy home screen** — a full-window assistant (Freeform / Entertainment /
  Technical voices) that finds books (library · Project Gutenberg · web · pasted text),
  opens and illustrates them by voice (style + cadence included), generates images with
  approval, retrieves real figures, does real math, manages the library, and hands the
  conversation off into the book chat when a book opens.
- **Chat that knows the book lazily** — a recent window plus an on-demand book search
  tool, so simple requests are instant and deep questions can reach the whole book.
- **Context window transparency** — provider-aware context budgets (local models sized to
  their *actual* window via Ollama), a usage donut showing where every token goes, message
  delete, and a one-click **Compact** that summarizes the conversation in place.
- **Keyless web search everywhere it's possible** — Wikipedia/Commons out of the box,
  DuckDuckGo full-web through the extension's and desktop app's CORS-free shells, and a
  Project Gutenberg catalog (with random-classic picks) for whole books.
- **Mature mode (adults only)** — opt-in unfiltered illustration + discussion of adult
  fiction (relaxed Gemini/Flux safety settings + faithful-depiction prompts end to end).
- **Smarter prompt naming** — locations now track the epithets the text uses ("the
  fortress" → Basgiliath), so indirect references get the right place's visual details.
- **One-API "native" mode** — when the same vendor (Gemini or OpenAI) serves text **and**
  images, opt into rendering through that vendor's **multimodal** model, which takes your
  uploaded character reference photos inline — cloud character-consistency without a local
  IP-Adapter. Includes an experimental **one-shot** sub-mode where the model reads each
  passage and draws it directly.
- **Multi-view character references** — upload up to three photos per character
  (different angles of the same face); they condition each image together for a more
  robust likeness, with thumbnails and per-photo remove in the Character Bible.
  Crowded scenes auto-throttle so several characters' references never blur together.
- **Exact mid-chapter location changes per image** — the setting is now tracked beat by
  beat: every illustration records the ONE place its own moment happens (not just the
  chapter's main location), so when a chapter moves (tavern → road → castle) each image
  commits to the right place, and the picture is pinned to it at render.
- **One-click local model downloads** — curated image models (incl. Z-Image Turbo,
  Flux.2 Klein, Qwen-Image) and Ollama text models download straight from Settings with
  a live progress bar; split-file models fetch every component (resumable) — no terminal.
- **Read-ahead prompts** — scene prompts are written with each chapter's analysis and
  stored; images render purely from stored prompts (no AI call at render time).
- **Name → appearance expansion** — prompts reference characters/outfits/places by
  their Bible names, expanded into full visual descriptions per image model at render.
- **World style** — an auto-derived genre/art-direction line applied to every image.
- **User-uploaded character reference images** (IP-Adapter), replacing auto-capture.
- **Family-correct rendering** — per-family sampler settings (Flux embedded guidance,
  Z-Image 8-step turbo, Qwen-Image CFG/shift) and separate-loader graphs for the
  split-file generation (Flux.2 / Z-Image / Qwen-Image) with catalog-exact text
  encoder + VAE resolution, plus per-family resolution limits.
- Whole-book storyboard with action-driven, location-aware prompts.
- Structured, **editable** character appearance + world glossary.
- Detailed, accumulating location descriptions; skip non-story pages.
- Pick any pages-per-image; auto quality scaling; bigger captioned image.
- Click-to-reveal; faster, spoiler-safe bloom; pause/resume & three regenerate scopes.
- On-device (WebGPU) and local-server text models; local Stable Diffusion images.

---

*Tip: the app works with **no API keys** — just open it and click **Load sample** to see
the whole flow with placeholder art, then add keys (or point it at local models) in
**Settings** for real illustrations.*
