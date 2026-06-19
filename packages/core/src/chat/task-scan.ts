import type { ChatTurn } from "../providers/llm/chat.js";
import { stripThink } from "../providers/llm/extraction.js";
import type { CalendarEvent, EmailSummary } from "../providers/google.js";
import { isIgnored, sourceId, type IgnoreRule, type TaskCandidate, type TaskPlan } from "./tasks.js";

/**
 * Inbox/calendar SCAN classifier (Phase 2) — the prompt + parse layer that turns
 * recent emails + upcoming events into ACTIONABLE task candidates the user can one-
 * click into a plan. Pure (string in / candidates out), so the "what counts as
 * actionable" rule and the parsing live in one unit-tested place; the worker runs it
 * over the `ChatCapable.chat` seam during an idle scan, then dedups against existing
 * plans AND the user's ignore list so dismissed ads/bloat never come back.
 */

export const MAX_SCAN_CANDIDATES = 8;

/** Present recent emails + upcoming events to the classifier, asking for both one-off
 * to-dos AND upcoming events that need PLANNING/PREP ahead of time (with the source id
 * echoed so we can map the reply back). `todayIso` lets it pick sensible "arrange by" dates. */
export function buildScanPrompt(emails: EmailSummary[], events: CalendarEvent[], todayIso?: string): ChatTurn[] {
  const emailLines = emails
    .map((e) => `[email:${e.id}] from ${e.from} — ${e.subject} — ${e.snippet.slice(0, 200)}`)
    .join("\n");
  const eventLines = events
    .filter((e) => e.id)
    .map((e) => `[event:${e.id}] ${e.summary} — ${e.start}`)
    .join("\n");
  const system =
    `${todayIso ? `Today is ${todayIso}. ` : ""}You triage a reader's recent email and upcoming calendar and ` +
    "surface anything that's a GENUINE TASK for THIS person — use your own judgment about what they need to act " +
    "on, decide, reply to, or plan. There's no fixed checklist: it spans one-off to-dos with a deadline or steps " +
    "(renewals, appointments, bills/payments due, forms, RSVPs, replies someone is waiting on) AND upcoming things " +
    "that need PLANNING/PREP ahead of time — especially TRIPS and TRAVEL: use the EMAILS as evidence of what is " +
    "already booked and flag the GAP (e.g. a trip with NO flight/lodging confirmation visible), naming the gap in " +
    "the title and setting 'suggestedDeadlineIso' to a sensible ARRANGE-BY date BEFORE the event (book flights/" +
    "lodging early), not the event date.\n" +
    "Skip obvious marketing, newsletters, promotions, social notifications, and pure receipts/FYI with no action. " +
    "But DON'T be over-conservative — if something plausibly needs an action, a decision, a reply, or planning, " +
    "surface it; a borderline item the reader can dismiss beats a missed obligation. For each, echo its exact id. " +
    "Respond with ONLY a JSON array (empty if nothing genuinely needs action):\n" +
    '[{"id": "email:..." | "event:...", "title": "short task name", "reason": "why it needs action ' +
    'or what prep is missing", "suggestedDeadlineIso": "ISO date or empty"}]';
  const user =
    `RECENT EMAILS:\n${emailLines || "(none)"}\n\nUPCOMING EVENTS:\n${eventLines || "(none)"}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function stripFences(s: string): string {
  const t = s.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(t);
  return (m ? m[1]! : t).trim();
}

/**
 * Tolerant parse of the classifier reply into candidates. The model echoes a
 * `email:<id>` / `event:<id>` ref; we map it back to the actual email/event so the
 * candidate carries the real `from`/title (and ignore anything that doesn't match an
 * input, so the model can't fabricate ids).
 */
export function parseCandidates(
  raw: string,
  emails: EmailSummary[],
  events: CalendarEvent[],
): TaskCandidate[] {
  let arr: unknown;
  try {
    arr = JSON.parse(stripFences(stripThink(raw)));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const emailById = new Map(emails.map((e) => [e.id, e]));
  const eventById = new Map(events.filter((e) => e.id).map((e) => [e.id!, e]));
  const out: TaskCandidate[] = [];
  for (const item of arr) {
    if (item == null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const ref = typeof o.id === "string" ? o.id : "";
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!ref || !title) continue;
    const reason = typeof o.reason === "string" ? o.reason.trim() : "";
    const due = typeof o.suggestedDeadlineIso === "string" && o.suggestedDeadlineIso.trim() ? o.suggestedDeadlineIso.trim() : undefined;
    if (ref.startsWith("email:")) {
      const e = emailById.get(ref.slice(6));
      if (!e) continue;
      out.push({ source: { kind: "scan", emailId: e.id }, title, reason, from: e.from, ...(due ? { suggestedDeadlineIso: due } : {}) });
    } else if (ref.startsWith("event:")) {
      const ev = eventById.get(ref.slice(6));
      if (!ev) continue;
      out.push({ source: { kind: "scan", eventId: ev.id! }, title, reason, ...(due ? { suggestedDeadlineIso: due } : {}) });
    }
    if (out.length >= MAX_SCAN_CANDIDATES) break;
  }
  return out;
}

/** Drop candidates already turned into a plan or matching an ignore rule. */
export function dedupeCandidates(
  candidates: TaskCandidate[],
  existingPlans: readonly TaskPlan[],
  ignored: readonly IgnoreRule[],
): TaskCandidate[] {
  const planSourceIds = new Set(existingPlans.map((p) => sourceId(p.source)).filter((id): id is string => !!id));
  return candidates.filter((c) => {
    const id = sourceId(c.source);
    if (id && planSourceIds.has(id)) return false;
    return !isIgnored(ignored, c);
  });
}
