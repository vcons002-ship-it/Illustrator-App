import { describe, expect, it } from "vitest";
import { buildConcatArgs, buildLastFrameArgs } from "./video-stitch.js";

describe("buildLastFrameArgs", () => {
  it("extracts the last frame WITHOUT end-relative seeking (webp-safe): -update 1 overwrites one PNG", () => {
    expect(buildLastFrameArgs("clips/clip_0.webp", "clips/frame_0.png")).toEqual([
      "-y", "-i", "clips/clip_0.webp", "-update", "1", "clips/frame_0.png",
    ]);
  });
  it("uses no -sseof (the webp demuxer can't seek from the end) and no -frames:v 1 (that keeps frame 0)", () => {
    const args = buildLastFrameArgs("in.webp", "out.png");
    expect(args).not.toContain("-sseof");
    // -update present but not a 1-frame cap: the whole stream is decoded so the final write wins.
    expect(args).toContain("-update");
    expect(args.slice(args.indexOf("-update"))).not.toContain("-frames:v");
    // Single PNG output, still last.
    expect(args[args.length - 1]).toBe("out.png");
  });
});

describe("buildConcatArgs", () => {
  it("normalizes each input then concatenates video-only into an mp4", () => {
    const args = buildConcatArgs(["a.webp", "b.mp4", "c.webp"], { width: 768, height: 512, fps: 24, out: "final.mp4" });
    // Each clip is an input.
    expect(args.slice(0, 7)).toEqual(["-y", "-i", "a.webp", "-i", "b.mp4", "-i", "c.webp"]);
    const fi = args.indexOf("-filter_complex");
    const filter = args[fi + 1]!;
    // Three normalized streams feeding a 3-way concat.
    expect(filter).toContain("[0:v]scale=768:512");
    expect(filter).toContain("[2:v]scale=768:512");
    expect(filter).toContain("fps=24");
    expect(filter).toContain("[v0][v1][v2]concat=n=3:v=1:a=0[out]");
    // Mapped + broadly-playable pixel format + the output path last.
    expect(args.slice(fi + 2)).toEqual(["-map", "[out]", "-pix_fmt", "yuv420p", "final.mp4"]);
  });

  it("handles a single clip (concat=n=1)", () => {
    const args = buildConcatArgs(["only.mp4"], { width: 640, height: 640, fps: 16, out: "out.mp4" });
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("concat=n=1:v=1:a=0[out]");
  });

  it("throws on an empty clip list", () => {
    expect(() => buildConcatArgs([], { width: 1, height: 1, fps: 1, out: "x.mp4" })).toThrow(/at least one clip/);
  });
});
