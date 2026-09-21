import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RenderRequestTracker } from "./render-request-tracker.js";

const HOOK = readFileSync(join(__dirname, "useEngineWorker.ts"), "utf8");
const APP = readFileSync(join(__dirname, "App.tsx"), "utf8");

// Exercise the actual hook cancellation callbacks without mounting the app or starting a worker.
// Their bodies contain no TS syntax; only the refs and message sink need substituting.
function runCancel(name: "chatCancel" | "buddyCancel" | "testRenderCancel", tracker: RenderRequestTracker) {
  const body = HOOK.match(new RegExp(`const ${name} = useCallback\\(\\(\\) => \\{([\\s\\S]*?)\\n  \\}, \\[\\]\\);`))?.[1];
  if (!body) throw new Error(`Cannot locate ${name}`);
  const sent: { type: string; requestId: number }[] = [];
  const empty = { current: undefined };
  new Function(
    "renderRequests", "send", "activeChatRequestId", "activeBuddyRequestId",
    "activeCodingAgentsRequestId", "activeSummarizeRequestId", body,
  )({ current: tracker }, (message: typeof sent[number]) => sent.push(message), empty, empty, empty, empty);
  return sent;
}

describe("render cancellation ownership", () => {
  it("keeps chat and playground requests independent", () => {
    const tracker = new RenderRequestTracker();
    tracker.start("playground", 41);
    tracker.start("chat", 42);
    expect(tracker.current("playground")).toBe(41);
    expect(tracker.current("chat")).toBe(42);
    tracker.finish("chat", 42);
    expect(tracker.current("chat")).toBeUndefined();
    expect(tracker.current("playground")).toBe(41);
  });

  it("does not let an old result clear a newer render's Stop target", () => {
    const tracker = new RenderRequestTracker();
    for (const owner of ["playground", "chat"] as const) {
      tracker.start(owner, 1);
      tracker.start(owner, 2);
      tracker.finish(owner, 1);
      expect(tracker.current(owner)).toBe(2);
      tracker.finish(owner, 2);
      expect(tracker.current(owner)).toBeUndefined();
    }
  });

  it("clears both scopes after a worker/remote failure", () => {
    const tracker = new RenderRequestTracker();
    tracker.start("playground", 1);
    tracker.start("chat", 2);
    tracker.clear();
    expect(tracker.current("chat")).toBeUndefined();
    expect(tracker.current("playground")).toBeUndefined();
    expect(HOOK).toContain("renderRequests.current.clear();");
  });

  for (const cancel of ["chatCancel", "buddyCancel"] as const) {
    it(`${cancel} during a scheduled/session switch leaves Test image running`, () => {
      const tracker = new RenderRequestTracker();
      tracker.start("playground", 41);
      expect(runCancel(cancel, tracker)).toEqual([]);
      expect(tracker.current("playground")).toBe(41);
    });

    it(`${cancel} still interrupts chat-owned image/video/document generation`, () => {
      const tracker = new RenderRequestTracker();
      tracker.start("playground", 41);
      tracker.start("chat", 42);
      expect(runCancel(cancel, tracker)).toEqual([{ type: "chatCancel", requestId: 42 }]);
    });
  }

  it("the explicit playground Stop cancels only its own request", () => {
    const tracker = new RenderRequestTracker();
    tracker.start("chat", 42);
    tracker.start("playground", 41);
    expect(runCancel("testRenderCancel", tracker)).toEqual([{ type: "chatCancel", requestId: 41 }]);
    tracker.finish("playground", 41);
    expect(runCancel("testRenderCancel", tracker)).toEqual([]);
  });

  it("assigns Test image to the playground and image/video tools to the chat", () => {
    expect(HOOK).toContain('const owner = opts?.renderOwner ?? "playground";');
    expect(HOOK).toContain("renderRequests.current.start(owner, requestId);");
    expect(HOOK).toContain("renderRequests.current.finish(owner, requestId);");
    expect(HOOK.match(/renderRequests\.current\.start\("chat", requestId\)/g)).toHaveLength(2);
    const document = APP.slice(APP.indexOf("const onBuildDocument ="), APP.indexOf("const playgroundRenderEpoch ="));
    expect(document).toContain('renderOwner: "chat"');
  });

  it("wires Stop into both image playgrounds", () => {
    expect(APP.match(/onCancel=\{onTestRenderCancel\}/g)).toHaveLength(2);
    const imageModal = APP.slice(APP.indexOf("function TestImageModal("), APP.indexOf("function PhotoTransformModal("));
    const photoModal = APP.slice(APP.indexOf("function PhotoTransformModal("));
    for (const modal of [imageModal, photoModal]) {
      expect(modal).toContain('onClick={onCancel}>Stop</button>');
    }
  });

  it("honors Stop before deferred engine startup completes and records user activity", () => {
    const playground = APP.slice(APP.indexOf("const playgroundRenderEpoch ="), APP.indexOf("const onAddImageToChat ="));
    expect(playground).toContain("markUserRequest();");
    expect(playground).toMatch(/await ensureRenderEngineReady\(\);\s*if \(epoch !== playgroundRenderEpoch\.current\) return/);
    expect(playground).toMatch(/const onTestRenderCancel = useCallback\(\(\) => \{\s*playgroundRenderEpoch\.current\+\+;\s*testRenderCancel\(\);/);
  });
});
