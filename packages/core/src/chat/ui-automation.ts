/**
 * DRIVING ANOTHER PROGRAM'S CONTROLS — the middle rung of the ladder.
 *
 * Asked to click something in a program with no API, the honest options used to be keystrokes (blind)
 * or a mouse click at a guessed coordinate (blinder). Both were documented and neither works well: a
 * screenshot comes back to the model as a vision model's PROSE DESCRIPTION, so there is nothing in it
 * that says where a button is, and general vision models are poor at pixel-precise targeting anyway.
 *
 * Windows has a much better answer that costs nothing: UI AUTOMATION, the accessibility tree. Every
 * standard app — Win32, WinForms, WPF, UWP, Electron, browsers — publishes its controls with a name,
 * a type, an enabled flag and an exact rectangle, and most can be INVOKED directly without the mouse
 * moving at all. That turns "guess where Save is" into "list the controls, click the one called Save",
 * which is deterministic, and it leaves vision to do what vision is actually good at: telling us what
 * state we ended up in.
 *
 * So the ladder the assistant walks down is: a real API (COM, a CLI) → this → vision coordinates.
 *
 * WHY THE SCRIPT IS GENERATED HERE rather than written by the model. A playbook that says "write some
 * UIA PowerShell" is a playbook a small local model gets wrong every time — and the failure is silent,
 * because a script that finds nothing and a script with a typo both print nothing. These scripts are
 * fixed, tested, and take the reader's strings only through {@link psLiteral}. The model picks an
 * action and a target; it never writes PowerShell.
 *
 * WHY -EncodedCommand. The command crosses `cmd /C` (the Windows default shell) before PowerShell sees
 * it, so a script with quotes, newlines and `$` in it is mangled by two layers of parsing. UTF-16LE +
 * base64 has no metacharacters at all, so nothing downstream can misread it. It is also why this needs
 * no temp file: there is no quoting to escape from.
 *
 * Everything here is PURE — string in, string out — so it is testable without Windows, which matters
 * because none of it can be run in CI.
 */

/** What the model asked us to do to another program's UI. */
export type UiAction = "windows" | "controls" | "click" | "type" | "focus" | "click_point";

export interface UiAutomationCall {
  action: UiAction;
  /** Window title substring — which program. Required for everything except `windows`. */
  window?: string;
  /** Control name (or automation id) substring — which thing inside it. */
  target?: string;
  /** Text to type, for `type`. */
  text?: string;
  /** Raw screen coordinates, for `click_point` (the vision fallback). */
  x?: number;
  y?: number;
}

/** Most controls a window will ever publish; a big app has thousands and the model needs none of them. */
export const MAX_UI_CONTROLS = 120;

/**
 * Quote a string as a PowerShell SINGLE-quoted literal.
 *
 * Single quotes are PowerShell's only truly literal string: no `$` expansion, no backtick escapes, and
 * the sole escape is `''` for a quote. So this is total — there is no input that can break out of it,
 * which is the whole reason the model is allowed to pass a window title through at all. PURE.
 */
export function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The preamble every script shares: load UIA, fail loudly, and never let a progress bar pollute stdout. */
const PREAMBLE = [
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  "Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes | Out-Null",
].join("\n");

/** Find the top-level window whose title contains `window`, or print a usable error and stop.
 * Listing the real titles on a miss is deliberate: "no such window" is unactionable, and the model's
 * next move is always to guess again unless it can see what IS open. */
function findWindow(window: string): string {
  return [
    "$root=[Windows.Automation.AutomationElement]::RootElement",
    "$wins=$root.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)",
    `$needle=${psLiteral(window)}`,
    "$w=$null",
    "foreach($c in $wins){ if($c.Current.Name -and $c.Current.Name.ToLower().Contains($needle.ToLower())){ $w=$c; break } }",
    "if(-not $w){",
    "  $open=@(); foreach($c in $wins){ if($c.Current.Name){ $open+=$c.Current.Name } }",
    '  @{ error=("No window matches """+$needle+""". Open windows: "+($open -join " | ")) } | ConvertTo-Json -Compress; exit 1',
    "}",
  ].join("\n");
}

/** Walk the window's descendants for a control whose Name or AutomationId contains `target`. */
function findControl(target: string): string {
  return [
    `$t=${psLiteral(target)}`,
    "$all=$w.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)",
    "$el=$null",
    "foreach($c in $all){ $n=$c.Current.Name; $a=$c.Current.AutomationId;",
    "  if(($n -and $n.ToLower().Contains($t.ToLower())) -or ($a -and $a.ToLower() -eq $t.ToLower())){ $el=$c; break } }",
    "if(-not $el){",
    "  $names=@(); foreach($c in $all){ if($c.Current.Name -and $c.Current.IsEnabled){ $names+=$c.Current.Name } }",
    "  $names=$names | Select-Object -Unique -First 40",
    '  @{ error=("No control matches """+$t+""". Enabled controls: "+($names -join " | ")) } | ConvertTo-Json -Compress; exit 1',
    "}",
  ].join("\n");
}

/** user32 P/Invoke for the cases UIA can't do itself: a real mouse click at a point. */
const MOUSE = [
  "if(-not ('W.U' -as [type])){ Add-Type -MemberDefinition @'",
  '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int i);',
  "'@ -Name U -Namespace W }",
].join("\n");

/** Click at a screen point: move, press, release. */
function clickAt(xExpr: string, yExpr: string): string {
  return [
    MOUSE,
    `[W.U]::SetCursorPos([int]${xExpr}, [int]${yExpr})`,
    "Start-Sleep -Milliseconds 60",
    "[W.U]::mouse_event(0x02,0,0,0,0); [W.U]::mouse_event(0x04,0,0,0,0)",
  ].join("\n");
}

/**
 * The PowerShell for one call. PURE — no I/O, no Windows needed to build or test it.
 *
 * Each script prints ONE line of JSON and nothing else, so {@link parseUiAutomationOutput} never has
 * to guess which part of stdout was the answer.
 */
export function uiAutomationScript(call: UiAutomationCall): string {
  const win = (call.window ?? "").trim();
  const target = (call.target ?? "").trim();

  if (call.action === "windows") {
    return [
      PREAMBLE,
      "$out=@()",
      "foreach($p in Get-Process){ if($p.MainWindowTitle){ $out+=@{ pid=$p.Id; process=$p.ProcessName; title=$p.MainWindowTitle } } }",
      "@{ windows=$out } | ConvertTo-Json -Compress -Depth 4",
    ].join("\n");
  }

  if (call.action === "click_point") {
    return [
      PREAMBLE,
      clickAt(String(Math.round(call.x ?? 0)), String(Math.round(call.y ?? 0))),
      `@{ clicked=@{ x=${Math.round(call.x ?? 0)}; y=${Math.round(call.y ?? 0)} } } | ConvertTo-Json -Compress`,
    ].join("\n");
  }

  if (call.action === "focus") {
    return [
      PREAMBLE,
      findWindow(win),
      // SetFocus is the polite route and fails on some windows; AppActivate is the blunt one that
      // works when it doesn't. Try both rather than reporting success on a window that never came up.
      "try{ $w.SetFocus() }catch{ (New-Object -ComObject WScript.Shell).AppActivate($w.Current.ProcessId) | Out-Null }",
      "Start-Sleep -Milliseconds 250",
      "@{ focused=$w.Current.Name } | ConvertTo-Json -Compress",
    ].join("\n");
  }

  if (call.action === "controls") {
    return [
      PREAMBLE,
      findWindow(win),
      "$all=$w.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)",
      "$out=@(); $n=0",
      `foreach($c in $all){ if($n -ge ${MAX_UI_CONTROLS}){ break }`,
      "  $r=$c.Current.BoundingRectangle",
      // Nameless controls are layout containers; they are most of the tree and none of them are
      // clickable targets, so they would only crowd out the ones that are.
      "  if(-not $c.Current.Name){ continue }",
      "  $out+=@{ name=$c.Current.Name; type=($c.Current.ControlType.ProgrammaticName -replace '^ControlType\\.',''); enabled=$c.Current.IsEnabled;",
      "    x=[int]($r.X+$r.Width/2); y=[int]($r.Y+$r.Height/2) }",
      "  $n++ }",
      "@{ window=$w.Current.Name; controls=$out } | ConvertTo-Json -Compress -Depth 4",
    ].join("\n");
  }

  if (call.action === "type") {
    return [
      PREAMBLE,
      findWindow(win),
      findControl(target),
      `$text=${psLiteral(call.text ?? "")}`,
      "$vp=$null",
      // ValuePattern SETS the field — no focus race, no stray characters, and it replaces rather than
      // appending. SendKeys is the fallback for controls that don't publish it (rich text, canvases).
      "if($el.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$vp)){",
      "  $vp.SetValue($text); @{ typed=$text; into=$el.Current.Name; via='value' } | ConvertTo-Json -Compress",
      "} else {",
      "  try{ $el.SetFocus() }catch{}",
      "  Start-Sleep -Milliseconds 120",
      "  Add-Type -AssemblyName System.Windows.Forms",
      "  [System.Windows.Forms.SendKeys]::SendWait($text)",
      "  @{ typed=$text; into=$el.Current.Name; via='keys' } | ConvertTo-Json -Compress",
      "}",
    ].join("\n");
  }

  // click
  return [
    PREAMBLE,
    findWindow(win),
    findControl(target),
    "$ip=$null; $tp=$null; $sp=$null",
    // Invoke is a real activation: it works on a window that isn't focused, can't miss, and can't hit
    // whatever happens to be on top. Toggle and SelectionItem cover checkboxes and list/tab items,
    // which don't implement Invoke. Only when a control publishes none of them do we move the mouse.
    "if($el.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$ip)){",
    "  $ip.Invoke(); @{ clicked=$el.Current.Name; via='invoke' } | ConvertTo-Json -Compress",
    "} elseif($el.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$tp)){",
    "  $tp.Toggle(); @{ clicked=$el.Current.Name; via='toggle'; state=$tp.Current.ToggleState.ToString() } | ConvertTo-Json -Compress",
    "} elseif($el.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$sp)){",
    "  $sp.Select(); @{ clicked=$el.Current.Name; via='select' } | ConvertTo-Json -Compress",
    "} else {",
    "  try{ $w.SetFocus() }catch{}",
    "  $r=$el.Current.BoundingRectangle",
    "  if($r.Width -le 0 -or $r.Height -le 0){ @{ error=('Control '''+$el.Current.Name+''' is offscreen or has no size — scroll it into view first.') } | ConvertTo-Json -Compress; exit 1 }",
    clickAt("($r.X+$r.Width/2)", "($r.Y+$r.Height/2)"),
    "  @{ clicked=$el.Current.Name; via='mouse'; x=[int]($r.X+$r.Width/2); y=[int]($r.Y+$r.Height/2) } | ConvertTo-Json -Compress",
    "}",
  ].join("\n");
}

/** UTF-16LE + base64, which is what `powershell -EncodedCommand` wants. Written by hand rather than
 * with Buffer/btoa so core stays runtime-neutral (this runs in a worker AND under vitest in node). */
export function encodePowerShellCommand(script: string): string {
  const bytes = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += CHARS[a >> 2]! + CHARS[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < bytes.length ? CHARS[((b & 15) << 2) | (c >> 6)]! : "=";
    out += i + 2 < bytes.length ? CHARS[c & 63]! : "=";
  }
  return out;
}

/**
 * The full shell command for a call — what `run_command` executes.
 *
 * Windows PowerShell specifically (`powershell`, not `pwsh`): UIAutomationClient is a .NET Framework
 * assembly and ships with Windows, while PowerShell Core may not resolve it.
 */
export function uiAutomationCommand(call: UiAutomationCall): string {
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(uiAutomationScript(call))}`;
}

/**
 * A PNG's pixel size, read out of its own header. PURE.
 *
 * The bottom rung of the ladder asks a vision model for a COORDINATE, and a coordinate is meaningless
 * without the frame it was measured in — 740 could be most of the way across a 1080p window or a
 * quarter of the way across a 4K screen. The capture never carried its size, and adding it would have
 * meant changing Rust that cannot be compiled here; the PNG already knows.
 *
 * IHDR is fixed by the spec: 8-byte signature, 4-byte length, "IHDR", then width and height as
 * big-endian u32 at offsets 16 and 20.
 */
export function pngSize(bytes: ArrayBuffer | Uint8Array): { width: number; height: number } | undefined {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 24) return undefined;
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < SIG.length; i++) if (b[i] !== SIG[i]) return undefined;
  if (String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== "IHDR") return undefined;
  const u32 = (o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
  const width = u32(16);
  const height = u32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * The prompt for a `locate` screenshot — asking a vision model WHERE something is, not what it sees.
 *
 * Two things make the answer usable rather than decorative. The size is stated, so the model has a
 * frame to answer in (without it the numbers are unanchored). And it is told to say plainly when it
 * cannot find the thing — a vision model asked for coordinates will otherwise supply some, and a
 * confident wrong point is worse than no point, because the click still happens. PURE.
 */
export function locatePrompt(what: string, size?: { width: number; height: number }): string {
  return (
    `You are looking at a screenshot of the reader's screen${
      size ? `, ${size.width} pixels wide and ${size.height} tall` : ""
    }. Find: ${what}.\n` +
    "Reply with ONLY the centre point, as JSON: {\"x\": <pixels from the left>, \"y\": <pixels from the top>}. " +
    "Add nothing else.\n" +
    'If you cannot see it, or you are not confident where it is, reply exactly {"error":"not found"} — do NOT guess ' +
    "a point. A wrong coordinate gets clicked."
  );
}

/** One control the window published. */
export interface UiControl {
  name: string;
  type: string;
  enabled: boolean;
  /** Centre of its rectangle, in screen pixels — ready to click without further arithmetic. */
  x: number;
  y: number;
}

export interface UiAutomationResult {
  error?: string;
  windows?: { pid: number; process: string; title: string }[];
  window?: string;
  controls?: UiControl[];
  clicked?: string | { x: number; y: number };
  typed?: string;
  into?: string;
  focused?: string;
  via?: string;
  state?: string;
}

/**
 * Read the script's one JSON line out of stdout. PURE.
 *
 * Tolerant on purpose: PowerShell will happily print a warning above the payload, and `ConvertTo-Json`
 * emits an object for one item and an array for several, so the shapes are normalised here rather than
 * left for every caller to rediscover.
 */
export function parseUiAutomationOutput(stdout: string): UiAutomationResult {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith("{"));
  if (!line) return { error: "the UI automation script printed nothing — is this Windows?" };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { error: `couldn't read the UI automation result: ${line.slice(0, 200)}` };
  }
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v == null ? [] : [v as T]);
  const out: UiAutomationResult = {};
  if (typeof raw.error === "string") out.error = raw.error;
  if (raw.windows !== undefined) out.windows = arr(raw.windows);
  if (typeof raw.window === "string") out.window = raw.window;
  if (raw.controls !== undefined) out.controls = arr(raw.controls);
  if (raw.clicked !== undefined) out.clicked = raw.clicked as string | { x: number; y: number };
  if (typeof raw.typed === "string") out.typed = raw.typed;
  if (typeof raw.into === "string") out.into = raw.into;
  if (typeof raw.focused === "string") out.focused = raw.focused;
  if (typeof raw.via === "string") out.via = raw.via;
  if (typeof raw.state === "string") out.state = raw.state;
  return out;
}

/**
 * What the MODEL reads after a control_ui call.
 *
 * Every branch ends by naming the next move, because this tool's whole purpose is to be one step of a
 * loop: a list of controls is useless unless the model knows it can click one by name, and an action
 * that reports success without saying "now look" is how a run drifts three steps past a dialog it
 * never noticed. PURE.
 */
export function formatUiAutomationResult(call: UiAutomationCall, r: UiAutomationResult): string {
  if (r.error) {
    return (
      `[control_ui ${call.action} — FAILED]\n${r.error}\n` +
      "Use the names listed above verbatim; if none of them is what you want, take a screenshot to see " +
      "the window and work out what to do next."
    );
  }
  if (r.windows) {
    const list = r.windows.map((w) => `- ${w.title}  (${w.process}, pid ${w.pid})`).join("\n");
    return (
      `[control_ui windows — ${r.windows.length} open]\n${list || "(none with a visible window)"}\n` +
      'Pick one by a distinctive part of its title, then list its controls with {"tool":"control_ui","action":"controls","window":"…"}.'
    );
  }
  if (r.controls) {
    const rows = r.controls
      .map((c) => `- "${c.name}" [${c.type}${c.enabled ? "" : ", disabled"}] at ${c.x},${c.y}`)
      .join("\n");
    return (
      `[control_ui controls in "${r.window ?? call.window ?? ""}" — ${r.controls.length}${
        r.controls.length >= MAX_UI_CONTROLS ? " (capped)" : ""
      }]\n${rows || "(this window publishes no named controls — it likely draws its own UI, so use a screenshot and click_point)"}\n` +
      'Click one with {"tool":"control_ui","action":"click","window":"…","target":"<its name>"} — the name, not the coordinates.'
    );
  }
  if (r.focused) return `[control_ui focus — "${r.focused}" is now in front]`;
  if (r.typed !== undefined) {
    return (
      `[control_ui type — put "${r.typed}" into "${r.into ?? ""}"${r.via === "keys" ? " (by keystrokes, so check it landed)" : ""}]\n` +
      "Take a screenshot if the value mattering here isn't obvious from the next step."
    );
  }
  if (r.clicked !== undefined) {
    const what = typeof r.clicked === "string" ? `"${r.clicked}"` : `${r.clicked.x},${r.clicked.y}`;
    return (
      `[control_ui click — activated ${what}${r.via ? ` via ${r.via}` : ""}${r.state ? `, now ${r.state}` : ""}]\n` +
      // A click that reports success proves the CALL worked, never that the program did what you
      // wanted. This is the sentence that keeps a run honest.
      "That says the click was delivered, NOT that it did what you expected. Screenshot or re-list the " +
      "controls to see the new state before the next action."
    );
  }
  return `[control_ui ${call.action} — done]`;
}
