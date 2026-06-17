import type { TaskPlan, TaskStep } from "./tasks.js";
import type { GanttAccent, GanttRow } from "../infographics/gantt-geometry.js";

/**
 * Map the Task Orchestrator's plans onto Gantt rows — the bridge between the durable
 * `TaskPlan`/`TaskStep` model and the pure `layoutGantt` geometry. A plan becomes a
 * top-level group bar spanning its window; each step becomes an indented sub-task bar
 * placed from its due date and lead time (so "all tasks and sub-tasks show in one
 * timeline"). Real ISO dates are reduced to integer DAY NUMBERS — a stable, timezone-free
 * axis the geometry can scale; the UI labels ticks back as dates via `dayToIso`.
 *
 * Pure (no store, no clock unless injected) so it's unit-testable; the row id encodes the
 * plan/step ids (`ganttRowRef`) so a click on a bar maps straight back to the plan to open
 * or the step to complete.
 */

const DAY = 86_400_000;
const ROW_SEP = "::"; // plan ids are `task-…` (no "::"), so a step row id stays unambiguous

/** Parse an ISO date ("YYYY-MM-DD" or a full timestamp) to an integer day number (days
 * since the epoch), or undefined when it isn't a real date. Date-only strings are read as
 * UTC so the axis is timezone-stable. */
export function isoToDay(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  return Number.isFinite(ms) ? Math.floor(ms / DAY) : undefined;
}

/** A day number back to an ISO date ("YYYY-MM-DD"), for axis tick labels. */
export function dayToIso(day: number): string {
  return new Date(Math.round(day) * DAY).toISOString().slice(0, 10);
}

/** Split a Gantt row id back into the plan (and step, for sub-task rows) it came from. */
export function ganttRowRef(id: string): { planId: string; stepId?: string } {
  const i = id.indexOf(ROW_SEP);
  return i === -1 ? { planId: id } : { planId: id.slice(0, i), stepId: id.slice(i + ROW_SEP.length) };
}

function stepAccent(status: TaskStep["status"]): GanttAccent {
  if (status === "done") return "done";
  if (status === "ready" || status === "in_progress") return "active";
  if (status === "blocked") return "blocked";
  return "todo";
}

/** Build the Gantt rows for a set of plans: a group row per plan + a sub-task row per step.
 * `todayDay` (the current day number) is injectable for deterministic tests. */
export function plansToGanttRows(
  plans: readonly TaskPlan[],
  opts: { todayDay?: number } = {},
): GanttRow[] {
  const today = opts.todayDay ?? Math.floor(Date.now() / DAY);
  const rows: GanttRow[] = [];
  for (const plan of plans) {
    const created = Math.floor(plan.createdAt / DAY);
    const planDue = isoToDay(plan.deadlineIso);
    const startBase = Math.min(created, today);
    const steps = [...plan.steps].sort((a, b) => a.order - b.order);
    const n = Math.max(1, steps.length);
    // When a step has no due date, spread it evenly across the plan window by its order, so
    // an un-dated plan still lays out as a sensible left-to-right sequence.
    const fallbackEnd = planDue ?? today + n;
    const span = Math.max(1, fallbackEnd - startBase);

    const stepRows: GanttRow[] = steps.map((s, i) => {
      const end = isoToDay(s.dueIso) ?? startBase + Math.round(((i + 1) / n) * span);
      const lead = Math.max(0, s.leadTimeDays ?? 0);
      const start = Math.max(startBase, end - lead);
      return {
        id: `${plan.id}${ROW_SEP}${s.id}`,
        label: s.title,
        start,
        end: Math.max(start, end),
        depth: 1,
        done: s.status === "done",
        accent: stepAccent(s.status),
      };
    });

    const planStart = stepRows.length ? Math.min(startBase, ...stepRows.map((r) => r.start)) : startBase;
    const planEnd = Math.max(
      planDue ?? startBase,
      ...(stepRows.length ? stepRows.map((r) => r.end) : [fallbackEnd]),
    );
    rows.push({
      id: plan.id,
      label: plan.title,
      start: planStart,
      end: planEnd,
      depth: 0,
      done: plan.status === "completed",
      accent: plan.status === "completed" ? "done" : "group",
    });
    rows.push(...stepRows);
  }
  return rows;
}
