import { memo, useMemo, useState } from "react";
import { ModalShell } from "./ModalShell.js";
import { modalHeaderRowStyle as headerRow, modalInputStyle as input } from "./tokens.js";

/**
 * Set up a "story as you go" before it starts: the opening scene, the workflow (Roleplay vs Direct
 * writing), and the cast (You & me — seeded from the identity souls — vs Custom characters). In
 * roleplay you tag who the reader plays ("me") and who the assistant plays ("you"); those become real
 * character names so the illustration tracks the right subjects. Builds the start_story payload.
 */

export interface StoryCharacterDraft {
  name: string;
  description: string;
}

export interface StoryStartPayload {
  opening: string;
  title?: string;
  characters?: { name: string; description?: string }[];
  roleplay?: { me?: string; you?: string };
  /** App-owned mapping for the stored You + Me pair. The host removes it from the `/story` JSON and
   * relays it to the worker as trusted control data; custom casts never set it. */
  soulCast?: { self: string; user: string };
  /** The conversation so far, when the reader chose to bring this chat into the story. */
  soFar?: string;
}

export interface StorySetupModalProps {
  /** The assistant's identity (from the Soul panel) — prefilled as the character it plays. */
  self: { name: string; note?: string };
  /** The reader's identity (from the You panel) — prefilled as the character they play. */
  user: { name: string; note?: string };
  /** The chat this was opened from, rendered as text — absent (or empty) when there's nothing worth
   * carrying. When present the reader is offered "continue what we've been telling", which hands it
   * to the story so the first beat carries on instead of opening a scene they've already left. */
  chatSoFar?: string;
  onStart: (payload: StoryStartPayload) => void;
  onClose: () => void;
}

type Workflow = "roleplay" | "direct";
type Cast = "you-and-me" | "custom";

export const StorySetupModal = memo(function StorySetupModal({ self, user, chatSoFar, onStart, onClose }: StorySetupModalProps) {
  const [opening, setOpening] = useState("");
  const canCarry = !!chatSoFar?.trim();
  // Defaults ON when there IS a conversation: opening this from a chat that's already telling a story
  // and having it start something unrelated is the surprise worth avoiding.
  const [carry, setCarry] = useState(canCarry);
  const [workflow, setWorkflow] = useState<Workflow>("roleplay");
  const [cast, setCast] = useState<Cast>("you-and-me");
  const [chars, setChars] = useState<StoryCharacterDraft[]>([{ name: "", description: "" }]);
  // Played names (You & me): prefilled from the souls, editable so they're always real + distinct.
  const [meName, setMeName] = useState(user.name || "Me");
  const [youName, setYouName] = useState(self.name || "You");
  // Played tags (Custom + roleplay): which custom character is the reader / the assistant.
  const [meIdx, setMeIdx] = useState(0);
  const [youIdx, setYouIdx] = useState(1);

  const namedChars = useMemo(() => chars.filter((c) => c.name.trim()), [chars]);
  const carrying = canCarry && carry;
  const resolvedMeName = meName.trim() || "Me";
  const resolvedYouName = youName.trim() || "You";
  const distinctYouAndMe =
    resolvedMeName.localeCompare(resolvedYouName, undefined, { sensitivity: "accent" }) !== 0;
  // Carrying the chat, the idea box is optional — that conversation is the premise.
  const canStart =
    (carrying || opening.trim().length > 0) &&
    (cast === "you-and-me" ? distinctYouAndMe : namedChars.length > 0);

  const setChar = (i: number, patch: Partial<StoryCharacterDraft>) =>
    setChars((cs) => cs.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const addChar = () => setChars((cs) => [...cs, { name: "", description: "" }]);
  const removeChar = (i: number) => setChars((cs) => (cs.length > 1 ? cs.filter((_, k) => k !== i) : cs));

  const start = () => {
    if (!canStart) return;
    const payload: StoryStartPayload = { opening: opening.trim() };
    if (carrying) payload.soFar = chatSoFar!.trim();
    if (cast === "you-and-me") {
      const me = resolvedMeName;
      const you = resolvedYouName;
      payload.soulCast = { self: you, user: me };
      payload.characters = [
        { name: you, ...(self.note ? { description: self.note } : {}) },
        { name: me, ...(user.note ? { description: user.note } : {}) },
      ];
      if (workflow === "roleplay") payload.roleplay = { me, you };
    } else {
      payload.characters = namedChars.map((c) => ({ name: c.name.trim(), ...(c.description.trim() ? { description: c.description.trim() } : {}) }));
      if (workflow === "roleplay") {
        const me = namedChars[meIdx]?.name.trim();
        const you = namedChars[youIdx]?.name.trim();
        payload.roleplay = { ...(me ? { me } : {}), ...(you ? { you } : {}) };
      }
    }
    onStart(payload);
  };

  return (
    <ModalShell title="Story as you go" onClose={onClose} width="min(640px, 100%)" cardStyle={{ gap: 12 }}>
        <div style={headerRow}>
          <strong>✍️ Story as you go</strong>
          <button style={btn} onClick={onClose}>
            Close
          </button>
        </div>

        {canCarry ? (
          <label style={{ ...panel, flexDirection: "row", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={carry}
              onChange={(e) => setCarry(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 13 }}>Bring the full conversation into this story</span>
              <span style={hint}>
                Includes every reader and assistant message, so the first beat picks up where you left
                off instead of starting a new scene. Story responses and explicit chapter headings
                become separate illustrated sections. Untick to begin something fresh.
              </span>
            </span>
          </label>
        ) : null}

        <label style={field}>
          <span style={label}>{carrying ? "Where to take it (optional)" : "Your story idea"}</span>
          <textarea
            style={textarea}
            value={opening}
            placeholder={
              carrying
                ? "Anything to steer the next beat — a turn you want, a mood, somewhere it should head. Leave it blank to just carry on."
                : "A sentence or two about the premise — the setting, who's there, the mood. The assistant writes the title and opening scene from this, then you co-write and illustrate each beat."
            }
            onChange={(e) => setOpening(e.target.value)}
            autoFocus
          />
        </label>

        <div style={row}>
          <label style={{ ...field, flex: 1 }}>
            <span style={label}>Workflow</span>
            <select style={select} value={workflow} onChange={(e) => setWorkflow(e.target.value as Workflow)}>
              <option value="roleplay">Roleplay — your input is woven into the narrated scene</option>
              <option value="direct">Direct writing — you direct, the assistant narrates</option>
            </select>
          </label>
          <label style={{ ...field, flex: 1 }}>
            <span style={label}>Cast</span>
            <select style={select} value={cast} onChange={(e) => setCast(e.target.value as Cast)}>
              <option value="you-and-me">You &amp; me</option>
              <option value="custom">Custom characters</option>
            </select>
          </label>
        </div>

        {cast === "you-and-me" ? (
          <div style={panel}>
            <span style={{ ...label, marginBottom: 4 }}>
              {workflow === "roleplay" ? "You play yourself; the assistant plays itself." : "The story features you and the assistant."}
            </span>
            <div style={row}>
              <label style={{ ...field, flex: 1 }}>
                <span style={label}>You play</span>
                <input style={input} value={meName} onChange={(e) => setMeName(e.target.value)} placeholder="Your character name" />
              </label>
              <label style={{ ...field, flex: 1 }}>
                <span style={label}>Assistant plays</span>
                <input style={input} value={youName} onChange={(e) => setYouName(e.target.value)} placeholder="The assistant's name" />
              </label>
            </div>
            <span style={hint}>
              Tip: fill in your look/personality under 🪞 Soul and 👤 You so the illustrations match.
            </span>
            {!distinctYouAndMe ? (
              <span role="alert" style={{ ...hint, color: "#ff9a9a", opacity: 0.9 }}>
                You and the assistant need distinct character names.
              </span>
            ) : null}
          </div>
        ) : (
          <div style={panel}>
            <span style={{ ...label, marginBottom: 4 }}>Characters</span>
            {chars.map((c, i) => (
              <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <input
                  style={{ ...input, flex: "0 0 30%" }}
                  value={c.name}
                  placeholder="Name"
                  onChange={(e) => setChar(i, { name: e.target.value })}
                />
                <input
                  style={{ ...input, flex: 1 }}
                  value={c.description}
                  placeholder="Look, personality, anything important"
                  onChange={(e) => setChar(i, { description: e.target.value })}
                />
                <button style={btn} onClick={() => removeChar(i)} disabled={chars.length <= 1} title="Remove" aria-label={`Remove character ${c.name || i + 1}`}>
                  ✕
                </button>
              </div>
            ))}
            <button style={btn} onClick={addChar}>
              + Add character
            </button>
            {workflow === "roleplay" && namedChars.length > 0 && (
              <div style={{ ...row, marginTop: 8 }}>
                <label style={{ ...field, flex: 1 }}>
                  <span style={label}>You play</span>
                  <select style={select} value={meIdx} onChange={(e) => setMeIdx(Number(e.target.value))}>
                    {namedChars.map((c, i) => (
                      <option key={i} value={i}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ ...field, flex: 1 }}>
                  <span style={label}>Assistant plays</span>
                  <select style={select} value={youIdx} onChange={(e) => setYouIdx(Number(e.target.value))}>
                    {namedChars.map((c, i) => (
                      <option key={i} value={i}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button style={btn} onClick={onClose}>
            Cancel
          </button>
          <button style={btnPrimary} onClick={start} disabled={!canStart}>
            Start story
          </button>
        </div>
    </ModalShell>
  );
});

const field: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const row: React.CSSProperties = { display: "flex", gap: 10 };
const panel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  padding: 10,
  gap: 4,
};
const label: React.CSSProperties = { fontSize: 12, opacity: 0.75 };
const hint: React.CSSProperties = { fontSize: 11, opacity: 0.55, marginTop: 4 };
const textarea: React.CSSProperties = { ...input, minHeight: 90, resize: "vertical" };
const select: React.CSSProperties = { ...input, cursor: "pointer" };
const btn: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 6,
  padding: "6px 12px",
  fontSize: 13,
  cursor: "pointer",
};
const btnPrimary: React.CSSProperties = {
  ...btn,
  background: "rgba(122,162,255,0.25)",
  border: "1px solid rgba(122,162,255,0.6)",
};
