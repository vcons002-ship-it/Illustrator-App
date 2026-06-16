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

## Features

Each feature notes **what it needs** in *(italics)*. A quick key:

- *(no setup)* — works out of the box, no keys.
- **Baseline:** anything the AI does needs a **text model** — either a cloud key
  (Claude / Gemini / OpenAI) **or** a free local model (on-device or Ollama/LM Studio).
  Set this up once; it's assumed below and only *extra* requirements are tagged.
- *(image model)* — needs image generation: a cloud image key (Flux/Gemini/OpenAI) **or** your own GPU (ComfyUI/AUTOMATIC1111).
- *(vision model)* — needs a model that can see images (cloud Claude/Gemini/OpenAI, or a local vision model).
- *(desktop)* — the desktop app only. *(opt-in)* — off by default, a Settings toggle.
- *(Google)* — connect Gmail/Calendar/Tasks. *(Schwab key)* — your own Schwab developer app.
- *(browser)* — a browser-provided capability (works where your browser supports it).

---

### 📖 Reading & illustrating books

- **Open almost any document** — EPUB, plain text, Markdown, HTML, PDF, **Word (.docx)**,
  **Excel (.xlsx)**, **CSV/TSV**, **RTF**, **JSON**, or **paste text** to read any article or
  excerpt. Data files open in technical mode automatically. *(no setup — placeholder art needs nothing)*
- **One illustration per page-group** — you choose how many pages share an image (any number,
  or one per chapter): fewer pages = more frequent, quicker art; more pages = rarer, richer art. *(image model)*
- **Reveal as you read** — each picture gently un-blurs ("blooms") as you move through its pages,
  so the image arrives with the moment; **click any image** to reveal it fully, click again to read on. *(no setup)*
- **On-image prompt** — every illustration shows the exact prompt it was made from (stored with the
  image, so it never changes — handy for troubleshooting). *(no setup)*
- **Clean reader** — chapter headings, page dividers, and an image panel sized to your window. *(no setup)*
- **Test image** — type a prompt and render one image with the current model/style to try
  providers/styles/LoRAs without opening a book. *(image model)*
- **Transform a photo** — drop in a picture and restyle/reimagine it through your image model,
  keeping its composition (doesn't force the book's art style onto it). *(image model)*
- **Export an illustrated copy** — save the open book (text + art so far) as a **self-contained
  HTML page** or an **EPUB**, from the toolbar or by asking the chat. *(no setup)*

### 🧠 Keeping the art consistent (the "Visual Bible")

The app builds a structured memory of the book so art stays consistent. *(builds automatically while reading — needs a text model)*

- **Characters** — every named character is tracked with appearance fields (hair, eyes, build,
  height, skin tone, age, marks) plus their outfits; editable in the Character Bible.
- **Locations** — captured by name with descriptions that **grow over the book**, so a place
  described once still looks right when a later chapter only mentions it.
- **Per-chapter storyboard** — what happens, the single key moment to illustrate, and **where** it
  happens — tracked per image, so each picture commits to the one place its moment occurs.
- **World glossary & world style** — recurring world rules ("riders wear flight leathers") and one
  auto-derived genre/art-direction line are applied to every illustration so nothing drifts.
- **Reference photos** — upload up to **three photos per character** (different angles of one face)
  for tighter likeness. *(used by ComfyUI's IP-Adapter when installed, or cloud one-API native mode)*
- **Spoiler-safe** — spoiler imagery stays hidden until you reach it; title/copyright/ToC pages are skipped.

### 🔬 Non-fiction & technical mode (the "Visual Atlas")

Import a book as **technical** and the app illustrates concepts and data instead of story scenes.

- **Tracks structures, systems & data** — recurring apparatus get consistent visuals; key
  definitions, quantities, and findings become a glossary. *(text model)*
- **Real figures first** — fetches an authoritative existing diagram before generating one.
  *(no setup via free Wikimedia Commons; whole-web figures need a Google Custom Search key)*
- **Sourced facts** — grounds the analysis in a web search and cites the sources.
  *(no setup via Wikipedia; whole-web needs a Custom Search key, or the Gemini reader's built-in grounding)*
- **Computed charts & statistics** — when a chapter states real numbers, the app draws a true
  bar/line/scatter chart (exact values, never an AI's guess) with min/max/mean/median + trend, and
  you can **download** it as SVG/PNG. *(no setup)*

### 📊 Spreadsheets & data

Open an Excel/CSV/TSV/JSON file — or **ask the assistant to build one from scratch** — and the app
keeps the real, typed grid (not flattened text).

- **Reads the whole workbook** — every worksheet as a switchable tab; **cell formulas preserved**
  (they round-trip on export, with computed values shown). *(no setup)*
- **Edit live** — click any cell to change it (type `=A2*2` for a formula), rename headers, add/delete
  rows & columns; every edit is type-checked, saved, and re-analysed by the chat immediately. *(no setup to edit)*
- **Build & extend by chat** — *"make me a monthly budget"*, *"set C2 to =A2*B2"*, *"add a Margin
  column = revenue − cost"* using real Excel functions. *(text model)*
- **Formulas compute live** — a built-in evaluator runs math, logic (IF/IFS), **lookups
  (VLOOKUP/INDEX/MATCH)**, **multi-criteria aggregates (SUMIFS/COUNTIFS)**, stats
  (MEDIAN/STDEV/CORREL/SLOPE), text, and **cross-sheet references** right in the grid. *(no setup)*
- **Grounded analysis in chat** — ask for counts, sums, averages, group-bys, pivots, filters; it
  computes over the **real cells** (never guessed) and shows a table + chart. *(text model)*
- **One-click Analysis sheet** — adds a tab of live cross-sheet formulas (count/sum/avg/median/stdev,
  correlation, regression) that recompute as you edit. *(no setup)*
- **Export to real Excel** — save as a true **.xlsx** (or CSV), optionally with **live formula
  totals**, a full **statistical Analysis sheet**, or a **native editable Excel chart**. *(no setup)*

### 🤝 The chat assistant (home screen)

The landing page **is** a full-window chat assistant, in three voices — **Freeform** (general),
**Entertainment** (book-club), **Technical** (research). *(text model)*

- **Talk about anything** — questions, brainstorming, working through ideas; it does **real math**
  with a built-in calculator (never guessed arithmetic).
- **Finds things to read** — your **library**, **Project Gutenberg** (~75k public-domain books;
  *"open Frankenstein"* / *"surprise me"*), **web articles** by search or URL, or text you **paste**.
- **Runs the app by voice** — set the art style + cadence, start illustrating, generate one-off
  images (with approval), manage the library — it knows your current settings and only overrides on request.
- **The conversation follows you** — when it opens a book, the discussion continues in the book chat, context intact.
- **Remembers what you like** — *"I prefer watercolor"*, *"never spoil endings"* → a **long-term
  memory** applied in every future chat (ask it to forget, too).
- **Learns skills from experience** — after a multi-step task it distils a reusable **skill** (a
  saved playbook) so it does that kind of task better next time; review/edit/delete in the 🧠 Skills panel. *(opt-in)*
- **Delegates subtasks** — hands a chunky lookup to a short-lived **read-only sub-agent** that
  researches and returns a concise result, keeping the main answer clean (it can't change anything).
- **Uses your MCP servers** — add **Model Context Protocol** servers in Settings and the assistant
  lists + calls their tools as part of a task. Both kinds: **HTTP** servers (`name https://host/mcp`)
  and **stdio** servers — a local command the desktop runs, like the official filesystem/git servers
  (`name npx -y @modelcontextprotocol/server-filesystem /path`). *(desktop; stdio runs a local program, so only add servers you trust)*
- **Changes settings by request** — *"set image quality to high"*, *"draw as a comic page"*, *"turn
  on mature mode"* — it applies and confirms (double-checking sensitive toggles first).
- **Asks instead of guessing** — if a request is ambiguous it asks one short question or offers a couple of options.
- **Type `/` for commands** — a slash menu runs any tool directly (`/web`, `/books`, `/draw`, `/calc`,
  `/style`, `/remember`, and *(desktop)* `/find`).
- **Makes files** — ask for a worksheet, quiz, CSV, or *"code me a landing page"* and it writes the full content with a **Save** button.
- **Walks you through setup** — *"how do I set up image generation?"*, *"connect my calendar"*,
  *"how do I connect Schwab?"* → it pulls the built-in step-by-step guide and walks you through it one step at a time. *(no setup)*

### 🌐 Web & research

- **Reads a page or repo for you** — point it at a URL (or a GitHub repo — README + file list, or a
  single file) and it pulls the text into the chat. *(full web access needs the desktop app or extension; Wikipedia works anywhere)*
- **In-app browser** — a 🌐 Browse panel reads any web page (text + links, no scripts run), lets you
  click through links, then **📖 Read & illustrate** or **🤖 Ask** about it; **🖥 Live** opens the real
  page (with scripts) in its own isolated window. *(desktop)*
- **Keyless web search** — Wikipedia/Commons out of the box; **full-web DuckDuckGo** through the
  desktop app or extension; a **Google Custom Search key** upgrades to whole-web everywhere. *(no setup; key optional)*

### 🗣 Voice

- **Dictate** — a 🎤 button fills the chat box from your microphone. *(browser)*
- **Read replies aloud** — a 🔈/🔊 toggle speaks the assistant's answers. *(browser)*

### 📋 Task Orchestrator (agentic, multi-step planning)

Connect Google and the assistant becomes a **persistent task planner**. *(needs Google; research-only plans work without it)*

- **Plan anything in plain language** — *"plan my car registration renewal"* (or *"plan this"* after
  it reads an email) → it researches the deadline/lead-time/cost/official site/steps, writes an
  ordered plan, and opens it ready to work.
- **It does the safe prep itself** — research, drafting documents, and creating **Google Tasks /
  Calendar reminders**. Risky/irreversible actions (submit, pay, send) are only **prepped** for you —
  it **never** submits, pays, or sends (Google access is read-and-create only).
- **Auto-pilot, if you want it** — a Settings opt-in lets the safe steps run **without a click each**. *(opt-in)*
- **Finds tasks before you ask** — while the app is open and you're away, it scans recent mail +
  calendar for actionable items (skipping newsletters) and pre-plans them; **"ignore this sender"**
  blocks junk for good. *(opt-in; desktop recommended)*
- **Open a task = a preloaded chat** — clicking a plan opens a chat with the summary, next ready step,
  prepped docs, and links loaded; mark a step done and it advances + checks off the Google Task.
- **📅 Calendar view** — a month calendar synced with **all** your Google calendars plus your planned
  deadlines, in one view. *(needs Google)*

### ⏰ Scheduled & periodic tasks

- **Natural-language scheduling** — *"every morning summarise my unread email"*, *"every Friday give
  me a market recap"* → a recurring task (daily/weekly/monthly/once). *(text model; the task itself may need Google/etc.)*
- **It just runs** — a built-in runner fires each due task into the chat at its time *(while the app is open — no always-on server)*.
- **Manage them** — the ⏰ Scheduled panel lists each task's cadence + next run; pause/resume or delete. *(no setup)*

### 📈 Markets & trading

A **📈 Markets** panel for following and researching stocks. *Not financial advice.*

- **TradingView chart** — type any ticker for TradingView's free interactive chart, embedded. *(no setup)*
- **Live quote** — a keyless last/open/high/low/volume snapshot. *(desktop or extension for the quote feed; chart works anywhere)*
- **Keyless technical analysis** — VWAP, moving averages, RSI, recent-move computed from real bars
  for watch levels + trend/momentum. *(no setup)*
- **Price alerts / watch levels** — *"alert me when AAPL crosses VWAP"*, *"ping me if NVDA moves ±3%"*
  → a notification while the app is open. *(no setup)*
- **Generate Pine Script & thinkScript** — ready-to-paste alerts/studies for TradingView or
  thinkorswim, from verified templates, with where to paste. *(no setup)*
- **Connect Schwab / thinkorswim** — real quotes, **option chains with Greeks + implied volatility**,
  positions, and your **watchlists**. *(Schwab key; desktop)*
- **Trade ideas from your watchlists** — *"pull 3 trades from my tracked ideas with the best
  risk-reward"* → it ranks picks with entry/target/stop + R:R. *(Schwab key)*
- **Theme / sector screens** — *"the 3 best photonics stocks on earnings growth + P/E"* via web
  research + grounded P/E/EPS/yield. *(no setup keyless; richer with a Schwab key)*
- **Review-and-place orders** — it **composes** the exact order and opens a review dialog; **you**
  tick a box and click *Place order* — it never submits on its own. *(Schwab key; desktop)*
- **Control your TradingView Desktop chart** — set the symbol/interval, add studies, inject Pine —
  *"put VWAP on my chart"*. **Chart-only — never trades.** See [MARKETS-BRIDGE.md](./MARKETS-BRIDGE.md). *(desktop · opt-in; TradingView Desktop with remote debugging)*

### 📱 Remote & mobile control

Drive the desktop assistant from your phone — no cloud.

- **From anywhere (Google Tasks)** — add a Google Task titled `VR: …` (e.g. *"VR: summarise my unread
  email"*); the desktop runs it and writes the answer back into the task. *(needs Google · opt-in · desktop must be open)*
- **Live link over Wi-Fi** — **🔗 Link phone** shows a URL; open it on a phone on the same Wi-Fi and it
  becomes a thin client of the desktop's engine (no keys/models on the phone). See [REMOTE-LINK.md](./REMOTE-LINK.md). *(desktop · same Wi-Fi · experimental)*

### 🛠 Hands-on desktop tools

The assistant can reach your machine to actually *do* things — every step is shown and waits for your click. *(desktop)*

- **Find a file on your computer** — *"open the PDF in my downloads"* → clickable matches. *(approve filesystem access once per session)*
- **Run a command and react to it** — install deps, run a build/tests, or run a script it wrote in a
  `VisualReader` workspace; output comes back so it can **test code, see failures, fix, and retry**. *(opt-in)*
- **Look at your screen** — screenshot the screen or one window and **assess it with a vision model**
  to check what it built works. *(opt-in · vision model)*
- **Work with your GitHub repos** — clone, branch, commit, push, open PRs, manage issues. *(opt-in · a GitHub token or your own `gh` login · runs through the command tool)*
- **OCR a scan** — drop a photo/scan of text and **🔤 Extract text** reads it and opens the
  transcription as a document. *(vision model)*

### 💬 Book chat (reading companion)

Open **Chat** while reading to discuss the book with an AI that actually knows it. *(text model)*

- **Spoiler-safe by default** (fiction) — only sees the book up to your position; an *allow spoilers*
  toggle unlocks the whole book. Technical books are fully visible.
- **Fast on simple requests, deep when asked** — keeps the text near your position in view and
  **looks passages up on demand** when a question needs another chapter.
- **Knows the app's analysis** — the glossary, structures/locations, chapter summaries, the actual
  image prompts, and any extracted datasets.
- **Can use the app's tools** — search the book/web, **read a web page**, find figures, **generate
  images** (with approval), **export**, and keep long-term memory; `/` opens its command menu.
- **Ask for render settings in plain chat** — *"draw a truck, 20 steps, flux 2"* picks the named
  *installed* model/steps/style for that render (and tells you what's installed if a name doesn't match). *(image model)*
- **Its own model choice** — defaults to a local model (free & private), independent of the book reader. *(local or a key)*
- **Context you can see** — a token-usage donut shows where the model's window is going, sized to a
  local model's **actual** limit; **delete** any message or **Compact** the chat into a summary. *(no setup)*

### ✏️ Control & correction

- **Begin / Pause / Resume** generation, and **← Exit book** anytime (the book stays in your Library). *(no setup)*
- **Character Bible editor** — fix any character's appearance; saved instantly. *(no setup)*
- **Re-generate** the **storyboard** (re-run analysis), **all images**, or **just this image**. *(image model / text model)*
- **Pre-render the whole book** in one go. *(image model)*
- **Pick frequency & quality** — pages-per-image and Auto/Draft/Standard/High/Ultra (Auto scales with
  page-group size); advanced users can override sampler steps + CFG on a local engine. *(image model)*
- **Progress you can see** — live "Building the Visual Bible… 3/12 chapters · pages 40/210" with token/percent feedback. *(no setup)*

### 🔌 Models, providers & privacy

- **Text (story understanding):** Claude, Gemini, or OpenAI with your key — **or local** (on-device
  WebGPU, or Ollama/LM Studio/llama.cpp). **Ollama models download from Settings** with a progress bar. *(a key or local model)*
- **Images:** a Flux-style API, Gemini, or OpenAI — **or local** on your GPU via ComfyUI/AUTOMATIC1111
  (SD 1.5 / SDXL / Flux.1, plus **Z-Image Turbo**, **Flux.2 Klein**, **Qwen-Image** on ComfyUI). The
  **desktop app can auto-manage** ComfyUI and fetch every file a model needs. *(a key or a GPU)*
- **Vision (seeing images):** Claude/Gemini/OpenAI all see images; **locally** a vision model does too
  (Ollama llama3.2-vision/llava/qwen2-vl, or LM Studio). *(a vision-capable model)*
- **One-API native mode** — when one vendor (Gemini/OpenAI) runs text **and** images, opt into its
  multimodal model so your character reference photos guide cloud renders. *(one Gemini or OpenAI key · opt-in)*
- **No keys? Still works** — built-in placeholder art shows the whole flow. *(no setup)*
- **Privacy** — keys are **encrypted on your device**; local/on-device options keep everything private.
- **Mature mode (adults only)** — relaxes the adjustable safety filters (Gemini text+image, Flux) for
  intentionally adult fiction. Claude/OpenAI keep their own policies; local models have no filter. *(opt-in)*

### 💻 Where it runs

- **Web app** — the main reader. *(no install)*
- **Desktop app** (Tauri) — the same reader, **plus** a managed local GPU image engine, **CORS-free web
  access** for the chat, and the **hands-on tools** (files, commands, screenshots, GitHub, browser, phone link). *(install)*
- **Chrome extension** — illustrates articles you read on the web (same engine; its background worker gives CORS-free access). *(load unpacked)*

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
- **Cloud relay for the phone link** — today the phone link is LAN-only; an opt-in relay
  would let it work away from home (needs a server + end-to-end encryption).

**Done recently**
- **Assistant roadmap (Phases 1–5)** — clearer **failure feedback** (the buddy explains a failed tool
  and suggests a next step), **self-improving skills** (opt-in; it distils reusable playbooks),
  an **in-app browser** (readable text + a live isolated webview), **phone/remote control** (a `VR:`
  Google-Task bus + a LAN thin-client link), **MCP client** (call your own MCP servers),
  **sub-agent delegation**, **voice** (dictate + read aloud), and **OCR** (extract text from a scan).
- **Markets & trading** — keyless analytics + alerts, Pine/thinkScript generation, a **Schwab/
  thinkorswim** connection (quotes, option chains + Greeks, positions, watchlists), watchlist trade
  ideas + theme screens, **review-and-place orders** (you always confirm), and an experimental
  **TradingView Desktop** chart bridge.
- **Spreadsheets end to end** — Excel/CSV import reads every worksheet (computed formula values), the
  grid is **editable** (edits persist + re-analyse live), and you can **export a real .xlsx** (with
  optional live-formula totals/analysis sheet/native chart) or CSV. Charts download as SVG/PNG.
- **Task Orchestrator** — connect Google and it plans real-world tasks end to end (research → ordered
  plan → auto-created Google Tasks/Calendar reminders + prepped docs, never submitting/paying/sending),
  with an opt-in auto-pilot, an idle inbox/calendar scan (persistent "ignore this sender"),
  open-a-task-as-a-preloaded-chat, and a built-in **Calendar** view.
- **Hands-on desktop tools** — with per-step approval: find files, run commands to build/test code and
  fix it iteratively, take screenshots a **cloud or local vision model** assesses, and GitHub repo work.
- **Illustrated export** — save the open book as a self-contained **HTML page** or an **EPUB**.
- **More ways in** — open Word, Excel, CSV/TSV, RTF, and JSON; drop an image to **transform a photo**.
- **Slash commands, memory & read-a-page** — `/` command menus, a **long-term memory** across books,
  `read_url` for web pages/GitHub repos, and **clarify-when-ambiguous** prompting.
- **The chat buddy home screen** — a full-window assistant (Freeform / Entertainment / Technical) that
  finds books, opens + illustrates them by voice, generates images with approval, does real math, and
  hands the conversation into the book chat when a book opens.
- **Chat that knows the book lazily** — a recent window plus an on-demand book-search tool.
- **Context window transparency** — provider-aware budgets (local models sized to their actual
  window), a usage donut, message delete, and a one-click **Compact**.
- **Keyless web search everywhere it's possible** — Wikipedia/Commons out of the box, DuckDuckGo
  full-web through the extension and desktop shells, and a Project Gutenberg catalog.
- **Mature mode (adults only)** — opt-in unfiltered illustration + discussion of adult fiction.
- **One-API "native" mode** — render through a vendor's multimodal model so character reference photos
  guide cloud renders (with an experimental one-shot sub-mode).
- **Multi-view character references** — up to three photos per character condition each image together.
- **Exact mid-chapter location changes per image** — each illustration records the one place its moment happens.
- **One-click local model downloads** — curated image models (Z-Image Turbo, Flux.2 Klein, Qwen-Image)
  and Ollama text models download from Settings with a progress bar (split files included, resumable).
- **Read-ahead prompts** — scene prompts written with each chapter's analysis and stored; images render
  from stored prompts (no AI call at render time).
- **Name → appearance expansion**, **world style**, user-uploaded character references (IP-Adapter),
  and **family-correct rendering** (per-family sampler settings + split-file loader graphs).
- Whole-book storyboard; structured editable character/world data; accumulating locations; skip
  non-story pages; pick any pages-per-image; auto quality scaling; click-to-reveal; spoiler-safe bloom;
  pause/resume + three regenerate scopes; on-device (WebGPU) and local-server text; local Stable Diffusion images.

---

*Tip: the app works with **no API keys** — just open it and click **Load sample** to see
the whole flow with placeholder art, then add keys (or point it at local models) in
**Settings** for real illustrations.*
