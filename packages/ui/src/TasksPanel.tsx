import { memo } from "react";
import type { TaskPlan, TaskStep } from "@visual-reader/core";

/**
 * The Task Orchestrator's panel — the durable plans the assistant built, with their
 * steps, deadlines, attached prep documents, official links, and progress. Each step
 * is badged "AI can prep" vs "you do this"; the next actionable step is highlighted.
 * Pure presentation (open/delete injected); plans are loaded/saved by App, the same
 * store the worker reads.
 */
export interface TasksPanelProps {
  plans: TaskPlan[];
  /** Open a plan to work it in a preloaded chat session. */
  onOpenTask: (planId: string) => void;
  /** Mark the current step done and advance the plan (best-effort Google write-back). */
  onAdvanceStep: (planId: string, stepId: string) => Promise<void> | void;
  onDelete: (planId: string) => Promise<void> | void;
  onClose: () => void;
}

function statusDot(status: TaskStep["status"]): string {
  return status === "done" ? "✓" : status === "ready" ? "▶" : status === "blocked" ? "⛔" : status === "in_progress" ? "…" : "○";
}

function PlanCard({
  plan,
  onOpen,
  onAdvance,
  onDelete,
}: {
  plan: TaskPlan;
  onOpen: () => void;
  onAdvance: (stepId: string) => void;
  onDelete: () => void;
}) {
  const doneCount = plan.steps.filter((s) => s.status === "done").length;
  const current = plan.steps.find((s) => s.status === "ready") ?? plan.steps.find((s) => s.status !== "done");
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong style={{ fontSize: 14 }}>{plan.title}</strong>
        {plan.deadlineIso ? <span style={{ fontSize: 11, color: "#ffcf8b" }}>due {plan.deadlineIso}</span> : null}
        <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.6 }}>
          {doneCount}/{plan.steps.length} done{plan.status === "completed" ? " · complete" : ""}
        </span>
      </div>
      {plan.summary ? <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>{plan.summary}</div> : null}
      <ol style={{ margin: "8px 0 0", paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
        {plan.steps.map((s) => {
          const ready = s.status === "ready";
          return (
            <li
              key={s.id}
              style={{
                fontSize: 12,
                padding: "4px 8px",
                borderRadius: 6,
                background: ready ? "rgba(122,162,255,0.14)" : "transparent",
                border: ready ? "1px solid rgba(122,162,255,0.4)" : "1px solid transparent",
                opacity: s.status === "done" ? 0.55 : 1,
              }}
            >
              <span style={{ opacity: 0.7 }}>{statusDot(s.status)} </span>
              <span style={{ textDecoration: s.status === "done" ? "line-through" : "none" }}>{s.title}</span>
              <span
                style={{
                  marginLeft: 6,
                  fontSize: 10,
                  padding: "0 5px",
                  borderRadius: 4,
                  background: s.actor === "ai_prep" ? "rgba(90,209,155,0.2)" : "rgba(255,255,255,0.08)",
                }}
              >
                {s.actor === "ai_prep" ? "AI preps" : "you do"}
              </span>
              {s.dueIso ? <span style={{ opacity: 0.5 }}> · {s.dueIso}</span> : null}
              {s.docs.length ? <span style={{ opacity: 0.5 }}> · 📄{s.docs.length}</span> : null}
              {s.links.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noreferrer" style={{ color: "#9db8ff", marginLeft: 6 }}>
                  {l.official ? "official ↗" : "link ↗"}
                </a>
              ))}
            </li>
          );
        })}
      </ol>
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button style={btnPrimary} onClick={onOpen}>
          Open &amp; work it →
        </button>
        {current ? (
          <button style={btn} onClick={() => onAdvance(current.id)} title={`Mark "${current.title}" done`}>
            ✓ Mark step done
          </button>
        ) : null}
        <button style={btn} onClick={onDelete} title="Delete this plan">
          Delete
        </button>
      </div>
    </div>
  );
}

export const TasksPanel = memo(function TasksPanel({ plans, onOpenTask, onAdvanceStep, onDelete, onClose }: TasksPanelProps) {
  const active = plans.filter((p) => p.status !== "archived").sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <strong>📋 Tasks — your planned to-dos</strong>
          <button style={btn} onClick={onClose}>
            Close
          </button>
        </div>
        <p style={{ fontSize: 12, opacity: 0.7, margin: "0 0 8px" }}>
          Multi-step tasks the assistant researched and planned. Open one to work it with everything preloaded — the AI
          handles the prep steps and walks you through the ones only you can do. Ask it to “plan …” anything to add more.
        </p>
        {active.length === 0 ? (
          <div style={{ opacity: 0.6, fontSize: 13, padding: "16px 0" }}>
            No tasks yet. In chat, say “plan my car registration renewal” (or “plan this” after it reads an email).
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {active.map((p) => (
              <PlanCard
                key={p.id}
                plan={p}
                onOpen={() => onOpenTask(p.id)}
                onAdvance={(stepId) => void onAdvanceStep(p.id, stepId)}
                onDelete={() => void onDelete(p.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

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
  width: "min(680px, 100%)",
  maxHeight: "92vh",
  overflowY: "auto",
  background: "#16181d",
  color: "#e6e6e6",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 12,
  padding: 18,
  fontFamily: "system-ui, sans-serif",
};
const card: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  padding: "10px 12px",
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
const btnPrimary: React.CSSProperties = {
  ...btn,
  background: "rgba(122,162,255,0.25)",
  border: "1px solid rgba(122,162,255,0.6)",
};
