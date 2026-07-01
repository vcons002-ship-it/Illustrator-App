/**
 * Pure ffmpeg-argv builders for the long-form video pipeline: the app renders a SERIES of short clips
 * (each continuing from the previous clip's last frame), then stitches them into one video. These helpers
 * produce the exact `ffmpeg` argument vectors — the desktop shell resolves the ffmpeg binary and runs
 * them (see `run_ffmpeg`). Kept pure + unit-tested here; no I/O.
 */

/** Options for {@link buildConcatArgs}: the normalized output size/fps + the destination path. */
export interface ConcatOptions {
  width: number;
  height: number;
  fps: number;
  /** Output file path (an .mp4). */
  out: string;
}

/**
 * ffmpeg argv to grab a still near the END of a clip — its last frame — to seed the NEXT clip in a
 * seamless chained render. `-sseof -0.2` seeks to 0.2s before the end (robust across containers, avoids
 * landing past the final frame), then `-frames:v 1` writes exactly one image to `outPath` (a .png).
 */
export function buildLastFrameArgs(clipPath: string, outPath: string): string[] {
  return ["-y", "-sseof", "-0.2", "-i", clipPath, "-frames:v", "1", outPath];
}

/**
 * ffmpeg argv to concatenate `clipPaths` (IN ORDER) into one re-encoded mp4 at `opts.out`. Uses the
 * filter-graph `concat` (not the stream-copy demuxer) so mixed containers (animated webp + mp4) and any
 * per-clip size are normalized first: each input is scaled to fit w×h, letterbox-padded, set to the
 * target fps, and given square pixels — then concatenated video-only (`a=0`; the stitched long video is
 * silent, the individual clips keep their own audio). `-pix_fmt yuv420p` keeps the mp4 broadly playable.
 * Throws on an empty list (the caller always has ≥ 1 clip).
 */
export function buildConcatArgs(clipPaths: string[], opts: ConcatOptions): string[] {
  if (clipPaths.length === 0) throw new Error("buildConcatArgs needs at least one clip");
  const { width, height, fps, out } = opts;
  const args: string[] = ["-y"];
  for (const p of clipPaths) args.push("-i", p);
  const n = clipPaths.length;
  const labels: string[] = [];
  let filter = "";
  for (let i = 0; i < n; i++) {
    filter +=
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},setsar=1[v${i}];`;
    labels.push(`[v${i}]`);
  }
  filter += `${labels.join("")}concat=n=${n}:v=1:a=0[out]`;
  args.push("-filter_complex", filter, "-map", "[out]", "-pix_fmt", "yuv420p", out);
  return args;
}
