import { memo, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  CommandHelp,
  MessageBubble,
  SlashMenu,
  ThinkingBlock,
  UsageDisclosure,
  completeSlash,
  type BuildDocumentFn,
  type ChatMessageVM,
  type FileActions,
  type RunCodeFn,
} from "./ChatPanel.js";
import {
  buddySlashCommands,
  speakableText,
  type BuddyPersona,
  type BuddyPlan,
  type BuddyToolCall,
  type ContextUsage,
  type ProjectFile,
} from "@visual-reader/core";
import type { ModelMenuGroup } from "./model-menu.js";
import type { LocalBackendId, ReaderSettings } from "./SettingsPanel.js";

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
 * INLINE as the landing experience itself (full-window, no overlay). ONE general
 * assistant voice, with a single optional Planning toggle (📋 Plan) that switches
 * the App's prompt into structured-planning mode; off, it's the everyday assistant.
 */

/** A file attached to the next chat message: a document read as text, or an image the
 * vision model describes. `status` drives the chip (spinner → ready → error). */
export interface ChatAttachmentChip {
  id: string;
  name: string;
  kind: "doc" | "image";
  status: "reading" | "ready" | "error";
  error?: string;
}

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
  /** The chat's lightweight working checklist (set_plan/complete_step) — a pinned, evolving plan the
   * buddy ticks off as it executes a multi-step ask. */
  plan?: BuddyPlan;
  /** Dismiss the working checklist (the ✕ on it) — clears it for good. */
  onDismissPlan?: () => void;
  /** An un-executed generate_image awaiting the reader's approval. */
  pendingTool?: BuddyToolCall;
  persona: BuddyPersona;
  onPersonaChange: (p: BuddyPersona) => void;
  /** Quick model switcher popped from the input row: the current LLM / image / video options + the
   * change to apply when one is picked. Absent → the button/popover don't render. */
  modelMenu?: { groups: ModelMenuGroup[]; onSelect: (patch: Partial<ReaderSettings>) => void };
  /** Multiple chat sessions (each its own history + folder); switch/create/delete. */
  sessions?: { id: string; label: string }[];
  activeSessionId?: string;
  onSwitchSession?: (id: string) => void;
  onNewSession?: () => void;
  /** Rename the active session (empty string clears back to the folder/"Chat N" fallback). */
  onRenameSession?: (id: string, label: string) => void;
  onDeleteSession?: (id: string) => void;
  onSend: (text: string) => void;
  /** Open the host's "Story as you go" setup modal (workflow + cast + characters). When omitted, the
   * ✍️ Story button falls back to a one-line opening prompt. */
  onStartStory?: () => void;
  /** Attach a file (document or image) to the next message — read into the chat as context. */
  onAttachFile?: (file: File) => void;
  /** Pending attachments, shown as removable chips above the composer. */
  attachments?: ChatAttachmentChip[];
  /** Remove a pending attachment before sending. */
  onRemoveAttachment?: (id: string) => void;
  onApprovePendingTool: () => void;
  /** Grant filesystem access for the session (find_files approval only). */
  onApprovePendingToolAlways?: () => void;
  onDismissPendingTool: () => void;
  /** Per-step approval QUEUE for parallel coding agents (Phase 2): each entry is one agent's
   * pending write/command, awaiting the reader's click while siblings keep running. */
  agentApprovals?: { id: number; title: string; call: BuddyToolCall }[];
  onApproveAgentTool?: (id: number) => void;
  onDenyAgentTool?: (id: number) => void;
  onCancel: () => void;
  onClearHistory: () => void;
  /** Force-load the local chat model into memory now (image renders evict it to free the GPU).
   * When omitted (cloud/web text models), the button is hidden. */
  onLoadModel?: () => void;
  /** Delete one message by index (must be referentially stable — see MessageBubble). */
  onDeleteMessage?: (index: number) => void;
  /** Compact the conversation into a summary (frees the model's context window). */
  onCompact?: () => void;
  /** Latest context-usage breakdown (for the usage donut). */
  contextUsage?: ContextUsage;
  /** Desktop build: enables the `/find` local-file command. */
  desktop?: boolean;
  /** Linked-phone client: desktop-runtime commands (/find, run) RELAY to the desktop, so the slash
   * list must offer them here too — gating on `desktop` alone hid permitted tools from the phone. */
  remote?: boolean;
  /** Open a local file from a `/find` result (desktop). Must be stable (memo). */
  onOpenLocalFile?: (path: string) => void;
  /** Save a file the assistant wrote in a code block. */
  onSaveFile?: (filename: string, content: string, mime: string) => Promise<string | true>;
  /** Run a code block (Python/JS/shell) on the host and show its output. */
  onRunCode?: RunCodeFn;
  /** Zip + save a multi-file (≥2 code blocks) answer as one project. */
  onSaveProject?: (files: ProjectFile[]) => Promise<string | true>;
  /** Generate + embed a designed document's images. */
  onBuildDocument?: BuildDocumentFn;
  /** Universal file-card actions (Download / Open in app / Open in library / Open on PC). Stable (memo). */
  fileActions?: FileActions;
  /** The session's working folder ("" = default workspace). Present → show the picker. */
  workingDir?: string;
  /** Set the working folder run_command/find_files operate in ("" resets to default). */
  onSetWorkingDir?: (dir: string) => void;
  /** Native folder picker (desktop); resolves to a path or undefined on cancel. */
  onPickFolder?: () => Promise<string | undefined>;
  /** Fill the parent container (width + height 100%) instead of the centered full-window card —
   * used when the panel is docked beside the story reader. */
  fill?: boolean;
  /** Bottom-dock mode: when true, the message history is hidden (only the header + input bar show),
   * so the dock collapses to a thin composer beneath the reader. The caret in the header toggles it
   * via `onToggleHistory`. Undefined → no caret (history always visible, e.g. the home-screen hero). */
  historyCollapsed?: boolean;
  onToggleHistory?: () => void;
}

export const ChatBuddyPanel = memo(function ChatBuddyPanel(props: ChatBuddyPanelProps) {
  const [draft, setDraft] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [loadingModel, setLoadingModel] = useState(false);
  // Quick model-switcher popover state (opened from the input row). Ref wraps the button + popover so an
  // outside click / Escape closes it.
  const [modelsOpen, setModelsOpen] = useState(false);
  // Which local backend (ComfyUI / AUTOMATIC1111) the Image section's checkpoint list is currently
  // showing — undefined defaults to whichever is active; reset on close so it re-defaults next open.
  const [selectedImageBackend, setSelectedImageBackend] = useState<LocalBackendId | undefined>(undefined);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!modelsOpen) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!modelMenuRef.current?.contains(t) && !modelBtnRef.current?.contains(t)) setModelsOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setModelsOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [modelsOpen]);
  useEffect(() => {
    if (!modelsOpen) setSelectedImageBackend(undefined);
  }, [modelsOpen]);
  // The header's secondary controls (new/rename/delete session, model, compact, help, clear) hide
  // behind a small ⋯ toggle to save space — only the session switcher + the toggle show by default.
  const [toolsOpen, setToolsOpen] = useState(false);
  const commands = useMemo(
    () => buddySlashCommands((props.desktop ?? false) || (props.remote ?? false)),
    [props.desktop, props.remote],
  );
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasReadyAttachment = (props.attachments ?? []).some((a) => a.status === "ready");
  const send = () => {
    const text = draft.trim();
    // Allow sending with only attachments (the host supplies a default ask); never while busy.
    if ((!text && !hasReadyAttachment) || props.busy) return;
    setDraft("");
    props.onSend(text);
  };
  const pickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    for (const f of files) props.onAttachFile?.(f);
    e.target.value = ""; // allow re-attaching the same file
  };

  // One chat, one voice. The only mode is an optional Planning toggle: on → structure a fuzzy goal
  // into an actionable plan before building; off → the general assistant just chats and acts.
  const planActive = props.persona === "planning";
  const planToggle = (
    <button
      style={{ ...personaButtonStyle, ...(planActive ? personaActiveStyle : {}) }}
      onClick={() => props.onPersonaChange(planActive ? "assistant" : "planning")}
      title="Plan mode — turn a fuzzy goal (a coding project or a complex deliverable) into a clear, actionable plan before building it. Toggle off to just chat and act."
      aria-pressed={planActive}
    >
      📋 Plan
    </button>
  );

  return (
    <div style={props.fill ? { ...panelStyle, width: "100%", height: "100%" } : panelStyle}>
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
            {toolsOpen && props.onNewSession && (
              <button style={smallButtonStyle} title="New chat session" onClick={props.onNewSession}>
                ＋
              </button>
            )}
            {toolsOpen && props.onRenameSession && props.activeSessionId && (
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
            {toolsOpen && props.onDeleteSession && props.sessions.length > 1 && props.activeSessionId && (
              <button
                style={smallButtonStyle}
                title="Delete this session (its history is removed)"
                aria-label="Delete this session"
                onClick={() => {
                  if (window.confirm("Delete this chat session? Its history is removed permanently.")) {
                    props.onDeleteSession!(props.activeSessionId!);
                  }
                }}
              >
                🗑
              </button>
            )}
          </span>
        ) : (
          <strong style={{ fontSize: 14 }}>Chat</strong>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {toolsOpen && <span style={personaGroupStyle}>{planToggle}</span>}
          {toolsOpen && props.onLoadModel && (
            <button
              style={smallButtonStyle}
              onClick={() => {
                props.onLoadModel!();
                setLoadingModel(true);
                window.setTimeout(() => setLoadingModel(false), 4000);
              }}
              disabled={loadingModel}
              title="Load the local chat model into memory now — image generation evicts it to free the GPU, so this brings it back without waiting for your next message"
            >
              {loadingModel ? "Loading…" : "⟳ Model"}
            </button>
          )}
          {toolsOpen && props.onCompact && props.messages.length > 4 && (
            <button
              style={smallButtonStyle}
              onClick={props.onCompact}
              disabled={props.busy}
              title="Summarize the conversation so far and continue from the summary (frees the model's memory)"
            >
              Compact
            </button>
          )}
          {toolsOpen && (
            <button
              style={smallButtonStyle}
              onClick={() => setShowHelp((h) => !h)}
              title="What can this chat do? (commands & tools)"
              aria-label="Help"
            >
              ?
            </button>
          )}
          {toolsOpen && props.messages.length > 0 && (
            <button
              style={smallButtonStyle}
              onClick={() => {
                if (window.confirm("Clear this conversation? All its messages are removed permanently.")) props.onClearHistory();
              }}
              title="Clear the buddy conversation"
            >
              Clear
            </button>
          )}
          {/* Small ⋯ toggle that reveals/hides the secondary controls above — saves header space. */}
          <button
            style={toolsOpen ? { ...smallButtonStyle, borderColor: "rgba(120,160,255,0.6)", color: "#acc4ff" } : smallButtonStyle}
            onClick={() => setToolsOpen((v) => !v)}
            title={toolsOpen ? "Hide chat tools" : "More chat tools (new, rename, clear, …)"}
            aria-expanded={toolsOpen}
            aria-label="Chat tools"
          >
            ⋯
          </button>
          {props.onToggleHistory && (
            <button
              style={smallButtonStyle}
              onClick={props.onToggleHistory}
              title={props.historyCollapsed ? "Show chat history" : "Hide chat history (keep the input bar)"}
              aria-expanded={!props.historyCollapsed}
            >
              {props.historyCollapsed ? "▴ History" : "▾ History"}
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

      <div ref={scrollRef} style={props.historyCollapsed ? { ...scrollStyle, display: "none" } : scrollStyle}>
        {props.messages.length === 0 && !props.streamingText && (
          <div style={{ opacity: 0.55, fontSize: 12, padding: 12, lineHeight: 1.5 }}>
            {props.persona === "planning"
              ? "Tell me what you want to build or write and I'll help you PLAN it first — a coding project or a complex deliverable. I'll ask a couple of questions, then lay out the approach, the steps, and the milestones, and offer to turn it into tasks (or kick off the work). Try “help me plan a budgeting web app” or “plan a 10-page report on coral reefs”."
              : "Ask me anything, or put me to work — research, images, documents, spreadsheets and data, tasks, markets, and reading. Try “generate a picture of an apple”, “research the best photonics stocks and make a comparison sheet”, “read this URL and summarize it”, “make a study quiz from my notes”, or “open a classic and illustrate it in oil-painting style”." +
                (props.desktop
                  ? " On desktop I can also find and open files on your computer, run and test code, and take a screenshot to see if it works (you approve each step)."
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
            {...(props.onRunCode ? { onRunCode: props.onRunCode } : {})}
            {...(props.onSaveProject ? { onSaveProject: props.onSaveProject } : {})}
            {...(props.onBuildDocument ? { onBuildDocument: props.onBuildDocument } : {})}
            {...(props.fileActions ? { fileActions: props.fileActions } : {})}
            {...(props.desktop ? { desktop: props.desktop } : {})}
            onAction={props.onSend}
          />
        ))}
        {props.thinking ? <ThinkingBlock text={props.thinking} /> : null}
        {props.streamingText ? (
          <MessageBubble message={{ role: "assistant", text: props.streamingText }} />
        ) : null}
        {props.plan && props.plan.steps.length > 0 ? (
          <div style={planBoxStyle}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontSize: props.plan.goal ? 12 : 11, fontWeight: 600, opacity: props.plan.goal ? 1 : 0.7, marginBottom: 4 }}>
                📋 {props.plan.goal || "Plan"}
              </div>
              {props.onDismissPlan ? (
                <button
                  type="button"
                  onClick={() => props.onDismissPlan?.()}
                  title="Dismiss this checklist"
                  style={{ background: "none", border: "none", color: "inherit", opacity: 0.5, cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}
                >
                  ✕
                </button>
              ) : null}
            </div>
            {props.plan.steps.map((s, i) => {
              const done = s.status === "done";
              const current = !done && props.plan!.steps.slice(0, i).every((p) => p.status === "done");
              return (
                <div key={i} style={{ fontSize: 12, padding: "1px 0", opacity: done ? 0.55 : current ? 1 : 0.7 }}>
                  <span style={{ opacity: 0.7 }}>{done ? "✓ " : current ? "▸ " : "○ "}</span>
                  {s.text}
                  {done && s.note ? <span style={{ opacity: 0.6 }}> — {s.note}</span> : null}
                </div>
              );
            })}
          </div>
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
        {(props.agentApprovals ?? []).map((a) => {
          const what =
            a.call.tool === "run_command"
              ? a.call.command
              : a.call.tool === "write_file"
                ? `write ${a.call.path}`
                : a.call.tool;
          return (
            <div
              key={a.id}
              style={{ ...approvalStyle, borderColor: "rgba(120,170,255,0.6)", background: "rgba(120,170,255,0.08)" }}
            >
              <div style={{ fontSize: 12, marginBottom: 6 }}>
                🤖 <b>{a.title}</b> wants to {a.call.tool === "run_command" ? "run a command" : "write a file"}:
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
                  {what.slice(0, 600)}
                </code>
                <span style={{ display: "block", opacity: 0.7, marginTop: 4 }}>
                  Runs in this agent's isolated worktree. Other agents keep working while this waits.
                </span>
              </div>
              <button style={{ ...smallButtonStyle, marginRight: 6 }} onClick={() => props.onApproveAgentTool?.(a.id)}>
                Approve
              </button>
              <button style={smallButtonStyle} onClick={() => props.onDenyAgentTool?.(a.id)}>
                Deny
              </button>
            </div>
          );
        })}
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
        {props.pendingTool?.tool === "generate_video" && (
          <div style={approvalStyle}>
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              🎬 Generate this video?
              <span style={{ display: "block", opacity: 0.7, marginTop: 2 }}>
                “{props.pendingTool.prompt}”
                {props.pendingTool.model ? ` · model: ${props.pendingTool.model}` : ""}
                {props.pendingTool.frames ? ` · ${props.pendingTool.frames} frames` : ""}
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
        {props.pendingTool?.tool === "generate_long_video" && (
          <div style={approvalStyle}>
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              🎬 Generate a long video from {props.pendingTool.clips.length} shots?
              <span style={{ display: "block", opacity: 0.7, marginTop: 2 }}>
                {props.pendingTool.title ? `“${props.pendingTool.title}” · ` : ""}
                renders each clip, chains them, and stitches into one video
                {props.pendingTool.model ? ` · model: ${props.pendingTool.model}` : ""}
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
        {props.pendingTool?.tool === "send_email" && (
          <div style={{ ...approvalStyle, borderColor: "rgba(255,170,90,0.6)", background: "rgba(255,170,90,0.08)" }}>
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              ✉ Send this email from your account?
              <span style={{ display: "block", marginTop: 4 }}>
                <b>To:</b> {props.pendingTool.to.join(", ")}
                {props.pendingTool.cc && props.pendingTool.cc.length > 0 ? ` · Cc: ${props.pendingTool.cc.join(", ")}` : ""}
              </span>
              <span style={{ display: "block" }}>
                <b>Subject:</b> {props.pendingTool.subject}
              </span>
              <div
                style={{
                  marginTop: 4,
                  padding: "6px 8px",
                  borderRadius: 6,
                  background: "rgba(0,0,0,0.3)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: 160,
                  overflowY: "auto",
                }}
              >
                {props.pendingTool.body}
              </div>
              <span style={{ display: "block", opacity: 0.7, marginTop: 4 }}>
                Sends immediately from your connected Google account. To keep it as a draft instead, ask the assistant to draft it.
              </span>
            </div>
            <button style={{ ...smallButtonStyle, marginRight: 6 }} onClick={props.onApprovePendingTool}>
              Send
            </button>
            <button style={smallButtonStyle} onClick={props.onDismissPendingTool}>
              Cancel
            </button>
          </div>
        )}
        {props.pendingTool?.tool === "spawn_coding_agents" && (
          <div style={{ ...approvalStyle, borderColor: "rgba(255,170,90,0.6)", background: "rgba(255,170,90,0.08)" }}>
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              🤖 Run {props.pendingTool.tasks.length} coding agents in parallel?
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {props.pendingTool.tasks.map((t, i) => (
                  <li key={i} style={{ marginBottom: 2 }}>
                    <b>{t.title}</b>
                    <span style={{ display: "block", opacity: 0.7 }}>{t.instructions.slice(0, 160)}</span>
                  </li>
                ))}
              </ul>
              <span style={{ display: "block", opacity: 0.7, marginTop: 4 }}>
                Each works in its own isolated git worktree, then the app merges their changes into this
                chat's working folder and cleans up the branches. They write + run commands on their own
                (Autonomous workspace). Review the merged changes afterward.
              </span>
            </div>
            <button style={{ ...smallButtonStyle, marginRight: 6 }} onClick={props.onApprovePendingTool}>
              Run agents
            </button>
            <button style={smallButtonStyle} onClick={props.onDismissPendingTool}>
              Cancel
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

      {modelsOpen && props.modelMenu && (
        <div ref={modelMenuRef} style={modelMenuStyle}>
          {props.modelMenu.groups.map((g) => {
            const backends = g.localBackends;
            const activeBackendId = selectedImageBackend ?? backends?.find((b) => b.active)?.id ?? backends?.[0]?.id;
            return (
              <div key={g.key}>
                <div style={modelGroupLabelStyle}>{g.label}</div>
                {g.options.map((o) => (
                  <button
                    key={o.id}
                    style={o.active ? { ...modelItemStyle, ...personaActiveStyle } : modelItemStyle}
                    // onMouseDown (not click) applies before the input blurs, mirroring the slash menu.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      props.modelMenu!.onSelect(o.patch);
                      setModelsOpen(false);
                    }}
                  >
                    <span style={{ width: 12, opacity: 0.9 }}>{o.active ? "✓" : ""}</span>
                    <span style={{ flex: 1 }}>{o.label}</span>
                    {o.sublabel ? <span style={{ opacity: 0.5, fontSize: 11 }}>{o.sublabel}</span> : null}
                  </button>
                ))}
                {backends && backends.length > 0 && activeBackendId && (
                  <>
                    <select
                      value={activeBackendId}
                      onChange={(e) => setSelectedImageBackend(e.target.value as LocalBackendId)}
                      onMouseDown={(e) => e.stopPropagation()}
                      style={modelBackendSelectStyle}
                    >
                      {backends.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.label}
                          {b.active ? " (active)" : ""}
                        </option>
                      ))}
                    </select>
                    {(g.localModelsByBackend?.[activeBackendId] ?? []).map((o) => (
                      <button
                        key={o.id}
                        style={o.active ? { ...modelItemStyle, ...personaActiveStyle } : modelItemStyle}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          props.modelMenu!.onSelect(o.patch);
                          setModelsOpen(false);
                        }}
                      >
                        <span style={{ width: 12, opacity: 0.9 }}>{o.active ? "✓" : ""}</span>
                        <span style={{ flex: 1 }}>{o.label}</span>
                        {o.sublabel ? <span style={{ opacity: 0.5, fontSize: 11 }}>{o.sublabel}</span> : null}
                      </button>
                    ))}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      <SlashMenu draft={draft} commands={commands} onPick={setDraft} />
      {props.onAttachFile && (props.attachments?.length ?? 0) > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 10px 4px" }}>
          {props.attachments!.map((a) => (
            <span
              key={a.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                padding: "3px 8px",
                borderRadius: 12,
                background: a.status === "error" ? "rgba(255,120,120,0.12)" : "rgba(122,162,255,0.12)",
                border: `1px solid ${a.status === "error" ? "rgba(255,120,120,0.4)" : "rgba(122,162,255,0.35)"}`,
              }}
              title={a.error ?? a.name}
            >
              <span>{a.kind === "image" ? "🖼" : "📄"}</span>
              <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {a.name}
              </span>
              <span style={{ opacity: 0.7 }}>
                {a.status === "reading" ? "…" : a.status === "error" ? "⚠" : ""}
              </span>
              {props.onRemoveAttachment && (
                <button
                  onClick={() => props.onRemoveAttachment!(a.id)}
                  style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, opacity: 0.7 }}
                  title="Remove"
                >
                  ✕
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div style={utilityRowStyle}>
        {props.onAttachFile && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.docx,.xlsx,.csv,.tsv,.txt,.md,.markdown,.rtf,.json,.html,.htm,.epub,.png,.jpg,.jpeg,.webp,.gif"
              style={{ display: "none" }}
              onChange={pickFile}
            />
            <button
              style={smallButtonStyle}
              onClick={() => fileInputRef.current?.click()}
              title="Attach a file (PDF, Word, Excel, CSV, text, or image) for me to read"
            >
              📎
            </button>
          </>
        )}
        <button
          style={smallButtonStyle}
          onClick={() => {
            // Story "as you go" is started by a click, not a chat tool. The host opens a setup modal
            // (workflow + cast + characters); when unavailable we fall back to a one-line opening.
            if (props.onStartStory) {
              props.onStartStory();
              return;
            }
            const opening = window.prompt(
              "✍️ Story as you go — describe the opening scene. We'll co-write it together and illustrate each beat:",
            );
            if (opening && opening.trim()) props.onSend(`/story ${opening.trim()}`);
          }}
          title="Start an illustrated story you co-write as you go (saved to your library to keep building)"
        >
          ✍️ Story
        </button>
        {props.modelMenu && props.modelMenu.groups.length > 0 && (
          <button
            ref={modelBtnRef}
            style={modelsOpen ? { ...smallButtonStyle, ...personaActiveStyle } : smallButtonStyle}
            onClick={() => setModelsOpen((o) => !o)}
            title="Switch the chat, image, or video model"
            aria-pressed={modelsOpen}
          >
            ⚙ Models
          </button>
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
              : props.persona === "planning"
                ? "What do you want to plan? (Enter to send, / for commands)"
                : "Ask anything, or tell me what to do… (Enter to send, / for commands)"
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
          <button style={smallButtonStyle} onClick={send} disabled={!draft.trim() && !hasReadyAttachment}>
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

/** Secondary actions (attach / story / models) — their own row above the input, so they never
 * squeeze the textarea's width on narrow screens. Wraps if it still doesn't fit. */
const utilityRowStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  padding: "6px 10px 0",
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

// The pinned working-checklist box — slightly stronger than the transient steps trace so it reads as
// the persistent plan.
const planBoxStyle = {
  margin: "2px 8px",
  padding: "6px 10px",
  borderRadius: 8,
  background: "rgba(122,162,255,0.1)",
  border: "1px solid rgba(122,162,255,0.3)",
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

// Quick model-switcher popover (opens above the input, mirroring the slash menu).
const modelMenuStyle = {
  borderTop: "1px solid rgba(255,255,255,0.1)",
  maxHeight: 260,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  padding: "4px 0",
} as const;
const modelGroupLabelStyle = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  opacity: 0.5,
  padding: "6px 12px 2px",
} as const;
const modelItemStyle = {
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  width: "100%",
  background: "transparent",
  color: "inherit",
  border: "none",
  textAlign: "left",
  padding: "5px 12px",
  fontSize: 12,
  cursor: "pointer",
} as const;
/** The Image group's ComfyUI/AUTOMATIC1111 picker — choosing a backend here just filters which
 * checkpoints show beneath it; it doesn't apply anything until a checkpoint row is clicked. */
const modelBackendSelectStyle = {
  margin: "2px 12px 4px",
  width: "calc(100% - 24px)",
  background: "rgba(255,255,255,0.06)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 6,
  padding: "3px 8px",
  fontSize: 12,
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
