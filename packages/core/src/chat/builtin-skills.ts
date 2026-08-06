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

You can focus another application's window and send it real keystrokes and clicks. Nothing extra is
installed — this is the operating system's own automation, reached through \`run_command\`.

${PS_HOWTO}

## Windows

**Focus the window first.** Input goes wherever focus is, so this step is never optional:

\`\`\`powershell
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*Notepad*" } | Select-Object -First 1
if (-not $p) { Write-Output "not running"; exit 1 }
(New-Object -ComObject WScript.Shell).AppActivate($p.Id)
Start-Sleep -Milliseconds 300
\`\`\`

**Type text and press keys** with SendKeys. \`{ENTER}\` \`{TAB}\` \`{ESC}\` \`{F5}\` \`{UP}\` \`{DOWN}\`,
\`^c\` is Ctrl+C, \`%{F4}\` is Alt+F4, \`+\` is Shift. A literal \`+ ^ % ~ ( ) { }\` must be braced
(\`{+}\`):

\`\`\`powershell
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("Hello there{ENTER}")
\`\`\`

**Move and click the mouse** through user32:

\`\`\`powershell
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int i);
'@ -Name U -Namespace W
[W.U]::SetCursorPos(500, 400)
[W.U]::mouse_event(0x02, 0, 0, 0, 0)   # left button down
[W.U]::mouse_event(0x04, 0, 0, 0, 0)   # left button up
\`\`\`

**List what is open**, to find a window title or check something launched:
\`Get-Process | Where-Object MainWindowTitle | Select-Object Id, ProcessName, MainWindowTitle\`

**Start something and leave it up** with \`{"tool":"run_command","command":"…","detach":true}\` — the
normal form is killed when it finishes or times out, which would take a game or a server down with it.

## macOS

\`osascript\` does the same job and is usually cleaner:

\`\`\`bash
osascript -e 'tell application "Preview" to activate' \\
          -e 'tell application "System Events" to keystroke "s" using command down'
osascript -e 'tell application "System Events" to key code 36'   # Return
osascript -e 'tell application "System Events" to click at {500, 400}'
\`\`\`

Keystroke control needs Accessibility permission for the app sending them; if it silently does
nothing, that is why — tell the reader to grant it in System Settings → Privacy & Security.

## Rules that matter

- **Look after you act.** These are blind: nothing tells you the click landed. Take a
  \`screenshot\` (pass the \`window\` name) and check before sending more input.
- **Small steps.** A long keystroke string that drifts out of the intended field keeps typing into
  whatever is focused instead. Send a little, verify, continue.
- **Say what you are about to drive, first.** You are moving the reader's real mouse and keyboard;
  if they are using the machine, you will fight them for it.
- **Prefer a real interface where one exists.** A CLI, a file format, or an API beats keystrokes
  every time. For Word and Excel use the \`office-documents\` skill — far more reliable than typing
  into the window.`;

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

/**
 * The shipped playbooks. `at` is 0 — they were never "written", and must never sort as newer than
 * something the reader saved.
 */
export const BUILTIN_SKILLS: readonly Skill[] = [
  {
    name: "control-open-programs",
    description:
      "Drive a program that's already running on the reader's machine — focus its window, send real keystrokes/clicks, then screenshot to check",
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
