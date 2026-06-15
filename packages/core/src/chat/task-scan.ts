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

/** Present recent emails + upcoming events to the classifier, asking only for
 * actionable items (with the source id echoed so we can map the reply back). */
export function buildScanPrompt(emails: EmailSummary[], events: CalendarEvent[]): ChatTurn[] {
  const emailLines = emails
    .map((e) => `[email:${e.id}] from ${e.from} — ${e.subject} — ${e.snippet.slice(0, 200)}`)
    .join("\n");
  const eventLines = events
    .filter((e) => e.id)
    .map((e) => `[event:${e.id}] ${e.summary} — ${e.start}`)
    .join("\n");
  const system =
    "You triage a reader's recent email and upcoming calendar for things that genuinely NEED " +
    "ACTION with a deadline or required steps — renewals, appointments to prep for, bills/payments " +
    "due, forms to file, RSVPs, confirmations needing a reply. IGNORE newsletters, marketing, " +
    "promotions, social notifications, receipts, and pure FYI. Be conservative — only flag a real " +
    "to-do. For each, echo its exact id. Respond with ONLY a JSON array (empty array if nothing):\n" +
    '[{"id": "email:..." | "event:...", "title": "short task name", "reason": "why it needs action", ' +
    '"suggestedDeadlineIso": "ISO date or empty"}]';
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
