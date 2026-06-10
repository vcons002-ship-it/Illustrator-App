# Visual Reader — Features, How It Works & Roadmap

A plain-language guide to what the app does and where it's going. For install/setup,
see **[SETUP.md](./SETUP.md)**; for the technical architecture, see **[README.md](./README.md)**.

---

## What it is

**Visual Reader illustrates a book as you read it.** You open an EPUB, and the app
quietly reads the story, learns the characters and places, and paints a picture for
each stretch of pages — keeping everyone looking consistent and never spoiling what's
ahead. It runs on your own machine and can work fully offline.

---

## Feature list

### 📖 Reading & illustrations
- **Open any EPUB** (or click *Load sample* to try it instantly).
- **Clean reader** with chapter headings and page dividers.
- **One illustration per page-group** — you choose how many pages share an image
  (any number), or one image per chapter. Fewer pages = more frequent, quicker art;
  more pages = rarer, richer art.
- **Reveal as you read** — each picture gently un-blurs ("blooms") as you move through
  its pages, so the image arrives with the moment.
- **Click to reveal** — click any illustration to show it in full immediately; click
  again to hand control back to your reading. (Resets when you turn the page.)
- **On-image caption** — a short line names the characters shown and the chapter's key
  action, fading in with the picture.
- **Bigger image panel** sized to your window.

### 🧠 Understanding the story (the "Visual Bible")
The app builds a structured memory of the book so art stays consistent:
- **Characters** with easy-to-read appearance fields (hair, eyes, gender, physique,
  height, skin tone, age, distinguishing marks) plus their outfits/fashion. **Every**
  named character with a description is tracked.
- **Locations** captured by name with detailed descriptions that **grow over the book** —
  so a place described once still looks right when a later chapter only mentions it.
- **Per-chapter storyboard** — what happens, the single key moment to illustrate, and
  **where** it happens (so an image never blends two different places).
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

### ✏️ Control & correction
- **Begin generating** button — start illustrating when you're ready; reuses anything
  made in past sessions.
- **Character Bible editor** — open *Characters*, see every character's appearance, and
  fix any mistake. Saved instantly (existing images stay until you re-render).
- **Pause / Resume** generation anytime.
- **Re-generate** in three scopes: the **storyboard** (re-run the analysis, e.g. after
  switching models), **all images**, or just **this image** (re-roll the one you're on).
- **Pre-render the whole book** in one go.
- **Pick frequency & quality** — pages-per-image, and Auto/Draft/Standard/High/Ultra
  (Auto scales quality up as pages-per-image grows).
- **Progress you can see** — "Building the Visual Bible… 3/12 chapters · 24% · pages
  40/210", plus live token/percent feedback.

### 🔌 Providers & privacy (bring your own, or run local)
- **Text (story understanding):** Claude, Gemini, or OpenAI with your key — **or local**:
  on-device (WebGPU, no key, nothing leaves your machine) or your own local LLM server
  (Ollama / LM Studio / llama.cpp). **Ollama models download from the Settings menu**
  with a live progress bar — no terminal.
- **Images:** a Flux-style API, Gemini, or OpenAI with your key — **or local** on your
  own GPU via ComfyUI or AUTOMATIC1111 (SD 1.5 / SDXL / Flux.1, plus **Z-Image Turbo**,
  **Flux.2 Klein** and **Qwen-Image** on ComfyUI). The **desktop app can auto-manage**
  ComfyUI and downloads every file a model needs (split files included, resumable).
- **No keys? Still works** — built-in placeholder art shows the whole flow.
- **Keys are encrypted** on your device; local/on-device options keep everything private.

### 💻 Where it runs
- **Web app** — the main reader.
- **Desktop app** (Tauri) — same reader, plus it can set up and launch a local GPU image
  engine for you.
- **Chrome extension** — illustrates articles you read on the web (shares the same engine).

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
                        • storyboard (what happens · key moment · where)
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
- **One picture, one place** — each image commits to the single location its pages
  describe, so actions from different settings never get mashed into one frame.
- **Consistency** — characters get a stable identity seed, and their names in every
  prompt are expanded into their Bible appearance at render time (image models can't
  picture a name) — so they don't drift from page to page. You can also upload a
  **reference image** per character in the Character Bible for even tighter likeness
  (used by ComfyUI's IP-Adapter when installed).
- **It stays out of your way** — in the web app the whole engine runs in a background
  worker, so reading never stutters while art is generated.

---

## Roadmap

**Next up / under consideration**
- **Web search to help understand a book** — *deferred on purpose.* The on-device model
  can't browse on its own; adding web knowledge means the app fetches results and feeds
  them in. The risk is **spoilers**, so the planned shape is an **opt-in, cloud-only**
  lookup limited to what you've already read. (Today the app stays fully offline-capable
  and spoiler-safe.)
- **Exact mid-chapter location changes per image** — finer "beat"-level location tracking
  so very long page-groups that move between places split cleanly.
- **Per-character LoRA styles** — pin a character with a dedicated LoRA for even tighter
  consistency (reference-image upload is in; the LoRA slot already exists).
- **One-API "native" mode** — when the same cloud provider serves text **and** images
  (e.g. Gemini for both), let that one API read a chapter and emit illustrations
  directly (the app already detects and flags this configuration).
- **Bring the newest reader UI to the Chrome extension** — bigger image, caption, and the
  Character Bible editor are in the web/desktop reader first.

**Designed-for, deliberately later**
- **Info-graphics** — diagrams, flowcharts, and summaries for non-fiction (the pipeline
  already has a slot for new output types).
- **Full on-device image generation** (WebGPU) — image models running entirely in-browser.
- **Hosted option** — an optional managed backend so you don't need your own keys/GPU.

**Done recently**
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
