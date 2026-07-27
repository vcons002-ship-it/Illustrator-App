# Changelog

User-facing changes, newest first. (Started July 2026; earlier history lives in the
"Done recently" list in [FEATURES.md](./FEATURES.md).)

## July 2026

### Tasks & chats

- **Planning now sets up its own follow-through** — when the assistant plans a task, it can also ask
  for the recurring checks that task needs to move forward on its own ("check for RSVP replies each
  morning", "chase whoever hasn't answered on the 9th"). Those become scheduled actions attached to
  the task, so the plan arrives with its background work already wired up instead of just describing
  it. Re-planning updates those checks in place rather than piling up duplicates, so each one keeps
  its history.
- **The assistant can work tasks while you're away** (off by default) — with "let the Task Assistant
  work on tasks by itself" enabled, it picks up the next step that's marked as *its* job and does it,
  rather than leaving it described but undone until you open the task. It only touches steps assigned
  to it, skips any plan that's waiting on an answer from you or is about to be re-planned, works one
  step at a time once you've been idle a few minutes, and gives up after two tries instead of
  retrying forever. It still never submits forms, pays, or sends email.

- **Close a chat without deleting it** — ✕ closes the chat you're in: it drops out of the switcher
  and everything is kept. It comes back from the "Closed (reopen)" group in the same switcher, or
  automatically when you open its task again — with the whole conversation intact. Previously the
  header had only New, Rename and Delete, so getting out of a task's chat meant hitting 🗑, which
  permanently threw away everything you'd worked through on that task (and reopening the task then
  showed just the original plan summary, because the history was gone). 🗑 is still there for
  actually deleting, and now says which chat it's about to destroy and points at ✕ instead.
- **⏰ Scheduled shows which task each action belongs to** — it was one flat list, so once actions
  started being attached to tasks there was no way to tell what an entry was for. Actions are now
  grouped under the task they maintain, with anything standalone listed separately. An action whose
  task has since been deleted is called out, since it would otherwise keep running with nothing to
  update. With nothing tied to a task, it's the same plain list as before.
- **Background jobs that keep a task up to date** — a scheduled action can now be attached to a task,
  and it runs inside that task's own chat instead of the generic Scheduled one. So a recurring job
  picks up with the task's conversation, checklist and files already in front of it, and writes what
  it finds back onto the task. Each run is also told when it last ran, so it covers only what's new
  rather than re-reading everything and re-reporting things it already handled. This is what makes
  something like "track RSVPs for the party and chase whoever hasn't replied" hold together over
  weeks: ask for it once, and each run adds to the same task.

- **Re-opening a task keeps your work** — opening a task replaced its chat with a one-line summary,
  and moments later saved that over the top of the conversation you'd had in it. Everything you and
  the assistant had worked through on that task was lost, every time you re-opened it. A task now
  reopens where you left off: the full conversation, its working checklist, and the files it wrote.
  The summary opener is now only shown the first time you start a task.
- **Chat names stick** — renamed chats (and the task chats named after their task) reverted to
  "Chat 1", "Chat 2"… on every restart, because the name was saved but thrown away on load. Names
  now survive restarts, and a task's chat follows the task if you rename it.

### Assistant

- **Old conversations stop repeating stale instructions** — the fix below stopped NEW leakage, but
  chats saved beforehand still carried the stray instruction in their history and kept acting on it.
  Those are now cleaned as they're loaded. Nothing is deleted: your visible chat is untouched, and
  only what the assistant is shown changes.
- **Internal instructions no longer leak into later conversations** — when a long turn hit its
  per-turn tool budget, the app told the assistant "don't call another tool now; summarise instead".
  That was a one-turn instruction, but it was being saved into the conversation — so from then on the
  assistant kept re-reading it as if you'd said it, and would visibly puzzle over why it wasn't
  allowed to use tools. The same applied to the app's step-by-step nudges while running a checklist.
  These now steer only the turn they belong to; what actually happened (results, renders, files
  written) is still kept.

### Calendar

- **The assistant can now edit calendar events, not just create them** — and in particular it can keep
  adding to one as things firm up. Tell it the confirmation number, the gate, the address, who's
  coming, or that a meeting moved, and it puts that on the event itself instead of only replying.
  Details **accumulate**: adding a note appends to what the event already says rather than wiping it,
  so an event you booked last week can gain a line at a time. It can also rename, move (start/end),
  or set the location of an existing event.
- **It can find an event to update, from any chat** — the calendar is now searchable by text, so a
  scheduled action or a brand-new conversation can look up "the flight" and add to it without ever
  having seen the booking happen. (Events that already happened are findable too, by asking for a
  window that reaches back.) Listed events show their existing details, so it can see what's already
  recorded before adding.
- **Switch an event between all-day and timed** — the Edit form's "All day" tick box now works both
  ways on an existing event: give an all-day event a start and end time, or drop the times off a
  timed one. The assistant can convert an event the same way. An all-day event that spans several
  days keeps its span when you edit something else about it.
- **All-day events** — 📅 Calendar's add-event form has an "All day" tick box (a birthday, a holiday,
  a whole-day trip), and the assistant can create or change one by giving plain dates instead of
  times. The fiddly part is handled for you: a one-day all-day event is written the obvious way
  ("July 4 to July 4") and stored the way Google requires.
- **Software update button works again** — updating from Settings failed with a confusing "outside the
  approved folders" message. The folder scoping added in an earlier security pass didn't make an
  exception for the app's own folder, which is exactly where the update has to run.
- **Edit events yourself, in the app** — 📅 Calendar now has an Edit control on each event: change the
  title, time, location, or the details/notes, and it's written straight through to Google. Events
  also show their details inline, so anything the assistant recorded is visible where you'd expect it
  rather than only in Google. Editing works from a linked phone too (the change is applied by the
  desktop, which holds the Google connection).

### Scheduled actions & the phone link

- **One-time scheduled actions** — "remind me to call the dentist on Friday at 5" now works. Only
  recurring cadences (daily/weekly/monthly) could actually be created before: a one-off had no way to
  say *which day*, and attempting one failed outright. You can now give a specific date, or just a
  time (it runs the next time that time comes around).
- **Your phone shows the full chat again on open** — a linked phone used to sit on an empty "Chat 1"
  until you sent a message, which then made everything appear at once. The phone's opening "send me
  your state" request was being discarded by the link itself, so the desktop never knew to answer;
  the message you typed was the next request through, which got there fine. The phone now also keeps
  asking until the desktop actually replies, so connecting before the desktop is ready (or during a
  restart or Wi-Fi blip) recovers on its own instead of leaving you on a blank chat. Separately, the
  desktop was packing the whole re-sync — chat history, images, the open book — into a single message
  too big for the link; it's now sent in pieces so nothing gets dropped for size.
- **Scheduled actions appear on your phone** — the ⏰ Scheduled panel was always empty on mobile
  (the phone was reading its own empty storage instead of the desktop's). It now mirrors the
  desktop's schedule, and enabling/disabling or deleting one from your phone applies on the desktop.
- **Scheduled actions no longer hijack your conversation** — a task firing used to drop itself into
  whatever chat you had open, interrupting you and leaving its instructions in that conversation's
  context (so the assistant would carry an unrelated "summarise my email" into later replies).
  Scheduled work now runs in its own ⏰ Scheduled chat, and only after you've been idle a couple of
  minutes — a due task waits for a lull rather than cutting in, and nothing is skipped.

### Audit #2 fixes (reliability, security, video, UI)

- **Long-form video is dramatically faster** — a bug meant the ~30 GB video model was unloaded and
  reloaded from scratch between *every* clip (minutes of dead time per clip). Clips now keep the model
  resident across the batch and free it once at the end, so a 10-clip render no longer pays ten full
  reloads.
- **Approved renders can't leak into the next chat** — if you hit Clear, switch sessions, or Stop
  while an image/video/stitch was rendering, its result is now dropped instead of appearing in (and
  driving a follow-up turn on) whichever conversation you moved to.
- **Send a photo from your phone** — full-resolution phone photos were silently too big for the
  desktop link and the send would just vanish; photos are now downscaled before they're relayed, so
  "look at this picture" works from a linked phone.
- **Phone + desktop no longer cross wires** — a linked phone and the desktop could collide on the same
  internal request id, occasionally delivering a result to the wrong device; their id spaces are now
  separated, and heavy renders the phone didn't ask for are no longer pushed down the link.
- **Cloud extraction fails loud, not empty** — when a cloud model (Claude/Gemini) hit its token limit
  mid-extraction, the app used to silently commit an empty result; it now reports the failure so the
  chapter isn't quietly blanked.
- **Deleting a chat message no longer scrambles the others** — a code card's run output, an inline
  preview, or an enlarged image could jump onto the wrong message after a delete; messages now keep
  their own state.
- **Security hardening** — the web-fetch proxy now re-checks every redirect hop (so a public URL can't
  bounce to your LAN), file/ffmpeg/git tools are confined to approved folders, the phone-link relay
  has connection and message-size limits, and the Gemini API key is sent as a header instead of in the
  URL.
- **Smaller fixes** — "Clear" on a book chat now asks first (matching the assistant chat); the file
  card's "⋯ More" menu closes after you pick something; the assistant chat scrolls to keep the newest
  plan/step/thinking updates in view; the playground stops hanging forever if a render reply is lost;
  monthly recurring tasks no longer skip a month on the 29th–31st.

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
