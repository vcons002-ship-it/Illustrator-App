# Changelog

User-facing changes, newest first. (Started July 2026; earlier history lives in the
"Done recently" list in [FEATURES.md](./FEATURES.md).)

## July 2026

### Assistant & UI

- **App-managed checklists no longer get stuck mid-run** — when working an app-managed plan (e.g.
  generating several images from a checklist), the assistant would sometimes try to "check the box"
  itself or narrate "done!" instead of actually running the step's tool — and the app counted each
  such turn as a failed attempt, parking after two with "⏸ Stuck — how do I proceed?". Turns where
  the step's real work was never attempted now re-nudge toward the exact tool instead of burning an
  attempt, so a checklist of renders runs to completion.

- **Task chats keep the task up to date** — anything you hand a task's chat now lands on the task
  itself: pasted links and uploaded files are captured onto the plan automatically the moment you
  send them, and the assistant is required to save the meaning (answers, decisions, a resume's key
  points) as it works — flagging the task for an in-place re-plan when the new info changes the
  steps. Closing the chat window no longer loses what you shared; the Tasks panel reflects it
  immediately.
- **Stitch existing clips into one video** — ask the assistant to "combine those clips" (it joins
  videos from the chat and/or local files, in order, normalizing mixed sizes/framerates), or open
  🎨 Creations → "Select clips", tap videos in play order, and hit Stitch. No re-rendering — hard
  cuts between clips, which is exactly right for multi-scene edits.
- **First + last frame videos (Wan)** — give the assistant two images ("morph this into that",
  "transition from A to B") and the clip is pinned to start at one and arrive exactly at the
  other. Wan 2.2 only; the LTX model reports it clearly instead of ignoring the end frame.
- **Long-form video keeps its subject** — chained clips used to "forget" the source material the
  moment the subject left the frame or a shot invented a scene change (each clip only sees the
  previous clip's last frame). Every clip now carries a persistent subject description, an explicit
  single-continuous-shot / stay-in-frame directive, and a scene-lock negative prompt (no cuts, no
  new scene, no panning away) — and the assistant is instructed to write shots that never let the
  subject exit. Drift can't be fully eliminated (it's inherent to last-frame chaining), but the
  render is now strongly anchored to the original subject.

- **The assistant can check tasks off** — say "I booked the flight" or "mark that done" and it
  marks the sub-task (or the whole task) complete, in the app and in Google Tasks when connected.
  It can also reopen a finished task. Checking off a specific sub-task now works in any order
  (previously the first pending step was silently completed instead of the one you named).
- **Models menu redesign** — the chat's ⚙ Models switcher is now tabbed (💬 Chat / 🖼 Image /
  🎬 Video) with provider sections, the active pick shown per tab, and a filter box for long
  model lists.

### Reliability & security (audit phases 1–2)

- **Engine crash recovery** — if the background engine crashes, in-flight chats and renders
  now fail cleanly and the engine restarts, instead of the app hanging on "generating" forever.
- **No more orphaned GPU processes** — managed engines are tracked and shut down with the app,
  including their child processes, so a crash no longer leaves VRAM held hostage.
- **Web-fetch hardening (SSRF guard)** — the assistant's web-fetch proxy refuses loopback,
  LAN, and link-local targets it wasn't explicitly asked to reach.
- **File access is scoped** — the assistant's file tools are confined to approved folders;
  anything else asks for your approval first.
- **Phone↔desktop settings no longer clobber each other** — a late echo from the desktop
  can't overwrite what you just typed on the phone.
- **Storage problems are visible** — running out of browser storage now shows a clear warning
  instead of silently dropping new books, chats, and images.
- **Sturdier cloud/local providers** — network timeouts and one-shot retries where they were
  missing, and automatic retries no longer re-run non-idempotent actions.
- **Prompt-injection markers** — web search results are delimited as data, not instructions,
  closing a manipulation path from malicious pages.

### Fixes & improvements

- **Videos play on linked phones** — video is stripped from the mirrored chat to keep the link
  light, and the phone now re-fetches the file from the desktop when you view it.
- **Managed ffmpeg** — a one-click "Download ffmpeg (~80 MB)" button installs a self-contained
  static build for long-form video, and a Windows dialog hang during download was fixed.
- **Better Models menu** — the quick model switcher is organized by provider, AUTOMATIC1111
  auto-connects at startup when configured, and the redundant "Generate on" toggle was removed
  (managed vs. your-own-server is now one setting).
- **Memory notes keep their full length** — durable memory/soul notes are no longer truncated
  below their 2,000-character limit.
- **Long-form video** — ask for a longer video and the assistant renders a series of clips,
  each continuing from the last frame of the previous one, stitched into a single mp4.
- **Video on mobile fixed** — generated clips no longer fail to load on phones due to a blob
  handling bug.
- **Video works alongside AUTOMATIC1111** — the video tool is no longer locked when images
  render on AUTOMATIC1111; video simply uses the ComfyUI connection next to it.
