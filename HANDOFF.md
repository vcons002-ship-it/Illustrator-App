# Session hand-off — `claude/chat-context-pull-2l6pkv`

Paste-in pointer for a fresh session:
> Continue the work on branch `claude/chat-context-pull-2l6pkv`. The repo's
> DEFAULT branch is `claude/visual-content-generator-BLJks` — develop on the
> work branch, then PR + merge into the default branch (the user's installers
> and `git pull` track it; `main` was deleted). Read `HANDOFF.md` first.

## Latest session: the conversational layer (chat buddy) + follow-ups

The landing page is now a full-window **chat buddy** that drives the whole app;
plus context-window management, mature mode, and a batch of user-reported fixes.
All merged to the default branch via PRs #6–#14. Key pieces:

- **Buddy** (`packages/core/src/chat/buddy-tools.ts` / `buddy-session.ts`) — a
  second provider-agnostic JSON tool protocol (separate union from the in-book
  chat's, deliberately): search_books (Gutendex) / random_books / search_web /
  search_images / calculate / open_library_book / open_web_text /
  open_pasted_text / remove_library_book / set_visual_style / generate_image
  (approval-gated, shared shape with the book chat so the worker render path
  serves both). Three personas, freeform = default; opens hand the conversation
  off into the book chat (`buddyHandoff` ref in App.tsx, consumed by the
  chat-history load effect). Worker: `handleBuddyChat` + `buddyOpened`/
  `buddySettings`/`buddyLibraryChanged` messages.
- **Keyless search stack** — `KeylessSearch` (`providers/image/ddg-search.ts`):
  DuckDuckGo Lite HTML parse through CORS-exempt transports only (extension
  proxy / desktop `http_fetch`), session-sticky fallback to `WikiSearch`;
  `GutenbergSearch` (`providers/book-search.ts`, subjects + deterministic
  `random()`); `fetchPageText` (`providers/page-text.ts`, Wikipedia extracts API
  special case + regex HTML→text).
- **Desktop CORS proxy** — Rust `http_fetch` command (`apps/desktop`), worker↔
  main `corsFetch` relay (workers can't reach `window.__TAURI__`), selective
  routing: ONLY keyless search + page fetch ride it (provider APIs keep native
  fetch/streaming). `Cargo.toml` ceiling-pins `time <0.3.48` (tauri-utils E0119
  on new rustc; Cargo.lock is gitignored so the pin must live in the manifest).
- **Context management** — provider-aware budgets in `engine.worker.ts`
  (`contextBudgets`): cloud fixed; local sized to the model's real window via
  Ollama `/api/show` (`LocalServerLLMProvider.contextLength`), CAPPED at
  `SAFE_LOCAL_CONTEXT_TOKENS = 8192` because /api/show reports the architectural
  max, not what Ollama loads (uncapped budgeting 500'd llama 3.2). The book
  section is a small recent window; a `search_book` tool (spoiler-gated keyword
  scan, `chat/book-passage-search.ts`) reaches the rest on demand. `Compact`
  (worker `summarize`) + per-message delete in both panels. Usage donut:
  `chat/context-usage.ts` + `charts/pie-geometry.ts` + `ContextUsageDonut`.
- **Mature mode** (`ReaderSettings.allowMature`, adults-only toggle, off by
  default) — Gemini `safetySettings: BLOCK_NONE` (LLM + native image), Flux
  `safety_tolerance: 6`, faithful-depiction notes threaded through extraction /
  prompt-writing (`MATURE_CONTENT_NOTE`) and chat/buddy prompts
  (`MATURE_CHAT_NOTE`). Claude/OpenAI have no knob (documented in the UI).
- **Misc fixes** — environment aliases ("the fortress" → Basgiliath) through
  extraction schema/merge/`findBibleTermsInText`; token-fallback model
  resolution + loud errors listing installed models; local-server error bodies
  surfaced (500/404 hints); scroll-settle correction in `useScrollDepth` + hold
  last page in App; Settings panel floats as an overlay; `← Exit book` (worker
  `close` message); calculator (`chat/calculator.ts`, no eval).

Pending / known limitations: WebLLM + LM Studio report no context length (only
Ollama does); DDG search inert in the plain web app (CORS, by design); desktop
`http_fetch` + managed-engine runtime still need on-device verification; mature
mode unverified against live provider APIs.

### Audit follow-ups DEFERRED (design calls, not yet done)
A two-agent audit of the session diff fixed the high/medium issues (see the
"Audit fixes" commit). Deliberately left for a decision:
- **`fullBookText` over-budget windowing** (`chat-context.ts`) — a single chapter
  larger than the budget (web articles/papers via `open_web_text`; technical mode
  is always full-view) is force-included un-sliced, blowing the context budget.
  `readSoFarText` tail-slices correctly; `fullBookText` should window the current
  chapter around the reader too.
- **DDG link↔snippet pairing** (`ddg-search.ts`) — paired by index across two
  regex passes; a result with a link but no snippet cell shifts all following
  snippets. Needs a single sequential scan + a markup fixture test.
- **`open_web_text` SSRF** (`buddy-tools.ts`) — accepts `http://localhost`/RFC-1918
  hosts; harmless in the CORS-bound web app, but the desktop/extension transports
  are CORS-exempt. Cheap to block loopback/private hosts.
- **Buddy-turn settings ownership** (`engine.worker.ts` / `App.tsx`) — a same-turn
  `set_visual_style`→`open` still races a stale `init` from the main thread; it
  self-heals via the follow-up `tune`, but the clean fix is the worker opening the
  book itself.
- **Delete-by-stable-key** (`App.tsx`/`ChatPanel`) — message delete is by index,
  which races the async history prepend; switch to an `at`-keyed delete.
- **Buddy→book handoff dedupe** — re-opening a book that was buddy-opened before
  duplicates the handed-off bubbles (persisted last time + handed off again).
- Minor: `lastActivePage` resets one render late; `useScrollDepth` settle assumes
  Map order == document order; Rust `http_fetch` collapses duplicate response
  headers (harmless today).

## Previous session: performance pass (no behavior changes)

A full-codebase performance audit, then the high-leverage batch implemented:

- **core/engine** — per-book lookup tables built once on `openBook` (`indexBook()`:
  chapter index + story flag per page, units/ranges per chapter); storyboard scene
  lookup + `isLlmPhaseComplete` memoized per bible object; prompt progress counted
  incrementally; `chapterText()` memoized per book (WeakMap); cached images loaded
  in parallel chunks of 24.
- **core/render-buffer** — skip pass runs once (re-armed on invalidate); the
  candidate scan stops once `maxConcurrent − inflight` pages are found.
- **core/pipeline** — `cachedResult` no longer builds a full `VisualRequest` per
  page on open; chapter context memoized per chapter.
- **core/image-search** — 10s `AbortSignal.timeout` on third-party figure
  downloads (a blackholing host can no longer hang a render).
- **ui** — `useScrollDepth` quantizes progress (1/64) and returns stable per-id
  ref callbacks; `PanelGrid`'s `Panel` memoized; `decoding="async"` on image tags.
- **apps/web** — book column extracted into memoized `ReaderColumn` (whole-book
  paragraphs no longer reconcile per scroll frame); worker drops per-step render
  progress that doesn't change the whole percent and per-token bible status posts
  (1s ticker owns the line); identity settings changes debounced 400ms.
- **apps/extension** — same identity/tuning split as the web app (shared
  `packages/ui/src/settingsKeys.ts`): tuning edits call `updateTier` instead of
  rebuilding the engine; rebuilds + settings persistence debounced.

A second pass implemented the rest of the audit:

- **Providers** — Flux honours `input.signal` (abort-aware poll/delay/download);
  Gemini grounded fallback retries only on 400; Claude system prompts carry
  `cache_control: ephemeral` (extraction + prompt pass); Gemini native image
  memoises reference base64; the pipeline caches reference bytes per ref id
  (identity-stable buffers, cleared on reference change); ComfyUI caches
  `/object_info` per session and uploads each reference photo once per buffer
  (was per render, with unbounded input-folder growth); grounding citation
  glossary entries no longer ride along in image-prompt requests.
- **Core** — bible persisted every 5 prompts/3s + on pause/finish during the
  prompt pass; the chat's spoiler-safe context renders chapters backwards until
  the budget fills (identical output).
- **UI** — MessageBubble/CharacterCard/DataChart/DataSection memoised (with
  App-side stable props for ChatPanel); search haystacks + dirty checks off the
  render path; BloomTransition writes the eased value straight to the DOM in one
  persistent rAF loop (zero React renders per frame); key fields commit on a
  300ms debounce/blur.
- **Apps** — image bytes are re-homed into Blobs on receipt (`DisplayResult` in
  `packages/ui/src/imageObjectUrl.ts`): the worker transfers the only copy, and
  Blob data is browser-managed, so a long book no longer pins hundreds of MB of
  ArrayBuffers in the main-thread heap (worker-side copies were already detached
  by the transfer). EPUB parses in a dedicated worker (`apps/web/src/epub.worker.ts`).
  The extension cache is LRU-capped at 20 pages (book ledger = recency index)
  and keys strip tracking params + plain anchors; the overlay quantizes scroll
  progress and memoises spoiler resolution. Epub TOC anchors resolve in one pass.

Deliberately NOT done (judgement calls): skipping `putBook` on library re-opens
(the write IS the recency refresh — skipping breaks "most recent first");
grounding-search lookahead (timing-sensitive, low value); ComfyUI WebSocket reuse
(low, localhost); reader-column virtualization (memoization removed the per-frame
cost; revisit only if very large books still lag).

**PR:** #1 (`vcons002-ship-it/illustrator-app`), base `main`, head
`claude/visual-content-generator-BLJks`. Everything below is committed + pushed (13 commits
ahead of `main`). All green: `pnpm test` (338), `pnpm -r run typecheck`, `pnpm run lint`,
web build, `cargo check`.

---

## Monorepo map (pnpm workspaces)
- `packages/core` — engine, pipeline, providers (LLM + image), Visual Bible, storage, types. **All unit-tested** (`vitest`, `packages/**/*.test.ts`).
- `packages/epub` — EPUB parsing **and** `bookFromText` (txt/md/paste → BookSource).
- `packages/ui` — React components + `buildProviders` (settings → providers/tier; shared by web + extension).
- `apps/web` — the reader app (Vite). Engine runs in a Web Worker (`engine.worker.ts`).
- `apps/desktop/src-tauri` — Rust shell (managed ComfyUI engine, model/LoRA downloads, `gpu_info`, `lora_headers`).
- `apps/extension` — Chrome extension reader.

Verify locally: `pnpm -r run typecheck && pnpm run lint && pnpm test && pnpm --filter @visual-reader/web run build` (+ `cd apps/desktop/src-tauri && cargo check`).

---

## What was built this session (newest first)

1. **Provider-agnostic grounding** (`8ff076b`) — a local/Claude/OpenAI reader can produce
   *sourced facts*, not just Gemini. `GoogleImageSearch.searchWeb()` + `groundingQuery()` +
   `formatGroundingContext()` (`packages/core/src/providers/image/image-search.ts`); the
   engine runs a per-chapter grounding pre-pass for technical books and cites sources in
   the glossary (`packages/core/src/engine.ts`, the extraction loop ~line 356).
2. **Hybrid scientific sources** (`a016a28`) — real-figure retrieval (Custom Search image
   mode) → AI generation fallback, in `pipeline.ts` (technical kind only). Gemini in-call
   grounding in `gemini-provider.ts` (`tools:[{google_search:{}}]`). `ImageResult.sourceUrl`
   added for hotlink-only figures; `ImagePanel` renders bytes **or** `sourceUrl`.
3. **Pasted books + real technical extraction** (`63f63e3`) — `TECHNICAL_EXTRACTION_SYSTEM`
   ("Visual Atlas": structures→environments, data→glossary, visualization-plan→keyEvents);
   `extractionSystemFor()`/`promptSystemFor()` pick prompts by `contentMode`. Library
   round-trip pinned.
4. **Universal import + playground** (`d537290`) — Open book… accepts EPUB/TXT/MD/HTML/PDF
   (`apps/web/src/import-file.ts`, pdf.js lazy chunk); "Paste text" + "Test image" modals
   in `App.tsx`; `worker testRender` message.
5. **Non-interrupting tuning** (`dda9237`) — style/quality/etc. changes route through a
   `tune` worker message → `Engine.updateTier()` (swaps the live tier in place, no
   dispose/abort). `useEngineWorker.ts` splits settings into identity vs tuning keys.
6. **Gemini sanity + Imagen scrub** (`2b7fccc`) — clean captions via `displayCaption()`;
   explicit art style beats world style; native Gemini aspect ratio; deleted the unwired
   Imagen `:predict` provider. Gemini always = `generateContent` (Nano Banana Pro > Flash).
7. **LoRA work** (`799c337`, `83cf7e6`, `8ce7eab`) — architecture detection from safetensors
   header (`lora-detect.ts` + Rust `lora_headers`), family-tagged downloads, manual override
   dropdown, **and the key fix**: LoRAs now apply on the diffusion path
   (`LoraLoaderModelOnly`) so they work on Flux.2 / Z-Image, not just SDXL.
8. **Quality overhaul** (`f6fb21c`, `a70a84d`, `37da552`, `78cdead`) — per-level step ladder
   + turbo guard, aspect ratio, VRAM-aware Auto + OOM fallback, sampler/scheduler dropdowns,
   seed re-roll on redo, multi-panel comic grid (`PanelGrid`), 18 art styles w/ descriptions.

---

## ⚠️ Unverified — the reason this hand-off exists

The previous environment had **no network egress** (even `google.com` was blocked), so the
Google API calls were written to the documented shapes but **never run live**. The fallback
paths (ungrounded retry, generate-instead) exist so a field-name drift degrades instead of
breaking. **First job in the networked environment: validate these for real.**

### Live-validation checklist
- **Custom Search image mode** — `GoogleImageSearch.search()` / `.retrieve()`: returns hits;
  bytes download (or thumbnail, or `sourceUrl` fallback). Request: `customsearch/v1?...&searchType=image`.
- **Custom Search web mode** — `.searchWeb()`: snippets + links; URL has **no** `searchType=image`.
- **Gemini in-call grounding** — `groundFacts` on + Gemini reader: body carries
  `tools:[{google_search:{}}]`; response has `groundingMetadata.groundingChunks[].web.uri`;
  sources fold into glossary. Confirm the **exact field names** (these drift by API version).
- **External grounding** — local/Claude/OpenAI reader + `groundFacts`: engine searches the
  chapter topic, injects `groundingContext`, cites sources. (`buildProviders` only sets
  `webSearch` when reader id !== "gemini".)
- **Gemini native image** — `generationConfig.imageConfig.aspectRatio` accepted (1:1/2:3/3:2).

### Quick harness
**Built** (`packages/core/src/providers/live-validation.test.ts`): env-gated vitest suite
exercising the real providers live. Run with
`GOOGLE_SEARCH_API_KEY=… GOOGLE_SEARCH_ENGINE_ID=… GEMINI_API_KEY=… pnpm test live-validation`
(skips, keeping CI green, when keys are absent). Don't commit keys. If a shape is wrong,
fix the provider — the graceful fallbacks mean a wrong shape currently fails *silently*,
so the suite tests the happy paths explicitly.

**Docs cross-check done (2026-06-11), live run still pending keys:** Custom Search params
(`searchType=image`, `num`, `safe`) + `items[].image.{contextLink,thumbnailLink,width,height}`
and Gemini `tools:[{google_search:{}}]` + `groundingMetadata.groundingChunks[].web.uri`
all match the code. One open question: the image-generation docs may now spell the aspect
field `generationConfig.responseFormat.image.aspectRatio` instead of our
`generationConfig.imageConfig.aspectRatio` — unconfirmed; the live render test will 400 if
ours is rejected. JSON-mode + search-tool compatibility is undocumented; the strict
grounded-extraction test answers it empirically.

**Catalog download URLs live-validated (2026-06-11)** — run any time with
`VALIDATE_DOWNLOAD_URLS=1 pnpm test live-validation` (no keys needed). Fixed that day:
- **Flux.2 Klein 9B**: `Comfy-Org/flux2-klein-9B` was renamed/stripped to
  `vae-text-encorder-for-flux-klein-9b` (encoder+VAE only) — the diffusion fp8 now only
  exists on gated `black-forest-labs/FLUX.2-klein-base-9b-fp8` (anonymous 401). Catalog now
  downloads encoder+VAE first (VAE moved to ungated `black-forest-labs/FLUX.2-small-decoder`)
  and fails last on the gated file with the downloader's browser-download hint. The ungated
  mirrors on HF are zero-download personal repos — rejected as an auto-download source.
- **comic LoRA**: ComicBookRedmond repos went private → URL dropped (style is prompt-only now).
- **storybook LoRA**: repointed to StoryBookRedmond-V2 (V1 filename changed); trigger fixed
  to the real training tag `KidsRedmAF, Kids Book`.
- **flux-schnell**: size corrected 12 → 17.2 GB (actual file).

---

## Credentials + environment setup the user is doing
- **Gemini key** — AI Studio (`aistudio.google.com/app/apikey`). Used for Gemini text/image
  **and** in-call grounding (grounding is a tool on the same key). Stored `keys.gemini`.
- **Custom Search** — TWO pieces, both needed for figure retrieval + external grounding:
  - **Engine id (`cx`)** from `programmablesearchengine.google.com` (enable Image search +
    Search-entire-web). Stored `settings.searchEngineId`.
  - **API key** from Google Cloud console → enable "Custom Search API" → Credentials → API
    key. Stored `keys.search` (encrypted like other keys).
  - Settings → **"Scientific sources"** section holds both fields + the grounding toggle.
- **Network allowlist** the env needs: `www.googleapis.com` (Custom Search + grounding),
  `generativelanguage.googleapis.com` (Gemini), `huggingface.co` (optional, LoRA URL checks).

---

## Key files
- Search/grounding: `packages/core/src/providers/image/image-search.ts` (+ `.test.ts`)
- Pipeline (retrieval-first technical render): `packages/core/src/pipeline/pipeline.ts`
- Engine (grounding pre-pass, `updateTier`, `imageSearch`/`webSearch` deps): `packages/core/src/engine.ts`
- Gemini LLM (in-call grounding): `packages/core/src/providers/llm/gemini-provider.ts`
- Extraction prompts (fiction vs Visual-Atlas): `packages/core/src/providers/llm/extraction.ts`
- Provider wiring + grounding routing: `packages/ui/src/buildProviders.ts`
- Settings UI (Scientific sources, LoRA override, etc.): `packages/ui/src/SettingsPanel.tsx`
- Web app (modals, import, caption): `apps/web/src/App.tsx`, `apps/web/src/import-file.ts`
- Worker protocol/handlers: `apps/web/src/worker-protocol.ts`, `apps/web/src/engine.worker.ts`

## Conventions
- `pnpm` (not npm). `exactOptionalPropertyTypes` is on — gate optional fields with
  `...(x ? { x } : {})`, don't pass `undefined`.
- Comments explain **why**, matching the existing dense style. New logic ships with tests.
- Commit/push only to `claude/visual-content-generator-BLJks`. Don't open a new PR (PR #1
  exists). Don't commit secrets.

## Session 3 additions (all committed + pushed, newest first)
1. **Reading-companion chat** (`e758fb5`) — ChatCapable seam on all six LLM providers
   (`packages/core/src/providers/llm/chat.ts`), provider-agnostic JSON tool protocol +
   context builder + tool loop (`packages/core/src/chat/`), worker `chat`/`chatTool`/
   `chatCancel` messages, `ChatPanel` (packages/ui), per-book history (IndexedDB v3
   `chats` store). Chat-only provider overrides in Settings (`chatTextProvider` /
   `chatLocalModel` / `chatImageProvider`, default local, per-slot fallback to the book's
   providers). In-chat render overrides resolve via `resolveModelRequest`/`resolveStyleRequest`
   (catalog.ts). generate_image needs explicit approval (injection guard).
2. **Computed charts** (`b751aee`) — bible **v8** (`datasets`), all four extraction-schema
   mirrors + parity test (fixed latent bug: Claude/local never returned `worldStyle`),
   pure stats/SVG geometry (`packages/core/src/charts/`), `DataChart`/`DataSection` (ui),
   aside wiring in App.tsx.
3. **Keyless search** (`de6e140`) — `WikiSearch` (Wikipedia grounding + Commons figures,
   CORS-open `origin=*`, `Api-User-Agent` header) behind the shared `FigureSearch`
   interface; buildProviders chains Google→Wikipedia so search/grounding always exist;
   live-validated (`VALIDATE_FREE_SEARCH=1 pnpm test live-validation`).
4. **Gemini-key fallback for Custom Search** (`e65b667`) — blank search key reuses the
   Gemini key (same GCP key works when Custom Search API is enabled on its project).

Still pending: the keyed live validation (Custom Search + Gemini grounding/native image)
— waiting on the user's GEMINI_API_KEY / GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_ENGINE_ID.

## Possible next steps (not yet built)
- Two-pass technical extraction (extract terms → grounded re-pass) for deeper accuracy.
- Surface retrieved-figure attribution/“open source” link in the reader caption UI.
- Concept-level entity panel for technical books (analogue of the Character Bible).
