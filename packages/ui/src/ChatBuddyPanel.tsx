import { memo, useEffect, useRef, useState } from "react";
import { MessageBubble, type ChatMessageVM } from "./ChatPanel.js";
import type { BuddyPersona, BuddyToolCall } from "@visual-reader/core";

/**
 * The landing-page chat buddy. Pure presentation, like ChatPanel — but rendered
 * INLINE as the landing experience itself (full-window, no overlay). Three
 * personas switch the buddy's voice (and the App's prompt): freeform (default —
 * a general assistant that runs the app on request), entertainment (stories,
 * recommendations) and technical (articles, papers, research).
 */

export interface ChatBuddyPanelProps {
  messages: ChatMessageVM[];
  /** In-flight assistant text (streaming providers), shown as a live bubble. */
  streamingText?: string;
  busy: boolean;
  /** Transient activity line ("searching Project Gutenberg…"). */
  activity?: string;
  /** An un-executed generate_image awaiting the reader's approval. */
  pendingTool?: BuddyToolCall;
  persona: BuddyPersona;
  onPersonaChange: (p: BuddyPersona) => void;
  onSend: (text: string) => void;
  onApprovePendingTool: () => void;
  onDismissPendingTool: () => void;
  onCancel: () => void;
  onClearHistory: () => void;
  /** Delete one message by index (must be referentially stable — see MessageBubble). */
  onDeleteMessage?: (index: number) => void;
}

export const ChatBuddyPanel = memo(function ChatBuddyPanel(props: ChatBuddyPanelProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.messages.length, props.streamingText, props.activity, props.pendingTool]);

  const send = () => {
    const text = draft.trim();
    if (!text || props.busy) return;
    setDraft("");
    props.onSend(text);
  };

  const personaButton = (p: BuddyPersona, label: string, title: string) => (
    <button
      style={{
        ...personaButtonStyle,
        ...(props.persona === p ? personaActiveStyle : {}),
      }}
      onClick={() => props.onPersonaChange(p)}
      title={title}
    >
      {label}
    </button>
  );

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <strong style={{ fontSize: 14 }}>Chat</strong>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span style={personaGroupStyle}>
            {personaButton("freeform", "Freeform", "General assistant — chat about anything; runs the app when asked")}
            {personaButton("entertainment", "Entertainment", "Stories, novels, fun reads — a book-club voice")}
            {personaButton("technical", "Technical", "Articles, papers, study material — a research voice")}
          </span>
          {props.messages.length > 0 && (
            <button style={smallButtonStyle} onClick={props.onClearHistory} title="Clear the buddy conversation">
              Clear
            </button>
          )}
        </span>
      </div>

      <div ref={scrollRef} style={scrollStyle}>
        {props.messages.length === 0 && !props.streamingText && (
          <div style={{ opacity: 0.55, fontSize: 12, padding: 12, lineHeight: 1.5 }}>
            {props.persona === "technical"
              ? "Ask for a topic — I can find articles, open them in the reader, and illustrate the concepts while we talk. Try “find me an article on the citric acid cycle and open it”."
              : props.persona === "entertainment"
                ? "Tell me what you feel like reading — I can open books from your library, find classics on Project Gutenberg, and illustrate them while we chat. Try “open Frankenstein and illustrate it”."
                : "Chat about anything — questions, ideas, math, inventions. When you want the app to do something, just ask: “open a random classic and illustrate it in oil painting style”, “generate a picture of an apple”, “show me a diagram of a jet engine”."}
          </div>
        )}
        {props.messages.map((m, i) => (
          <MessageBubble key={i} message={m} index={i} {...(props.onDeleteMessage ? { onDelete: props.onDeleteMessage } : {})} />
        ))}
        {props.streamingText ? (
          <MessageBubble message={{ role: "assistant", text: props.streamingText }} />
        ) : null}
        {props.activity ? (
          <div style={{ opacity: 0.6, fontSize: 12, padding: "2px 8px" }}>{props.activity}</div>
        ) : null}
        {props.pendingTool?.tool === "generate_image" && (
          <div style={approvalStyle}>
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              Generate this image?
              <span style={{ display: "block", opacity: 0.7, marginTop: 2 }}>
                “{props.pendingTool.prompt}”
                {props.pendingTool.model ? ` · model: ${props.pendingTool.model}` : ""}
                {props.pendingTool.steps ? ` · ${props.pendingTool.steps} steps` : ""}
                {props.pendingTool.style ? ` · style: ${props.pendingTool.style}` : ""}
              </span>
            </div>
            <button style={{ ...smallButtonStyle, marginRight: 6 }} onClick={props.onApprovePendingTool}>
              Run
            </button>
            <button style={smallButtonStyle} onClick={props.onDismissPendingTool}>
              Dismiss
            </button>
          </div>
        )}
      </div>

      <div style={inputRowStyle}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            props.busy
              ? "Thinking…"
              : props.persona === "technical"
                ? "What do you want to study? (Enter to send)"
                : "What do you feel like reading? (Enter to send)"
          }
          rows={2}
          style={textareaStyle}
        />
        {props.busy ? (
          <button style={smallButtonStyle} onClick={props.onCancel}>
            Stop
          </button>
        ) : (
          <button style={smallButtonStyle} onClick={send} disabled={!draft.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
});

// Full-window landing experience: the chat IS the home screen, so it takes the
// viewport (minus the header area) rather than floating as a small card.
const panelStyle = {
  width: "min(1100px, 96vw)",
  height: "max(440px, calc(100vh - 290px))",
  background: "#16181d",
  color: "#e6e6e6",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 10,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
} as const;

const headerStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 12px",
  borderBottom: "1px solid rgba(255,255,255,0.1)",
} as const;

const scrollStyle = {
  flex: 1,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
} as const;

const inputRowStyle = {
  display: "flex",
  gap: 8,
  padding: 10,
  borderTop: "1px solid rgba(255,255,255,0.1)",
  alignItems: "flex-end",
} as const;

const textareaStyle = {
  flex: 1,
  resize: "none",
  background: "rgba(255,255,255,0.06)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 6,
  padding: 8,
  fontSize: 13,
  fontFamily: "inherit",
} as const;

const smallButtonStyle = {
  background: "rgba(255,255,255,0.08)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 12,
  cursor: "pointer",
} as const;

const personaGroupStyle = {
  display: "inline-flex",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 6,
  overflow: "hidden",
} as const;

const personaButtonStyle = {
  background: "transparent",
  color: "inherit",
  border: "none",
  padding: "6px 10px",
  fontSize: 12,
  cursor: "pointer",
  opacity: 0.7,
} as const;

const personaActiveStyle = {
  background: "rgba(122,162,255,0.22)",
  opacity: 1,
} as const;

const approvalStyle = {
  alignSelf: "flex-start",
  border: "1px solid rgba(122,162,255,0.5)",
  borderRadius: 8,
  padding: 10,
  background: "rgba(122,162,255,0.08)",
} as const;
