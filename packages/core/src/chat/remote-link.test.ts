import { describe, expect, it } from "vitest";
import {
  buildLinkUrl,
  decodeFrame,
  encodeFrame,
  generatePairingToken,
  parseLinkToken,
  REMOTE_LINK_PORT,
} from "./remote-link.js";

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
