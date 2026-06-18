import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  CommandHelp,
  MessageBubble,
  SlashMenu,
  ThinkingBlock,
  UsageDisclosure,
  completeSlash,
  type BuildDocumentFn,
  type ChatMessageVM,
} from "./ChatPanel.js";
import {
  buddySlashCommands,
  speakableText,
  type BuddyPersona,
  type BuddyToolCall,
  type ContextUsage,
  type ProjectFile,
} from "@visual-reader/core";

/** Minimal shape of the Web Speech recognition API (not in TS's DOM lib). */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

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
  /** A thinking model's live reasoning (shown dimmed/collapsible while it works). */
  thinking?: string;
  busy: boolean;
  /** Transient activity line ("searching Project Gutenberg…"). */
  activity?: string;
  /** A running log of the steps the buddy has taken this turn (tools it called), so its
   * process is visible instead of a single flickering status line. */
  steps?: string[];
  /** An un-executed generate_image awaiting the reader's approval. */
  pendingTool?: BuddyToolCall;
  persona: BuddyPersona;
  onPersonaChange: (p: BuddyPersona) => void;
  /** Multiple chat sessions (each its own history + folder); switch/create/delete. */
  sessions?: { id: string; label: string }[];
  activeSessionId?: string;
  onSwitchSession?: (id: string) => void;
  onNewSession?: () => void;
  /** Rename the active session (empty string clears back to the folder/"Chat N" fallback). */
  onRenameSession?: (id: string, label: string) => void;
  onDeleteSession?: (id: string) => void;
  onSend: (text: string) => void;
  onApprovePendingTool: () => void;
  /** Grant filesystem access for the session (find_files approval only). */
  onApprovePendingToolAlways?: () => void;
  onDismissPendingTool: () => void;
  onCancel: () => void;
  onClearHistory: () => void;
  /** Delete one message by index (must be referentially stable — see MessageBubble). */
  onDeleteMessage?: (index: number) => void;
  /** Compact the conversation into a summary (frees the model's context window). */
  onCompact?: () => void;
  /** Latest context-usage breakdown (for the usage donut). */
  contextUsage?: ContextUsage;
  /** Desktop build: enables the `/find` local-file command. */
  desktop?: boolean;
  /** Open a local file from a `/find` result (desktop). Must be stable (memo). */
  onOpenLocalFile?: (path: string) => void;
  /** Save a file the assistant wrote in a code block. */
  onSaveFile?: (filename: string, content: string, mime: string) => Promise<string | true>;
  /** Zip + save a multi-file (≥2 code blocks) answer as one project. */
  onSaveProject?: (files: ProjectFile[]) => Promise<string | true>;
  /** Generate + embed a designed document's images. */
  onBuildDocument?: BuildDocumentFn;
  /** The session's working folder ("" = default workspace). Present → show the picker. */
  workingDir?: string;
  /** Set the working folder run_command/find_files operate in ("" resets to default). */
  onSetWorkingDir?: (dir: string) => void;
  /** Native folder picker (desktop); resolves to a path or undefined on cancel. */
  onPickFolder?: () => Promise<string | undefined>;
}

export const ChatBuddyPanel = memo(function ChatBuddyPanel(props: ChatBuddyPanelProps) {
  const [draft, setDraft] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const commands = useMemo(() => buddySlashCommands(props.desktop ?? false), [props.desktop]);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.messages.length, props.streamingText, props.activity, props.pendingTool]);

  // Voice mode (optional, browser-only): dictate with the mic, hear replies read aloud.
  const speechApi = useMemo(() => {
    if (typeof window === "undefined") return undefined;
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition;
  }, []);
  const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [listening, setListening] = useState(false);
  const [speakOn, setSpeakOn] = useState(false);
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const toggleMic = () => {
    if (listening) {
      recogRef.current?.stop();
      return;
    }
    if (!speechApi) return;
    const r = new speechApi();
    r.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
    r.interimResults = false;
    r.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += `${e.results[i]![0]!.transcript} `;
      setDraft((d) => (d ? `${d} ` : "") + text.trim());
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recogRef.current = r;
    r.start();
    setListening(true);
  };
  // Speak each NEW assistant message while the toggle is on.
  const spokenUpto = useRef(props.messages.length);
  useEffect(() => {
    if (!speakOn || !ttsSupported) {
      spokenUpto.current = props.messages.length;
      return;
    }
    for (let i = spokenUpto.current; i < props.messages.length; i++) {
      const m = props.messages[i];
      if (m?.role === "assistant" && m.text) window.speechSynthesis.speak(new SpeechSynthesisUtterance(speakableText(m.text)));
    }
    spokenUpto.current = props.messages.length;
  }, [props.messages, speakOn, ttsSupported]);
  const toggleSpeak = () => {
    if (speakOn && ttsSupported) window.speechSynthesis.cancel();
    setSpeakOn((s) => !s);
  };

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
        {props.sessions && props.onSwitchSession ? (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <select
              value={props.activeSessionId}
              onChange={(e) => props.onSwitchSession!(e.target.value)}
              style={sessionSelectStyle}
              title="Switch chat session (each keeps its own history + working folder)"
            >
              {props.sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            {props.onNewSession && (
              <button style={smallButtonStyle} title="New chat session" onClick={props.onNewSession}>
                ＋
              </button>
            )}
            {props.onRenameSession && props.activeSessionId && (
              <button
                style={smallButtonStyle}
                title="Rename this chat"
                onClick={() => {
                  const cur = props.sessions?.find((s) => s.id === props.activeSessionId)?.label ?? "";
                  const next = window.prompt("Rename this chat (leave blank to reset):", cur);
                  if (next !== null) props.onRenameSession!(props.activeSessionId!, next);
                }}
              >
                ✎
              </button>
            )}
            {props.onDeleteSession && props.sessions.length > 1 && props.activeSessionId && (
              <button
                style={smallButtonStyle}
                title="Delete this session (its history is removed)"
                onClick={() => props.onDeleteSession!(props.activeSessionId!)}
              >
                🗑
              </button>
            )}
          </span>
        ) : (
          <strong style={{ fontSize: 14 }}>Chat</strong>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span style={personaGroupStyle}>
            {personaButton("freeform", "Freeform", "General assistant — chat about anything; runs the app when asked")}
            {personaButton("entertainment", "Entertainment", "Stories, novels, fun reads — a book-club voice")}
            {personaButton("technical", "Technical", "Articles, papers, study material — a research voice")}
          </span>
          {props.onCompact && props.messages.length > 4 && (
            <button
              style={smallButtonStyle}
              onClick={props.onCompact}
              disabled={props.busy}
              title="Summarize the conversation so far and continue from the summary (frees the model's memory)"
            >
              Compact
            </button>
          )}
          <button
            style={smallButtonStyle}
            onClick={() => setShowHelp((h) => !h)}
            title="What can this chat do? (commands & tools)"
            aria-label="Help"
          >
            ?
          </button>
          {props.messages.length > 0 && (
            <button style={smallButtonStyle} onClick={props.onClearHistory} title="Clear the buddy conversation">
              Clear
            </button>
          )}
        </span>
      </div>

      {props.onSetWorkingDir && (
        <WorkingFolderBar
          workingDir={props.workingDir ?? ""}
          onSet={props.onSetWorkingDir}
          {...(props.onPickFolder ? { onPick: props.onPickFolder } : {})}
        />
      )}
      {props.contextUsage && <UsageDisclosure usage={props.contextUsage} />}
      {showHelp && (
        <CommandHelp
          commands={commands}
          intro="Tell me what you want in plain language — I'll use these tools when they help. You can also run any of them directly by typing the command:"
        />
      )}

      <div ref={scrollRef} style={scrollStyle}>
        {props.messages.length === 0 && !props.streamingText && (
          <div style={{ opacity: 0.55, fontSize: 12, padding: 12, lineHeight: 1.5 }}>
            {props.persona === "technical"
              ? "Ask for a topic — I can find articles, open them in the reader, and illustrate the concepts while we talk. Try “find me an article on the citric acid cycle and open it”."
              : props.persona === "entertainment"
                ? "Tell me what you feel like reading — I can open books from your library, find classics on Project Gutenberg, and illustrate them while we chat. Try “open Frankenstein and illustrate it”."
                : "Chat about anything — questions, ideas, math, inventions, writing. I can also run the app for you: “open a random classic and illustrate it in oil painting style”, “generate a picture of an apple”, “read this URL and summarize it”, “make a study quiz from my notes”." +
                  (props.desktop
                    ? " On the desktop app I can also find files on your computer, run and test code, and take a screenshot to see if it works (you approve each step)."
                    : "")}
          </div>
        )}
        {props.messages.map((m, i) => (
          <MessageBubble
            key={i}
            message={m}
            index={i}
            {...(props.onDeleteMessage ? { onDelete: props.onDeleteMessage } : {})}
            {...(props.onOpenLocalFile ? { onOpenLocalFile: props.onOpenLocalFile } : {})}
            {...(props.onSaveFile ? { onSaveFile: props.onSaveFile } : {})}
            {...(props.onSaveProject ? { onSaveProject: props.onSaveProject } : {})}
            {...(props.onBuildDocument ? { onBuildDocument: props.onBuildDocument } : {})}
            onAction={props.onSend}
          />
        ))}
        {props.thinking ? <ThinkingBlock text={props.thinking} /> : null}
        {props.streamingText ? (
          <MessageBubble message={{ role: "assistant", text: props.streamingText }} />
        ) : null}
        {props.steps && props.steps.length > 0 ? (
          <div style={stepsBoxStyle}>
            {props.steps.map((s, i) => {
              const last = i === props.steps!.length - 1;
              return (
                <div key={i} style={{ fontSize: 12, padding: "1px 0", opacity: last && props.busy ? 0.9 : 0.55 }}>
                  <span style={{ opacity: 0.6 }}>{last && props.busy ? "▸ " : "✓ "}</span>
                  {s}
                </div>
              );
            })}
          </div>
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
        {props.pendingTool?.tool === "find_files" && (
          <div style={approvalStyle}>
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              🔒 Let the buddy search your computer for a file?
              <span style={{ display: "block", opacity: 0.7, marginTop: 2 }}>
                “{props.pendingTool.query}” — it reads file names only, and opens nothing without your click.
              </span>
            </div>
            <button style={{ ...smallButtonStyle, marginRight: 6 }} onClick={props.onApprovePendingTool}>
              Allow once
            </button>
            {props.onApprovePendingToolAlways && (
              <button
                style={{ ...smallButtonStyle, marginRight: 6 }}
                onClick={props.onApprovePendingToolAlways}
                title="Don't ask again for file searches this session"
              >
                Allow this session
              </button>
            )}
            <button style={smallButtonStyle} onClick={props.onDismissPendingTool}>
              Deny
            </button>
          </div>
        )}
        {props.pendingTool?.tool === "run_command" && (
          <div style={{ ...approvalStyle, borderColor: "rgba(255,170,90,0.6)", background: "rgba(255,170,90,0.08)" }}>
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              ⚠ Run this command on your computer?
              <code
                style={{
                  display: "block",
                  marginTop: 4,
                  padding: "6px 8px",
                  borderRadius: 6,
                  background: "rgba(0,0,0,0.3)",
                  fontFamily: "ui-monospace, Menlo, monospace",
                  fontSize: 12,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {props.pendingTool.command}
              </code>
              <span style={{ display: "block", opacity: 0.7, marginTop: 4 }}>
                Runs in your VisualReader/workspace folder, with your permissions. Read it before approving.
              </span>
            </div>
            <button style={{ ...smallButtonStyle, marginRight: 6 }} onClick={props.onApprovePendingTool}>
              Run
            </button>
            <button style={smallButtonStyle} onClick={props.onDismissPendingTool}>
              Deny
            </button>
          </div>
        )}
        {props.pendingTool?.tool === "screenshot" && (
          <div style={{ ...approvalStyle, borderColor: "rgba(255,170,90,0.6)", background: "rgba(255,170,90,0.08)" }}>
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              📷 Let the assistant {props.pendingTool.window ? `capture the “${props.pendingTool.window}” window` : "capture your screen"} and look at it?
              {props.pendingTool.question && (
                <span style={{ display: "block", opacity: 0.7, marginTop: 2 }}>
                  To check: “{props.pendingTool.question}”
                </span>
              )}
              <span style={{ display: "block", opacity: 0.7, marginTop: 2 }}>
                {props.pendingTool.window
                  ? "Captures just that window and sends it to your chat model."
                  : "Captures your whole primary screen and sends it to your chat model — close anything private first."}
              </span>
            </div>
            <button style={{ ...smallButtonStyle, marginRight: 6 }} onClick={props.onApprovePendingTool}>
              Capture
            </button>
            {props.onApprovePendingToolAlways && (
              <button
                style={{ ...smallButtonStyle, marginRight: 6 }}
                onClick={props.onApprovePendingToolAlways}
                title="Don't ask again for screen captures this session (e.g. while testing a running game)"
              >
                Allow this session
              </button>
            )}
            <button style={smallButtonStyle} onClick={props.onDismissPendingTool}>
              Deny
            </button>
          </div>
        )}
      </div>

      <SlashMenu draft={draft} commands={commands} onPick={setDraft} />
      <div style={inputRowStyle}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            } else if (e.key === "Tab") {
              const completed = completeSlash(draft, commands);
              if (completed) {
                e.preventDefault();
                setDraft(completed);
              }
            }
          }}
          placeholder={
            props.busy
              ? "Thinking…"
              : props.persona === "technical"
                ? "What do you want to study? (Enter to send, / for commands)"
                : "What do you feel like reading? (Enter to send, / for commands)"
          }
          rows={2}
          style={textareaStyle}
        />
        {speechApi ? (
          <button
            style={listening ? { ...smallButtonStyle, borderColor: "#ff8c8c", color: "#ff8c8c" } : smallButtonStyle}
            onClick={toggleMic}
            title={listening ? "Stop dictation" : "Dictate with your microphone"}
          >
            {listening ? "● Rec" : "🎤"}
          </button>
        ) : null}
        {ttsSupported ? (
          <button
            style={speakOn ? { ...smallButtonStyle, borderColor: "rgba(90,209,155,0.6)", color: "#9be8c0" } : smallButtonStyle}
            onClick={toggleSpeak}
            title={speakOn ? "Stop reading replies aloud" : "Read replies aloud"}
          >
            {speakOn ? "🔊 On" : "🔈"}
          </button>
        ) : null}
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
// viewport (minus the slimmed header/intro) rather than floating as a small card.
const panelStyle = {
  width: "min(1100px, 96vw)",
  height: "max(480px, calc(100vh - 188px))",
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

const stepsBoxStyle = {
  margin: "2px 8px",
  padding: "6px 10px",
  borderRadius: 8,
  background: "rgba(122,162,255,0.06)",
  border: "1px solid rgba(122,162,255,0.18)",
} as const;

const sessionSelectStyle = {
  background: "rgba(255,255,255,0.08)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 6,
  padding: "5px 8px",
  fontSize: 13,
  fontWeight: 600,
  maxWidth: 160,
  cursor: "pointer",
} as const;

/** Desktop: shows/sets the folder the assistant's commands + file search run in. */
function WorkingFolderBar({
  workingDir,
  onSet,
  onPick,
}: {
  workingDir: string;
  onSet: (dir: string) => void;
  onPick?: () => Promise<string | undefined>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(workingDir);
  const label = workingDir || "Default workspace (~/VisualReader/workspace)";
  const tinyBtn = { ...smallButtonStyle, padding: "2px 8px", fontSize: 11 } as const;
  const browse = async () => {
    const p = await onPick?.();
    if (p) onSet(p);
  };
  return (
    <div style={folderBarStyle}>
      <span title="Where the assistant's commands and file search run">📁</span>
      {editing ? (
        <>
          <input
            style={folderInputStyle}
            value={draft}
            placeholder="Absolute path to a project folder (blank = default workspace)"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onSet(draft.trim());
                setEditing(false);
              }
            }}
            autoFocus
          />
          <button style={tinyBtn} onClick={() => { onSet(draft.trim()); setEditing(false); }}>Set</button>
          <button style={tinyBtn} onClick={() => { setDraft(workingDir); setEditing(false); }}>Cancel</button>
        </>
      ) : (
        <>
          <span
            style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.8 }}
            title={label}
          >
            {label}
          </span>
          {onPick ? <button style={tinyBtn} onClick={() => void browse()}>Browse…</button> : null}
          <button style={tinyBtn} onClick={() => { setDraft(workingDir); setEditing(true); }}>
            {onPick ? "Type" : "Change"}
          </button>
          {workingDir ? (
            <button style={tinyBtn} title="Use the default workspace" onClick={() => onSet("")}>Reset</button>
          ) : null}
        </>
      )}
    </div>
  );
}

const folderBarStyle = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 10px",
  fontSize: 11,
  borderBottom: "1px solid rgba(255,255,255,0.08)",
} as const;

const folderInputStyle = {
  flex: 1,
  minWidth: 0,
  background: "rgba(255,255,255,0.06)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 6,
  padding: "3px 8px",
  fontSize: 11,
  fontFamily: "ui-monospace, Menlo, monospace",
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
