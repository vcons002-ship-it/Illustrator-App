import { describe, expect, it } from "vitest";
import { buildScanPrompt, dedupeCandidates, parseCandidates } from "./task-scan.js";
import { normalizeTaskPlan, type IgnoreRule } from "./tasks.js";
import type { CalendarEvent, EmailSummary } from "../providers/google.js";

const emails: EmailSummary[] = [
  { id: "m1", from: "DMV <noreply@dmv.gov>", subject: "Registration renewal due", date: "d", snippet: "renew by July 31" },
  { id: "m2", from: "deals@shop.com", subject: "50% OFF SALE", date: "d", snippet: "buy now" },
];
const events: CalendarEvent[] = [{ id: "e1", summary: "Dentist", start: "2026-06-20T14:00:00Z", end: "2026-06-20T15:00:00Z" }];

describe("buildScanPrompt", () => {
  it("lists emails+events with ids and asks only for actionable items", () => {
    const [sys, user] = buildScanPrompt(emails, events);
    expect(sys!.content).toMatch(/IGNORE newsletters, marketing/);
    expect(sys!.content).toMatch(/JSON array/);
    expect(user!.content).toContain("[email:m1]");
    expect(user!.content).toContain("[event:e1]");
  });
});

describe("parseCandidates", () => {
  it("maps echoed ids back to the real email/event (and ignores fabricated ids)", () => {
    const raw = JSON.stringify([
      { id: "email:m1", title: "Renew registration", reason: "due July 31", suggestedDeadlineIso: "2026-07-31" },
      { id: "event:e1", title: "Prep for dentist", reason: "appointment" },
      { id: "email:ghost", title: "fabricated", reason: "x" }, // not in inputs → dropped
    ]);
    const cands = parseCandidates(raw, emails, events);
    expect(cands).toHaveLength(2);
    expect(cands[0]).toEqual({
      source: { kind: "scan", emailId: "m1" },
      title: "Renew registration",
      reason: "due July 31",
      from: "DMV <noreply@dmv.gov>",
      suggestedDeadlineIso: "2026-07-31",
    });
    expect(cands[1]!.source).toEqual({ kind: "scan", eventId: "e1" });
  });

  it("tolerates <think>/fences and returns [] on junk", () => {
    expect(parseCandidates("<think>hmm</think>```json\n[]\n```", emails, events)).toEqual([]);
    expect(parseCandidates("not json", emails, events)).toEqual([]);
  });
});

describe("dedupeCandidates", () => {
  it("drops candidates already planned or matching an ignore rule", () => {
    const cands = parseCandidates(
      JSON.stringify([
        { id: "email:m1", title: "Renew registration", reason: "" },
        { id: "event:e1", title: "Prep for dentist", reason: "" },
      ]),
      emails,
      events,
    );
    const existingPlan = normalizeTaskPlan({ title: "Renew", source: { kind: "scan", emailId: "m1" }, steps: [{ title: "s" }] });
    const ignored: IgnoreRule[] = [{ kind: "phrase", value: "dentist", at: 1 }];
    const kept = dedupeCandidates(cands, [existingPlan], ignored);
    expect(kept).toEqual([]); // m1 already planned, dentist ignored by phrase
  });
});
