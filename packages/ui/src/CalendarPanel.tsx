import { t } from "./design/tokens.js";
import { memo, useMemo, useState } from "react";
import type { CalendarEvent } from "@visual-reader/core";
import { ModalShell } from "./ModalShell.js";

/**
 * An in-app month-grid calendar synced with the user's Google calendar(s). Shows every
 * event pulled by the worker (tagged with its source calendar's colour) plus the
 * deadlines of the Task Orchestrator's plans/steps, so the schedule the assistant builds
 * and the user's real calendar live in one view. Pure presentation — the visible range's
 * events are fetched by App via the `loadCalendar` worker op and passed straight in.
 */
export interface CalendarDeadline {
  /** YYYY-MM-DD the item is due. */
  date: string;
  title: string;
  /** Which plan it belongs to, so a click can open the task. */
  planId?: string;
}

export interface CalendarPanelProps {
  /** Google events for (at least) the visible month, each colour-tagged by calendar. */
  events: CalendarEvent[];
  /** Task-plan / step deadlines to overlay as markers. */
  deadlines?: CalendarDeadline[];
  /** First day of the month currently shown. */
  month: Date;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  /** Jump to a plan when its deadline marker is clicked. */
  onOpenTask?: (planId: string) => void;
  /** Create a calendar event on the selected day (shown only when present, i.e. Google connected). */
  onCreateEvent?: (ev: { summary: string; start: string; end: string; description?: string; location?: string }) => Promise<{ ok: boolean; error?: string }>;
  /** Edit an existing event IN GOOGLE (only the given fields change). Present ⇒ each event in the
   * day list gets an Edit control. The change is written straight through to the user's calendar, so
   * what the assistant records and what the user types here land in the same place. */
  onUpdateEvent?: (
    eventId: string,
    patch: { summary?: string; start?: string; end?: string; description?: string; location?: string },
    calendarId?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
  loading?: boolean;
  /** When set, the last Google sync failed — shown in the header (the last-good grid stays). */
  error?: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Local YYYY-MM-DD key for a Date (calendar cells are local-day buckets). */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The (local) start day of an event. All-day dates are already YYYY-MM-DD. */
function eventStartDay(ev: CalendarEvent): string {
  if (ev.allDay) return ev.start.slice(0, 10);
  const t = Date.parse(ev.start);
  return Number.isNaN(t) ? ev.start.slice(0, 10) : dayKey(new Date(t));
}

/**
 * EVERY local day an event covers, so a multi-day event (a week-long trip) shows across all its
 * days, not just the start. All-day events use Google's EXCLUSIVE end date (the end is the day
 * AFTER the last day), so we step back one day for the last covered day. Capped at 366 days so a
 * malformed event can't blow up the grid. Returns at least the start day.
 */
function eventDayKeys(ev: CalendarEvent): string[] {
  const startKey = eventStartDay(ev);
  let endKey = startKey;
  if (ev.end) {
    if (ev.allDay) {
      const endExcl = new Date(`${ev.end.slice(0, 10)}T00:00:00`);
      endExcl.setDate(endExcl.getDate() - 1); // all-day end is exclusive
      endKey = dayKey(endExcl);
    } else {
      const t = Date.parse(ev.end);
      if (!Number.isNaN(t)) endKey = dayKey(new Date(t));
    }
  }
  if (endKey <= startKey) return [startKey];
  const keys: string[] = [];
  const cur = new Date(`${startKey}T00:00:00`);
  const last = new Date(`${endKey}T00:00:00`);
  for (let i = 0; i < 366 && cur <= last; i++) {
    keys.push(dayKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return keys.length ? keys : [startKey];
}

function timeLabel(ev: CalendarEvent): string {
  if (ev.allDay) return "";
  const t = Date.parse(ev.start);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Local "HH:MM" for an ISO datetime — what an `<input type="time">` wants. Empty when unparseable
 * (or for a bare all-day date, which carries no clock time). */
function clockOf(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const CalendarPanel = memo(function CalendarPanel({
  events,
  deadlines = [],
  month,
  onPrev,
  onNext,
  onToday,
  onOpenTask,
  onCreateEvent,
  onUpdateEvent,
  onClose,
  loading = false,
  error,
}: CalendarPanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  // Inline "+ Add event" form (for the selected day): summary + times + optional location.
  const [adding, setAdding] = useState(false);
  const [evSummary, setEvSummary] = useState("");
  const [evStart, setEvStart] = useState("09:00");
  const [evEnd, setEvEnd] = useState("10:00");
  const [evLocation, setEvLocation] = useState("");
  const [evAllDay, setEvAllDay] = useState(false);
  const [evBusy, setEvBusy] = useState(false);
  const [evError, setEvError] = useState<string | null>(null);
  const submitEvent = async () => {
    if (!onCreateEvent || !selected || !evSummary.trim()) return;
    let startIso: string;
    let endIso: string;
    if (evAllDay) {
      // All-day: send BARE dates. The API layer handles Google's exclusive end date (a one-day event
      // ends the FOLLOWING day), so the selected day on both ends is exactly right here.
      startIso = selected;
      endIso = selected;
    } else {
      const start = new Date(`${selected}T${evStart || "09:00"}`);
      const end = new Date(`${selected}T${evEnd || evStart || "10:00"}`);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
        setEvError("Pick a valid start before end.");
        return;
      }
      startIso = start.toISOString();
      endIso = end.toISOString();
    }
    setEvBusy(true);
    setEvError(null);
    const res = await onCreateEvent({
      summary: evSummary.trim(),
      start: startIso,
      end: endIso,
      ...(evLocation.trim() ? { location: evLocation.trim() } : {}),
    });
    setEvBusy(false);
    if (res.ok) {
      setAdding(false);
      setEvSummary("");
      setEvLocation("");
      setEvAllDay(false);
    } else {
      setEvError(res.error ?? "Couldn't create the event.");
    }
  };

  // Inline EDIT of an existing event (one at a time), keyed by event id. Seeded from the event so an
  // untouched field is submitted unchanged; times are omitted for an all-day event (editing those
  // here would convert it to a timed one).
  const [editId, setEditId] = useState<string | null>(null);
  const [edSummary, setEdSummary] = useState("");
  const [edStart, setEdStart] = useState("");
  const [edEnd, setEdEnd] = useState("");
  const [edLocation, setEdLocation] = useState("");
  const [edDescription, setEdDescription] = useState("");
  const [edAllDay, setEdAllDay] = useState(false);
  const [edBusy, setEdBusy] = useState(false);
  const [edError, setEdError] = useState<string | null>(null);
  const beginEdit = (ev: CalendarEvent): void => {
    setEditId(ev.id ?? null);
    setEdSummary(ev.summary === "(no title)" ? "" : ev.summary);
    // An all-day event has no clock times to seed — the defaults below are what it becomes if the
    // reader converts it to a timed event.
    setEdStart(ev.allDay ? "09:00" : clockOf(ev.start));
    setEdEnd(ev.allDay ? "10:00" : clockOf(ev.end));
    setEdAllDay(!!ev.allDay);
    setEdLocation(ev.location ?? "");
    setEdDescription(ev.description ?? "");
    setEdError(null);
  };
  const submitEdit = async (ev: CalendarEvent): Promise<void> => {
    if (!onUpdateEvent || !ev.id) return;
    const patch: { summary?: string; start?: string; end?: string; description?: string; location?: string } = {};
    if (edSummary.trim() && edSummary.trim() !== ev.summary) patch.summary = edSummary.trim();
    if (edLocation !== (ev.location ?? "")) patch.location = edLocation.trim();
    if (edDescription !== (ev.description ?? "")) patch.description = edDescription;
    const wasAllDay = !!ev.allDay;
    const kindChanged = wasAllDay !== edAllDay;
    const day = eventStartDay(ev);
    if (edAllDay) {
      // Only rewrite the dates when CONVERTING to all-day. An event that was already all-day keeps its
      // own span — recomputing it here would silently collapse a multi-day trip to a single day.
      if (kindChanged) {
        patch.start = day;
        patch.end = day; // the API turns this into Google's exclusive next-day end
      }
    } else if (edStart || edEnd) {
      const s = new Date(`${day}T${edStart || "09:00"}`);
      const e = new Date(`${day}T${edEnd || "10:00"}`);
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) {
        setEdError("Pick a valid start before end.");
        return;
      }
      // Send both ends when either moves (Google would otherwise leave the event inverted) — and
      // always on a conversion, since that's the change itself.
      if (kindChanged || clockOf(ev.start) !== edStart || clockOf(ev.end) !== edEnd) {
        patch.start = s.toISOString();
        patch.end = e.toISOString();
      }
    }
    if (Object.keys(patch).length === 0) {
      setEditId(null);
      return;
    }
    setEdBusy(true);
    setEdError(null);
    const res = await onUpdateEvent(ev.id, patch, ev.calendarId);
    setEdBusy(false);
    if (res.ok) setEditId(null);
    else setEdError(res.error ?? "Couldn't save the change.");
  };

  // Build the 6×7 grid of days covering the visible month (leading/trailing spill).
  const cells = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay()); // back up to the Sunday on/before the 1st
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [month]);

  const eventsByDay = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      // A multi-day event lands on EVERY day it spans (so a week-long trip shows across the week).
      for (const k of eventDayKeys(ev)) {
        const arr = m.get(k) ?? [];
        arr.push(ev);
        m.set(k, arr);
      }
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1));
    }
    return m;
  }, [events]);

  const deadlinesByDay = useMemo(() => {
    const m = new Map<string, CalendarDeadline[]>();
    for (const d of deadlines) {
      const k = d.date.slice(0, 10);
      const arr = m.get(k) ?? [];
      arr.push(d);
      m.set(k, arr);
    }
    return m;
  }, [deadlines]);

  const todayKey = dayKey(new Date());
  const selectedEvents = selected ? eventsByDay.get(selected) ?? [] : [];
  const selectedDeadlines = selected ? deadlinesByDay.get(selected) ?? [] : [];

  return (
    <ModalShell
      title="Calendar"
      onClose={onClose}
      overlayStyle={overlay}
      cardStyle={panel}
    >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <strong style={{ fontSize: 15 }}>📅 Calendar</strong>
          <span style={{ fontSize: 13, opacity: 0.75 }}>
            {MONTHS[month.getMonth()]} {month.getFullYear()}
          </span>
          {loading ? <span style={{ fontSize: 11, opacity: 0.6 }}>· syncing…</span> : null}
          {!loading && error ? (
            <span style={{ fontSize: 11, color: t.state.danger }} title={error}>
              · sync failed
            </span>
          ) : null}
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button style={btn} onClick={onPrev} title="Previous month">
              ‹
            </button>
            <button style={btn} onClick={onToday} title="Jump to this month">
              Today
            </button>
            <button style={btn} onClick={onNext} title="Next month">
              ›
            </button>
            <button style={btn} onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7, 1fr)",
            // The weekday header is auto-height; the six week-rows split the remaining panel height
            // equally so the whole month is always visible (bigger cells, no inner scroll).
            gridTemplateRows: "auto repeat(6, minmax(0, 1fr))",
            gap: 2,
            flex: "1 1 auto",
            minHeight: 0,
          }}
        >
          {WEEKDAYS.map((w) => (
            <div key={w} style={{ fontSize: 11, opacity: 0.55, textAlign: "center", padding: "2px 0" }}>
              {w}
            </div>
          ))}
          {cells.map((d) => {
            const k = dayKey(d);
            const inMonth = d.getMonth() === month.getMonth();
            const isToday = k === todayKey;
            const dayEvents = eventsByDay.get(k) ?? [];
            const dayDeadlines = deadlinesByDay.get(k) ?? [];
            return (
              <button
                key={k}
                onClick={() => setSelected(k === selected ? null : k)}
                style={{
                  ...dayCell,
                  background: k === selected ? t.accent.fill : isToday ? t.fill.subtle : "transparent",
                  border: isToday ? `1px solid ${t.accent.edge}` : `1px solid ${t.border.faint}`,
                  opacity: inMonth ? 1 : 0.38,
                }}
              >
                <div style={{ fontSize: 11, fontWeight: isToday ? 700 : 400, textAlign: "right" }}>{d.getDate()}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 1, overflow: "hidden" }}>
                  {dayDeadlines.map((dl, i) => (
                    <div key={`dl-${i}`} style={{ ...chip, background: "rgba(255,196,120,0.22)", border: "1px solid rgba(255,196,120,0.5)" }}>
                      ⏰ {dl.title}
                    </div>
                  ))}
                  {dayEvents.slice(0, 3).map((ev, i) => (
                    <div
                      key={`ev-${i}`}
                      style={{ ...chip, background: ev.color ? hexToBg(ev.color) : t.accent.fill }}
                      title={`${timeLabel(ev)} ${ev.summary}`.trim()}
                    >
                      {ev.summary}
                    </div>
                  ))}
                  {dayEvents.length > 3 ? (
                    <div style={{ fontSize: 9, opacity: 0.6, paddingLeft: 2 }}>+{dayEvents.length - 3} more</div>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>

        {selected ? (
          <div style={{ marginTop: 12, borderTop: `1px solid ${t.border.faint}`, paddingTop: 10, flexShrink: 0, overflowY: "auto", maxHeight: "28vh" }}>
            <strong style={{ fontSize: 13 }}>{selected}</strong>
            {selectedEvents.length === 0 && selectedDeadlines.length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>Nothing scheduled.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                {selectedDeadlines.map((dl, i) => (
                  <div
                    key={`sd-${i}`}
                    onClick={dl.planId && onOpenTask ? () => onOpenTask(dl.planId!) : undefined}
                    style={{ fontSize: 12, cursor: dl.planId && onOpenTask ? "pointer" : "default", color: t.state.warn }}
                  >
                    ⏰ {dl.title} {dl.planId && onOpenTask ? <span style={{ opacity: 0.6 }}>· open task →</span> : null}
                  </div>
                ))}
                {selectedEvents.map((ev, i) =>
                  editId && ev.id === editId ? (
                    <div key={`se-${i}`} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "4px 0" }}>
                      <input autoFocus value={edSummary} onChange={(e) => setEdSummary(e.target.value)} placeholder="Event title" style={evInput} />
                      <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, opacity: 0.85, cursor: "pointer" }} title="Switch between an all-day event and one with a set time">
                        <input type="checkbox" checked={edAllDay} onChange={(e) => setEdAllDay(e.target.checked)} />
                        All day
                      </label>
                      {edAllDay ? null : (
                        <>
                          <input type="time" value={edStart} onChange={(e) => setEdStart(e.target.value)} style={evTime} title="Start" />
                          <span style={{ opacity: 0.5 }}>→</span>
                          <input type="time" value={edEnd} onChange={(e) => setEdEnd(e.target.value)} style={evTime} title="End" />
                        </>
                      )}
                      <input value={edLocation} onChange={(e) => setEdLocation(e.target.value)} placeholder="Location" style={evInput} />
                      <textarea
                        value={edDescription}
                        onChange={(e) => setEdDescription(e.target.value)}
                        placeholder="Details (notes, confirmation numbers…)"
                        rows={2}
                        style={{ ...evInput, width: "100%", resize: "vertical", fontFamily: "inherit" }}
                      />
                      <button style={btn} onClick={() => void submitEdit(ev)} disabled={edBusy}>
                        {edBusy ? "Saving…" : "Save"}
                      </button>
                      <button style={btn} onClick={() => { setEditId(null); setEdError(null); }} disabled={edBusy}>
                        Cancel
                      </button>
                      {edError ? <span style={{ fontSize: 11, color: t.state.danger, width: "100%" }}>⚠ {edError}</span> : null}
                    </div>
                  ) : (
                    <div key={`se-${i}`} style={{ fontSize: 12, display: "flex", gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: ev.color ?? t.accent.base, marginTop: 4, flexShrink: 0 }} />
                      <span style={{ flex: 1 }}>
                        {ev.allDay ? <span style={{ opacity: 0.6 }}>all day</span> : <span style={{ opacity: 0.7 }}>{timeLabel(ev)}</span>}{" "}
                        {ev.summary}
                        {ev.location ? <span style={{ opacity: 0.5 }}> · {ev.location}</span> : null}
                        {/* The details the assistant accumulates on an event live here — show them, so
                            what it recorded is visible (and editable) rather than hidden in Google. */}
                        {ev.description ? (
                          <span style={{ display: "block", opacity: 0.55, whiteSpace: "pre-wrap", marginTop: 2 }}>{ev.description}</span>
                        ) : null}
                      </span>
                      {onUpdateEvent && ev.id ? (
                        <button style={{ ...btn, padding: "1px 6px", fontSize: 11, flexShrink: 0 }} onClick={() => beginEdit(ev)} title="Edit this event in Google Calendar">
                          Edit
                        </button>
                      ) : null}
                    </div>
                  ),
                )}
              </div>
            )}
            {onCreateEvent ? (
              adding ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 8 }}>
                  <input autoFocus value={evSummary} onChange={(e) => setEvSummary(e.target.value)} placeholder="Event title" style={evInput} />
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, opacity: 0.85, cursor: "pointer" }} title="An event with no set time, shown across the whole day">
                    <input type="checkbox" checked={evAllDay} onChange={(e) => setEvAllDay(e.target.checked)} />
                    All day
                  </label>
                  {evAllDay ? null : (
                    <>
                      <input type="time" value={evStart} onChange={(e) => setEvStart(e.target.value)} style={evTime} title="Start" />
                      <span style={{ opacity: 0.5 }}>→</span>
                      <input type="time" value={evEnd} onChange={(e) => setEvEnd(e.target.value)} style={evTime} title="End" />
                    </>
                  )}
                  <input value={evLocation} onChange={(e) => setEvLocation(e.target.value)} placeholder="Location (optional)" style={evInput} />
                  <button style={btn} onClick={() => void submitEvent()} disabled={evBusy || !evSummary.trim()}>
                    {evBusy ? "Adding…" : "Add"}
                  </button>
                  <button style={btn} onClick={() => { setAdding(false); setEvError(null); }}>Cancel</button>
                  {evError ? <span style={{ fontSize: 11, color: t.state.danger, width: "100%" }}>⚠ {evError}</span> : null}
                </div>
              ) : (
                <button style={{ ...btn, marginTop: 8 }} onClick={() => setAdding(true)} title={`Add an event on ${selected}`}>
                  ＋ Add event
                </button>
              )
            ) : null}
          </div>
        ) : (
          <div style={{ fontSize: 11, opacity: 0.55, marginTop: 10 }}>
            Synced with your Google calendar(s) plus your planned task deadlines. Click a day to see its schedule.
          </div>
        )}
    </ModalShell>
  );
});

/** Translate a calendar's hex colour into a translucent chip background. */
function hexToBg(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return t.accent.fill;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},0.3)`;
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: t.surface.overlay,
  backdropFilter: "blur(6px)",
  zIndex: 100,
  padding: 20,
};
const panel: React.CSSProperties = {
  width: "min(960px, 100%)",
  // A definite height (capped to the viewport) so the month grid can grow to fill it — the whole
  // calendar stays on screen without the panel itself scrolling.
  height: "min(880px, 94vh)",
  display: "flex",
  flexDirection: "column",
  background: t.surface.card,
  color: t.text.base,
  border: `1px solid ${t.border.subtle}`,
  borderRadius: 12,
  padding: 18,
  fontFamily: "system-ui, sans-serif",
};
const dayCell: React.CSSProperties = {
  // Sized by its grid row (the six rows split the panel height) — a floor keeps it tappable when the
  // viewport is short, and minHeight:0 lets it shrink instead of forcing a scroll.
  minHeight: 0,
  borderRadius: 6,
  padding: 3,
  textAlign: "left",
  color: "inherit",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};
const chip: React.CSSProperties = {
  fontSize: 9.5,
  lineHeight: 1.25,
  padding: "1px 4px",
  borderRadius: 3,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const btn: React.CSSProperties = {
  background: t.fill.base,
  color: "inherit",
  border: `1px solid ${t.border.button}`,
  borderRadius: 6,
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
};
const evInput: React.CSSProperties = {
  background: "rgba(0,0,0,0.25)",
  color: "inherit",
  border: `1px solid ${t.border.button}`,
  borderRadius: 6,
  padding: "5px 8px",
  fontSize: 12,
  minWidth: 120,
  flex: "1 1 120px",
};
const evTime: React.CSSProperties = {
  background: "rgba(0,0,0,0.25)",
  color: "inherit",
  border: `1px solid ${t.border.button}`,
  borderRadius: 6,
  padding: "4px 6px",
  fontSize: 12,
};
