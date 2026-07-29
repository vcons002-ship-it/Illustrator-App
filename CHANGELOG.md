# Changelog

User-facing changes, newest first. (Started July 2026; earlier history lives in the
"Done recently" list in [FEATURES.md](./FEATURES.md).)

## July 2026

### The assistant

- **Its appearance no longer fades from its own memory** — Soul keeps far more notes than can fit in
  every prompt, and prompt selection preferred the newest ones. Because a physical description is
  usually written near the beginning, it could remain plainly visible in the Soul panel while the
  assistant itself could no longer see it. Appearance notes are now reserved first regardless of age,
  with the remaining prompt space filled by its newest personality and experience notes. The same
  rule protects the reader's appearance in the You soul.
- **It can potter about on its own** (off by default) — turn on "Let it explore something of its own
  while you're idle" and, a few times an hour when you're not using the app, it follows its own
  curiosity: reads around a topic on the web and writes up what it found interesting. It lands in its
  own **✨ Creative** chat, so it never appears in a conversation you're having, and it remembers what
  it has already covered so it goes somewhere new each time. Running one has to bring that chat to the
  front briefly, so it puts you back in the chat you had open when it finishes — unless you've come
  back and started doing something, in which case it leaves your view alone. It also waits for the
  app's real background work — scheduled actions, task steps — to be finished before starting, so it
  never competes with something that actually matters. While exploring it can only search, read, and
  write a document: it cannot run commands, touch your files, email anyone, or spend anything,
  whatever your other permissions allow. Settings has an **✨ Explore something now** button and shows
  when it last ran, so you can see it work immediately instead of leaving the app alone for ten
  minutes to find out.
- **You can talk to it about what it explored** — open the ✨ Creative chat and ask; it's an ordinary
  conversation there, with everything it can normally do. It also knows, in any chat, that exploring
  on its own is something it does, so bringing up a piece it wrote doesn't meet a blank. The
  instructions it gives itself while working alone ("nobody is waiting on you", "don't ask any
  questions") no longer linger in that chat afterwards, where they'd have made it oddly reluctant to
  talk to you.
- **What it explores can change who it is** — if a piece of reading genuinely lands, it can add that
  to its own identity notes ("I'm drawn to problems where the obvious answer is wrong", "I find pure
  taxonomy dull"), so its taste is shaped by what it has actually spent time on rather than only by
  what you've told it. It's asked to be sparing, since that list is short and the oldest notes drop
  off — though it now keeps 200 rather than 40, so weeks of them no longer quietly delete the
  character underneath. Roughly the newest forty ride in the assistant's head at any time; the rest
  stay on disk and in the Soul panel, and it's told how many it isn't currently seeing.
  While exploring alone it can only edit its OWN notes — your memories, and its picture of you,
  are out of reach.
- **It explores about once an hour, not three or four times** — the gap between runs was counted from
  when one *started*, so the minutes it spent searching and writing came out of the quiet period. It's
  now counted from when a run finishes, and it's longer. The last-run time is also remembered across
  restarts: it was held in memory only, so every relaunch — including the app's own self-updates —
  forgot the gap and let a run start as soon as you'd been idle ten minutes.
- **It gets out of the way of scheduled tasks** — a scheduled action opens its chat on one tick and
  sends on the next, and in that gap nothing reads as due and nothing is running yet. Idle exploring
  could step into exactly that window and take the screen from a task that was half-way through
  appearing. It now stands down for a few minutes after any sign of scheduled or task work — and if it
  had already switched to its own chat before standing down, it hands the screen back instead of
  leaving you parked there.
- **It stops circling the same subject — without being stopped from following a thread** — every piece
  it wrote alone kept coming back to its first interest. It was being asked to keep its own list of
  what it had already covered, and mostly didn't, so each run started with no history and picked its
  favourite again. The app now records the topic itself, from the piece that was actually written, and
  shows it that list before asking it to choose. What's ruled out is only writing the same piece
  twice: carrying a thread forward onto new ground is explicitly fine, and after three pieces in a row
  in one area it's asked — not forced — to give the next one to something else, with the thread left
  open to come back to. It's also told that its identity notes describe how it thinks, not a subject
  to keep returning to.
- **Exploring no longer eats what it knows about you** — those "already covered" notes were being kept
  in the same 40-note memory as your preferences, which evicts the oldest, so a couple of days of
  exploring would quietly delete real memories. They now live in their own list (120 of them), and any
  that the old build left behind are moved out of your memory automatically on startup.
- **Your Soul panels work on the phone** — they were reading the phone's own storage, which is always
  empty, so everything the assistant is showed as nothing there, and an edit made on the phone went
  somewhere nothing ever reads. Both souls are now mirrored from the computer, and edits are saved
  there. (Reference photos stay on the computer — they're too large to mirror — so that section is
  hidden on the phone rather than pretending to save.)
- **The reasoning bubble shows the reasoning, not the preamble** — it opened by restating who it is
  and who you are almost every turn, which is the same paragraph each time and pushed the part you
  actually wanted out of view. It's told not to bother restating it (it still has it, and still acts
  on it), and anything that does get restated at the start is trimmed from the bubble before you see
  it. Only the opening is ever cut, it's matched against your actual identity notes rather than
  guessed at, and it gives up rather than risk swallowing real thinking — so a thought that mentions
  something about you mid-way through is left alone.
- **The reasoning bubble stays how you left it** — open it and it stays open; close it and it stays
  closed, through the next reply and after a restart. It used to spring back open every time the
  assistant spoke, so closing it only lasted one message. Two gaps in that are now closed: the
  in-book chat never received the setting at all, so its reasoning always expanded while it worked;
  and the finished reply's reasoning was hardcoded shut, so it collapsed the instant the turn ended
  even if you'd deliberately opened it. It's one choice now, covering the live block and the reply it
  becomes. Older replies in the history stay collapsed regardless — otherwise scrolling back would be
  a wall of reasoning.

### The app itself

- **The text encoder you picked is the one that's used** — choosing an exact encoder or VAE in
  Settings → Local model was treated as a strong hint rather than an instruction: if the name stopped
  matching what the engine lists, the app quietly went back to detecting one itself, which is the
  file you switched away from. Nothing said so — Settings still showed your choice, and the failure
  turned up later as a broken render. An explicit choice is now either used or reported, with the
  engine's actual file list in the message so you can pick a real name. Automatic detection still
  behaves as before when you haven't chosen.
- **"Needs a text encoder" when the files are right there** — the app asks the engine which model
  files it has, and remembers the answer because installed files don't change while you work. But an
  empty list is a perfectly successful answer, and the engine gives one while it's still starting up.
  Remembered, that turned a few seconds of bad timing into every image failing with "needs a text
  encoder and a VAE" while both sat on disk — and the app restarting itself to update is exactly when
  it can come back before the engine is ready. It now tells the two situations apart: an engine that
  can name the models it has HAS scanned, so anything else it says is the truth and you get the real
  message at once; an engine reporting nothing at all — no models, no encoders, no anything — hasn't
  started yet, so the app waits for it (up to about a minute) instead of blaming your install. Either
  way it no longer holds on to the empty answer, so a retry always asks again.
- **On a narrow window, every picture is with its own scene** — in one column you only ever saw one
  illustration, sitting under the entire book: the two-column layout puts the picture in a pane
  beside the text, and that pane is the second column, so when the layout collapses it lands at the
  very bottom showing whichever passage you were last on. Every other picture was simply never on the
  page. Each unit's illustration is now drawn in the reading flow, at the end of the passage it
  illustrates, with its description under it. Pictures not yet painted leave no gap.
- **The book gets its own toolbar** — everything that acts on the open book (illustrating, ↻ Redo,
  characters, data, export, import) is now a separate bar of its own beneath the app's toolbar, with
  its own **▾ Book tools** caret, outlined and tinted so it's clear at a glance that everything in it
  acts on the book you have open and nothing outside it does. Before, the two kinds sat mixed
  together in one long wrapping row, and hiding the app's tools took the book's with them. The two
  collapse independently now.
- **Minimising the chat now actually gives the room back** — hiding the message history still left
  three rows of chat above the text box (the session/tools header, the working folder, the context
  meter), so collapsing the dock reclaimed far less of the page than it looked like it should. With
  the history away you get just a way back and somewhere to type; the reader and its illustration
  take everything else. If the assistant is waiting on your approval for something, that is never
  hidden — a line appears with a button to bring it up.
- **Illustrating a book no longer switches off everything that waits for you to be idle** — pressing
  ▶ Start illustrating set a flag that nothing ever cleared: not finishing the book, not the queue
  emptying, only closing and reopening. That flag fed the app's "something is running" signal, which
  is what every idle behaviour checks before it does anything — so from the moment you illustrated
  anything, exploring on its own, scheduled actions and task steps all stopped for the rest of the
  session. It looked exactly like the feature quietly expiring after a while. The app now asks
  whether there is actually work left — analysis, prompts, or unfinished pictures — rather than
  whether you ever pressed the button.
- **A wrong clock can't switch off idle exploring for good** — the wait between runs is measured
  against the last one, and that time is remembered across restarts. If it ever ended up ahead of the
  current time — an internet time correction, a dual-boot machine, or just fixing a wrong date — the
  next run was never due again, permanently, with nothing on screen to say so. A stamp in the future
  is now discarded, and a clock that moves backwards counts as "long enough ago" rather than "just
  ran".
- **The phone link comes back after an update** — the app restarted correctly but the phone got a
  host error, because the link's port was still held by the copy of the app that was shutting down:
  the new one couldn't open it, and its link died on arrival. The outgoing app now hands the port
  over before starting its replacement, and the link retries for a few seconds if something is still
  holding it — so the handover works from either end.
- **…and it says so when it can't start** — the phone link reported itself as running the instant it
  was asked to start, before it knew whether the port had opened. So a link that never came up looked
  live: the address and QR code were shown, the desktop connected to a port with nothing behind it,
  and the only sign of trouble was an error on the phone. It now waits to find out, and tells you
  what went wrong instead.
- **Update no longer closes the app without bringing it back** — the update finishes by building a
  new app and starting it, and starting it was the fragile part. The new app was launched as a child
  of the one about to shut down, sharing its console and standard handles, which on Windows is how a
  relaunch turns into a disappearance: a program tied to a window that's closing, or to a group its
  parent belonged to, gets closed with it rather than replacing it. It's now started as a genuinely
  independent program, from the same folder the desktop-prod.bat launcher starts it from, so the
  relaunch reproduces the way that's known to work. And the old app no longer shuts down on faith: it
  waits for the new one to get through its own startup, and if it stops, the previous version is put
  back and the app you're looking at stays open to tell you — instead of vanishing with no message.
- **The ↻ Redo and ⤓ Export menus stay on screen on a phone** — both dropped a fixed-width panel
  straight down from their button, which broke in a different way in each orientation. Held upright,
  the toolbar wraps and the button can sit near the left of the screen; the panel, which lines its
  right edge up with the button, then hung off the left side of the display with nothing to scroll to
  reach it. Turned sideways, the toolbar takes most of the height and the menu was taller than what
  was left, so the last item or two fell off the bottom — and the toolbar doesn't scroll, so they were
  simply unreachable. Both menus now measure the screen when you open them: the panel is kept inside
  the edges, narrows on a small screen, opens upwards when there's more room above, and scrolls inside
  itself if it still doesn't fit. They re-measure when you rotate the phone, and close on Escape or a
  tap outside.
- **The story picture fits its window, prompt and all** — the image was capped against the whole
  window, which ignores the chat docked underneath it (taller still with the history open). So the
  picture alone could be taller than the space it sits in, pushing the prompt and the "lock this look"
  buttons below the fold with no obvious way down. The picture now sizes itself to the box it's given
  and shrinks to fit, so everything under it stays put.
- **One scroll in the reader, and the whole picture on screen** — the illustration pane had its own
  scrollbar next to the page's, and its bottom sat below the window however you scrolled. It was
  positioned by guesswork: pushed down by a fixed 80px inside a region that already starts below the
  header, and given a height measured against the whole window rather than the space it actually
  occupies. With the controls wrapped onto two rows the error grew. It's now measured from the real
  region and re-measured when the window changes, so the pane fits exactly and only scrolls when its
  own content is genuinely taller.
- **Settings looks like itself again** — moving the panel so it measures against the window (see
  below) also detached it from the app's own styling, and it came out as black text on a near-black
  card in the wrong font. It now carries its own colours and typography instead of borrowing the
  page's. Its dropdowns and boxes are dark too: most of them carry no colours of their own, so the
  browser was drawing them from its light palette — white boxes with black text on a near-black
  card, and dropdown lists that opened white behind pale text.
- **Settings scrolls by itself again** — reaching its top or bottom took a nudge of the page behind
  it. The panel positions itself against the window, but it's opened from a button in the header, and
  the header's frosted-glass effect quietly makes it the thing "against the window" means — so the
  panel hung from the header instead, and its height no longer matched the room it had. It's now
  attached to the page itself, where its own measurements are true.

- **Settings shows which build you're running** — right under the title, above the search box. The app
  updates itself, so "this still doesn't work" and "this still doesn't work because you're on an older
  build" looked identical from the outside; twice that has cost several rounds to untangle. Quote the
  build when something seems missing. The assistant knows it too, so you can just ask it.
- **Updating says what it actually installed** — the branch and commit, on every outcome. "You're
  already on the latest version" was unfalsifiable: a copy tracking a branch that never receives a
  change reports exactly that, indefinitely, while the fix you're waiting for sits somewhere else.
  Comparing the commit it reports against the build shown in Settings also separates "didn't
  download" from "didn't rebuild".
- **The update button finishes the job on a packaged build** — if you run the built app (the one
  desktop-prod.bat makes) rather than the development one, updating used to get you halfway: it
  pulled the code and rebuilt the web app, but the built app has that web app *compiled into it*, so
  nothing you could see actually changed until someone ran desktop-prod.bat again. Which meant
  remoting in. It now rebuilds the app itself and restarts into the new one — several minutes, with a
  note on screen telling you to leave it alone, and the window closes and reopens by itself at the
  end. If the rebuild fails, the app you had is put back exactly as it was and the message says what
  went wrong.
- **The update button now applies the build number by itself** — no closing and reopening. The build
  is recorded to a small file each time the app is built and read when it starts, instead of being
  baked into the build settings. Those settings are only read when the app's development server
  starts, and nothing the app can do restarts that server — so anything kept there was beyond the
  update button's reach by construction.
- **Settings warns when the window is older than your files** — if the code has been pulled and built
  but this window is still the one loaded beforehand, it now says so under the build number and tells
  you to reload. Previously the update button reported one build and Settings showed another, with
  nothing explaining the gap or which of the two was the problem.
- **Updates that change the build setup still tell you to restart** — that case is now rare rather
  than routine, and it's stated instead of silently not applying.

### Stories

- **A chat can now come into a story whole** — the story setup already offered to carry the current
  conversation, but it only used that conversation as hidden context for generating the next beat;
  the book itself stored just that one new reply, and a generation failure reduced even that to the
  final paragraph. Carrying now stores every reader and assistant message in the book first, followed
  by the generated continuation when one is available. The option says explicitly that it brings the
  full conversation; untick it to start fresh.

- **…and not in the story's title either** — the last place it was hiding, and the one that explains
  why it survived everything else: the title goes into every prompt the book ever renders, and a
  story titled from its opening premise carries that premise's weather with it. "A Rainy Night in
  Blackwater" rained on every later picture, indoors and months of story later, from a line nobody
  thinks of as a prompt at all. The weather word is removed and the rest of the title kept, so the
  picture still knows which world it's in.
- **You can choose how character descriptions reach the image model** (Settings → images) — where
  each person's appearance sits in the prompt changes how likely the model is to put one person's
  features on another, and which shape works best depends on the model. **Names + a description
  list** keeps the sentence clean with a glossary above it ("Nico = a man with a beard") and is the
  default for Flux.2 and friends. **Names with their description beside them** writes "Nico (a man
  with a beard) and Lyra (a woman with red hair) sit at a bar", so nothing has to be looked up.
  **Descriptions instead of names** drops the names entirely, and is the default for Stable
  Diffusion. If features keep landing on the wrong character, the middle one is the one to try — in
  testing it has come out noticeably more consistent than the default on Flux.2. The choice applies
  to every book and every image provider, so it can't quietly behave one way on one book and another
  way on the next.
- **A story keeps its own chat, and keeps it to itself** — what you type in the chat under a story
  becomes its next beat, and the assistant writes that beat from the conversation it can see. So the
  two have to be the same thing, and they weren't: starting a story made a fresh, clean chat for it,
  but nothing kept it there. Reopen the story from your library and you got whichever chat was last
  open; leave it running and a scheduled task, a task step or an idle exploration would switch the
  chat to its own. Whatever you wrote next was composed against THAT conversation — which is how
  unrelated material found its way into the prose. Each story now owns a chat, remembered across
  restarts and returned to whenever you open the book; and while a story is open, nothing in the
  background takes the chat away from it (anything due simply waits until you close the story).
- **Places and Creatures have their own windows now** — the Visual Bible keeps three lists and only
  the characters could be looked at, let alone corrected. The other two shape every picture just as
  surely: a place's description is what a scene set there is drawn from, and it's where the look and
  atmosphere of your world live. **Places** and **Creatures** buttons sit beside Characters in the
  book's toolbar, with the same search-and-fix panel — name, other names it's known by, and its
  description a detail per line. Saved instantly; existing images are kept until you re-render, same
  as characters. (Creatures only appears when the story has any.)
- **A person is described once, whichever of their names is used** — the description was attached per
  *word*, not per person, so someone mentioned by name and then by nickname ("Rell… the Captain",
  "Lyra… her Ghost Broker outfit") got their full head-to-toe description twice in one sentence.
  That reads as two people and is drawn as two people — which is where stray duplicate figures were
  coming from. The first mention now carries the description and every later one, by any name, is
  just the name.
- **An outfit's name belongs to the outfit** — the assistant records costume identities as nicknames
  as well as outfits, so "wears her Ghost Broker outfit" could resolve to a *person*. Outfit names
  are now reserved: no nickname can claim one, whether it belongs to the wearer or to somebody else,
  and the outfit's own description appears there instead — which is what it was for.
- **You can edit a character's nicknames** — they were shown as small "aka" text with no way to
  change them, which is the worst of both: visible enough to worry about, impossible to act on. A
  nickname is what makes a word in a prompt mean that person, so a wrong one silently puts their
  whole description wherever it appears. Character bible → the field under each name.
- **A character's description says what each part of it describes, once** — two things in how those
  descriptions were built were quietly working against keeping people apart. They were stored as bare
  adjectives and joined into a list — "male, short brown, beard" — where nothing says *what* is short
  and brown; meanwhile a phrase that does carry its noun, like "cybernetic eye", becomes the most
  attachable thing in the sentence and lands on whichever face the model finds most prominent. Each
  part now names its own subject ("short brown hair", "wide, expectant eyes") unless it already does,
  so a beard stays a beard rather than becoming "beard hair". And a feature recorded in two fields —
  "cybernetic eye" in one, "one cybernetic eye that whirs as it focuses" in the other — was being
  said twice, doubling its pull; it's now said once, in the more specific wording.
- **A name that owns something keeps its description on the right side of it** — "Nico's (a man with
  a beard) wrist" put the description between the owner and the thing owned, where it reads as
  describing the wrist. It's now "Nico (a man with a beard)'s wrist".
- **The world keeps its weather; people don't carry it around** — the first pass at the rain problem
  went too far and took the atmosphere with it: a beat whose prose is all dialogue had nothing left
  to say what the light and air were like, so consecutive pictures stopped agreeing about the world
  they were in. Weather now stays where it's genuinely a fact and is already scoped — a **place's**
  description (which only reaches a picture when that place is in it) and the **world facts** the
  app applies as defaults. What the world facts were missing wasn't the weather but the rest of the
  instruction: conditions are now described as reaching only as far as a scene can actually show
  them, so a rainy world reaches an indoor scene through a window and no further, and a passage that
  states its own conditions still wins. Weather is still removed from the things that follow a
  person around whatever the scene — appearance, outfits, the art-direction line, the title.
- **…and not in anyone's description either** — the same accumulation happens to people: a character
  first described in a downpour keeps "rain-plastered hair" in their appearance, an outfit recorded
  outdoors keeps "beaded with rain", and both then go into every picture they appear in, wherever
  it's set. Those are filtered.
- **A rainy opening no longer rains for the whole story** — the app keeps a list of "world facts" it
  applies to every illustration by default. That's right for the things it's for (what people
  customarily wear, the technology level, the materials) and wrong for weather: a story that opened
  in a downpour got rain recorded as a standing fact about its world, and from then on every prompt
  was written with rain in it, indoor scenes included. The setting you describe at the start now sets
  the opening scene, not the permanent conditions — weather that matters to a beat comes from that
  beat's own writing, as it should. (This is the third and last place weather was getting stuck; the
  other two were fixed alongside it.)
- **You can tell whether "lock this look" worked** — the button now shows a 📌 and a count once a
  character has locked looks, so the capture confirms itself where you click instead of sending you
  to the Character Bible to check. And in the Bible, a reference whose picture can't be loaded now
  says so with a retry, instead of showing the same dim "…" it shows while loading — which was
  indistinguishable from the capture having silently failed.
- **Every illustration will show you its prompt** — the "Full prompt" expander under a picture only
  appeared when hiding the machine scaffolding actually shortened the caption, so whether you could
  see an image's prompt depended on what happened to be in it. It's now always there. It also shows
  something truer: on a local engine the character descriptions, world style and quality tags are
  added inside the engine, *after* the app records the prompt — so what was labelled "as sent to the
  model" had never been sent, and was usually identical to the caption above it, which is why the
  expander so often wasn't offered. The engine now hands back the text it really used. (Pictures
  already painted keep the prompt they were saved with; repaint one to record the full version.) A
  page whose picture hasn't been painted yet says so, instead of quietly offering nothing.
- **"Scene continuity" no longer adds people to a picture that already knows its cast** — when a beat
  is too terse to name anyone ("she nods"), the app appends who and where to the illustration
  request, or the picture would be of strangers in nowhere. But it was doing that even when the
  illustration request already named people — adding everyone else it believed was in the scene, and
  those extra names got drawn. The tracked cast is who's in the *room* over the course of a beat; the
  request is who's in the *frame*, written by the part of the app that actually read the prose. The
  frame now wins: the names are only supplied when none were given. The setting is still always
  supplied, since naming who is present says nothing about where they are.
- **The weather stays in the scene it belongs to** — it was raining in every picture, indoors
  included, because one beat happened to mention rain. A place's description is built up chapter by
  chapter and the book's art-direction line is applied to every image, so "rain lashing the windows"
  became a permanent fact about the tavern, and "rain-slicked" sitting in the style line rained on
  the whole book. Nothing ever took it back out. Weather is now stripped from both — it lives in the
  scene's own description, where the assistant puts it anyway, so a scene that IS in the rain still
  renders in the rain.
- **Character regions no longer overlap** (experimental per-character weighting) — neighbouring
  columns were deliberately given a 6% overlap to blend the join between them. That band was the one
  place both characters' descriptions applied to the same pixels, which is the exact mixing the
  feature exists to prevent, sitting where two figures are most likely to meet — masculine and
  feminine features fused along the seam. The columns now tile exactly, in whole pixels, and if that
  can't be arranged the picture is rendered normally instead.
- **A story keeps its analysis, its prompts and its pictures when you reload** — sometimes a story
  came back from a reload with none of it. Each beat you send starts the assistant reading the one
  before it, and starting that reading cancelled whatever reading was already underway — which, in a
  story, is the previous beat, since the model writing the prose and the model doing the reading are
  the same one and queue behind each other. So a beat sent while the last one was still being read
  threw that work away and started again from the oldest unread beat. Keep talking at a normal pace
  and it never catches up: nothing gets read, so nothing is written down, and a reload finds a story
  with no scene breakdown, no illustration prompts and no images. New beats now join the reading
  already in progress instead of restarting it. (Re-reading the book on purpose — ↻ Redo → Story
  analysis — still cancels and starts over, which is what it's for.)
- **Being mentioned isn't being in the room** — a character merely *named* in a beat ("she remembered
  Rell's cybernetic eye") was added to the scene's cast even when the assistant's own record of that
  scene said they weren't there. Their description then went into the picture, where the image model
  attached their features to whoever actually was in frame — and because the cast carries forward
  through terse beats, one passing mention rode along scene after scene. Now only the scene's real
  cast counts, plus anyone the beat says explicitly *arrives*. When the assistant hasn't recorded a
  cast for a beat, mentions still stand in, since they're all there is to go on. The same now goes
  for the two characters being played in a role-play: they were held present in every beat on the
  grounds that chat dialogue rarely restates who's in the room, but that put them into pictures of
  scenes they'd walked out of. They're still assumed present through a beat the assistant hasn't
  described — just no longer in spite of one it has.
- **A scene's cast is who's actually in it, not everyone who has ever appeared** — the tracked cast
  only ever grew. It was built by adding whoever a beat mentioned, and the mechanism meant to remove
  people was never used by anything, so a character who walked past in beat three was still being
  drawn into beat thirty — name in the prompt, description and all. A dozen beats in, the picture was
  mostly a cast list and the actual scene had to compete with it. The assistant already records who is
  present in each scene when it plans the illustration; that's now what decides it, so people come and
  go with the story. A terse beat that names nobody still carries the previous cast forward, which was
  the point of the original design.
- **The setting moves when the story moves** — the current place was carried forward whenever the new
  one wasn't recognised yet, which is exactly what happens the first time you walk somewhere new: the
  assistant hasn't finished reading the beat that introduces it. So the previous location was being
  described into a picture of somewhere else. Naming a new place now clears the old one even before
  it's known, rather than quietly keeping it.

- **Every picture gets its own seed, instead of the whole book sharing one** — the reason a redo was
  reliably better than the first attempt. Each character carries a fixed number derived from their
  name, meant to keep them looking consistent, and that same number was being used as the random seed
  for *every* image they appear in — so a book was one draw from the lottery. A poor draw meant every
  first render was poor in the same way, and re-rolling each image by hand was the only escape:
  Redo picks a fresh random seed, which is exactly why it kept looking better. Each image now mixes
  its own position into that number. Re-rendering the same image still gives you the same picture, so
  nothing became unpredictable — but one unlucky number can't spoil a whole book any more. (Character
  consistency doesn't depend on this; it comes from the descriptions in the Visual Bible and from any
  look you've pinned with 📌.)
- **The first picture of a story is no longer the worst one** — it was being drawn from your soul
  notes, all of them, joined together and cut off at 200 characters: "I'm drawn to problems where the
  obvious answer is wrong; I find pure taxo" as a description of what someone LOOKS like. At the
  opening beat that's the only thing the image model has, because the assistant hasn't read enough of
  the story yet to work out anyone's appearance — which is why re-rendering the same picture a bit
  later came out so much better. Only the notes that actually describe a look are used now, whole
  notes rather than a sentence cut in half, and if none of them do, the character is left neutral
  instead of being drawn from a personality note. There's also more room than there was: a character's
  description used to be cut at 160 characters — under two lines, so "silver hair falling past the
  shoulders, sharp grey eyes, late forties, lean, wears a long charcoal coat" already filled it before
  reaching a scar or a skin tone, and the rest was dropped without a word. People now get twice that,
  and the soul's own limit matches it exactly, so nothing is trimmed twice by two different numbers.
  (Places and outfits keep the tighter limit — they're phrases.) (This also explains why the experimental
  per-character option seemed to make things worse: it was concentrating that same noise into each
  character's own part of the canvas.)

- **Each character can be weighted to their own part of the picture** — an experimental option (off
  by default, in Settings under Images, your own engine only) aimed at features migrating between
  people. With two to four described characters, each one's description is weighted towards the part
  of the canvas they occupy instead of all the descriptions being thrown at the whole image at once.
  The scene, setting and composition still come from the picture as a whole.
  The first version of this **made pictures worse** — figures came out misshapen and at mismatched
  sizes — because it cut the picture into boxes and drew each character to fill their box, so a whole
  person was being composed inside a narrow strip. It now weights the description towards an area
  instead of cutting anything, and it's off unless you ask for it. Try it on a scene you can compare
  against; if figures come out oddly proportioned, turn it back off and say so.
- **A firmer line between characters in the same picture** — with three or more people in frame, one
  person's hair or clothing could end up on another. The glossary the image model is given now says
  outright that each description belongs to that person only. This is a nudge, not a cure: mixing up
  features between subjects is a known weakness of every image model, and it gets worse with each
  person added. The usual remedy, a negative prompt per character, isn't available on Flux — it runs
  without the guidance mechanism negative prompts rely on, so anything put there is ignored.

- **A third character's face stops turning up on someone else** — with two characters in a scene, one
  of them could be drawn wearing a third character's features. Two separate causes, both fixed.
  - **A place named after somebody counted as that person being there.** A scene set in "Rell's
    Tavern" was read as a mention of Rell: he was resolved into the scene, listed among the characters
    for the picture, and his appearance went into it. Every name is now matched longest-first and each
    piece of the text belongs to the longest name covering it — so the tavern takes its own name, and
    Rell is only present when he's actually named. That works once the app knows the place, which it
    usually doesn't yet on the beat you first walk into it, so the phrasing itself is now read too: a
    name followed by 's and a capitalised word ("in Rell's Tavern") is naming somewhere, not someone.
    An ordinary possessive — "Rell's hand", "Rell's coat" — still means he's there, as it should, and
    naming him anywhere else in the same scene puts him in it regardless. Where the scene's place is
    written in a way that rule can't see (all lower case, or with no possessive at all), the app now
    passes the place it knows the beat is set in, which settles it outright. (This one applied to any
    illustrated book, not just stories.) The story's own cast tracker had the same loose name match,
    and that's the one that made it stick: it decides who is in the scene and CARRIES THAT FORWARD, so
    a single beat set in "Sato's Synthetic Noodles" put Sato in the picture and kept him there for
    every beat after it. It uses the same matcher as the rest now, and an existing story repairs
    itself when you reopen it — the tracked cast is worked out again from the beats rather than
    trusted from what was saved.
  - **Nicknames could claim other characters' names.** The assistant hands out nicknames as it writes,
    and they collide — one character picking up "the Captain" while another character IS the Captain.
    A name now belongs to the character whose name it is; a nickname only counts when it isn't
    somebody else's actual name. Genuinely shared nicknames that nobody owns still work as before.
- **A story you've already started in the chat can come with you** — "Story as you go" always began
  from a blank page, so a story that had been building up in conversation for half an hour was thrown
  away the moment you turned it into a real one. The setup now offers **"Continue what we've been
  telling in this chat"** (ticked by default when there's a conversation to carry), and the first beat
  picks up where you left off — same characters, same place, no recap and no rewind. The idea box
  becomes optional when you're carrying: that conversation is the premise. Untick it to begin
  something fresh, exactly as before. The chat you started from is untouched, and leaving the story
  returns you to it.

### Library

- **A book listed in your library always opens** — the list and the open button disagreed about what
  a book's id was (one read it off the record, the other off the key it was filed under), so a book
  filed under the wrong key sat in the list and did nothing when clicked, forever. It's now found
  anyway and quietly re-filed on the first open, so it opens normally from then on; Remove takes it
  too, instead of leaving the row behind. A book saved without an id of its own opens as well.
- **A book that won't open now says why** — clicking one that couldn't be opened did nothing at all:
  no message, no error, whatever the reason. Now it tells you, including the case where a book is
  listed but its saved copy isn't actually on the device.
- **Clicking the book you already have open shows it** instead of doing nothing — which read as the
  library being broken whenever it was open but hidden behind the chat.

### Scheduled actions

- **A scheduled action set up while working a task now belongs to that task** — and runs in that task's
  own chat, picking up its history and checklist, instead of starting cold in the shared ⏰ Scheduled
  window. Attaching it was previously left entirely to the assistant remembering to, which it usually
  didn't, so almost everything ended up in the one shared chat regardless of what it was for.
- **Every scheduled action says where it runs** — ⏰ Scheduled shows a "Runs on:" line on each action,
  naming the task it belongs to or the shared ⏰ Scheduled chat. It's always shown, including on the
  phone and when you have no tasks to attach to, so where an action runs is never something you have
  to infer.
- **You can move an existing action onto a task** — that "Runs on:" line is a picker. Actions created
  before this stay unattached, because nothing in them reliably says which task they belong to and
  guessing would be worse; this is how you attach them.
- **Only live tasks are offered to attach an action to** — the "Runs on:" picker listed every task
  ever created, including completed and deleted ones. Attaching an action to a finished task produces
  one that never runs. An action already attached to a finished task now says so in the picker
  instead of appearing unattached. The assistant is held to the same rule: if it tries to attach a
  new action to a task that's already done — easy to do by asking for a recurring check while still
  in that task's chat — it's left unattached and it tells you, rather than quietly creating something
  that will never fire.
- **The assistant is told where an action will run** when it schedules one, so it can say so — and
  notice when something meant for a task isn't attached to one.
- **Actions on a finished task stop running** — an action attached to a task you've completed, ignored
  or removed used to keep firing, reopening that task's chat to chase work that no longer mattered.
  It's skipped rather than cancelled, so reopening the task (or a repeating one coming round again)
  brings its checks straight back.

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

### Documents

- **Saving a document from the chat works, and tells you what happened** — the PDF and Word cards on a
  document from an earlier session had nothing to save: their contents are moved into storage when the
  chat is written to disk, and only a linked phone ever knew how to fetch them back. On the computer
  the button quietly wrote an empty file. It now retrieves the real contents; the Markdown card was
  always fine, since it carries its own text. The card also SAYS what happened now — "✓ Saved to …",
  or the actual error — where before every outcome, success or failure, looked identical: the chip
  flickered and nothing else changed. If the contents genuinely can't be found it refuses instead of
  writing an empty file.
- **Revising a document changes just that part, instead of rewriting the whole thing** — ask for a
  tightened intro or an extra section and the assistant now edits those lines in place. Before, every
  revision meant re-typing the entire document from scratch.
- **Lists inside a document update in place too** — a checklist, an attendance or RSVP list, a status
  per item: a changed answer overwrites that entry where it already sits, ticking its checkbox and
  keeping the list's formatting, rather than adding a second line for the same person further down.
  This is the same fix as the calendar one below, now available anywhere the assistant keeps a
  running list.
- **An edit that could mean more than one line changes nothing** — if what the assistant is aiming at
  matches several lines, it's shown those lines and asked to say which, instead of picking one. Two
  lines can start the same way without being duplicates ("Bo: brought chips" and "Bo: allergic to
  nuts"), and the old behaviour rewrote the first and deleted the rest — losing real content. Clearing
  out genuine duplicates is still possible, but it's now something the assistant does on purpose after
  reading them, not a side effect of a vague match.
- **Long documents stop losing their endings** — the assistant only ever held the first 8,000
  characters of the document it was working on (roughly 1,200 words), and the copy it had just
  trailed off with no indication there was more. So on anything longer, "revise this" quietly
  rebuilt the document out of the part it could see and threw away the rest. It can now read any part
  of a document on demand, it's told plainly when it's looking at an excerpt — including a list of
  every section, so it knows what's past the cut — and revisions apply to the real, whole document
  rather than to the excerpt. How much it holds at once now also scales with the model you're using
  instead of one fixed number.

### Files & editing

- **No more invented instructions for buttons that don't exist** — a file outside the folders the app
  may touch was refused with "pick the folder first (📁) or search for the file", which is advice for
  YOU but was being handed to the assistant, which can't see your screen. It passed it on and filled
  in the rest from imagination: click the folder icon, approve the folder in the window that pops up.
  There is no such window. Two changes: that refusal now tells the assistant to find the file itself —
  searching for a file approves its folder, which is exactly what it did, successfully, the moment it
  was told the instructions were made up — and it's now a standing rule that it must never walk you
  through clicking something it hasn't been told exists. When it can't fix something, it says what
  failed instead of inventing a fix.

- **Big files are now fully editable** — the assistant could only ever see a file's first 60,000
  characters, and since it edits by matching text exactly, anything past that was unreachable: it
  couldn't change what it couldn't read. It can now read any stretch of a file by line number, and is
  told where it stopped and how far the file goes, so it keeps reading until it has the part it needs.
  The old advice for long files was to run a shell command, which isn't available unless you've
  enabled it.
- **The assistant can edit spreadsheet cells from the main chat** — it could build you a sheet and then
  not touch it, so "make the margin column a formula" meant rebuilding the whole thing and losing
  anything you'd typed in since. Worse, it had been told it *could* edit cells from there, and those
  calls silently did nothing — so it would report a change that never happened. It can now set a cell,
  add a computed column, and read the sheet back with the cell references shown, all from the chat
  you're already in. It reads before it writes, so your own edits aren't overwritten.
- **A long-running task stops quietly losing its earliest notes** — accumulated task context is capped,
  and the cap used to cut mid-sentence, leaving a fragment that read like a real note with no sign
  anything had been lost. It now drops whole notes and says how many.

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

### Email

- **Drafts can be revised instead of re-written** — asking for a change to an email the assistant just
  drafted ("make it warmer", "add that I'll be late") had nowhere to go: it couldn't edit a draft, and
  the draft's id was never even handed back, so the only option was drafting again and leaving a
  second copy beside the first. It can now change part of a draft in place — the body, the subject,
  the recipients — leaving everything it doesn't mention untouched, and it can list your saved drafts
  to find one from an earlier conversation. Blind-copied recipients survive an edit, which they
  wouldn't have if the draft were simply rewritten. A draft it has open stays visible to it for the
  rest of the conversation, so a change asked for much later still edits that draft rather than
  starting a new one. And if it reaches for "new draft" anyway when the email is plainly the same one
  — same people, same subject — the app updates the draft you already have instead of leaving a second
  copy, and says that's what it did. A genuinely different email still drafts normally.
- **The assistant can see who an email was sent to** — To and Cc were never fetched or shown, so it
  could read a thread but not tell you who was on it, and couldn't answer "who hasn't replied yet".

### Calendar

- **A list kept on an event gets updated, not duplicated** — when the assistant tracks something on a
  calendar event (who's RSVP'd, what's packed, a status per person), a changed answer now overwrites
  that person's line where it already sits. Before, it could only add text to the bottom, so the event
  ended up saying both "Bo: ?" and "Bo: yes". It also no longer works from a shortened copy of the
  event's notes, which is how it came to write the same update in two places.

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
