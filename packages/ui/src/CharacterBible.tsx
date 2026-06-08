import { useEffect, useState } from "react";
import type { Character, CharacterAppearance, VisualBible } from "@visual-reader/core";

/**
 * Read + correct the Visual Bible's characters. The LLM fills in each character's
 * appearance as easy-to-scan fields (Hair, Eyes, Gender, Build…); the reader can
 * fix any mistake. Saving persists immediately but does NOT re-render existing
 * images — the edit applies to new/regenerated illustrations (the reader chooses
 * when to re-render), so this stays a cheap, instant correction surface.
 */

/** A patch the host forwards to `engine.updateCharacter`. */
export interface CharacterEdit {
  appearance?: Partial<CharacterAppearance>;
  clothing?: string[];
}

export interface CharacterBibleProps {
  bible: VisualBible | undefined;
  onSave: (characterId: string, patch: CharacterEdit) => void;
  onClose: () => void;
}

/** Labels + order for the structured appearance fields. */
const APPEARANCE_FIELDS: Array<{ key: keyof CharacterAppearance; label: string }> = [
  { key: "gender", label: "Gender" },
  { key: "age", label: "Age" },
  { key: "hair", label: "Hair" },
  { key: "eyes", label: "Eyes" },
  { key: "build", label: "Physique" },
  { key: "height", label: "Height" },
  { key: "skinTone", label: "Skin tone" },
  { key: "distinguishingMarks", label: "Distinguishing marks" },
  { key: "notes", label: "Notes" },
];

export function CharacterBible({ bible, onSave, onClose }: CharacterBibleProps) {
  const characters = bible?.characters ?? [];
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q ? characters.filter((c) => matchesQuery(c, q)) : characters;
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <strong>Character bible</strong>
          <span style={{ opacity: 0.6, fontSize: 12 }}>
            {q ? `${filtered.length} of ${characters.length}` : characters.length} character
            {characters.length === 1 ? "" : "s"} tracked
          </span>
          <button style={buttonStyle} onClick={onClose}>
            Close
          </button>
        </div>
        <p style={{ opacity: 0.65, fontSize: 12, margin: "0 0 8px" }}>
          Fix any wrong detail below (any field is free text — e.g. “long brown hair that fades
          to silver at the tips”). Saved instantly; re-render an image to apply it (existing
          images are kept).
        </p>
        {characters.length > 0 && (
          <input
            style={searchStyle}
            value={query}
            placeholder="Search characters by name, alias, or any detail…"
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        {characters.length === 0 ? (
          <p style={{ opacity: 0.7 }}>
            No characters yet — they appear here as the Visual Bible is built.
          </p>
        ) : filtered.length === 0 ? (
          <p style={{ opacity: 0.7 }}>No characters match “{query}”.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {filtered.map((c) => (
              <CharacterCard key={c.id} character={c} onSave={onSave} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Match a character against a lowercased query across name, aliases, and every detail. */
function matchesQuery(c: Character, q: string): boolean {
  const haystack = [
    c.name,
    ...c.aliases,
    ...Object.values(c.appearance),
    ...c.persistentTraits,
    ...c.clothing,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

function CharacterCard({
  character,
  onSave,
}: {
  character: Character;
  onSave: (characterId: string, patch: CharacterEdit) => void;
}) {
  const [appearance, setAppearance] = useState<CharacterAppearance>(character.appearance);
  const [clothing, setClothing] = useState(character.clothing.join(", "));
  const [saved, setSaved] = useState(false);

  // Re-sync local edits if the bible changes underneath (e.g. a rebuild).
  useEffect(() => {
    setAppearance(character.appearance);
    setClothing(character.clothing.join(", "));
  }, [character]);

  const dirty =
    JSON.stringify(appearance) !== JSON.stringify(character.appearance) ||
    clothing !== character.clothing.join(", ");

  const save = () => {
    onSave(character.id, {
      appearance,
      clothing: clothing
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <strong>{character.name}</strong>
        {character.aliases.length > 0 && (
          <span style={{ opacity: 0.55, fontSize: 12 }}>aka {character.aliases.join(", ")}</span>
        )}
      </div>
      <div style={gridStyle}>
        {APPEARANCE_FIELDS.map(({ key, label }) => (
          <label key={key} style={fieldStyle}>
            <span style={labelStyle}>{label}</span>
            <input
              style={inputStyle}
              value={appearance[key]}
              onChange={(e) => setAppearance((a) => ({ ...a, [key]: e.target.value }))}
            />
          </label>
        ))}
        <label style={{ ...fieldStyle, gridColumn: "1 / -1" }}>
          <span style={labelStyle}>Clothing / outfit</span>
          <input
            style={inputStyle}
            value={clothing}
            placeholder="comma-separated, e.g. black flight leathers, buckled straps"
            onChange={(e) => setClothing(e.target.value)}
          />
        </label>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
        {saved && <span style={{ color: "#7dd87f", fontSize: 12 }}>✓ saved</span>}
        <button style={buttonStyle} disabled={!dirty} onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

const overlayStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "6vh 16px",
  zIndex: 50,
  overflowY: "auto",
} as const;

const panelStyle = {
  width: "min(720px, 100%)",
  background: "#171922",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 12,
  padding: 16,
  fontFamily: "system-ui, sans-serif",
  color: "#e9ecf2",
} as const;

const headerStyle = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginBottom: 8,
} as const;

const searchStyle = {
  width: "100%",
  boxSizing: "border-box",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 8,
  color: "inherit",
  padding: "8px 10px",
  fontSize: 13,
  marginBottom: 12,
} as const;

const cardStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
} as const;

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 8,
} as const;

const fieldStyle = { display: "flex", flexDirection: "column", gap: 3 } as const;
const labelStyle = { opacity: 0.6, fontSize: 11 } as const;
const inputStyle = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 6,
  color: "inherit",
  padding: "4px 8px",
  fontSize: 13,
} as const;

const buttonStyle = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.3)",
  color: "inherit",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
} as const;
