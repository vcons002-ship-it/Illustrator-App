import type { Skill } from "./skills.js";

/**
 * PLAYBOOKS THE APP SHIPS WITH — knowledge about how to use its own capabilities, rather than
 * anything the reader wrote.
 *
 * The skills store starts empty, so everything the assistant knows how to do has to be learned or
 * told. That is right for a reader's own conventions and wrong for the things the app can do and
 * nobody would ever guess: driving a running program, or editing the Word document that is open on
 * the reader's screen right now. Both are possible today, through a shell the app has had all
 * along, and neither has ever happened — the same shape as `run_command` being filed under "coding"
 * and therefore never reached for.
 *
 * A skill is the right home rather than more prompt text. The index costs one line each; the body —
 * which is long, exact, and mostly useless to any given conversation — loads only when a task
 * matches. The always-on prompt has no room left for either of these, and would not want them.
 *
 * MERGED AT READ TIME, never seeded (see `withBuiltinSkills`). Deliberately NOT added to
 * STARTER_SKILLS: that seeds once, and only into a store that is still empty, so every install that
 * has ever saved a skill — including every existing one — would never receive these. A capability
 * doc has to reach the installs that are already running.
 */

/** How to get a real PowerShell script to run from here. Shared by both Windows playbooks: they are
 * loaded independently, so each needs it, and getting the quoting wrong is the usual reason this
 * whole approach appears not to work. */
const PS_HOWTO = `**Run PowerShell properly.** \`run_command\` uses \`cmd /C\` on Windows unless the reader has
switched it to PowerShell, and multi-line script squeezed through \`powershell -Command "..."\` gets
mangled by two layers of quoting. So don't fight it — write the script to a file, then run the file:

1. \`write_file\` → \`drive.ps1\` (workspace folder; that is where commands start).
2. \`run_command\` → \`powershell -NoProfile -ExecutionPolicy Bypass -File drive.ps1\`

Its stdout/stderr/exit code come back to you, so \`Write-Output\` anything you need to see. Use
\`powershell\` and not \`pwsh\`: the COM and WinForms pieces below want Windows PowerShell.

\`run_command\`, \`write_file\` and \`screenshot\` live in the \`coding\` toolset — \`load_toolset\`
it if they aren't in front of you. This is desktop only; on a phone there is no shell to reach.`;

const APP_CONTROL = `# Driving a program that is already running

Work DOWN this ladder. Each rung is more reliable than the one below it, so never start lower than
you have to.

## 1. A real interface, if the program has one

Word and Excel have a full API — see the \`office-documents\` skill, which beats everything below for
those. Many programs have a command line, or read a file format you can simply write. A browser is
driven with \`browser_eval\`, not with clicks. Ask "is there a real way in?" before reaching for the
mouse. Usually there is.

## 2. control_ui — the accessibility tree

Windows publishes every control in a window: its name, its type, whether it is enabled, and where it
is. That is a real handle on the UI, not a picture of one.

\`\`\`json
{"tool":"control_ui","action":"windows"}
{"tool":"control_ui","action":"controls","window":"Notepad"}
{"tool":"control_ui","action":"click","window":"Notepad","target":"Save"}
{"tool":"control_ui","action":"type","window":"Notepad","target":"Text Editor","text":"hello"}
{"tool":"control_ui","action":"focus","window":"Calculator"}
\`\`\`

**Always list the controls before clicking.** The names it returns are the exact strings to pass back
as \`target\`, and seeing them tells you what state the window is in — a dialog that opened shows up
as new controls.

**Click by name, never by coordinate.** A named click activates the control directly: it works on a
window that isn't focused, it cannot miss, and it cannot hit whatever happens to be on top instead.

Works for almost anything with a normal interface — Win32, WinForms, WPF, UWP, Electron, browsers.

## 3. Vision, only when a window publishes nothing

Some windows draw their own interface and have no tree to read: games, canvas apps, some custom
software. \`controls\` comes back empty for those. Then, and only then:

\`\`\`json
{"tool":"screenshot","window":"My Game","locate":"the Start button"}
{"tool":"control_ui","action":"click_point","x":640,"y":380}
\`\`\`

A coordinate read off a picture is a GUESS. Screenshot again afterwards to see whether it landed, and
if the vision pass says it cannot find the thing, believe it — never click a made-up point.

For a keyboard-driven program this rung is often unnecessary: focus the window and send keys.

\`\`\`powershell
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
\`\`\`

\`{ENTER}\` \`{TAB}\` \`{ESC}\` \`{F5}\` \`{UP}\`; \`^c\` is Ctrl+C, \`%{F4}\` is Alt+F4, \`+\` is Shift; a
literal \`+ ^ % ~ ( ) { }\` must be braced. Games reading raw input (most real ones) ignore SendKeys
entirely — if nothing happens that is why, and say so rather than trying harder.

${PS_HOWTO}

## Starting a program

\`{"tool":"run_command","command":"…","detach":true}\` starts something and LEAVES it running. The
normal form is killed when it finishes or times out, which would take a game or a server down with
it. You get a pid back, not output.

## macOS

\`osascript\` covers rungs 2 and 3 together:

\`\`\`bash
osascript -e 'tell application "Preview" to activate'
osascript -e 'tell application "System Events" to keystroke "s" using command down'
osascript -e 'tell application "System Events" to click at {500, 400}'
\`\`\`

Keystroke control needs Accessibility permission for the app sending them. If it silently does
nothing, that is why — tell the reader to grant it in System Settings → Privacy & Security.

## Rules that matter

- **Look after you act.** \`control_ui\` reports that a click was DELIVERED, never that it did what
  you wanted. Re-list the controls, or screenshot, before the next action.
- **One action, then look.** Two actions off one observation is how a run ends up typing into a
  dialog it never saw.
- **Say what you are driving before you start.** This is the reader's real machine, and if they are
  using it you will fight them for the keyboard.
- **Stop and ask** when you cannot tell what state you are in, or when the next step looks
  destructive. Stopping is cheap; a wrong click on someone's live document is not.`;

const OFFICE_DOCUMENTS = `# Reading and editing Word / Excel — including the file open right now

You can talk to a RUNNING Office app and work on the document the reader is looking at, without
closing it or asking them to save. Attach to the live instance; only open a file when nothing is
running.

${PS_HOWTO}

## Attach to what is already open (Windows)

\`\`\`powershell
try   { $word = [Runtime.InteropServices.Marshal]::GetActiveObject("Word.Application") }
catch { Write-Output "Word is not running"; exit 1 }
$excel = [Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")
\`\`\`

That throws when the app isn't running. Handle it and SAY so — do not quietly \`New-Object\` a second
instance, because a second instance cannot see the reader's unsaved changes and the edit lands
nowhere they will look.

## Word — read, then edit

\`\`\`powershell
$doc = $word.ActiveDocument
$doc.Name; $doc.Paragraphs.Count
$doc.Content.Text                              # the whole text — read it before changing anything
$doc.Paragraphs(3).Range.Text                  # one paragraph
$doc.Paragraphs(3).Range.Text = "Replacement text."
$f = $doc.Content.Find
$f.Text = "old"; $f.Replacement.Text = "new"
$f.Execute([ref]$true) | Out-Null               # last arg true = replace all
$doc.Content.InsertParagraphAfter()
$doc.Save()                                     # or $doc.SaveAs2("C:\\path\\out.docx")
\`\`\`

## Excel — cells, ranges, formulas

\`\`\`powershell
$wb = $excel.ActiveWorkbook
$sheet = $wb.Worksheets.Item(1)
$sheet.UsedRange.Rows.Count; $sheet.UsedRange.Columns.Count
$sheet.Range("A1").Value2                       # one cell
$sheet.Range("A1:C10").Value2                   # a block, back as a 2-D array
$sheet.Range("B2").Value2 = 42                  # write
$sheet.Range("D2").Formula = "=SUM(A2:C2)"
$sheet.Cells.Item(3, 2).Value2                  # row, column
$wb.Save()
\`\`\`

To get a whole sheet into this conversation, the cheap route is often no COM at all: save/export it
as CSV and \`read_file\` the result.

## Nothing running? Open the file

\`\`\`powershell
$word = New-Object -ComObject Word.Application
$word.Visible = $true                           # let the reader watch; $false for headless work
$doc = $word.Documents.Open("C:\\path\\report.docx")
\`\`\`

Excel is the same with \`Excel.Application\` / \`$excel.Workbooks.Open(...)\`. If you opened it
headless, close it when you're done (\`$doc.Close()\`, \`$word.Quit()\`) or it lingers invisibly.

## macOS

AppleScript reaches the same objects:

\`\`\`bash
osascript -e 'tell application "Microsoft Word" to get content of text object of active document'
osascript -e 'tell application "Microsoft Excel" to get value of range "A1" of active sheet'
osascript -e 'tell application "Microsoft Excel" to set value of range "B2" of active sheet to 42'
\`\`\`

## Rules that matter

- **READ BEFORE YOU WRITE.** Print the text or the range first, and tell the reader what you are
  about to change. This hits their live document and there is no undo that you control.
- **Save only when asked.** Leaving it unsaved is a feature: the reader can look, and press Ctrl+Z.
- **One step at a time, and read the output.** COM errors are specific and worth relaying verbatim
  rather than retrying blind.
- **.docx/.xlsx with no Office running** is a different job — it's a zip of XML, so a command-line
  tool (pandoc, python-docx, openpyxl, duckdb over a CSV export) is usually simpler than automation.`;

/**
 * MOVED OUT OF THE ALWAYS-ON PROMPT. Both were carried on every turn — 1,683 characters of exact
 * syntax serving maybe one conversation in fifty — and both pass the test a skill has to pass: the
 * model KNOWS what kind of job it is on when it starts one, so a matching index line gets fetched in
 * time. (A routing rule or a negative capability would not: the model about to route wrong doesn't
 * know it needs a playbook. Those stayed in the prompt.)
 */
const DESIGNED_DOCUMENTS = `# A designed piece the app fills with pictures

For an invitation, flyer, poster, greeting card, menu or certificate — anything where the LAYOUT
matters and it needs images — write a COMPLETE styled HTML document in ONE \`\`\`html block, and mark
each picture you want generated with an \`<img>\` carrying a \`data-generate\` description:

\`\`\`html
<img data-generate="a friendly cartoon brontosaurus holding a baby bottle, soft pastel storybook
style, white background" alt="dino" width="320">
\`\`\`

The app then shows a "Generate N images & build" button that renders each one, embeds it, and hands
the reader a finished document to Preview and Save.

**Rules that matter**
- The description carries subject, art style, colours and mood, and MATCHES the piece's theme — it is
  the whole prompt the image model gets.
- No double quotes inside the description (it lives in a quoted attribute).
- Set \`width\`/\`height\` so the layout holds before the images exist.
- Write real CSS, real layout and real text around the images. A page that is only \`<img>\` tags is
  not a designed piece.
- One \`\`\`html block for the whole document, not one per section.`;

const MULTI_FILE_PROJECTS = `# Several files that link together

A site is \`index.html\` + \`styles.css\` + \`app.js\`; a script project has modules. Write each file in
its OWN fenced block and NAME it on the fence line, after the language:

\`\`\`\`
\`\`\`html index.html
\`\`\`css styles.css
\`\`\`js app.js
\`\`\`python src/main.py      ← a relative path is fine
\`\`\`\`

The app then offers a "Save all as project (.zip)" button that keeps the whole set, folder structure
and all, in one archive.

**The mistake to avoid.** CLOSE each block with \`\`\` and OPEN a new fence for the next file. Writing
the next file's name on a line INSIDE the block you are already in does NOT start a new file — it
puts a stray line in the middle of the current one. Asked for three haikus as three documents, this
is exactly what happened: three files reached the reader as one card. One fence per file, always.

**Make them work together.** Reference the files by those exact names — \`<link href="styles.css">\`,
\`<script src="app.js">\`, \`from utils import x\` — so the saved project runs as-is.

**When the reader will KEEP or RUN it**, prefer \`write_file\` into the workspace over fenced blocks:
a file on disk can be re-read, edited and executed, while a big fenced block truncates and drops out
of your context. Fences are for a set the reader wants handed to them.`;

const LOCAL_MODELS = `# The AI models downloaded on this computer

The local models this app talks to are managed by **Ollama**, through its \`ollama\` command. Every
answer below is a \`run_command\` away — desktop only, and \`run_command\` lives in the \`coding\`
toolset, so \`load_toolset\` it if it isn't in front of you.

## The four commands

\`\`\`
ollama list          # every model on disk: NAME, ID, SIZE, MODIFIED
ollama ps            # what is loaded in memory RIGHT NOW, and when it unloads
ollama show <name>   # a model's parameters, context length, quantization, license
ollama rm <name>     # delete it and reclaim its disk
\`\`\`

Names include the tag, and the tag is part of the identity: \`qwen3:8b\` and \`qwen3:8b-q4_K_M\` are two
separate downloads. Copy the NAME column from \`ollama list\` verbatim — \`ollama rm qwen3\` removes
\`qwen3:latest\` and nothing else, which is the usual reason "I deleted it and the space didn't come
back".

## Deleting: \`ollama rm\` is the only way

Look for the files and you will not find them. Ollama stores models **content-addressed**, not as
\`.gguf\` files you can pick out of a folder:

\`\`\`
<models>/manifests/registry.ollama.ai/library/<model>/<tag>   # a small JSON file listing digests
<models>/blobs/sha256-<64 hex chars>                          # the actual weights, unnamed
\`\`\`

where \`<models>\` is \`%USERPROFILE%\\.ollama\\models\` on Windows, \`~/.ollama/models\` on macOS, and on
Linux \`~/.ollama/models\` or \`/usr/share/ollama/.ollama/models\` when it runs as the system service.
An \`OLLAMA_MODELS\` environment variable overrides all of these — check it before believing a path.

**Blobs are SHARED.** Two tags of one model, or a model and a fine-tune of it, commonly point at the
same layers, and a blob is only freed when the last manifest referencing it goes. So:

- Deleting a blob by hand silently corrupts every other model that referenced it, and the damage
  shows up later as a load failure with no obvious cause. Never do it.
- \`ollama rm\` removes the manifest and then the blobs nothing else needs. It is the ONLY safe
  delete, and it is why "how much will I get back?" has no answer before the fact — \`SIZE\` in
  \`ollama list\` counts shared layers once per model.

To measure the real total on disk, size the models directory itself (\`du -sh\` / PowerShell
\`Get-ChildItem -Recurse | Measure-Object -Sum Length\`), not the sum of the SIZE column.

## Before you remove anything

Deleting is not undoable — the model has to be downloaded again, which is minutes to hours.

1. Run \`ollama list\` and SHOW the reader the list first.
2. Say which exact names you are about to remove and how big they are, and let them confirm.
3. Check the model the app is currently set to use for chat (and \`ollama ps\` for what is loaded).
   Removing the model that is answering right now leaves the chat unable to reply until another one
   is picked in Settings — say so plainly rather than doing it quietly.

## Getting one back, or getting a new one

\`ollama pull <name>\` downloads it; \`ollama list\` afterwards confirms it landed. If \`ollama\` isn't a
recognised command at all, Ollama either isn't installed or isn't on PATH — say that rather than
reporting the models as missing.`;

/**
 * The shipped playbooks. `at` is 0 — they were never "written", and must never sort as newer than
 * something the reader saved.
 */
export const BUILTIN_SKILLS: readonly Skill[] = [
  {
    name: "control-open-programs",
    description:
      "Drive a program that's already running on the reader's machine — find its real controls by name and click or type into them, then check",
    body: APP_CONTROL,
    at: 0,
  },
  {
    name: "office-documents",
    description:
      "Read and edit a Word document or Excel workbook the reader has OPEN right now (live, unsaved), or a file on disk",
    body: OFFICE_DOCUMENTS,
    at: 0,
  },
  // The DESCRIPTION is the trigger, and it is all the model reads before deciding to load the body —
  // so it is written in the words a REQUEST would use ("invitation, flyer, poster") rather than the
  // words the feature uses. The `coding` toolset trigger saying "coding" is why the shell went
  // unused for months; this is the same lesson, applied before it costs anything.
  {
    name: "designed-documents",
    description:
      "Make an invitation, flyer, poster, greeting card, menu or certificate — a laid-out page the app generates the pictures for",
    body: DESIGNED_DOCUMENTS,
    at: 0,
  },
  // Written in the words the ASK arrives in — "how much space", "delete the model", "which models
  // do I have" — because the reader hits this at the point of running out of disk, not while
  // thinking about Ollama. The body exists mostly to stop one specific wrong answer: hunting for
  // `.gguf` files to delete, which the storage layout makes both impossible and destructive.
  {
    name: "manage-local-models",
    description:
      "See which AI models are downloaded on this computer, how much space they take, and delete the ones the reader doesn't want",
    body: LOCAL_MODELS,
    at: 0,
  },
  {
    name: "multi-file-projects",
    description:
      "Write a set of files that link together (a website, a script project with modules) so the reader can save the whole project",
    body: MULTI_FILE_PROJECTS,
    at: 0,
  },
];

/**
 * The reader's skills plus the shipped ones — for the always-on index and for `read_skill`.
 *
 * Merged at READ time and never persisted: the store holds only what the reader (or the model)
 * saved, so `forget` cannot delete a built-in and a `read_skill` cannot copy one in. A stored skill
 * of the same name WINS — if someone has written their own `office-documents`, theirs is what
 * applies, because a shipped default should never override what a reader chose to keep. PURE.
 */
export function withBuiltinSkills(stored: readonly Skill[]): Skill[] {
  const taken = new Set(stored.map((s) => s.name.trim().toLowerCase()));
  return [...stored, ...BUILTIN_SKILLS.filter((b) => !taken.has(b.name))];
}
