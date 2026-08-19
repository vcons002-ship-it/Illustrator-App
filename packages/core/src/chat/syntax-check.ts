/**
 * DOES THE FILE STILL PARSE? — asked automatically, after every change the app makes to source.
 *
 * The prompt already tells the model to check its work, and it sometimes does: one run in the wild
 * extracted a page's <script> block and put it through Node's parser, found the syntax error that
 * had killed the whole page, and reported PARSE OK afterwards. That was the model being diligent on
 * a good day. Every real coding harness does it on every day — Aider lints after each edit and hands
 * the errors straight back — because the alternative is a broken file that is not discovered until
 * the reader opens it and reports that nothing works.
 *
 * DELIBERATELY MODEST. This checks that a file PARSES, not that it is correct, and only for
 * languages where parsing is cheap, safe and needs no project setup. Nothing here executes the
 * file's own code: `node --check` parses and exits, `ast.parse` builds a tree, `new Function` compiles
 * a body without ever calling it. A check that ran the file would be a far worse idea than no check.
 *
 * A language with no cheap parser (TypeScript without tsc, CSS, Rust, Go) gets no check rather than a
 * bad one, and says nothing — a verification that is silently absent is better than one that is
 * silently wrong.
 */

/** What to run, and what to call it when reporting the outcome. */
export interface SyntaxCheck {
  command: string;
  /** Human/model-facing name of the checker, e.g. "node --check". */
  label: string;
}

/** Extension → how to parse it. `node`/`python` are the RESOLVED interpreter names (which vary:
 * python3, py, …), so this stays a pure function of what the host found. */
export function syntaxCheckFor(
  relPath: string,
  interpreters: { node?: string | undefined; python?: string | undefined },
): SyntaxCheck | undefined {
  const file = relPath.trim();
  // A path that needs quoting inside the one-liners below is a path this cannot check safely. Skipping
  // is the correct outcome: a mis-quoted command would report a syntax error in the wrong thing.
  if (!file || /["'`$\\]/.test(file)) return undefined;
  const ext = (file.split("/").pop() ?? "").split(".").pop()?.toLowerCase() ?? "";
  const node = interpreters.node;
  const python = interpreters.python;
  if (node && (ext === "js" || ext === "mjs" || ext === "cjs")) {
    return { command: `${node} --check "${file}"`, label: "node --check" };
  }
  if (node && (ext === "html" || ext === "htm")) {
    /**
     * A page's <script> is where a syntax error kills everything — the reported failure was exactly
     * this: one numeric literal split across two lines, and the whole page dead rather than one
     * button. `new Function` COMPILES the body and never calls it, so nothing in the page runs.
     *
     * No script at all is a pass, not a failure: plenty of pages are markup only.
     */
    const js =
      "const fs=require('fs');" +
      `const s=fs.readFileSync('${file}','utf8');` +
      "const m=[...s.matchAll(/<script\\b[^>]*>([\\s\\S]*?)<\\/script>/gi)].map(x=>x[1]).filter(x=>x.trim());" +
      "if(!m.length){console.log('no inline script to check');process.exit(0)}" +
      "try{m.forEach(b=>new Function(b));console.log('parsed '+m.length+' script block(s), '+m.reduce((n,b)=>n+b.length,0)+' chars')}" +
      "catch(e){console.error('SyntaxError: '+e.message);process.exit(1)}";
    return { command: `${node} -e "${js}"`, label: "inline <script> parse" };
  }
  if (python && (ext === "py" || ext === "pyw")) {
    // ast.parse rather than py_compile: same answer, and it does not litter the reader's folder with
    // a __pycache__ directory they never asked for.
    return {
      command: `${python} -c "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read());print('parsed ok')" "${file}"`,
      label: "python ast.parse",
    };
  }
  return undefined;
}

/** JSON is checked in the host — it needs no subprocess, and a parse error carries a position that
 * a command's exit code would throw away. Returns the complaint, or undefined when it is valid. */
export function jsonSyntaxError(relPath: string, text: string): string | undefined {
  if (!/\.(json|jsonc?)$/i.test(relPath)) return undefined;
  try {
    JSON.parse(text);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The model-facing line for a completed check. Kept short: this rides on every write, and a
 * paragraph of ceremony after each one would crowd a small window for no gain. */
export function syntaxCheckNote(label: string, ok: boolean, output: string): string {
  const tail = output.trim().slice(0, 600);
  return ok
    ? `\n[✓ ${label}: the file parses.${tail ? ` ${tail}` : ""}]`
    : `\n[✗ ${label}: THE FILE DOES NOT PARSE — you have just broken it.${tail ? `\n${tail}` : ""}\n` +
      `Fix it now with edit_file before doing anything else, and do not report this work as done.]`;
}
