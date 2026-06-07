import type { ImageGenerationInput, ImageGenerationOutput, ImageProvider } from "./image-provider.js";

/**
 * Network-free image provider that synthesises a deterministic SVG placeholder
 * from the prompt + identity seed. Lets the buffer, caching, and UI bloom/
 * spoiler flows be exercised end-to-end without API keys.
 */
export class MockImageProvider implements ImageProvider {
  readonly id = "mock";

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    const seed = input.anchors[0]?.seed ?? hash(input.prompt);
    const hue = seed % 360;
    const hue2 = (hue + 40) % 360;
    const label = escapeXml(input.prompt.slice(0, 80));
    const w = input.width ?? 512;
    const h = input.height ?? 512;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue},60%,55%)"/>
    <stop offset="1" stop-color="hsl(${hue2},55%,35%)"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <text x="50%" y="92%" fill="rgba(255,255,255,0.85)" font-family="sans-serif"
    font-size="16" text-anchor="middle">${label}</text>
</svg>`;
    return {
      bytes: new TextEncoder().encode(svg).buffer as ArrayBuffer,
      mimeType: "image/svg+xml",
    };
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}
