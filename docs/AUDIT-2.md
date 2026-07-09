# Full-code audit #2 (July 2026)

A five-track read-only audit (core chat/tools/workflow · core providers/storage/epub · web host +
worker · UI + extension · Rust shell + security), run after Phases 1–5 and the video/task/gallery
work. Findings are grouped by area and ordered by severity within each. Every item names file:line
and a concrete failure scenario. The five ⭐ items were **re-verified against source** by the
orchestrator; the rest are the agents' reads (high-confidence, but a fixing pass should re-confirm
before editing).

Legend: 🔴 high · 🟡 medium · 🟢 low. Effort: S (≤1h) · M (a few hours) · L (bigger).

This is a **findings document** — nothing here is fixed yet. Suggested first wave is the five
verified 🔴s plus the workflow collar hole; they're all small and high-value.

---

## Security

### S1 🔴 ⭐ `http_fetch` SSRF guard is redirect-blind — S
`apps/desktop/src-tauri/src/main.rs:642`. The reqwest client is built with no redirect policy, so it
follows up to 10 redirects; `is_private_host` runs only on the *initial* URL (line 632). A
prompt-injected page fetches an attacker public URL that `302`s to `http://169.254.169.254/…` (cloud
metadata) or `http://127.0.0.1:PORT` — the redirect target is never re-validated, defeating the whole
guard. **Fix:** `.redirect(Policy::none())` + re-run `is_private_host` per hop (or a custom policy).

### S2 🟡 `run_ffmpeg` skips `APPROVED_ROOTS` — M
`main.rs:2209`. Only checks `p.is_dir()` for cwd; the `-i <in>` / `<out>` paths in `args` are ungated,
so ffmpeg can read/write arbitrary files (and reach URLs via its protocol handlers). Every other
file-touching command routes through `resolve_approved_cwd`/`is_approved_path`. **Fix:** gate cwd +
validate in/out paths against approved roots.

### S3 🟡 `git_*` commands take an arbitrary caller-supplied dir, no roots gate — M
`main.rs:2411-2504` (`git_commit_all`, `git_worktree_diff`, `git_merge_branch`, `git_conflict_versions`,
`git_complete_merge`, `git_worktree_remove`). A prompt-injected flow can commit in the user's real repo,
read tracked file contents via `git show`/`git diff`, or delete branches — outside the roots
`read_file`/`run_command` enforce. Args are fixed (no shell injection), which caps it. **Fix:** gate
`dir`/`repo_dir` through `is_approved_path`.

### S4 🟡 SSRF port exemption spans the whole private range, not just loopback — S
`main.rs:590 & 632`. The `LOCAL_ENGINE_PORTS` exemption applies to any host `is_private_host` matches,
so a page can drive `http_fetch` to `http://<any-LAN-IP>:{8188,7860,11434,11435,1234}` — a co-worker's
Ollama/LM Studio, etc. **Fix:** restrict the exemption to `127.0.0.1`/`::1`.

### S5 🟡 Buddy parser executes tool-JSON anywhere in the reply (injection surface) — M
`packages/core/src/chat/buddy-tools.ts:1779-1794`. `parseBuddyToolCalls` runs `extractJsonObjects` over
the whole reply with no positional envelope — unlike `chat-tools.ts:196-205`, which deliberately accepts
only a whole-reply or *trailing* object so quoted JSON never executes. Scenario: `read_url`/`read_email`
returns content containing `{"tool":"draft_email",…}`; the model quotes it while summarizing → the call
auto-runs. Also: showing the reader an *example* tool call in a ```json block executes it. **Fix:**
restrict extraction to line-start / trailing objects (the format the prompt mandates).

### S6 🟡 Remote relay: internet-exposable, gated only by a frontend-chosen token, no size/rate caps — M
`main.rs:817-857, 981-1054`. Binds `0.0.0.0` and may be Cloudflare-tunneled; the sole gate is a token
whose entropy the JS caller picks; no failed-attempt backoff and no `WebSocketConfig` message-size limit
(tokio-tungstenite default 64 MB) — unauthenticated peers can open many connections and buffer large
frames before auth. `ct_eq` correctly closes the timing channel. **Fix:** server-side high-entropy
token, message-size + connection caps + backoff.

### S7 🟢 Gemini API key travels in the URL query string — S
`packages/core/src/providers/llm/gemini-provider.ts:156, 176, 228`. `?key=…` is logged by proxies
(incl. this app's own), devtools, error strings. **Fix:** use the `x-goog-api-key` header.

### S8 🟢 Misc Rust: single-process timeout kills leak trees (`run_command`/`run_ffmpeg`/`mcp_stdio`), `spawn_a1111` adopt race, relay re-broadcasts the auth frame, wildcard CORS on the LAN asset server — S each
`main.rs:1951, 2255, 951, 2701, 1031, 1136`. Individually low; the timeout-kill-should-be-`kill_tree`
ones are the most worth doing (they orphan GPU-holding children).

**Confirmed still-holding (checked):** canonicalized `APPROVED_ROOTS` on `read_file`/`search_files`/
`run_command`/workspace ops (defeats `..`/symlink/8.3); `kill_tree` on all engine children; the
`KILL_ON_JOB_CLOSE` Job Object; `ct_eq`; `is_private_host` covers decimal/hex/IPv6-mapped forms;
`open_browser_window` capability scoped to `main` with no remote IPC grant; OAuth PKCE+state; no
`eval`/cross-origin postMessage; article-HTML allowlist sanitizer.

---

## Correctness — video pipeline (newest code, thinnest tests)

### V1 🔴 ⭐ `warmBatch` is dead — every long-video clip reloads the ~30 GB model — S
`packages/core/src/providers/image/local-engine/comfyui-backend.ts:1152` + `apps/web/src/engine.worker.ts:4157`.
`generateVideo`'s `finally` **unconditionally** `await this.freeMemory()`, and `handleChatVideo` never
passes `warmBatch` into the input. So on a 10-clip run, clip 1's finally unloads the model and clip 2's
"warm" skip finds a cold engine → full multi-minute reload per clip — exactly what the worker comment
says warmBatch prevents. **Fix:** plumb `warmBatch` into the input; skip the finally-free when set; the
host loop frees once after the last clip.

### V2 🟡 Long-video "last frame" extraction (`-sseof`) is unreliable on animated WEBP — M (needs real-box check)
`packages/core/src/providers/image/video-stitch.ts:22` + `App.tsx:4678`. Wan clips are `SaveAnimatedWEBP`;
`ffmpeg -sseof -0.2 -i clip.webp` needs end-relative seeking the webp demuxer may not support — depending
on the bundled ffmpeg the chain errors or silently seeds every clip from frame 0 (freezing the "seamless"
chain). LTX (mp4) is fine. **Fix:** save Wan long-form as mp4, or extract the last frame without seeking.

### V3 🟡 img2img never resizes the source photo — runs at native resolution — S
`comfyui-backend.ts:1475`. The img2img branch is `LoadImage → VAEEncode` with no `ImageScale`, so the
clamped `width`/`height` are unused — a 4032×3024 phone photo samples SDXL at ~12 MP → OOM/artifacts;
with hires on, `LatentUpscale` can downscale to a wrong aspect. The LTX graph inserts `ImageScale`
correctly. **Fix:** add `ImageScale` (lanczos, clamped) between nodes 15 and 16.

### V4 🟡 `generate_long_video` silently drops `source.ref` on kind "last" — S
`buddy-tools.ts:2583`. `generate_video` honors `ref` on kind "last" (named image / "1"/"2") and the
prompt says long-video's `source` has "the same options", but the long-video parse maps
`{kind:"last",ref:"photoA.jpg"}` → bare `{kind:"last"}`. Two-upload "start from photoA" silently seeds
from the newest image. (Same class as V-ref work; asymmetry introduced with the FLF feature.) **Fix:**
carry the ref like `generate_video`; add a test.

### V5 🟢 `generate_video` `end` coerces every invalid shape to `{kind:"last"}` — S
`buddy-tools.ts:2515`. `end:{}` / `{"kind":"library"}`-no-ref → `{kind:"last"}`, and if source also
defaults to last, you get the do-nothing same-image "morph" the prompt warns against — GPU time for
nothing. **Fix:** drop an unusable `end` (fail louder).

### V6 🟢 Flux cloud tier ignores `input.seed` — pinned-seed re-renders don't reproduce — S
`packages/core/src/providers/image/flux-provider.ts:75`. Uses only `anchors[0]?.seed`; both local
backends honor `input.seed ?? anchors[0]?.seed`. **Fix:** one-line `input.seed ?? …`.

### Test gap: the runtime video path (`generateVideo`: endImage upload ordering, LTX-vs-Wan branch,
endImage-without-start/endImage-on-LTX rejections, finally-free) has **no coverage** — the pure graph
builders + stitch/continuity helpers are well tested, but the plumbing between them (where V1 lives) is
the untested seam.

---

## Correctness — workflow / tools

### W1 🟡 Workflow collar hole: `tool_ok` counts nested host-tool failures as success — S
`packages/core/src/chat/workflow.ts:188` (`toolSucceeded`). It only checks top-level `!r.result.error`,
but host tools report failure *nested* (`{video:{ok:false,error}}`, `{writeFile:{ok:false}}`). A step
`needs:"generate_video"` (no alias → `tool_ok`) advances past a failed render — re-opening the exact
"model claims done" gap the collar exists to close. Same for `generate_long_video`/`stitch_videos`/
`edit_file`. **Fix:** add video/edit aliases in `needsToDoneWhen` and/or make `toolSucceeded` reject
nested `ok:false`.

### W2 🟡 `needsToDoneWhen` turns an unknown token into an unsatisfiable contract (doc says fall through) — S
`workflow.ts:94`. Any unrecognized `needs` → `tool_ok(<token>)`, which can never be satisfied → the step
burns all reminders + attempts then parks. A step tagged `needs:"research"` wedges. **Fix:** validate
against the real tool-name set, return `undefined` (→ `inferDoneWhen`) otherwise.

### W3 🟡 `edit_file` missing from the approval routing table — policy drift — S
`packages/core/src/chat/tool-approval.ts`. `write_file` routes `"host"` (auto-runs even with workspace
flags off); `edit_file` falls to `"ask"` in every config — so the tool the prompt tells the model to
*prefer* always stops for a click while the broader `write_file` doesn't. **Fix:** give `edit_file` the
same route as `write_file` (or gate both on the workspace flags). No test mentions `edit_file`.

### W4 🟢 `stitch_videos` auto-runs on arbitrary model-supplied paths with no parse validation — S
`tool-approval.ts:75` + `buddy-tools.ts:2536`. Route is unconditionally `"stitch"`; parse accepts up to
24 arbitrary strings as "paths" with no extension/protocol check. With S5 (mid-prose parse), injected
content could trigger clickless local-file reads (`concat:`/URL protocols if the host resolver is
permissive). **Fix:** extension allowlist + reject `-`/protocol-prefixed refs at parse time.

### W5 🟢 `tool-inventory.ts` omits `generate_video`/`generate_long_video`/`edit_file`/`delegate_coding_task` — S
Those capabilities have **no** `feature-parity.test.ts` guard, so a future consolidation could drop one
and CI stays green. **Fix:** add the rows.

---

## Correctness — host / worker state

### H1 🔴 ⭐ Approved-render continuations ignore Clear / session switch / Stop — S
`App.tsx` approve handlers (`approveGenerateImage/Video/LongVideo/StitchVideos`, ~4443/4565/4626/4774).
They `appendBuddy(...)` + `dispatchBuddyTurn(...)` after the render without re-checking `buddyTurnSeq`
(only `dispatchBuddyTurn` checks it, after its own await). Switch sessions during a 2-min video → the
"stopped" feedback appends into the **new** session and launches a turn carrying the **old** transcript
(cross-session contamination, then persisted). On Stop in app-managed mode, the "failed" feedback →
`advanceWorkflowAfterTurn` → retry → re-runs the render the user stopped. **Fix:** snapshot
`buddyTurnSeq.current` at the top of each approve handler; bail before append/dispatch if it changed.

### H2 🔴 Phone + desktop share one worker requestId space (two independent counters) — M
`apps/web/src/useEngineWorker.ts:536, 710-748`. A linked phone relays raw worker frames with ids from
its own counter (starts at 1) while the desktop uses its own (also from 1); the worker routes purely by
`(type, requestId)`. A desktop book-chat / 60 s `marketIndicators` id can collide with a phone request
of the same type → results delivered to the wrong side, and the phone's silence-watchdog `chatCancel`
aborts the desktop's turn via the shared abort map. **Fix:** namespace phone ids (start at 1e9, or
rewrite at the bridge). *(Reported, not re-verified — needs the two-device path.)*

### H3 🟡 `resolveVideoSource` can't see externalized/stripped images (no blob-store fallback) — S
`App.tsx:4533`. It only collects messages with live inline bytes; after a reload, history is byte-less
and only the last 8 are rehydrated. "Animate the image named X" for a 10th-from-last image → "there's no
image to animate yet" though it's visibly in chat; positional refs ("2") can also point at the wrong
image. `resolveStitchClip` already does the `getImageBlob` fallback — mirror it here.

### H4 🟡 Phone attachment send rides one unbounded, unchunked relay frame — silently dropped — M
`App.tsx:5713` + `import-file.ts:97`. `vrcmd:chatSend` carries the full-res photo bytes raw; a 5–12 MB
photo → a 7–16 MB base64 frame that a Cloudflare tunnel drops silently (the codebase documents the
~3 MB ceiling). "Send photo from phone" does nothing, chips already consumed. **Fix:** downscale
phone-side, or chunk like `vrsync:fileData`.

### H5 🟡 Host-bridge engine mirror has no frame-size bound — M
`useEngineWorker.ts:775`. Every `WorkerToMain` is mirrored to the phone base64 in one frame, including a
`chatToolResult` carrying a rendered video (tens of MB) the phone ignores anyway — pure waste that can
kill the tunnel socket. **Fix:** skip/strip byte payloads for ids the phone doesn't own.

### H6 🟡 Deferred-engine flag + status not cleared on the A1111 probe-success path — S
`useLocalEngine.ts:442`. `engineDeferredRef` only clears in `startManagedEngine`; when the deferred start
resolves via the A1111 branch, the flag stays true and the "Starting…" status sticks — so *every*
later standalone render re-runs `ensureA1111` + a full `probeServer` first. **Fix:** on `res.ok` in
`ensureRenderEngineReady`, clear the ref + status.

### H7 🟢 `appManagedNudgeRef` not reset on session switch/Clear; generic step ids — S
`App.tsx:1181` + `resetBuddyView`/`onClearBuddy`. Switching from session A (2 reminders burned on "s2")
to B whose workflow is also on "s2" inherits the count. Contained by the attempts cap. **Fix:** reset
in `resetBuddyView`/`onClearBuddy`.

### H8 🟢 Misc host: coding-agent progress posted under a dead requestId (never displays); `testRender`
has no watchdog (a lost reply hangs the playground forever) — S each.
`engine.worker.ts:2904`, `useEngineWorker.ts:1600`.

**Confirmed clean (checked):** transfer-list hygiene (every `chatVideo`/`assessImage` caller `.slice(0)`s
before transfer — no detached reuse); the `useRemoteMirror`/`useLocalEngine` extractions are faithful
code motion (same state set both ways, echo guard intact); worker protocol uses delete-then-resolve,
`failAllPending` drains all 24 maps; `advanceWorkflowAfterTurn` resets evidence + nudge budget on real
attempts; chunked `vrsync:fileData` cleans up partials.

---

## Reliability — cloud extraction

### R1 🔴 Claude extraction silently commits an empty chapter on parse failure — S
`packages/core/src/providers/llm/claude-provider.ts:186`. When `parsed_output` is null (schema drift,
refusal, or a 12288-token truncation — `stop_reason` unchecked), it merges an empty extraction and
returns success; the chapter is marked processed with no keyEvents → its units sit "waiting to be
illustrated" forever, no error, no retry. The **local** path deliberately *throws* on exactly this.
**Fix:** throw on null `parsed_output` / `stop_reason === "max_tokens"` so the engine's recovery kicks
in.

### R2 🟡 Gemini extraction: unparseable/truncated JSON also silently commits empty — S
`gemini-provider.ts:107`. Same class; `finishReason`/`MAX_TOKENS` unchecked. `isEmptyExtraction` already
exists — apply the same throw-on-empty guard.

### R3 🟡 Monthly schedules with `dayOfMonth` 29–31 double-fire and skip months (JS Date overflow) — S
`packages/core/src/chat/scheduled-tasks.ts:83` and `tasks.ts:306` (`shiftIso`). `new Date(2026, 8, 31)`
→ Oct 1; a `dayOfMonth:31` task runs Aug 31 → "Sep 31" = Oct 1 (Sept skipped) → fires again Oct 31. A
recurring deadline of Jan 31 drifts permanently. **Fix:** clamp the day to the target month's last day.

### R4 🟢 Provider stream readers not cancelled on error (leaked sockets); native Ollama NDJSON chat has
no connect timeout — S–M. `local-server-provider.ts:680` + `sse.ts:55`.

### R5 🟢 Key-vault device-key generation race can orphan encrypted keys; backup export encodes the whole
buffer ignoring `byteOffset` (corrupts subarray views); `/prompt` retry is not idempotent (can
double-render a 5-min video). `key-vault.ts:52`, `indexeddb-store.ts:53`, `comfyui-backend.ts:1159`.

---

## UI / UX

### U1 🟡 Chat lists use index keys + delete-by-index → child state attaches to the wrong message — M
`ChatPanel.tsx:414`, `ChatBuddyPanel.tsx:449`. Deleting message N shifts every later message into the
prior component instance; `CodeCard` run output, iframe preview, `ImageGallery` enlarged state then
render under a different message. **Fix:** key on a stable id (or `at`) and delete by id.

### U2 🟡 Toasts render *under* modal backdrops (contradicting their contract) — S
`Toast.tsx:43` (`zIndex:80`) vs ModalShell overlay `zIndex:100` (OrderReview 120) with a blur backdrop.
An error toast fired while any modal/Tasks/Memories is open is dimmed into illegibility — the exact
"mid-flow failures are silent" bug toasts were built to fix. **Fix:** raise the stack above the highest
overlay (~130).

### U3 🟡 CreationsPanel skipped the ModalShell a11y migration; all image cards hydrate eagerly — M
`CreationsPanel.tsx:90, 217`. The gallery + its lightbox have backdrop-close but no Escape/`role=dialog`/
focus handling (a regression vs the 7 migrated modals), and every image tile fires `load()` on mount
with no visibility gating or concurrency cap — opening a 200-image gallery issues 200 parallel blob
reads and materializes every full-size Blob at once; deleted items' object URLs are never revoked until
close. **Fix:** wrap in ModalShell + own Escape for the lightbox; IntersectionObserver-gate hydration,
revoke on delete.

### U4 🟡 ModalShell: Escape has no focus trap and no `defaultPrevented`/stack check — S+M
`ModalShell.tsx:46-59`. `aria-modal` is set but Tab walks into the hidden background; and Escape on an
inner edit input both cancels the edit *and* closes the whole dialog (MemoriesPanel), and one Escape
closes both dialogs of a stacked pair. **Fix:** sentinel tab-wrap (or `inert` on the app root); inner
handlers `stopPropagation`, shell skips `defaultPrevented`.

### U5 🟢 Book-chat "Clear" has no confirm (buddy chat does); model-menu tab summary shows "—" for a
configured-but-not-yet-fetched local server model; ChatBuddyPanel auto-scroll misses `steps`/`plan`/
`thinking` updates; `<details>` file-card menu never closes after select; stitch-select mode is
thumbnail-blind and can lose its Cancel control / pass a host-deleted key to `onStitch`. `ChatPanel.tsx:384,
988`, `model-menu.ts:76`, `ChatBuddyPanel.tsx:202`, `CreationsPanel.tsx:97`. — S each.

**Extension:** composes correctly with shared ui/core; same identity/tuning split, no drift.

---

## Suggested sequencing

1. **First wave (verified 🔴 + collar, all S):** V1 warmBatch, H1 approve-seq-guard, U-video S2/V-settings
   (below), S1 SSRF redirect, W1 collar hole, R1 Claude silent-commit, and the video-settings-identity
   fix (see next). Each is small and either data-/reliability-critical or a big perf win.
2. **Video-settings-identity 🔴 (S)** — `packages/ui/src/settingsKeys.ts`: `videoModel`/`videoParams`/
   `videoFiles` fall into `identitySettingsKey`, so picking a video model or nudging frames/fps while a
   book is open **wipes the rendered illustrations + aborts the bible build** (verified). Move the three
   into `TUNING_FIELDS`.
3. **Second wave (🟡):** S2/S3 roots gates, S5 parser envelope, U1 index keys, U2 toast z-index, U3/U4
   modal a11y, V3 img2img resize, V4 long-video ref, W2/W3, R2/R3, H3–H6.
4. **Third wave (🟢) + the test gaps** (runtime video path, collar nested-failure, `needsToDoneWhen`
   unknown token, `edit_file` route, monthly day>28).

Nothing here is architectural. The recurring theme: the newest seams — video plumbing, the
approval→workflow→session cross-cut, the phone link's two unowned invariants, and new overlays built
alongside (but outside) the ModalShell/tokens/settings-split contracts — are where the bugs cluster.
App.tsx's size is a risk multiplier for the host findings; continuing the Phase-5 extraction program is
the highest-leverage structural hardening.
