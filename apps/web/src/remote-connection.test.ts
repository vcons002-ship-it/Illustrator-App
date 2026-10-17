import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectRemoteDesktop } from "./remote-connection.js";

function fixture() {
  const sockets: Array<{
    readyState: number; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>;
    onopen?: () => void; onclose?: (e: { code: number }) => void;
    onmessage?: (e: { data: string }) => void;
  }> = [];
  const status = vi.fn();
  const ready = vi.fn();
  const applied: string[] = [];
  const stop = connectRemoteDesktop({
    createSocket: () => {
      const socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    hello: "authenticated hello", onSocket: vi.fn(), onStatus: status,
    onFrame: (data) => { applied.push(data); return data === "conversation snapshot"; },
    onReady: () => { expect(applied.at(-1)).toBe("conversation snapshot"); ready(); },
  });
  return { sockets, status, ready, stop };
}
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("WebSocket", { OPEN: 1 }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("phone desktop connection lifecycle", () => {
  it("does not claim Linked or flush commands until the conversation has been applied", () => {
    const f = fixture();
    f.sockets[0]!.onopen?.();
    expect(f.status).toHaveBeenLastCalledWith("Connected to relay; waiting for the desktop…");
    expect(f.ready).not.toHaveBeenCalled();
    f.sockets[0]!.onmessage?.({ data: "unrelated worker tick" });
    expect(f.ready).not.toHaveBeenCalled();
    f.sockets[0]!.onmessage?.({ data: "conversation snapshot" });
    expect(f.status).toHaveBeenLastCalledWith("Linked to a desktop");
    expect(f.ready).toHaveBeenCalledTimes(1);
    f.stop();
  });
  it("backs off repeated opens that are immediately rejected instead of looping each second", () => {
    const f = fixture();
    f.sockets[0]!.onopen?.(); f.sockets[0]!.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(1_000);
    expect(f.sockets).toHaveLength(2);
    f.sockets[1]!.onopen?.(); f.sockets[1]!.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(1_000);
    expect(f.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(f.sockets).toHaveLength(3);
    f.stop();
  });
  it.each([1008, 1009])("stops retrying a permanent rejection (%s)", (code) => {
    const f = fixture(); f.sockets[0]!.onopen?.(); f.sockets[0]!.onclose?.({ code });
    vi.advanceTimersByTime(120_000);
    expect(f.sockets).toHaveLength(1);
    expect(f.status.mock.lastCall?.[0]).toMatch(code === 1008 ? /pairing expired/ : /sync exceeded/);
    f.stop();
  });
  it("continues asking a slow desktop and cancels hello retries after a snapshot", () => {
    const f = fixture(); f.sockets[0]!.onopen?.();
    vi.advanceTimersByTime(120_000);
    expect(f.sockets[0]!.send.mock.calls.length).toBeGreaterThan(5);
    f.sockets[0]!.onmessage?.({ data: "conversation snapshot" });
    const sent = f.sockets[0]!.send.mock.calls.length;
    vi.advanceTimersByTime(120_000);
    expect(f.sockets[0]!.send).toHaveBeenCalledTimes(sent);
    f.stop();
  });
  it("does not reconnect after component cleanup", () => {
    const f = fixture(); f.sockets[0]!.onopen?.();
    f.stop(); f.sockets[0]!.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(120_000);
    expect(f.sockets).toHaveLength(1);
  });
});
