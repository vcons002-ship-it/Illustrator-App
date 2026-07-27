import { describe, expect, it } from "vitest";
import {
  buildGoogleAuthUrl,
  buildRawEmail,
  createDraft,
  sendEmail,
  decodeBase64UrlBytes,
  createTask,
  createEvent,
  applyDescriptionEdits,
  applyDescriptionLines,
  nextDayIso,
  toTaskDue,
  patchTask,
  patchEvent,
  patchTimeField,
  decodeBase64Url,
  exchangeGoogleCode,
  gmailReadEmail,
  gmailSearch,
  listEvents,
  listAllEvents,
  listTaskTree,
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
  it("requests offline access + PKCE with all scopes (incl. calendar.readonly for calendarList)", () => {
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
    // calendarList.list (the calendar grid + email/calendar sweep) needs a calendar-list read
    // scope — calendar.events alone 403s. Lock that in.
    expect(GOOGLE_SCOPES).toContain("https://www.googleapis.com/auth/calendar.readonly");
    // Email write: drafting (compose) + sending.
    expect(GOOGLE_SCOPES).toContain("https://www.googleapis.com/auth/gmail.compose");
    expect(GOOGLE_SCOPES).toContain("https://www.googleapis.com/auth/gmail.send");
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

  it("collects attachment parts (filename + attachmentId), and omits the field when none", () => {
    const msg = {
      id: "m3",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", body: { data: b64url("see attached") } },
          { mimeType: "application/pdf", filename: "itinerary.pdf", body: { attachmentId: "att-1", size: 1234 } },
        ],
      },
    };
    expect(parseGmailMessage(msg).attachments).toEqual([
      { attachmentId: "att-1", filename: "itinerary.pdf", mimeType: "application/pdf" },
    ]);
    expect(parseGmailMessage({ id: "m4", payload: { mimeType: "text/plain", body: { data: b64url("hi") } } }).attachments).toBeUndefined();
  });

  it("carries To/Cc through (so 'who was this sent to' is answerable), and omits them when unset", () => {
    const withRecipients = parseGmailMessage({
      id: "m5",
      payload: {
        headers: [
          { name: "From", value: "Ada <ada@x.com>" },
          { name: "To", value: "Bo <bo@x.com>, Cy <cy@x.com>" },
          { name: "Cc", value: "Dee <dee@x.com>" },
          { name: "Subject", value: "Party" },
        ],
        mimeType: "text/plain",
        body: { data: b64url("rsvp please") },
      },
    });
    expect(withRecipients.to).toBe("Bo <bo@x.com>, Cy <cy@x.com>");
    expect(withRecipients.cc).toBe("Dee <dee@x.com>");

    const bare = parseGmailMessage({
      id: "m6",
      payload: { headers: [{ name: "From", value: "Ada <ada@x.com>" }], mimeType: "text/plain", body: { data: b64url("hi") } },
    });
    expect(bare.to).toBeUndefined();
    expect(bare.cc).toBeUndefined();
  });
});

describe("gmailSearch", () => {
  it("asks Gmail for the To/Cc headers — format=metadata returns ONLY the ones named", async () => {
    // One transport for both calls: the list response and the per-message response share a body here,
    // which is fine because we only assert on the URLs and the recipient fields.
    const transport = new FakeTransport({
      messages: [{ id: "m1" }],
      id: "m1",
      snippet: "rsvp please",
      payload: {
        headers: [
          { name: "From", value: "Ada <ada@x.com>" },
          { name: "To", value: "Bo <bo@x.com>" },
          { name: "Cc", value: "Dee <dee@x.com>" },
          { name: "Subject", value: "Party" },
        ],
      },
    });
    const emails = await gmailSearch(transport, "tok", "party");
    const messageUrl = transport.requests[1]?.url ?? "";
    expect(messageUrl).toContain("metadataHeaders=To");
    expect(messageUrl).toContain("metadataHeaders=Cc");
    expect(emails[0]?.to).toBe("Bo <bo@x.com>");
    expect(emails[0]?.cc).toBe("Dee <dee@x.com>");
    // Summaries stay summaries — no body.
    expect(emails[0]).not.toHaveProperty("body");
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

  it("listAllEvents falls back to the primary calendar when calendarList is forbidden (403 scopes)", async () => {
    // First request = calendarList → 403 (calendar.events lacks calendar-list read); the fallback
    // then reads the primary calendar's events directly (covered by calendar.events).
    const t = new (class implements Transport {
      n = 0;
      readonly urls: string[] = [];
      send(req: TransportRequest): Promise<TransportResponse> {
        this.urls.push(req.url);
        if (this.n++ === 0) {
          return Promise.resolve({ ok: false, status: 403, json: <T>() => Promise.resolve({} as T), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)), text: () => Promise.resolve("insufficient scopes") });
        }
        const body = { items: [{ id: "ev1", summary: "Standup", start: { dateTime: "2026-06-16T09:00:00Z" }, end: { dateTime: "2026-06-16T09:15:00Z" } }] };
        return Promise.resolve({ ok: true, status: 200, json: <T>() => Promise.resolve(body as T), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)), text: () => Promise.resolve("") });
      }
    })();
    const evs = await listAllEvents(t, "tok", { timeMin: "2026-06-01T00:00:00Z", timeMax: "2026-06-30T00:00:00Z" });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ summary: "Standup", calendarId: "primary" });
    // It read the primary calendar's events after the calendarList 403.
    expect(t.urls.some((u) => u.includes("/calendars/primary/events"))).toBe(true);
  });

  it("listTaskTree paginates (page count includes sub-tasks) and nests sub-tasks across pages", async () => {
    // Page 1: a parent + a nextPageToken. Page 2: that parent's sub-task (on a later page).
    const t = new (class implements Transport {
      n = 0;
      readonly urls: string[] = [];
      send(req: TransportRequest): Promise<TransportResponse> {
        this.urls.push(req.url);
        const body =
          this.n++ === 0
            ? { items: [{ id: "p1", title: "Parent" }], nextPageToken: "PAGE2" }
            : { items: [{ id: "s1", title: "Child", parent: "p1", status: "completed" }] };
        return Promise.resolve({ ok: true, status: 200, json: <T>() => Promise.resolve(body as T), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)), text: () => Promise.resolve("") });
      }
    })();
    const trees = await listTaskTree(t, "tok", 500);
    expect(trees).toHaveLength(1);
    expect(trees[0]).toMatchObject({ id: "p1", title: "Parent" });
    expect(trees[0]!.subtasks).toEqual([{ id: "s1", title: "Child", status: "completed" }]);
    expect(t.urls[1]).toContain("pageToken=PAGE2"); // followed the page token
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

describe("email: buildRawEmail / createDraft / sendEmail", () => {
  const decode = (raw: string) => new TextDecoder().decode(decodeBase64UrlBytes(raw));

  it("builds an RFC-822 message with the right headers + body", () => {
    const raw = buildRawEmail({ to: ["a@b.com"], subject: "Hi there", body: "Line one\nLine two" });
    const mime = decode(raw);
    expect(mime).toContain("To: a@b.com");
    expect(mime).toContain("Subject: Hi there");
    expect(mime).toMatch(/Content-Type: text\/plain; charset="UTF-8"/);
    // Body sits after the blank line.
    expect(mime).toContain("\r\n\r\nLine one\nLine two");
  });

  it("joins multiple recipients and omits empty cc/bcc", () => {
    const raw = buildRawEmail({ to: ["a@b.com", "c@d.com"], subject: "S", body: "B" });
    const mime = decode(raw);
    expect(mime).toContain("To: a@b.com, c@d.com");
    expect(mime).not.toContain("Cc:");
    expect(mime).not.toContain("Bcc:");
  });

  it("includes cc/bcc when present and RFC-2047 encodes a non-ASCII subject", () => {
    const raw = buildRawEmail({ to: ["a@b.com"], cc: ["c@d.com"], bcc: ["e@f.com"], subject: "Café ☕", body: "B" });
    const mime = decode(raw);
    expect(mime).toContain("Cc: c@d.com");
    expect(mime).toContain("Bcc: e@f.com");
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?.+\?=/); // encoded-word, not raw unicode
    expect(mime).not.toContain("Subject: Café");
  });

  it("createDraft POSTs { message: { raw } } to the drafts endpoint", async () => {
    const t = new FakeTransport({ id: "draft-1", message: { id: "m1", threadId: "th1" } });
    const r = await createDraft(t, "tok", { to: ["a@b.com"], subject: "S", body: "B" });
    expect(r.id).toBe("draft-1");
    expect(t.requests[0]!.method).toBe("POST");
    expect(t.requests[0]!.url).toMatch(/\/drafts$/);
    expect(t.requests[0]!.body).toMatchObject({ message: { raw: expect.any(String) } });
  });

  it("sendEmail POSTs { raw } to messages/send", async () => {
    const t = new FakeTransport({ id: "sent-1", threadId: "th2" });
    const r = await sendEmail(t, "tok", { to: ["a@b.com"], subject: "S", body: "B" });
    expect(r.id).toBe("sent-1");
    expect(t.requests[0]!.url).toMatch(/\/messages\/send$/);
    expect(t.requests[0]!.body).toMatchObject({ raw: expect.any(String) });
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

  it("createTask widens a bare date deadline to RFC 3339 (Google rejects YYYY-MM-DD)", async () => {
    const t = new FakeTransport({ id: "t2b", title: "Tailor resume" });
    await createTask(t, "tok", { title: "Tailor resume", due: "2026-07-01" });
    expect(t.requests[0]!.body).toMatchObject({ title: "Tailor resume", due: "2026-07-01T00:00:00.000Z" });
  });

  it("createTask nests a sub-task via the parent/previous query params (no malformed due dropped)", async () => {
    const t = new FakeTransport({ id: "sub1", title: "Submit application" });
    await createTask(t, "tok", { title: "Submit application", due: "not-a-date", parent: "p1", previous: "sub0" });
    expect(t.requests[0]!.url).toMatch(/parent=p1/);
    expect(t.requests[0]!.url).toMatch(/previous=sub0/);
    expect(t.requests[0]!.body).not.toHaveProperty("due"); // unrecognised due omitted, insert still succeeds
  });

  it("toTaskDue normalises bare dates, passes through date-times, drops junk", () => {
    expect(toTaskDue("2026-07-01")).toBe("2026-07-01T00:00:00.000Z");
    expect(toTaskDue("2026-07-01T09:30:00-04:00")).toBe("2026-07-01T09:30:00-04:00");
    expect(toTaskDue("2026-07-01T00:00:00Z")).toBe("2026-07-01T00:00:00Z");
    expect(toTaskDue("next week")).toBeUndefined();
    expect(toTaskDue("")).toBeUndefined();
    expect(toTaskDue(undefined)).toBeUndefined();
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

/** Fake transport that returns a DIFFERENT scripted body per call (for read-modify-write paths). */
class SequencedTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  private i = 0;
  constructor(private readonly bodies: unknown[]) {}
  send(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    const json = this.bodies[Math.min(this.i++, this.bodies.length - 1)];
    return Promise.resolve({
      ok: true,
      status: 200,
      json: <T>() => Promise.resolve(json as T),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      text: () => Promise.resolve(""),
    });
  }
}

describe("applyDescriptionLines (upsert a labelled line)", () => {
  // The line-upsert behaviour itself is covered in file-edits.test.ts — documents share the same
  // primitive. This just holds the calendar's end of it: an RSVP list updating in place, not doubling.
  it("overwrites the entry already in the list rather than appending a second one", () => {
    const rsvp = "Party at 6.\nRSVP:\n- Ada: yes\n- Bo: ?\n- Cy: ?\nBring a dish.";
    const r = applyDescriptionLines(rsvp, [{ match: "Bo", line: "Bo: yes" }]);
    expect(r.text).toBe("Party at 6.\nRSVP:\n- Ada: yes\n- Bo: yes\n- Cy: ?\nBring a dish.");
    expect(r.replaced).toEqual(["Bo"]);
    // A genuinely new name joins the list, ahead of the prose that follows it.
    expect(applyDescriptionLines(rsvp, [{ match: "Dee", line: "Dee: yes" }]).text).toBe(
      "Party at 6.\nRSVP:\n- Ada: yes\n- Bo: ?\n- Cy: ?\n- Dee: yes\nBring a dish.",
    );
  });
});

describe("applyDescriptionEdits (find/replace in a description)", () => {
  it("replaces a whole line by its text, keeping the bullet, and reports nothing missed", () => {
    const r = applyDescriptionEdits("- Bo: ?\n- Cy: ?", [{ find: "Bo: ?", replace: "Bo: yes" }]);
    expect(r).toEqual({ text: "- Bo: yes\n- Cy: ?", missed: [] });
  });

  it("deletes the line when the replacement is empty", () => {
    expect(applyDescriptionEdits("- Bo: ?\n- Cy: ?", [{ find: "- Cy: ?", replace: "" }]).text).toBe("- Bo: ?");
  });

  it("falls back to a substring, first occurrence only", () => {
    expect(applyDescriptionEdits("gate B12, gate B12", [{ find: "B12", replace: "C4" }]).text).toBe("gate C4, gate B12");
  });

  it("reports a miss rather than guessing — the caller must not append instead", () => {
    const r = applyDescriptionEdits("- Bo: ?", [{ find: "- Zed: ?", replace: "- Zed: no" }]);
    expect(r).toEqual({ text: "- Bo: ?", missed: ["- Zed: ?"] });
  });
});

describe("patchEvent (edit an existing calendar event)", () => {
  it("PATCHes only the fields given, at the event's URL", async () => {
    const t = new FakeTransport({ id: "e1", summary: "Dentist", start: { dateTime: "2026-07-04T17:00:00-04:00" }, end: { dateTime: "2026-07-04T18:00:00-04:00" } });
    const ev = await patchEvent(t, "tok", "e1", { location: "12 Main St" });
    expect(ev.id).toBe("e1");
    expect(t.requests[0]!.method).toBe("PATCH");
    expect(t.requests[0]!.url).toContain("/calendars/primary/events/e1");
    expect(t.requests[0]!.body).toEqual({ location: "12 Main St" }); // untouched fields aren't sent
  });

  it("appendDescription ADDS to the event's existing text instead of replacing it", async () => {
    // GET (current state) then PATCH — appending has to read first, because Calendar's PATCH replaces
    // a field wholesale, so a naive write would erase every earlier note.
    const t = new SequencedTransport([
      { id: "e1", summary: "Flight", description: "Booked with Delta." },
      { id: "e1", summary: "Flight", description: "Booked with Delta.\nConfirmation #A1234" },
    ]);
    const ev = await patchEvent(t, "tok", "e1", { appendDescription: "Confirmation #A1234" });
    expect(t.requests[0]!.method).toBe("GET");
    expect(t.requests[1]!.method).toBe("PATCH");
    expect((t.requests[1]!.body as { description: string }).description).toBe("Booked with Delta.\nConfirmation #A1234");
    expect(ev.description).toContain("Confirmation #A1234");
  });

  it("appendDescription on an event with no description yet doesn't lead with a blank line", async () => {
    const t = new SequencedTransport([{ id: "e2", summary: "Lunch" }, { id: "e2", summary: "Lunch", description: "Table for 4" }]);
    await patchEvent(t, "tok", "e2", { appendDescription: "Table for 4" });
    expect((t.requests[1]!.body as { description: string }).description).toBe("Table for 4");
  });

  it("description REPLACES (and skips the read) — the rewrite/correct path", async () => {
    const t = new FakeTransport({ id: "e1", summary: "S", description: "fresh" });
    await patchEvent(t, "tok", "e1", { description: "fresh" });
    expect(t.requests).toHaveLength(1); // no GET
    expect(t.requests[0]!.method).toBe("PATCH");
  });

  it("sends a bare date as an ALL-DAY date, not a midnight dateTime", async () => {
    const t = new FakeTransport({ id: "e3", summary: "Holiday", start: { date: "2026-07-04" }, end: { date: "2026-07-05" } });
    await patchEvent(t, "tok", "e3", { start: "2026-07-04", end: "2026-07-05" });
    // Shape-explicit (see patchTimeField): the opposite key is nulled so a conversion actually lands.
    expect(t.requests[0]!.body).toEqual({
      start: { date: "2026-07-04", dateTime: null },
      end: { date: "2026-07-05", dateTime: null },
    });
    const t2 = new FakeTransport({ id: "e3", summary: "Holiday" });
    await patchEvent(t2, "tok", "e3", { start: "2026-07-04T09:00:00-04:00" });
    expect(t2.requests[0]!.body).toEqual({ start: { dateTime: "2026-07-04T09:00:00-04:00", date: null } });
  });

  it("setLines overwrites the line already there instead of appending a second one", async () => {
    const before = "Party at 6.\nRSVP:\n- Ada: yes\n- Bo: ?\n- Cy: ?\nBring a dish.";
    const t = new SequencedTransport([{ id: "e1", summary: "Party", description: before }, { id: "e1", summary: "Party" }]);
    await patchEvent(t, "tok", "e1", { setLines: [{ match: "Bo", line: "Bo: yes" }] });
    expect((t.requests[1]!.body as { description: string }).description).toBe(
      "Party at 6.\nRSVP:\n- Ada: yes\n- Bo: yes\n- Cy: ?\nBring a dish.",
    );
  });

  it("editDescription refuses the WHOLE call when a find misses, and says what the text really is", async () => {
    const t = new SequencedTransport([{ id: "e1", summary: "Party", description: "RSVP:\n- Bo: ?" }]);
    await expect(
      patchEvent(t, "tok", "e1", {
        editDescription: [
          { find: "- Bo: ?", replace: "- Bo: yes" },
          { find: "- Zed: ?", replace: "- Zed: no" },
        ],
      }),
    ).rejects.toThrow(/"- Zed: \?"[\s\S]*RSVP:/);
    // Nothing was written — a half-applied edit is worse than none.
    expect(t.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
  });

  it("applies edits, then setLines, then append — all in one read/write round-trip", async () => {
    const t = new SequencedTransport([
      { id: "e1", summary: "Party", description: "Party at 6.\n- Bo: ?" },
      { id: "e1", summary: "Party" },
    ]);
    await patchEvent(t, "tok", "e1", {
      editDescription: [{ find: "Party at 6.", replace: "Party at 7." }],
      setLines: [{ match: "Bo", line: "Bo: yes" }],
      appendDescription: "Parking out back.",
    });
    expect(t.requests.filter((r) => r.method === "GET")).toHaveLength(1); // one read, not three
    expect((t.requests[1]!.body as { description: string }).description).toBe("Party at 7.\n- Bo: yes\nParking out back.");
  });

  it("refuses an empty patch rather than issuing a no-op write", async () => {
    const t = new FakeTransport({});
    await expect(patchEvent(t, "tok", "e1", {})).rejects.toThrow(/nothing to update/i);
    expect(t.requests).toHaveLength(0);
  });

  it("escapes the event id and honours a non-primary calendar", async () => {
    const t = new FakeTransport({ id: "a/b", summary: "S" });
    await patchEvent(t, "tok", "a/b", { summary: "S" }, "work@group.calendar.google.com");
    expect(t.requests[0]!.url).toContain("/calendars/work%40group.calendar.google.com/events/a%2Fb");
  });
});

describe("listEvents search (finding an event to edit later)", () => {
  it("passes a free-text query as Calendar's q param", async () => {
    const t = new FakeTransport({ items: [{ id: "e9", summary: "Flight to Denver" }] });
    const evs = await listEvents(t, "tok", { query: "flight" });
    expect(t.requests[0]!.url).toContain("q=flight");
    expect(evs[0]!.id).toBe("e9"); // the id is what makes it addressable by patchEvent
  });

  it("omits q entirely when no query is given (or it's blank)", async () => {
    const t = new FakeTransport({ items: [] });
    await listEvents(t, "tok", {});
    expect(t.requests[0]!.url).not.toContain("q=");
    await listEvents(t, "tok", { query: "   " });
    expect(t.requests[1]!.url).not.toContain("q=");
  });

  it("honours an explicit PAST timeMin, so an event that already happened can be found", async () => {
    const t = new FakeTransport({ items: [] });
    await listEvents(t, "tok", { query: "flight", timeMin: "2020-01-01T00:00:00Z" });
    expect(t.requests[0]!.url).toContain("timeMin=2020-01-01T00%3A00%3A00Z");
  });
});

describe("all-day events (bare dates + Google's exclusive end)", () => {
  it("nextDayIso rolls across month and year ends", () => {
    expect(nextDayIso("2026-07-04")).toBe("2026-07-05");
    expect(nextDayIso("2026-07-31")).toBe("2026-08-01");
    expect(nextDayIso("2026-02-28")).toBe("2026-03-01");
    expect(nextDayIso("2028-02-28")).toBe("2028-02-29"); // leap year
    expect(nextDayIso("2026-12-31")).toBe("2027-01-01");
  });

  it("createEvent sends bare dates as an all-day event, bumping the exclusive end", async () => {
    // "July 4 → July 4" is how a one-day event is naturally written; Google needs the end to be the
    // day AFTER, and rejects an end that isn't strictly after the start.
    const t = new FakeTransport({ id: "e1", summary: "Holiday", start: { date: "2026-07-04" }, end: { date: "2026-07-05" } });
    const ev = await createEvent(t, "tok", { summary: "Holiday", start: "2026-07-04", end: "2026-07-04" });
    expect(t.requests[0]!.body).toMatchObject({ start: { date: "2026-07-04" }, end: { date: "2026-07-05" } });
    expect(ev.allDay).toBe(true);
  });

  it("createEvent keeps a multi-day all-day span's own end (bumped past the last day)", async () => {
    const t = new FakeTransport({ id: "e2", summary: "Trip" });
    await createEvent(t, "tok", { summary: "Trip", start: "2026-07-04", end: "2026-07-08" });
    expect(t.requests[0]!.body).toMatchObject({ start: { date: "2026-07-04" }, end: { date: "2026-07-08" } });
  });

  it("createEvent still sends timed events as dateTime (unchanged)", async () => {
    const t = new FakeTransport({ id: "e3", summary: "Call" });
    await createEvent(t, "tok", { summary: "Call", start: "2026-06-18T14:00:00-04:00", end: "2026-06-18T15:00:00-04:00" });
    expect(t.requests[0]!.body).toMatchObject({
      start: { dateTime: "2026-06-18T14:00:00-04:00" },
      end: { dateTime: "2026-06-18T15:00:00-04:00" },
    });
  });

  it("patchEvent applies the same all-day normalisation when moving both ends", async () => {
    const t = new FakeTransport({ id: "e1", summary: "Holiday" });
    await patchEvent(t, "tok", "e1", { start: "2026-07-04", end: "2026-07-04" });
    expect(t.requests[0]!.body).toEqual({
      start: { date: "2026-07-04", dateTime: null },
      end: { date: "2026-07-05", dateTime: null },
    });
  });
});

describe("converting an event between all-day and timed", () => {
  // Calendar's patch MERGES nested objects: sending only the new shape leaves the old key in place,
  // so the event would carry both `date` and `dateTime` — invalid, and the conversion appears to do
  // nothing. Each patch must null the shape it's replacing.
  it("all-day → timed nulls `date` while setting `dateTime`", async () => {
    const t = new FakeTransport({ id: "e1", summary: "Trip" });
    await patchEvent(t, "tok", "e1", { start: "2026-07-04T09:00:00-04:00", end: "2026-07-04T10:00:00-04:00" });
    expect(t.requests[0]!.body).toEqual({
      start: { dateTime: "2026-07-04T09:00:00-04:00", date: null },
      end: { dateTime: "2026-07-04T10:00:00-04:00", date: null },
    });
  });

  it("timed → all-day nulls `dateTime` while setting `date` (and keeps the exclusive end)", async () => {
    const t = new FakeTransport({ id: "e1", summary: "Trip" });
    await patchEvent(t, "tok", "e1", { start: "2026-07-04", end: "2026-07-04" });
    expect(t.requests[0]!.body).toEqual({
      start: { date: "2026-07-04", dateTime: null },
      end: { date: "2026-07-05", dateTime: null },
    });
  });

  it("patchTimeField states the shape and nulls the other, both ways", () => {
    expect(patchTimeField({ date: "2026-07-04" })).toEqual({ date: "2026-07-04", dateTime: null });
    expect(patchTimeField({ dateTime: "2026-07-04T09:00:00Z" })).toEqual({ dateTime: "2026-07-04T09:00:00Z", date: null });
  });

  it("a one-ended time patch is still shape-explicit", async () => {
    const t = new FakeTransport({ id: "e1", summary: "S" });
    await patchEvent(t, "tok", "e1", { end: "2026-07-04T11:00:00-04:00" });
    expect(t.requests[0]!.body).toEqual({ end: { dateTime: "2026-07-04T11:00:00-04:00", date: null } });
  });
});
