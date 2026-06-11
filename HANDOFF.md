# Session hand-off — `claude/visual-content-generator-BLJks`

Paste-in pointer for a fresh session:
> Continue the work on branch `claude/visual-content-generator-BLJks`. Read `HANDOFF.md`
> first. Priority: live-validate the Google Custom Search (figure retrieval) + grounding
> calls now that the environment has network access.

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
A unit test with a real transport, or a throwaway script under `apps/web`, hitting the
endpoints with the user's keys. Don't commit keys. If a shape is wrong, fix the provider —
the graceful fallbacks mean a wrong shape currently fails *silently*, so test the happy path
explicitly.

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

## Possible next steps (not yet built)
- Two-pass technical extraction (extract terms → grounded re-pass) for deeper accuracy.
- Surface retrieved-figure attribution/“open source” link in the reader caption UI.
- Concept-level entity panel for technical books (analogue of the Character Bible).
