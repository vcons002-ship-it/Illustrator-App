import { describe, it, expect } from "vitest";
import type { ImageResult } from "@visual-reader/core";
import { placeholderLabel } from "./imageStatus.js";

const result = (over: Partial<ImageResult>): ImageResult => ({
  requestId: "r",
  pageId: "p",
  status: "queued",
  ...over,
});

describe("placeholderLabel", () => {
  it("prompts the reader to begin when generation hasn't started", () => {
    expect(placeholderLabel(undefined, true)).toEqual({
      label: 'Press “Begin generating book” to illustrate this page',
      pulse: false,
    });
  });

  it("shows a static 'waiting' message for a queued page (in line, not active)", () => {
    // Generation is on (awaitingStart false) but this page hasn't started rendering.
    expect(placeholderLabel(undefined, false)).toEqual({
      label: "waiting to be illustrated…",
      pulse: false,
    });
    expect(placeholderLabel(result({ status: "queued" }), false)).toEqual({
      label: "waiting to be illustrated…",
      pulse: false,
    });
  });

  it("pulses 'painting…' only while actually rendering, with percent when known", () => {
    expect(placeholderLabel(result({ status: "rendering" }), false)).toEqual({
      label: "painting this page…",
      pulse: true,
    });
    expect(placeholderLabel(result({ status: "rendering", progress: 0.42 }), false)).toEqual({
      label: "painting this page… 42%",
      pulse: true,
    });
  });

  it("reports skipped front/back matter and errors without a pulse", () => {
    expect(placeholderLabel(result({ status: "skipped" }), false)).toEqual({
      label: "No illustration — front/end matter",
      pulse: false,
    });
    expect(placeholderLabel(result({ status: "error", error: "boom" }), false)).toEqual({
      label: "couldn't render: boom",
      pulse: false,
    });
  });
});
