import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "../dist");
mkdirSync(dist, { recursive: true });
copyFileSync(resolve(here, "../manifest.json"), resolve(dist, "manifest.json"));
console.log("Copied manifest.json → dist/");
