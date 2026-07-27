import type { Transport } from "./transport/transport.js";
import type { VisualReaderStore } from "../storage/store.js";

/**
 * Google integration — Gmail (read + draft/send), Calendar (read + create), Tasks (read + create).
 * OAuth 2.0 with PKCE against the user's OWN Google Cloud OAuth client (no app
 * backend); the desktop shell runs the consent + loopback redirect, this module does
 * the token exchange/refresh and the API calls through the Transport seam (so the
 * desktop CORS proxy carries them). Read + create + draft/send email, never delete,
 * matching the chosen permission scope.
 *
 * The PARSERS (Gmail message → email, API item → event/task) are pure and unit-tested;
 * the network functions take an injected Transport so they're testable with a fake.
 */

/**
 * Read Gmail + read/create Calendar events + read/create Tasks.
 *
 * `calendar.events` grants reading/creating events, but NOT listing the user's calendars
 * (`calendarList.list` → 403 "insufficient authentication scopes"), which the calendar grid
 * and the email+calendar sweep both need. `calendar.readonly` supplies that calendar-list read
 * (and read of events on every calendar) while `calendar.events` keeps the create path —
 * read-everything + create-events, never delete, matching the app's Google posture.
 *
 * NOTE: this list changed — anyone who connected Google before it did has a token without the
 * new scope and must reconnect (Settings → Google → disconnect, then Connect) to clear the 403.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  // gmail.compose creates DRAFTS (the safe default — the reader reviews + sends); gmail.send lets
  // the buddy send directly when the reader explicitly asks. Both are added together so a single
  // reconnect grants the whole email-write posture.
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/tasks",
] as const;

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export interface GoogleTokens {
  accessToken: string;
  /** Long-lived; only returned on the FIRST exchange (offline access). */
  refreshToken?: string;
  /** ms epoch when the access token expires. */
  expiresAt: number;
}

// ----------------------------------------------------------------- OAuth (PKCE)

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A PKCE verifier + its S256 challenge (Web Crypto). */
export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/** The Google consent URL to open in the browser (offline access + forced consent so a
 * refresh token always comes back). */
export function buildGoogleAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes?: readonly string[];
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: (opts.scopes ?? GOOGLE_SCOPES).join(" "),
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(transport: Transport, fields: Record<string, string>): Promise<GoogleTokens> {
  const res = await transport.send({ url: TOKEN_ENDPOINT, method: "POST", formEncoded: fields });
  const data = await res.json<RawTokenResponse>().catch(() => ({}) as RawTokenResponse);
  if (!res.ok || !data.access_token) {
    throw new Error(`Google token request failed: ${data.error_description || data.error || res.status}`);
  }
  return {
    accessToken: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

/** Exchange the consent `code` for tokens (first time → includes a refresh token). */
export function exchangeGoogleCode(opts: {
  transport: Transport;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<GoogleTokens> {
  return tokenRequest(opts.transport, {
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
}

/** Get a fresh access token from the stored refresh token. */
export function refreshGoogleToken(opts: {
  transport: Transport;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<GoogleTokens> {
  return tokenRequest(opts.transport, {
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
}

// ------------------------------------------------------------- token storage

/** Store key for the persisted Google tokens (refresh token survives reloads). */
export const GOOGLE_TOKENS_KEY = "google-tokens";

export async function loadGoogleTokens(store: VisualReaderStore): Promise<GoogleTokens | undefined> {
  try {
    const raw = await store.getMemo?.(GOOGLE_TOKENS_KEY);
    if (!raw) return undefined;
    const t = JSON.parse(raw) as GoogleTokens;
    return typeof t?.accessToken === "string" ? t : undefined;
  } catch {
    return undefined;
  }
}

export async function saveGoogleTokens(store: VisualReaderStore, tokens: GoogleTokens): Promise<void> {
  await store.putMemo?.(GOOGLE_TOKENS_KEY, JSON.stringify(tokens));
}

export async function clearGoogleTokens(store: VisualReaderStore): Promise<void> {
  await store.deleteMemo?.(GOOGLE_TOKENS_KEY);
}

/**
 * A currently-valid access token: returns the stored one, or refreshes (and persists
 * the new one, keeping the refresh token) when it's within a minute of expiry. Throws
 * when Google isn't connected. Used by every API call.
 */
export async function getFreshAccessToken(
  store: VisualReaderStore,
  opts: { clientId: string; clientSecret: string; transport: Transport },
): Promise<string> {
  const tokens = await loadGoogleTokens(store);
  if (!tokens) throw new Error("Google isn't connected — connect it in Settings.");
  if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
  if (!tokens.refreshToken) throw new Error("Google session expired — reconnect it in Settings.");
  const refreshed = await refreshGoogleToken({
    transport: opts.transport,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    refreshToken: tokens.refreshToken,
  });
  const merged: GoogleTokens = { ...refreshed, refreshToken: refreshed.refreshToken ?? tokens.refreshToken };
  await saveGoogleTokens(store, merged);
  return merged.accessToken;
}

// -------------------------------------------------------------------- API calls

async function apiGet<T>(transport: Transport, token: string, url: string): Promise<T> {
  const res = await transport.send({ url, method: "GET", headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(await apiError(res));
  return res.json<T>();
}

async function apiPost<T>(transport: Transport, token: string, url: string, body: unknown): Promise<T> {
  const res = await transport.send({
    url,
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body,
  });
  if (!res.ok) throw new Error(await apiError(res));
  return res.json<T>();
}

async function apiError(res: { status: number; json: <T>() => Promise<T> }): Promise<string> {
  const data = await res.json<{ error?: { message?: string } }>().catch(() => undefined);
  return `Google API error ${res.status}${data?.error?.message ? `: ${data.error.message}` : ""}`;
}

// --------------------------------------------------------------------- Gmail

export interface EmailSummary {
  id: string;
  from: string;
  /** Recipients, as the raw header ("A <a@x>, B <b@y>"). Absent when the header isn't set. Needed for
   * any "who was this sent to / who hasn't replied" question — without it the assistant can see a
   * thread but not who's on it. */
  to?: string;
  cc?: string;
  subject: string;
  date: string;
  snippet: string;
}
/** A file attached to an email — its id lets us download the bytes via gmailGetAttachment. */
export interface EmailAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
}
export interface EmailFull extends EmailSummary {
  body: string;
  /** Attached files (omitted when none) — so the agent can SEE what's attached and pull it in. */
  attachments?: EmailAttachment[];
}

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType?: string;
  /** Set on attachment parts (a real file); empty on inline body parts. */
  filename?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  snippet?: string;
  payload?: { headers?: GmailHeader[] } & GmailPart;
}

/** Decode Gmail's base64url to raw bytes (attachments + binary bodies). */
export function decodeBase64UrlBytes(data: string): Uint8Array {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Decode Gmail's base64url body data to a UTF-8 string. */
export function decodeBase64Url(data: string): string {
  return new TextDecoder().decode(decodeBase64UrlBytes(data));
}

function header(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Walk the MIME tree for the first text/plain body (falling back to text/html, stripped). */
function bodyText(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const t = bodyText(child);
    if (t) return t;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return decodeBase64Url(part.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  return "";
}

/** Collect every attachment part (a part with a filename + attachmentId) from the MIME tree. */
function collectAttachments(part: GmailPart | undefined, out: EmailAttachment[] = []): EmailAttachment[] {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) {
    out.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType ?? "application/octet-stream",
    });
  }
  for (const child of part.parts ?? []) collectAttachments(child, out);
  return out;
}

/** Pure: a Gmail message JSON → a structured email (PURE — unit-tested). */
export function parseGmailMessage(msg: GmailMessage): EmailFull {
  const headers = msg.payload?.headers;
  const attachments = collectAttachments(msg.payload);
  return {
    id: msg.id,
    from: header(headers, "From"),
    // Only when actually present — an absent header reads as "" and an empty To: is noise.
    ...(header(headers, "To") ? { to: header(headers, "To") } : {}),
    ...(header(headers, "Cc") ? { cc: header(headers, "Cc") } : {}),
    subject: header(headers, "Subject"),
    date: header(headers, "Date"),
    snippet: msg.snippet ?? "",
    body: bodyText(msg.payload).trim(),
    ...(attachments.length ? { attachments } : {}),
  };
}

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Search the inbox (Gmail query syntax, e.g. "is:unread from:acme"); returns metadata. */
export async function gmailSearch(
  transport: Transport,
  token: string,
  query: string,
  max = 10,
): Promise<EmailSummary[]> {
  const list = await apiGet<{ messages?: { id: string }[] }>(
    transport,
    token,
    `${GMAIL}/messages?maxResults=${Math.min(25, Math.max(1, max))}&q=${encodeURIComponent(query)}`,
  );
  const ids = (list.messages ?? []).map((m) => m.id);
  const msgs = await Promise.all(
    ids.map((id) =>
      apiGet<GmailMessage>(
        transport,
        token,
        // Ask for To/Cc as well: `format=metadata` returns ONLY the headers named here, so leaving them
        // out is why a search result could never show who an email was addressed to.
        `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`,
      ),
    ),
  );
  return msgs.map((m) => {
    const { body: _body, ...summary } = parseGmailMessage(m);
    return summary;
  });
}

/** Full text of one email (for pulling into the chat to summarize/re-work). */
export async function gmailReadEmail(transport: Transport, token: string, id: string): Promise<EmailFull> {
  return parseGmailMessage(await apiGet<GmailMessage>(transport, token, `${GMAIL}/messages/${id}?format=full`));
}

/** Download one attachment's raw bytes (by the ids from `EmailFull.attachments`). */
export async function gmailGetAttachment(
  transport: Transport,
  token: string,
  messageId: string,
  attachmentId: string,
): Promise<Uint8Array> {
  const data = await apiGet<{ data?: string }>(
    transport,
    token,
    `${GMAIL}/messages/${messageId}/attachments/${attachmentId}`,
  );
  return decodeBase64UrlBytes(data.data ?? "");
}

/** The connected account's email address (also verifies the token works). */
export async function getGoogleEmail(transport: Transport, token: string): Promise<string> {
  const p = await apiGet<{ emailAddress?: string }>(transport, token, `${GMAIL}/profile`);
  return p.emailAddress ?? "";
}

/** An outgoing email's fields (shared by draft + send). */
export interface EmailDraft {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
}

/** Standard base64 (with padding) — for the RFC-2047 encoded-word inside a header, which
 * uses normal base64, unlike the base64URL of the message envelope. */
function base64Std(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Pure: an {@link EmailDraft} → the base64url-encoded RFC-822 message the Gmail API wants.
 * Recipients are comma-joined; empty cc/bcc headers are omitted; a non-ASCII subject is
 * RFC-2047 (UTF-8/base64) encoded; the body is sent as UTF-8 text/plain. Unit-tested.
 */
export function buildRawEmail(d: EmailDraft): string {
  const enc = new TextEncoder();
  // RFC-2047-encode the subject when it carries any non-ASCII char (a raw header must be 7-bit).
  const nonAscii = [...d.subject].some((ch) => ch.charCodeAt(0) > 127);
  const subject = nonAscii ? `=?UTF-8?B?${base64Std(enc.encode(d.subject))}?=` : d.subject;
  const headers = [
    `To: ${d.to.join(", ")}`,
    ...(d.cc && d.cc.length ? [`Cc: ${d.cc.join(", ")}`] : []),
    ...(d.bcc && d.bcc.length ? [`Bcc: ${d.bcc.join(", ")}`] : []),
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  return base64Url(enc.encode(`${headers.join("\r\n")}\r\n\r\n${d.body}`));
}

/** Create a Gmail DRAFT (the reader reviews + sends from Gmail). Needs the gmail.compose scope. */
export async function createDraft(
  transport: Transport,
  token: string,
  d: EmailDraft,
): Promise<{ id: string; message?: { id?: string; threadId?: string } }> {
  return apiPost(transport, token, `${GMAIL}/drafts`, { message: { raw: buildRawEmail(d) } });
}

/** SEND an email directly (only when the reader explicitly asks). Needs the gmail.send scope. */
export async function sendEmail(
  transport: Transport,
  token: string,
  d: EmailDraft,
): Promise<{ id: string; threadId?: string }> {
  return apiPost(transport, token, `${GMAIL}/messages/send`, { raw: buildRawEmail(d) });
}

// ------------------------------------------------------------------- Calendar

export interface CalendarEvent {
  id?: string;
  summary: string;
  /** ISO datetime (or date for all-day). */
  start: string;
  end: string;
  description?: string;
  location?: string;
  /** Which calendar this came from + its colour (set by listEvents for the grid view). */
  calendarId?: string;
  color?: string;
  /** True when start carries no time (an all-day event). */
  allDay?: boolean;
}

/** One of the user's calendars. */
export interface GoogleCalendar {
  id: string;
  summary: string;
  primary?: boolean;
  backgroundColor?: string;
}

interface RawEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

/** Pure: a Calendar API item → a CalendarEvent (PURE — unit-tested). */
export function parseCalendarEvent(e: RawEvent): CalendarEvent {
  return {
    ...(e.id ? { id: e.id } : {}),
    summary: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    ...(e.start?.date && !e.start?.dateTime ? { allDay: true } : {}),
    ...(e.description ? { description: e.description } : {}),
    ...(e.location ? { location: e.location } : {}),
  };
}

const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars";

/** Events from one calendar (default "primary"), in a window (default: from now). */
export async function listEvents(
  transport: Transport,
  token: string,
  opts: { max?: number; timeMin?: string; timeMax?: string; calendarId?: string; query?: string } = {},
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    maxResults: String(Math.min(250, Math.max(1, opts.max ?? 10))),
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: opts.timeMin ?? new Date().toISOString(),
    ...(opts.timeMax ? { timeMax: opts.timeMax } : {}),
    // Free-text search across an event's title/description/location — how an event is FOUND when its
    // id isn't already at hand (a later session, or a scheduled run, that needs to update "the flight").
    ...(opts.query?.trim() ? { q: opts.query.trim() } : {}),
  });
  const cal = encodeURIComponent(opts.calendarId ?? "primary");
  const data = await apiGet<{ items?: RawEvent[] }>(transport, token, `${CAL_BASE}/${cal}/events?${params.toString()}`);
  return (data.items ?? []).map(parseCalendarEvent);
}

/** The user's calendars (for the calendar view — show events across all of them). */
export async function listCalendars(transport: Transport, token: string): Promise<GoogleCalendar[]> {
  const data = await apiGet<{ items?: { id?: string; summary?: string; primary?: boolean; backgroundColor?: string }[] }>(
    transport,
    token,
    "https://www.googleapis.com/calendar/v3/users/me/calendarList",
  );
  return (data.items ?? [])
    .filter((c): c is { id: string } & typeof c => typeof c.id === "string")
    .map((c) => ({
      id: c.id,
      summary: c.summary ?? c.id,
      ...(c.primary ? { primary: true } : {}),
      ...(c.backgroundColor ? { backgroundColor: c.backgroundColor } : {}),
    }));
}

/** Events across ALL the user's calendars in a window (each tagged with its colour) —
 * the data behind the in-app calendar grid. Bounded per calendar. */
export async function listAllEvents(
  transport: Transport,
  token: string,
  opts: { timeMin: string; timeMax: string; maxCalendars?: number },
): Promise<CalendarEvent[]> {
  // calendarList.list needs a calendar-list read scope (calendar.readonly). A token issued
  // before that scope was added (or a user who hasn't reconnected) 403s here — so fall back to
  // just the PRIMARY calendar, which calendar.events already covers. The calendar still loads
  // instead of failing the whole sweep; reconnecting unlocks every calendar.
  let calendars: GoogleCalendar[];
  try {
    calendars = (await listCalendars(transport, token)).slice(0, opts.maxCalendars ?? 12);
  } catch {
    calendars = [{ id: "primary", summary: "Primary", primary: true }];
  }
  const lists = await Promise.all(
    calendars.map((c) =>
      listEvents(transport, token, { calendarId: c.id, timeMin: opts.timeMin, timeMax: opts.timeMax, max: 250 })
        .then((evs) => evs.map((e) => ({ ...e, calendarId: c.id, ...(c.backgroundColor ? { color: c.backgroundColor } : {}) })))
        .catch(() => [] as CalendarEvent[]),
    ),
  );
  return lists.flat();
}

/** The day after a "YYYY-MM-DD" (calendar-correct across month/year ends). PURE. */
export function nextDayIso(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
}

/**
 * Normalise an event's start/end for the API. A bare "YYYY-MM-DD" on BOTH ends means an ALL-DAY
 * event, where Google's `end.date` is EXCLUSIVE — the day AFTER the last day. Callers (and the model)
 * naturally write "July 4 → July 4" for a one-day event, which the API rejects for not being strictly
 * after the start, so the end is bumped to the next day. PURE.
 */
export function eventTimeFields(start: string, end: string): { start: { date: string } | { dateTime: string }; end: { date: string } | { dateTime: string } } {
  const s = eventTimeField(start);
  let e = eventTimeField(end);
  if ("date" in s && "date" in e && e.date <= s.date) e = { date: nextDayIso(s.date) };
  return { start: s, end: e };
}

/** Create an event. `start`/`end` are ISO datetimes (with offset or Z) — or bare "YYYY-MM-DD" dates
 * for an ALL-DAY event (see eventTimeFields for the exclusive-end handling). */
export async function createEvent(
  transport: Transport,
  token: string,
  ev: { summary: string; start: string; end: string; description?: string; location?: string },
): Promise<CalendarEvent> {
  const body = {
    summary: ev.summary,
    ...eventTimeFields(ev.start, ev.end),
    ...(ev.description ? { description: ev.description } : {}),
    ...(ev.location ? { location: ev.location } : {}),
  };
  return parseCalendarEvent(await apiPost<RawEvent>(transport, token, `${CAL_BASE}/primary/events`, body));
}

/** One event by id — used to read what an event already says before adding to it. */
export async function getEvent(transport: Transport, token: string, id: string, calendarId = "primary"): Promise<CalendarEvent> {
  const cal = encodeURIComponent(calendarId);
  return parseCalendarEvent(await apiGet<RawEvent>(transport, token, `${CAL_BASE}/${cal}/events/${encodeURIComponent(id)}`));
}

/** A start/end value as Calendar wants it: a bare "YYYY-MM-DD" is an ALL-DAY date, anything else a
 * datetime. Sending `dateTime` for a bare date would silently convert an all-day event into a timed
 * one at midnight. PURE. */
export function eventTimeField(value: string): { date: string } | { dateTime: string } {
  const v = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : { dateTime: value };
}

/**
 * The same start/end value, but stated as a full PATCH field: the shape being set, and the OTHER one
 * explicitly `null`.
 *
 * Calendar's patch MERGES nested objects, so sending only the new shape when CONVERTING an event
 * between all-day and timed leaves the old key in place — the event ends up carrying both `date` and
 * `dateTime`, which is invalid (the API rejects it, or keeps the stale one and appears to ignore the
 * change). Nulling the other key asserts the intended shape outright. On an event that's already the
 * target shape it's a harmless no-op, so every patch can use it. PURE.
 */
export function patchTimeField(field: { date: string } | { dateTime: string }): { date: string | null; dateTime: string | null } {
  return "date" in field ? { date: field.date, dateTime: null } : { dateTime: field.dateTime, date: null };
}

/**
 * Update an existing event in place (PATCH — only the fields given change).
 *
 * `appendDescription` is the "add what we learned to this event" path: Calendar's PATCH REPLACES a
 * field wholesale, so appending has to read the current description and send the combined text, or
 * each new note would erase the last one. Everything else is a straight replace.
 */
export async function patchEvent(
  transport: Transport,
  token: string,
  id: string,
  patch: { summary?: string; start?: string; end?: string; description?: string; appendDescription?: string; location?: string },
  calendarId = "primary",
): Promise<CalendarEvent> {
  const body: Record<string, unknown> = {};
  if (patch.summary !== undefined) body.summary = patch.summary;
  if (patch.start !== undefined && patch.end !== undefined) {
    // Both ends move together → same all-day exclusive-end normalisation as creating one.
    const { start, end } = eventTimeFields(patch.start, patch.end);
    body.start = patchTimeField(start);
    body.end = patchTimeField(end);
  } else {
    if (patch.start !== undefined) body.start = patchTimeField(eventTimeField(patch.start));
    if (patch.end !== undefined) body.end = patchTimeField(eventTimeField(patch.end));
  }
  if (patch.location !== undefined) body.location = patch.location;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.appendDescription) {
    // An explicit `description` in the same call wins as the base to append onto; otherwise read the
    // event's current text (one extra GET, only on the append path).
    const existing = patch.description ?? (await getEvent(transport, token, id, calendarId)).description ?? "";
    body.description = existing.trim() ? `${existing.trimEnd()}\n${patch.appendDescription}` : patch.appendDescription;
  }
  if (Object.keys(body).length === 0) throw new Error("nothing to update — pass at least one field to change");
  const cal = encodeURIComponent(calendarId);
  const res = await transport.send({
    url: `${CAL_BASE}/${cal}/events/${encodeURIComponent(id)}`,
    method: "PATCH",
    headers: { authorization: `Bearer ${token}` },
    body,
  });
  if (!res.ok) throw new Error(await apiError(res));
  return parseCalendarEvent(await res.json<RawEvent>());
}

// ---------------------------------------------------------------------- Tasks

export interface TaskItem {
  id?: string;
  title: string;
  notes?: string;
  /** RFC 3339 date (the API only honours the date part). */
  due?: string;
  status?: string;
}

interface RawTask {
  id?: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: string;
  /** Present on a sub-task — the id of the task it's nested under. */
  parent?: string;
}

/** Pure: a Tasks API item → a TaskItem (PURE — unit-tested). */
export function parseTask(t: RawTask): TaskItem {
  return {
    ...(t.id ? { id: t.id } : {}),
    title: t.title ?? "(untitled)",
    ...(t.notes ? { notes: t.notes } : {}),
    ...(t.due ? { due: t.due } : {}),
    ...(t.status ? { status: t.status } : {}),
  };
}

const TASKS = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks";

/** Open to-do items from the default list. */
export async function listTasks(transport: Transport, token: string, max = 20): Promise<TaskItem[]> {
  const data = await apiGet<{ items?: RawTask[] }>(
    transport,
    token,
    `${TASKS}?showCompleted=false&maxResults=${Math.min(50, Math.max(1, max))}`,
  );
  return (data.items ?? []).map(parseTask);
}

/** All sub-tasks under a parent task, INCLUDING completed/hidden ones — so a re-plan can reconcile
 * against what's already in Google without creating duplicates or losing completed history. */
export async function listSubtasks(
  transport: Transport,
  token: string,
  parentId: string,
): Promise<{ id: string; title: string; status?: string }[]> {
  const data = await apiGet<{ items?: RawTask[] }>(
    transport,
    token,
    `${TASKS}?showCompleted=true&showHidden=true&maxResults=100`,
  );
  return (data.items ?? [])
    .filter((t): t is RawTask & { id: string } => t.parent === parentId && !!t.id)
    .map((t) => ({ id: t.id, title: t.title ?? "", ...(t.status ? { status: t.status } : {}) }));
}

/** Top-level to-dos from the default list, each with its nested sub-tasks (a single Google Tasks
 * read; the API returns parents + children flat, re-joined here by `parent`). Includes completed/
 * hidden items and all ids so the app can mirror Google Tasks back into its own list and reconcile
 * against what it created (matching by id) instead of duplicating. */
export async function listTaskTree(
  transport: Transport,
  token: string,
  max = 500,
): Promise<{ id: string; title: string; notes?: string; due?: string; status?: string; subtasks: { id: string; title: string; status?: string }[] }[]> {
  // PAGINATE: a single list page maxes at 100 items, and that page COUNTS SUB-TASKS (the API returns
  // a flat list — sub-tasks carry a `parent`), so one page can drop parents. Follow nextPageToken up
  // to `max` total / a bounded page count, then nest. Most accounts fit one page (no extra calls).
  const items: RawTask[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20 && items.length < max; page++) {
    const url =
      `${TASKS}?showCompleted=true&showHidden=true&maxResults=100` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const data = await apiGet<{ items?: RawTask[]; nextPageToken?: string }>(transport, token, url);
    items.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return items
    .filter((t): t is RawTask & { id: string } => !!t.id && !t.parent)
    .map((t) => ({
      id: t.id,
      title: t.title ?? "(untitled)",
      ...(t.notes ? { notes: t.notes } : {}),
      ...(t.due ? { due: t.due } : {}),
      ...(t.status ? { status: t.status } : {}),
      subtasks: items
        .filter((s): s is RawTask & { id: string } => s.parent === t.id && !!s.id)
        .map((s) => ({ id: s.id, title: s.title ?? "", ...(s.status ? { status: s.status } : {}) })),
    }));
}

/** Google Tasks wants an RFC 3339 timestamp for `due` (it only honours the date part). Plans
 * carry a bare `YYYY-MM-DD` deadline, which the API REJECTS with a 400 — silently dropping the
 * task (or sub-task) whose write then fails. Widen a bare date to midnight UTC, pass through a
 * value that already has a time, and omit anything unrecognisable rather than send a malformed
 * `due`. PURE — unit-tested. */
export function toTaskDue(due: string | undefined): string | undefined {
  if (!due) return undefined;
  const s = due.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s; // already a date-time
  return undefined; // unrecognised — better to omit than have Google reject the whole insert
}

/** Add a to-do. `due` is a date or RFC 3339 timestamp (normalised; the API honours the date part). */
export async function createTask(
  transport: Transport,
  token: string,
  t: { title: string; notes?: string; due?: string; parent?: string; previous?: string },
): Promise<TaskItem> {
  // `parent` nests this task under another (a sub-task); `previous` keeps insertion order.
  const params = new URLSearchParams();
  if (t.parent) params.set("parent", t.parent);
  if (t.previous) params.set("previous", t.previous);
  const url = params.toString() ? `${TASKS}?${params.toString()}` : TASKS;
  const due = toTaskDue(t.due);
  const body = {
    title: t.title,
    ...(t.notes ? { notes: t.notes } : {}),
    ...(due ? { due } : {}),
  };
  return parseTask(await apiPost<RawTask>(transport, token, url, body));
}

/** Create a PARENT task plus nested SUB-TASKS in Google Tasks, preserving order. Google Tasks
 * supports a single level of nesting (parent + children), which is exactly this shape. */
export async function createTaskGroup(
  transport: Transport,
  token: string,
  group: { title: string; notes?: string; due?: string; subtasks: { title: string; notes?: string; due?: string }[] },
): Promise<{ parent: TaskItem; subtasks: TaskItem[] }> {
  const parent = await createTask(transport, token, {
    title: group.title,
    ...(group.notes ? { notes: group.notes } : {}),
    ...(group.due ? { due: group.due } : {}),
  });
  const subtasks: TaskItem[] = [];
  let previous: string | undefined;
  for (const st of group.subtasks) {
    const child = await createTask(transport, token, {
      title: st.title,
      ...(st.notes ? { notes: st.notes } : {}),
      ...(st.due ? { due: st.due } : {}),
      ...(parent.id ? { parent: parent.id } : {}),
      ...(previous ? { previous } : {}),
    });
    subtasks.push(child);
    if (child.id) previous = child.id;
  }
  return { parent, subtasks };
}

/** Flip a to-do's completion and/or update its notes (the remote-bus write-back when a
 * step is finished in-app, or an answer is posted back). Read+create+update only — no delete. */
export async function patchTask(
  transport: Transport,
  token: string,
  id: string,
  patch: { status?: "completed" | "needsAction"; notes?: string },
): Promise<TaskItem> {
  const body: Record<string, unknown> = {};
  if (patch.status) body.status = patch.status;
  if (patch.notes !== undefined) body.notes = patch.notes;
  const res = await transport.send({
    url: `${TASKS}/${encodeURIComponent(id)}`,
    method: "PATCH",
    headers: { authorization: `Bearer ${token}` },
    body,
  });
  if (!res.ok) throw new Error(await apiError(res));
  return parseTask(await res.json<RawTask>());
}

/** Whether a single Google Task still exists — used to CONFIRM a deletion (the task tree caps at
 * 100, so "absent from the tree" alone could be truncation). Returns false ONLY on a definitive
 * 404/410 (deleted); a present task → true; any other error THROWS so a network blip is never
 * mistaken for a deletion. */
export async function googleTaskExists(transport: Transport, token: string, id: string): Promise<boolean> {
  const res = await transport.send({
    url: `${TASKS}/${encodeURIComponent(id)}`,
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404 || res.status === 410) return false;
  if (!res.ok) throw new Error(await apiError(res));
  return true;
}
