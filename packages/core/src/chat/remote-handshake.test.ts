import { describe, expect, it } from "vitest";
import {
  HELLO_RETRY_MAX_MS,
  HELLO_RETRY_START_MS,
  isSnapshotAnswer,
  nextHelloDelay,
} from "./remote-handshake.js";

describe("isSnapshotAnswer", () => {
  it("counts the conversation frame — the one the phone is actually waiting for", () => {
    expect(isSnapshotAnswer("vrsync:chat")).toBe(true);
  });

  it("does NOT count a frame the desktop pushed on its own initiative", () => {
    // This was the bug: any of these arriving first proved the desktop was awake, not that it had
    // heard the request — and the phone stopped asking with the chat never sent.
    for (const t of ["vrsync:chatLive", "vrsync:library", "vrsync:settings", "vrsync:book", "vrsync:soul"]) {
      expect(isSnapshotAnswer(t)).toBe(false);
    }
  });
});

describe("nextHelloDelay", () => {
  it("starts small and doubles", () => {
    expect(nextHelloDelay(0)).toBe(HELLO_RETRY_START_MS);
    expect(nextHelloDelay(HELLO_RETRY_START_MS)).toBe(4_000);
    expect(nextHelloDelay(4_000)).toBe(8_000);
  });

  it("settles at a heartbeat instead of ever giving up", () => {
    // A desktop can be asleep, restarting, or on a laptop nobody has opened. None of those is a
    // reason to abandon a conversation that still exists.
    let d = 0;
    for (let i = 0; i < 40; i++) d = nextHelloDelay(d);
    expect(d).toBe(HELLO_RETRY_MAX_MS);
    expect(nextHelloDelay(d)).toBe(HELLO_RETRY_MAX_MS);
  });

  it("recovers from a nonsense previous value", () => {
    expect(nextHelloDelay(-5)).toBe(HELLO_RETRY_START_MS);
    expect(nextHelloDelay(Number.NaN)).toBe(HELLO_RETRY_START_MS);
  });
});
