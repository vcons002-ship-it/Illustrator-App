/**
 * Write the build stamp that the app reads at RUNTIME (`apps/web/public/build.json`).
 *
 * It used to be a Vite `define`, substituted at compile time. That can't work here: the desktop app
 * runs `cargo tauri dev`, so the page is served by a long-lived vite dev server that reads its config
 * once at startup — and `app.restart()` relaunches only the Tauri binary, not that server. So a
 * config-baked value could not be refreshed by the in-app updater at all; it needed the terminal
 * running desktop.bat to be closed.
 *
 * A file under `public/` is read from disk on every request instead, so `pnpm build` + a reload is
 * enough. Run from the `build` and `dev` scripts explicitly rather than via a `prebuild` lifecycle
 * hook, because pnpm does not run pre/post scripts by default.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "apps", "web", "public", "build.json");

const git = (args) => {
  try {
    return execSync(`git ${args}`, { cwd: join(here, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

const stamp = {
  sha: git("rev-parse --short HEAD") || "dev",
  branch: git("rev-parse --abbrev-ref HEAD") || "",
  at: new Date().toISOString().slice(0, 16).replace("T", " ") + "Z",
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(stamp, null, 2)}\n`);
console.log(`build stamp: ${stamp.sha}${stamp.branch ? ` (${stamp.branch})` : ""} at ${stamp.at}`);
