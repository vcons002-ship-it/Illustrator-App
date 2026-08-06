import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * EVERY SURFACE THAT USES TOKENS MUST BE ABLE TO LOAD THEM.
 *
 * The extension mounts `ImagePanel` and `SettingsPanel` from @visual-reader/ui into an
 * arbitrary website. Those components now reference `var(--vr-*)`, so without the stylesheet
 * every colour in them resolves to nothing and the panel renders transparent on the host page
 * — a failure mode that no unit test in packages/ui would ever see, because there the tokens
 * are always present.
 *
 * This was a real bug: the stylesheet was wired into the web app's entry and the extension,
 * built separately, was left behind.
 */

const HERE = join(__dirname);
const content = readFileSync(join(HERE, "content.tsx"), "utf8");
const manifest = JSON.parse(readFileSync(join(HERE, "..", "manifest.json"), "utf8")) as {
  content_scripts: { js: string[]; css?: string[] }[];
};

describe("the extension can load the design tokens", () => {
  it("imports the shared stylesheet", () => {
    expect(content).toContain('@visual-reader/ui/styles.css');
  });

  it("declares that stylesheet in the manifest", () => {
    // A content script cannot inject a stylesheet by import alone — the bundler emits the file
    // and the manifest is what actually loads it. Importing without declaring builds a CSS file
    // that nothing ever reads, which looks identical to "the tokens didn't work".
    const script = manifest.content_scripts[0];
    expect(script?.css, "manifest declares no css for the content script").toBeTruthy();
    expect(script?.css?.length).toBeGreaterThan(0);
  });

  it("no longer carries its own copy of the keyframes", () => {
    // vr-pulse was DEFINED in App.tsx, CONSUMED in packages/ui, and duplicated here — three
    // places for one animation. It lives in styles/motion.css now.
    expect(content).not.toContain("@keyframes vr-pulse");
  });
});
