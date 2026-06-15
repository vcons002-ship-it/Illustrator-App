import { memo, useMemo, useState } from "react";
import type { CalendarEvent } from "@visual-reader/core";

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
  onClose: () => void;
  loading?: boolean;
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

/** Bucket an event onto its (local) start day. All-day dates are already YYYY-MM-DD. */
function eventDayKey(ev: CalendarEvent): string {
  if (ev.allDay) return ev.start.slice(0, 10);
  const t = Date.parse(ev.start);
  return Number.isNaN(t) ? ev.start.slice(0, 10) : dayKey(new Date(t));
}

function timeLabel(ev: CalendarEvent): string {
  if (ev.allDay) return "";
  const t = Date.parse(ev.start);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export const CalendarPanel = memo(function CalendarPanel({
  events,
  deadlines = [],
  month,
  onPrev,
  onNext,
  onToday,
  onOpenTask,
  onClose,
  loading = false,
}: CalendarPanelProps) {
  const [selected, setSelected] = useState<string | null>(null);

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
      const k = eventDayKey(ev);
      const arr = m.get(k) ?? [];
      arr.push(ev);
      m.set(k, arr);
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
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <strong style={{ fontSize: 15 }}>📅 Calendar</strong>
          <span style={{ fontSize: 13, opacity: 0.75 }}>
            {MONTHS[month.getMonth()]} {month.getFullYear()}
          </span>
          {loading ? <span style={{ fontSize: 11, opacity: 0.6 }}>· syncing…</span> : null}
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

        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
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
                  background: k === selected ? "rgba(122,162,255,0.18)" : isToday ? "rgba(255,255,255,0.06)" : "transparent",
                  border: isToday ? "1px solid rgba(122,162,255,0.6)" : "1px solid rgba(255,255,255,0.07)",
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
                      style={{ ...chip, background: ev.color ? hexToBg(ev.color) : "rgba(122,162,255,0.22)" }}
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
          <div style={{ marginTop: 12, borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 10 }}>
            <strong style={{ fontSize: 13 }}>{selected}</strong>
            {selectedEvents.length === 0 && selectedDeadlines.length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>Nothing scheduled.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                {selectedDeadlines.map((dl, i) => (
                  <div
                    key={`sd-${i}`}
                    onClick={dl.planId && onOpenTask ? () => onOpenTask(dl.planId!) : undefined}
                    style={{ fontSize: 12, cursor: dl.planId && onOpenTask ? "pointer" : "default", color: "#ffcf8b" }}
                  >
                    ⏰ {dl.title} {dl.planId && onOpenTask ? <span style={{ opacity: 0.6 }}>· open task →</span> : null}
                  </div>
                ))}
                {selectedEvents.map((ev, i) => (
                  <div key={`se-${i}`} style={{ fontSize: 12, display: "flex", gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: ev.color ?? "#7aa2ff", marginTop: 4, flexShrink: 0 }} />
                    <span>
                      {ev.allDay ? <span style={{ opacity: 0.6 }}>all day</span> : <span style={{ opacity: 0.7 }}>{timeLabel(ev)}</span>}{" "}
                      {ev.summary}
                      {ev.location ? <span style={{ opacity: 0.5 }}> · {ev.location}</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 11, opacity: 0.55, marginTop: 10 }}>
            Synced with your Google calendar(s) plus your planned task deadlines. Click a day to see its schedule.
          </div>
        )}
      </div>
    </div>
  );
});

/** Translate a calendar's hex colour into a translucent chip background. */
function hexToBg(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "rgba(122,162,255,0.22)";
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
  background: "rgba(8,9,13,0.7)",
  backdropFilter: "blur(6px)",
  zIndex: 100,
  padding: 20,
};
const panel: React.CSSProperties = {
  width: "min(820px, 100%)",
  maxHeight: "92vh",
  overflowY: "auto",
  background: "#16181d",
  color: "#e6e6e6",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 12,
  padding: 18,
  fontFamily: "system-ui, sans-serif",
};
const dayCell: React.CSSProperties = {
  minHeight: 78,
  borderRadius: 6,
  padding: 3,
  textAlign: "left",
  color: "inherit",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
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
  background: "rgba(255,255,255,0.08)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 6,
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
};
