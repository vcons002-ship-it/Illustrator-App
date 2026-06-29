import { describe, expect, it } from "vitest";
import {
  buildLinkUrl,
  buildRemoteLinkUrl,
  decodeFrame,
  deserializeFromRemote,
  encodeFrame,
  generatePairingToken,
  isLocalOnlyMessage,
  isAppSyncMessage,
  parseLinkToken,
  remoteModeFromHash,
  REMOTE_LINK_PORT,
  serializeForRemote,
} from "./remote-link.js";
import { base64ToBytes, bytesToBase64 } from "../providers/image/base64.js";

describe("generatePairingToken", () => {
  it("produces a token of the requested length from the safe alphabet, and varies", () => {
    const t = generatePairingToken(24);
    expect(t).toHaveLength(24);
    expect(t).toMatch(/^[A-HJ-NP-Za-hj-np-z2-9]+$/); // no 0/O/1/I/l look-alikes
    expect(generatePairingToken()).not.toBe(generatePairingToken());
  });
});

describe("buildLinkUrl / parseLinkToken", () => {
  it("round-trips the token through the link URL", () => {
    const url = buildLinkUrl({ host: "192.168.1.20", port: REMOTE_LINK_PORT, token: "Tok-en_24" });
    expect(url).toContain(`192.168.1.20:${REMOTE_LINK_PORT}`);
    expect(parseLinkToken(url)).toBe("Tok-en_24");
    expect(parseLinkToken("#vrlink=abc")).toBe("abc");
    expect(parseLinkToken("https://x/")).toBeUndefined();
  });
});

describe("encodeFrame / decodeFrame", () => {
  it("only returns the payload when the token matches", () => {
    const frame = encodeFrame("secret", { type: "buddyChat", requestId: 1 });
    expect(decodeFrame(frame, "secret")).toEqual({ type: "buddyChat", requestId: 1 });
    expect(decodeFrame(frame, "wrong")).toBeUndefined();
    expect(decodeFrame("not json", "secret")).toBeUndefined();
    expect(decodeFrame(JSON.stringify({ payload: 1 }), "secret")).toBeUndefined();
  });
});

describe("thin-client helpers", () => {
  it("remoteModeFromHash builds a ws URL from the link hash + host", () => {
    expect(remoteModeFromHash("#vrlink=abc", "192.168.1.20:8787")).toEqual({ wsUrl: "ws://192.168.1.20:8787/", token: "abc" });
    expect(remoteModeFromHash("#nope", "host")).toBeUndefined();
  });

  it("remoteModeFromHash uses wss:// over an https page (tunnel), ws:// over http", () => {
    // A Cloudflare tunnel serves the SPA over https; the socket MUST be wss (browsers block ws from https).
    expect(remoteModeFromHash("#vrlink=tok", "vr.example.com", "https:")).toEqual({ wsUrl: "wss://vr.example.com/", token: "tok" });
    expect(remoteModeFromHash("#vrlink=tok", "192.168.1.20:8787", "http:")).toEqual({ wsUrl: "ws://192.168.1.20:8787/", token: "tok" });
  });

  it("buildRemoteLinkUrl makes an https tunnel link with the token in the QUERY (survives Access), normalizing the host", () => {
    // Query, not #hash — a Cloudflare Access login preserves the query but drops a fragment.
    expect(buildRemoteLinkUrl("vr.example.com", "Tok 1")).toBe("https://vr.example.com/?vrlink=Tok%201");
    expect(buildRemoteLinkUrl("https://vr.example.com/", "t")).toBe("https://vr.example.com/?vrlink=t"); // scheme + trailing slash stripped
    expect(buildRemoteLinkUrl("  ", "t")).toBeUndefined();
    expect(buildRemoteLinkUrl("host", "")).toBeUndefined();
    // parseLinkToken accepts the query form too (the client reads it on load).
    expect(parseLinkToken("?vrlink=abc")).toBe("abc");
  });

  it("flags local-only (CORS) messages so they never cross the relay", () => {
    expect(isLocalOnlyMessage({ type: "corsFetch" })).toBe(true);
    expect(isLocalOnlyMessage({ type: "buddyChat" })).toBe(false);
  });

  it("distinguishes app-state mirror frames from engine messages by their type prefix", () => {
    expect(isAppSyncMessage({ type: "vrsync:state" })).toBe(true);
    expect(isAppSyncMessage({ type: "vrcmd:open" })).toBe(true);
    expect(isAppSyncMessage({ type: "buddyChat" })).toBe(false); // an engine message
    expect(isAppSyncMessage({ type: "update" })).toBe(false);
    expect(isAppSyncMessage(undefined)).toBe(false);
  });

  it("round-trips a message with an ArrayBuffer through serialize/deserialize (+ a frame)", () => {
    const bytes = new Uint8Array([1, 2, 3, 250]).buffer;
    const safe = serializeForRemote({ type: "image", requestId: 5, bytes, nested: { also: bytes } }, bytesToBase64);
    // Composes with the token frame (encode → decode → deserialize).
    const payload = decodeFrame(encodeFrame("tok", safe), "tok");
    const back = deserializeFromRemote(payload, base64ToBytes) as { type: string; requestId: number; bytes: ArrayBuffer; nested: { also: ArrayBuffer } };
    expect(back.type).toBe("image");
    expect(back.requestId).toBe(5);
    expect(new Uint8Array(back.bytes)).toEqual(new Uint8Array([1, 2, 3, 250]));
    expect(new Uint8Array(back.nested.also)).toEqual(new Uint8Array([1, 2, 3, 250]));
  });
});
