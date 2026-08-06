import { describe, expect, it } from "vitest";
import {
  MAX_UI_CONTROLS,
  encodePowerShellCommand,
  formatUiAutomationResult,
  locatePrompt,
  parseUiAutomationOutput,
  pngSize,
  psLiteral,
  uiAutomationCommand,
  uiAutomationScript,
} from "./ui-automation.js";

/** Decode an -EncodedCommand payload back to the script, the way PowerShell would. */
function decode(command: string): string {
  const b64 = /-EncodedCommand (\S+)/.exec(command)![1]!;
  const bin = Buffer.from(b64, "base64");
  let out = "";
  for (let i = 0; i < bin.length; i += 2) out += String.fromCharCode(bin[i]! | (bin[i + 1]! << 8));
  return out;
}

describe("psLiteral", () => {
  it("wraps in single quotes, where nothing expands", () => {
    expect(psLiteral("Notepad")).toBe("'Notepad'");
    // $ and ` are literal inside single quotes — this is why the model is allowed to pass a title.
    expect(psLiteral("$env:PATH `n")).toBe("'$env:PATH `n'");
  });

  it("escapes the ONE character that could break out", () => {
    expect(psLiteral("it's")).toBe("'it''s'");
    // The classic injection attempt: close the quote, run something, reopen.
    expect(psLiteral("'; Remove-Item C:\\ -Recurse; '")).toBe("'''; Remove-Item C:\\ -Recurse; '''");
  });
});

describe("encodePowerShellCommand", () => {
  it("round-trips through UTF-16LE base64", () => {
    const script = 'Write-Output "héllo"\n$x = 1 + 2';
    expect(decode(`-EncodedCommand ${encodePowerShellCommand(script)}`)).toBe(script);
  });

  it("pads correctly at every length (the classic base64 off-by-one)", () => {
    for (const s of ["a", "ab", "abc", "abcd", "abcde"]) {
      expect(decode(`-EncodedCommand ${encodePowerShellCommand(s)}`)).toBe(s);
    }
  });
});

describe("uiAutomationCommand", () => {
  it("carries the script with no shell metacharacters left in it", () => {
    const cmd = uiAutomationCommand({ action: "click", window: "Notepad", target: "Save" });
    expect(cmd.startsWith("powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ")).toBe(true);
    // The point of encoding: a command that survives `cmd /C` untouched. Anything cmd could act on
    // — quotes, &, |, >, newlines — must be gone.
    expect(/["'&|<>^\n]/.test(cmd)).toBe(false);
  });

  it("uses Windows PowerShell, not pwsh (UIAutomationClient is .NET Framework)", () => {
    expect(uiAutomationCommand({ action: "windows" })).toMatch(/^powershell /);
  });

  it("a hostile window title stays inside its quotes", () => {
    const script = decode(uiAutomationCommand({ action: "focus", window: "'; calc; '" }));
    expect(script).toContain("$needle='''; calc; '''");
    // No unescaped break-out: the injected text never becomes its own statement.
    expect(script).not.toMatch(/^\s*calc;/m);
  });
});

describe("uiAutomationScript", () => {
  it("lists windows without needing UIA at all", () => {
    const s = uiAutomationScript({ action: "windows" });
    expect(s).toContain("MainWindowTitle");
    expect(s).toContain("ConvertTo-Json");
  });

  it("caps how many controls it will report", () => {
    const s = uiAutomationScript({ action: "controls", window: "Excel" });
    expect(s).toContain(`if($n -ge ${MAX_UI_CONTROLS})`);
    // Nameless layout containers are most of a real tree and none of them are targets.
    expect(s).toContain("if(-not $c.Current.Name){ continue }");
  });

  it("reports each control's CENTRE, so a coordinate is usable without more arithmetic", () => {
    const s = uiAutomationScript({ action: "controls", window: "Notepad" });
    expect(s).toContain("x=[int]($r.X+$r.Width/2)");
  });

  it("clicks by pattern first and only falls back to the mouse", () => {
    const s = uiAutomationScript({ action: "click", window: "Notepad", target: "Save" });
    const invoke = s.indexOf("InvokePattern");
    const toggle = s.indexOf("TogglePattern");
    const select = s.indexOf("SelectionItemPattern");
    const mouse = s.indexOf("mouse_event");
    // Invoke works on an unfocused window and cannot hit the wrong thing; the mouse can do both.
    expect(invoke).toBeGreaterThan(-1);
    expect(toggle).toBeGreaterThan(invoke);
    expect(select).toBeGreaterThan(toggle);
    expect(mouse).toBeGreaterThan(select);
  });

  it("refuses to mouse-click a control with no size instead of clicking 0,0", () => {
    const s = uiAutomationScript({ action: "click", window: "App", target: "Hidden" });
    expect(s).toContain("$r.Width -le 0");
    expect(s).toContain("offscreen");
  });

  it("types with ValuePattern when it can, keystrokes when it can't", () => {
    const s = uiAutomationScript({ action: "type", window: "Notepad", target: "Edit", text: "hi" });
    expect(s).toContain("ValuePattern");
    expect(s).toContain("SendKeys");
    expect(s).toContain("$text='hi'");
  });

  it("lists what IS open when the window isn't found", () => {
    // "No such window" with no alternatives just makes the model guess again.
    const s = uiAutomationScript({ action: "focus", window: "Nope" });
    expect(s).toContain("Open windows: ");
  });

  it("lists the enabled control names when the target isn't found", () => {
    const s = uiAutomationScript({ action: "click", window: "W", target: "Nope" });
    expect(s).toContain("Enabled controls: ");
  });

  it("rounds click_point coordinates (a fractional pixel is a PowerShell cast error)", () => {
    const s = uiAutomationScript({ action: "click_point", x: 10.7, y: 20.2 });
    expect(s).toContain("SetCursorPos([int]11, [int]20)");
    expect(s).not.toContain("10.7");
  });
});

describe("parseUiAutomationOutput", () => {
  it("reads the JSON line even with noise above it", () => {
    const r = parseUiAutomationOutput('WARNING: something\n{"focused":"Notepad"}\n');
    expect(r.focused).toBe("Notepad");
  });

  it("normalises PowerShell's one-item-is-an-object quirk", () => {
    // ConvertTo-Json emits a bare object for one element and an array for several. Callers must not
    // have to know that.
    const one = parseUiAutomationOutput('{"controls":{"name":"Save","type":"Button","enabled":true,"x":1,"y":2}}');
    expect(one.controls).toHaveLength(1);
    expect(one.controls![0]!.name).toBe("Save");
    const many = parseUiAutomationOutput('{"controls":[{"name":"A"},{"name":"B"}]}');
    expect(many.controls).toHaveLength(2);
  });

  it("takes the LAST JSON line, so a chatty preamble can't win", () => {
    const r = parseUiAutomationOutput('{"error":"old"}\n{"focused":"Real"}');
    expect(r.focused).toBe("Real");
    expect(r.error).toBeUndefined();
  });

  it("says something usable when the script printed nothing or junk", () => {
    expect(parseUiAutomationOutput("")).toMatchObject({ error: expect.stringContaining("printed nothing") });
    expect(parseUiAutomationOutput("{not json")).toMatchObject({ error: expect.stringContaining("couldn't read") });
  });
});

describe("pngSize", () => {
  /** A minimal but REAL PNG header: signature, IHDR length, tag, then width/height big-endian. */
  const png = (w: number, h: number): Uint8Array => {
    const b = new Uint8Array(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    b.set([0, 0, 0, 13], 8);
    b.set([73, 72, 68, 82], 12); // "IHDR"
    new DataView(b.buffer).setUint32(16, w);
    new DataView(b.buffer).setUint32(20, h);
    return b;
  };

  it("reads the size out of the header", () => {
    expect(pngSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it("handles a 4K screen without the sign bit flipping it negative", () => {
    // A naive `<< 24` makes anything past 2^31 negative; 3840 is safe but the shift must still be
    // unsigned for the general case.
    expect(pngSize(png(3840, 2160))).toEqual({ width: 3840, height: 2160 });
  });

  it("returns undefined for anything that isn't a PNG", () => {
    expect(pngSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(pngSize(new Uint8Array(24))).toBeUndefined(); // right length, wrong signature
    const noIhdr = png(10, 10);
    noIhdr[12] = 0;
    expect(pngSize(noIhdr)).toBeUndefined();
  });

  it("accepts an ArrayBuffer too (what the capture hands back)", () => {
    expect(pngSize(png(800, 600).buffer as ArrayBuffer)).toEqual({ width: 800, height: 600 });
  });
});

describe("locatePrompt", () => {
  it("states the frame the coordinates are measured in", () => {
    const p = locatePrompt("the Save button", { width: 1920, height: 1080 });
    expect(p).toContain("1920 pixels wide and 1080 tall");
    expect(p).toContain("the Save button");
  });

  it("gives the model a way to say it doesn't know", () => {
    // Asked for coordinates, a vision model will supply some. A confident wrong point is worse than
    // none, because the click happens anyway.
    expect(locatePrompt("x")).toContain('{"error":"not found"}');
    expect(locatePrompt("x")).toMatch(/do NOT guess/);
  });

  it("works without a known size rather than printing 'undefined'", () => {
    expect(locatePrompt("x")).not.toContain("undefined");
  });
});

describe("formatUiAutomationResult", () => {
  it("a click reports DELIVERY, and says so — never success", () => {
    const out = formatUiAutomationResult(
      { action: "click", window: "Notepad", target: "Save" },
      { clicked: "Save", via: "invoke" },
    );
    expect(out).toContain("activated \"Save\"");
    // The sentence that stops a run walking three steps past a dialog it never noticed.
    expect(out).toMatch(/NOT that it did what you expected/);
  });

  it("a control list tells the model to click BY NAME", () => {
    const out = formatUiAutomationResult(
      { action: "controls", window: "Notepad" },
      { window: "Untitled - Notepad", controls: [{ name: "Save", type: "Button", enabled: true, x: 10, y: 20 }] },
    );
    expect(out).toContain('"Save" [Button] at 10,20');
    expect(out).toContain("the name, not the coordinates");
  });

  it("an empty control list routes to the vision rung instead of dead-ending", () => {
    const out = formatUiAutomationResult({ action: "controls", window: "Game" }, { window: "Game", controls: [] });
    expect(out).toContain("draws its own UI");
    expect(out).toContain("click_point");
  });

  it("a failure hands back the names it DID find", () => {
    const out = formatUiAutomationResult(
      { action: "click", window: "W", target: "Nope" },
      { error: 'No control matches "Nope". Enabled controls: Save | Cancel' },
    );
    expect(out).toContain("Save | Cancel");
    expect(out).toContain("verbatim");
  });

  it("flags a keystroke-typed value as needing a check", () => {
    const keys = formatUiAutomationResult({ action: "type" }, { typed: "hi", into: "Edit", via: "keys" });
    expect(keys).toContain("check it landed");
    const value = formatUiAutomationResult({ action: "type" }, { typed: "hi", into: "Edit", via: "value" });
    expect(value).not.toContain("check it landed");
  });
});
