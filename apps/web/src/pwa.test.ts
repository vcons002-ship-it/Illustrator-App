import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * INSTALLING THE PHONE CLIENT AS A REAL APP.
 *
 * Chrome offers "Install and create shortcut" on every page, regardless of whether the page
 * supports it — so the presence of that menu entry proved nothing, and the app looked like it
 * already had this. What it actually produced was a bookmark: a Chrome-badged icon opening in a tab
 * with the address bar still there. Every assertion here is about the difference between that and a
 * real installed app, and each one is a single line that silently un-installs the app if it goes.
 */

const WEB = join(__dirname, "..");
const html = readFileSync(join(WEB, "index.html"), "utf8");
const manifestPath = join(WEB, "public", "manifest.webmanifest");

describe("the phone client can be installed", () => {
  it("declares a manifest at all — without one Chrome makes a bookmark, not an app", () => {
    expect(html).toMatch(/<link[^>]+rel="manifest"/);
    expect(existsSync(manifestPath), "the manifest is linked but not shipped").toBe(true);
  });

  it("asks for its own window, which is the entire point", () => {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    // Anything other than standalone/fullscreen still shows the browser's address bar — the bar
    // whose hiding and showing resizes the viewport on every frame of a scroll.
    expect(["standalone", "fullscreen"]).toContain(m.display);
    expect(m.name, "an unnamed app installs as the bare hostname").toBeTruthy();
    expect(m.start_url).toBeTruthy();
  });

  it("ships every icon it promises, at the sizes Android actually requires", () => {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      icons: { src: string; sizes: string; purpose?: string }[];
    };
    for (const icon of m.icons) {
      expect(existsSync(join(WEB, "public", icon.src.replace(/^\//, ""))), `${icon.src} is missing`).toBe(
        true,
      );
    }
    const sizes = m.icons.map((i) => i.sizes);
    // Chrome refuses to install without both, and says so only in a console warning nobody reads.
    expect(sizes, "no 192px icon — Chrome will not offer to install").toContain("192x192");
    expect(sizes, "no 512px icon — Chrome will not offer to install").toContain("512x512");
    // Android crops an icon to a circle or a squircle. Without a maskable variant it crops the
    // ordinary one and takes the edges of the artwork with it.
    expect(m.icons.some((i) => i.purpose === "maskable"), "no maskable icon").toBe(true);
  });

  it("does not letterbox a maskable icon inside its own mask", () => {
    // A maskable icon needs its CONTENT within the safe zone — but the app's icon is a solid fill,
    // which has no content to lose. Padding it produced a small square floating in a dark circle on
    // the launcher. This asserts the icon reaches its own corners, which is where a mask cuts.
    const png = readFileSync(join(WEB, "public", "icon-maskable-512.png"));
    // IHDR: width and height are the two 4-byte big-endian ints at offset 16.
    expect(png.readUInt32BE(16), "maskable icon is not 512px").toBe(512);
    expect(png.readUInt32BE(20)).toBe(512);
    expect(png.length, "a letterboxed icon carries a second colour and is far larger").toBeLessThan(3000);
  });

  it("covers the notch, or the safe-area insets are all zero", () => {
    // env(safe-area-inset-*) only reports anything when the page is allowed under the bars in the
    // first place. Without this the browser letterboxes the page and the dock's inset does nothing.
    expect(html).toMatch(/viewport-fit=cover/);
  });

  it("paints the browser's own chrome, which needs no install", () => {
    // The one thing here that helps TODAY, on the existing link: without it a white bar sits above
    // a near-black app.
    expect(html).toMatch(/<meta[^>]+name="theme-color"/);
  });

  it("says the iOS words too, which are not the standard ones", () => {
    expect(html).toMatch(/name="apple-mobile-web-app-capable"/);
    expect(html).toMatch(/rel="apple-touch-icon"/);
  });
});

describe("the installed shortcut carries the pairing", () => {
  const engine = readFileSync(join(WEB, "src", "useEngineWorker.ts"), "utf8");

  /**
   * The manifest's start_url is a bare "/", which relies on the phone still having the token in
   * storage. True on Android, false on iOS (an installed app gets its own jar) and false after site
   * data is cleared — and the failure is silent: the icon opens a local app with no link, which is
   * exactly what the token-persistence code goes to such lengths to avoid elsewhere in this file.
   */
  it("points the manifest at the token it already holds", () => {
    expect(engine).toContain("pointManifestAtThisPairing");
    const fn = /function pointManifestAtThisPairing[\s\S]*?\n}/.exec(engine)?.[0] ?? "";
    expect(fn, "pointManifestAtThisPairing not found").toBeTruthy();
    expect(fn, "the manifest link is never rewritten").toMatch(/rel="manifest"/);
    expect(fn).toMatch(/vrlink/);
  });

  it("is called with the token, not before it is known", () => {
    // Above the call, initRemoteMode has already returned early for every path that has no token —
    // so a desktop visitor, who has no pairing at all, never rewrites anything.
    const init = /function initRemoteMode\(\)[\s\S]*?\n}/.exec(engine)?.[0] ?? "";
    expect(init).toContain("pointManifestAtThisPairing(token)");
    const guardAt = init.indexOf("if (!token || !host) return undefined;");
    expect(guardAt, "the no-token guard moved").toBeGreaterThan(-1);
    expect(init.indexOf("pointManifestAtThisPairing(token)")).toBeGreaterThan(guardAt);
  });
});

describe("the dock clears the home indicator", () => {
  it("owns its padding in CSS, so the safe-area inset is not overridden", () => {
    // The cascade trap, for the fourth time: an inline `padding` beats the class that adds the
    // inset, and the bar would sit under the swipe indicator with nothing to show for the change.
    const app = readFileSync(join(WEB, "src", "App.tsx"), "utf8");
    const dock = /\n {2}chatDock: \{([\s\S]*?)\n {2}\},/.exec(app)?.[1] ?? "";
    expect(dock, "styles.chatDock not found").toBeTruthy();
    expect(dock, "styles.chatDock still sets padding inline, which beats .vr-dock").not.toContain(
      "padding",
    );

    const layout = readFileSync(
      join(WEB, "..", "..", "packages", "ui", "src", "styles", "layout.css"),
      "utf8",
    );
    const rule = /\.vr-dock \{([\s\S]*?)\n\}/.exec(layout)?.[1] ?? "";
    expect(rule).toMatch(/padding:/);
    expect(rule, "the dock does not clear the home indicator").toMatch(/safe-area-inset-bottom/);
  });
});

/**
 * A REBUILT DESKTOP ONLY REACHES A PAGE THAT RELOADS.
 *
 * The cache headers already make that reload pick up the new build — the HTML shell is
 * `no-cache, must-revalidate` and only content-hashed assets cache long. What was missing was
 * anything that makes the reload HAPPEN. A tab reloads whenever you revisit it; an installed app is
 * resumed, returning you to a page that can be days old, and standalone display has no address bar
 * and no pull-to-refresh to force one with. `loadBuildStamp` reads once and caches, so nothing
 * noticed. Installing is exactly what turns this from unlikely into routine.
 */
describe("a stale build makes itself known", () => {
  const hook = readFileSync(join(WEB, "src", "useStaleBuild.ts"), "utf8");
  const stamp = readFileSync(join(WEB, "src", "build-stamp.ts"), "utf8");

  it("asks the server again, rather than reading the memoised answer", () => {
    // loadBuildStamp caches for the life of the page — correctly, since the RUNNING build cannot
    // change. Reusing it here would compare a value against itself and never fire.
    expect(stamp).toContain("refetchBuildSha");
    const fn = /export async function refetchBuildSha[\s\S]*?\n}/.exec(stamp)?.[0] ?? "";
    expect(fn, "refetchBuildSha not found").toBeTruthy();
    expect(fn, "a cached response would answer the wrong question").toContain('cache: "no-store"');
    expect(fn, "a failed check must never surface as an error").toContain("catch");
  });

  it("checks when the app is brought back to the front", () => {
    // The moment staleness starts to matter and the moment a reload is free. A timer alone would
    // miss the whole case: an app in the background is not running its intervals.
    expect(hook).toContain("visibilitychange");
    expect(hook).toContain('document.visibilityState === "visible"');
  });

  it("never compares against a stamp it failed to read", () => {
    // loadBuildStamp falls back to "unstamped" so a missing stamp cannot break a render. Comparing
    // against that would declare every build stale, forever, on every phone that hiccuped once.
    expect(hook).toContain('"unstamped"');
  });

  it("stays stale once stale", () => {
    // A desktop mid-rebuild can briefly serve the old stamp again. A notice that appeared and then
    // vanished before it could be tapped is worse than none.
    expect(hook).toMatch(/staleRef\.current \|\|/);
  });

  it("offers a tap and does not reload on its own", () => {
    const bar = readFileSync(join(WEB, "..", "..", "packages", "ui", "src", "UpdateBar.tsx"), "utf8");
    expect(bar, "the bar reloads by itself, taking a half-typed message with it").not.toMatch(
      /location\.reload|setTimeout/,
    );
    expect(bar).toContain("onReload");
    const app = readFileSync(join(WEB, "src", "App.tsx"), "utf8");
    expect(app).toContain("<UpdateBar onReload={() => window.location.reload()} />");
  });
});

/**
 * A CHECKLIST WHOSE STEPS ARE MESSAGES USED TO STOP AFTER TWO.
 *
 * The chain's definition of progress was "a step ticked", and that stalls the case it most needs to
 * serve. Asked for the alphabet a letter at a time, a model writes "A" and returns it as its ANSWER
 * — a complete reply to the step it was given — without reaching for complete_step at all. Nothing
 * ticks, exactly one no-progress turn is tolerated, and the run halts with 25 steps open and two
 * letters delivered. No amount of fixing the check-off guard reaches that, because the guard was
 * never consulted: the model never tried to tick anything.
 */
describe("a checklist chain keeps going while messages keep arriving", () => {
  const app = readFileSync(join(WEB, "src", "App.tsx"), "utf8");

  it("counts a new message as progress, not only a ticked step", () => {
    expect(app).toMatch(/countDonePlanSteps\(plan\) > doneAtStart \|\|/);
    expect(app, "presence alone would let a repeating model run to the cap").toContain("said !== adv.lastText");
  });

  it("still stops on a model repeating itself", () => {
    // Novelty rather than mere presence, for the same reason it is the test one level down: a model
    // saying the same thing again is exactly what a stuck run looks like.
    expect(app).toMatch(/adv\.noProgress = moved \? 0 : adv\.noProgress \+ 1;/);
  });

  it("keeps the chain cap, which is what bounds the whole thing", () => {
    expect(app).toMatch(/const cap = Math\.max\(20, plan!\.steps\.length \* 2 \+ 5\);/);
    expect(app).toMatch(/adv\.count <= cap && adv\.noProgress <= 1/);
  });

  it("resets the chain on a fresh reader turn, including what was last said", () => {
    // Without lastText resetting, a reader who asks the same thing twice would have their second
    // request judged against the first one's answer and halt immediately.
    expect(app).toContain('{ count: 0, noProgress: 0, lastText: "" }');
  });
});
