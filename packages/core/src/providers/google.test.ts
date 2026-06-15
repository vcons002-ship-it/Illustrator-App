import { describe, expect, it } from "vitest";
import {
  buildGoogleAuthUrl,
  createTask,
  patchTask,
  decodeBase64Url,
  exchangeGoogleCode,
  gmailReadEmail,
  listEvents,
  listAllEvents,
  parseCalendarEvent,
  parseGmailMessage,
  parseTask,
  GOOGLE_SCOPES,
} from "./google.js";
import type { Transport, TransportRequest, TransportResponse } from "./transport/transport.js";

/** Fake transport that records requests and returns a scripted JSON body. */
class FakeTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  constructor(
    private readonly json: unknown,
    private readonly ok = true,
    private readonly status = 200,
  ) {}
  send(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    return Promise.resolve({
      ok: this.ok,
      status: this.status,
      json: <T>() => Promise.resolve(this.json as T),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      text: () => Promise.resolve(""),
    });
  }
}

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("buildGoogleAuthUrl", () => {
  it("requests offline access + PKCE with all three scopes", () => {
    const url = new URL(
      buildGoogleAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:5555", codeChallenge: "chal", state: "st" }),
    );
    const p = url.searchParams;
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(p.get("client_id")).toBe("cid");
    expect(p.get("redirect_uri")).toBe("http://127.0.0.1:5555");
    expect(p.get("code_challenge")).toBe("chal");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("scope")).toBe(GOOGLE_SCOPES.join(" "));
  });
});

describe("exchangeGoogleCode", () => {
  it("POSTs form-encoded and returns tokens with an expiry", async () => {
    const t = new FakeTransport({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
    const before = Date.now();
    const tokens = await exchangeGoogleCode({
      transport: t,
      clientId: "cid",
      clientSecret: "sec",
      code: "code123",
      redirectUri: "http://127.0.0.1:5555",
      codeVerifier: "ver",
    });
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    const req = t.requests[0]!;
    expect(req.url).toBe("https://oauth2.googleapis.com/token");
    expect(req.formEncoded).toMatchObject({ grant_type: "authorization_code", code: "code123", code_verifier: "ver" });
  });

  it("throws with Google's error_description on failure", async () => {
    const t = new FakeTransport({ error: "invalid_grant", error_description: "Bad code" }, false, 400);
    await expect(
      exchangeGoogleCode({ transport: t, clientId: "c", clientSecret: "s", code: "x", redirectUri: "r", codeVerifier: "v" }),
    ).rejects.toThrow(/Bad code/);
  });
});

describe("parseGmailMessage", () => {
  it("pulls headers + the text/plain body out of the MIME tree", () => {
    const msg = {
      id: "m1",
      snippet: "hello there",
      payload: {
        headers: [
          { name: "From", value: "Ada <ada@x.com>" },
          { name: "Subject", value: "Lunch?" },
          { name: "Date", value: "Mon, 15 Jun 2026 10:00:00 +0000" },
        ],
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64url("Plain body line") } },
          { mimeType: "text/html", body: { data: b64url("<b>html</b>") } },
        ],
      },
    };
    expect(parseGmailMessage(msg)).toEqual({
      id: "m1",
      from: "Ada <ada@x.com>",
      subject: "Lunch?",
      date: "Mon, 15 Jun 2026 10:00:00 +0000",
      snippet: "hello there",
      body: "Plain body line",
    });
  });

  it("falls back to stripped HTML when there's no plain part", () => {
    const msg = { id: "m2", payload: { mimeType: "text/html", body: { data: b64url("<p>Hi <b>there</b></p>") } } };
    expect(parseGmailMessage(msg).body).toBe("Hi there");
  });
});

describe("decodeBase64Url", () => {
  it("decodes URL-safe base64 (Gmail's encoding)", () => {
    expect(decodeBase64Url(b64url("a+b/c?"))).toBe("a+b/c?");
  });
});

describe("gmailReadEmail", () => {
  it("fetches format=full with the bearer token and parses it", async () => {
    const t = new FakeTransport({ id: "m9", payload: { headers: [{ name: "Subject", value: "S" }] } });
    const email = await gmailReadEmail(t, "tok", "m9");
    expect(email.subject).toBe("S");
    expect(t.requests[0]!.url).toContain("/messages/m9?format=full");
    expect(t.requests[0]!.headers?.authorization).toBe("Bearer tok");
  });
});

describe("calendar + tasks parsers", () => {
  it("parseCalendarEvent prefers dateTime, falls back to all-day date", () => {
    expect(parseCalendarEvent({ id: "e1", summary: "Sync", start: { dateTime: "2026-06-15T14:00:00Z" }, end: { dateTime: "2026-06-15T15:00:00Z" } })).toEqual({
      id: "e1",
      summary: "Sync",
      start: "2026-06-15T14:00:00Z",
      end: "2026-06-15T15:00:00Z",
    });
    const allDay = parseCalendarEvent({ summary: "Holiday", start: { date: "2026-12-25" }, end: { date: "2026-12-26" } });
    expect(allDay.start).toBe("2026-12-25");
    expect(allDay.allDay).toBe(true);
  });

  it("listAllEvents tags each event with its calendar id + colour", async () => {
    // First request = calendarList; subsequent = each calendar's events.
    const t = new (class implements Transport {
      n = 0;
      readonly requests: TransportRequest[] = [];
      send(req: TransportRequest): Promise<TransportResponse> {
        this.requests.push(req);
        const body =
          this.n++ === 0
            ? { items: [{ id: "primary", summary: "Me", primary: true, backgroundColor: "#3366cc" }] }
            : { items: [{ id: "ev1", summary: "Standup", start: { dateTime: "2026-06-16T09:00:00Z" }, end: { dateTime: "2026-06-16T09:15:00Z" } }] };
        return Promise.resolve({ ok: true, status: 200, json: <T>() => Promise.resolve(body as T), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)), text: () => Promise.resolve("") });
      }
    })();
    const evs = await listAllEvents(t, "tok", { timeMin: "2026-06-01T00:00:00Z", timeMax: "2026-06-30T00:00:00Z" });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ summary: "Standup", calendarId: "primary", color: "#3366cc" });
  });

  it("parseTask keeps title/notes/due", () => {
    expect(parseTask({ id: "t1", title: "File taxes", due: "2026-04-15T00:00:00Z" })).toEqual({
      id: "t1",
      title: "File taxes",
      due: "2026-04-15T00:00:00Z",
    });
    expect(parseTask({}).title).toBe("(untitled)");
  });
});

describe("listEvents / createTask network shape", () => {
  it("listEvents asks for upcoming, ordered, single events", async () => {
    const t = new FakeTransport({ items: [{ summary: "A", start: { dateTime: "2026-06-15T14:00:00Z" }, end: { dateTime: "2026-06-15T15:00:00Z" } }] });
    const events = await listEvents(t, "tok", { max: 5 });
    expect(events).toHaveLength(1);
    expect(t.requests[0]!.url).toMatch(/singleEvents=true/);
    expect(t.requests[0]!.url).toMatch(/orderBy=startTime/);
  });

  it("createTask POSTs the title/notes/due as JSON", async () => {
    const t = new FakeTransport({ id: "t2", title: "Call dentist" });
    const task = await createTask(t, "tok", { title: "Call dentist", due: "2026-06-20T00:00:00Z" });
    expect(task.title).toBe("Call dentist");
    expect(t.requests[0]!.method).toBe("POST");
    expect(t.requests[0]!.body).toMatchObject({ title: "Call dentist", due: "2026-06-20T00:00:00Z" });
  });

  it("patchTask PATCHes the completion status (remote-bus write-back)", async () => {
    const t = new FakeTransport({ id: "t3", title: "done", status: "completed" });
    const task = await patchTask(t, "tok", "t3", { status: "completed" });
    expect(task.status).toBe("completed");
    expect(t.requests[0]!.method).toBe("PATCH");
    expect(t.requests[0]!.url).toContain("/tasks/t3");
    expect(t.requests[0]!.body).toEqual({ status: "completed" });
  });
});
