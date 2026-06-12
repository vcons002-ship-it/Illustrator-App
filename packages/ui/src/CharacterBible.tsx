import { memo, useEffect, useMemo, useState } from "react";
import type { Character, CharacterAppearance, Outfit, VisualBible } from "@visual-reader/core";
import { MAX_CHARACTER_REFS, referenceIdsOf } from "@visual-reader/core";

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
  outfits?: Outfit[];
}

/** Seed the outfit editor: existing outfits, else migrate the legacy clothing list. */
function initialOutfits(c: Character): Outfit[] {
  if (c.outfits && c.outfits.length > 0) return c.outfits.map((o) => ({ ...o }));
  if (c.clothing.length > 0) return [{ label: "Default", description: c.clothing.join(", "), context: "" }];
  return [];
}

export interface CharacterBibleProps {
  bible: VisualBible | undefined;
  onSave: (characterId: string, patch: CharacterEdit) => void;
  /** Add a reference image for IP-Adapter (multi-view; capped per character). */
  onAddReference?: (characterId: string, image: { bytes: ArrayBuffer; mimeType: string }) => void;
  /** Remove one of a character's reference images. */
  onRemoveReference?: (characterId: string, refId: string) => void;
  /** Fetch a reference image's bytes for its thumbnail. */
  getReferenceImage?: (refId: string) => Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined>;
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

export function CharacterBible({
  bible,
  onSave,
  onAddReference,
  onRemoveReference,
  getReferenceImage,
  onClose,
}: CharacterBibleProps) {
  const characters = bible?.characters ?? [];
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  // Each character's searchable haystack, built once per bible update — not per
  // keystroke (a long novel tracks dozens-to-hundreds of characters, each with
  // many fields to join and lowercase).
  const haystacks = useMemo(
    () => characters.map((c) => ({ c, hay: characterHaystack(c) })),
    [characters],
  );
  const filtered = useMemo(
    () => (q ? haystacks.filter((e) => e.hay.includes(q)).map((e) => e.c) : characters),
    [characters, haystacks, q],
  );
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
              <CharacterCard
                key={c.id}
                character={c}
                onSave={onSave}
                {...(onAddReference ? { onAddReference } : {})}
                {...(onRemoveReference ? { onRemoveReference } : {})}
                {...(getReferenceImage ? { getReferenceImage } : {})}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A character's lowercased searchable text: name, aliases, and every detail. */
function characterHaystack(c: Character): string {
  return [
    c.name,
    ...c.aliases,
    ...Object.values(c.appearance),
    ...c.persistentTraits,
    ...c.clothing,
    ...(c.outfits ?? []).flatMap((o) => [o.label, o.description, o.context]),
  ]
    .join(" ")
    .toLowerCase();
}

// Memoised: a search keystroke (or any parent re-render) must not re-render every
// card — each one carries ~9 inputs, outfit rows, and a reference gallery.
const CharacterCard = memo(function CharacterCard({
  character,
  onSave,
  onAddReference,
  onRemoveReference,
  getReferenceImage,
}: {
  character: Character;
  onSave: (characterId: string, patch: CharacterEdit) => void;
  onAddReference?: (characterId: string, image: { bytes: ArrayBuffer; mimeType: string }) => void;
  onRemoveReference?: (characterId: string, refId: string) => void;
  getReferenceImage?: (refId: string) => Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined>;
}) {
  const [appearance, setAppearance] = useState<CharacterAppearance>(character.appearance);
  const [outfits, setOutfits] = useState<Outfit[]>(() => initialOutfits(character));
  const [saved, setSaved] = useState(false);

  // Re-sync local edits if the bible changes underneath (e.g. a rebuild).
  useEffect(() => {
    setAppearance(character.appearance);
    setOutfits(initialOutfits(character));
  }, [character]);

  const cleanOutfits = useMemo(
    () =>
      outfits
        .map((o) => ({ label: o.label.trim(), description: o.description.trim(), context: o.context.trim() }))
        .filter((o) => o.label || o.description),
    [outfits],
  );
  // The stringify round-trips ran on EVERY render of every card; keyed on the
  // actual edit state they run once per real change.
  const dirty = useMemo(
    () =>
      JSON.stringify(appearance) !== JSON.stringify(character.appearance) ||
      JSON.stringify(cleanOutfits) !== JSON.stringify(initialOutfits(character)),
    [appearance, cleanOutfits, character],
  );

  const setOutfit = (i: number, patch: Partial<Outfit>) =>
    setOutfits((list) => list.map((o, k) => (k === i ? { ...o, ...patch } : o)));
  const addOutfit = () => setOutfits((list) => [...list, { label: "", description: "", context: "" }]);
  const removeOutfit = (i: number) => setOutfits((list) => list.filter((_, k) => k !== i));

  const save = () => {
    onSave(character.id, { appearance, outfits: cleanOutfits });
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
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={labelStyle}>Outfits (the illustrator picks the one fitting each scene)</span>
          <button style={smallButtonStyle} onClick={addOutfit}>
            + Add outfit
          </button>
        </div>
        {outfits.length === 0 && (
          <span style={{ opacity: 0.5, fontSize: 12 }}>No outfits yet — add one, or they fill in as the book is read.</span>
        )}
        {outfits.map((o, i) => (
          <div key={i} style={outfitRowStyle}>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                style={{ ...inputStyle, flex: "0 0 38%" }}
                value={o.label}
                placeholder="label, e.g. flight leathers"
                onChange={(e) => setOutfit(i, { label: e.target.value })}
              />
              <input
                style={{ ...inputStyle, flex: 1 }}
                value={o.context}
                placeholder="when worn, e.g. flying, battle"
                onChange={(e) => setOutfit(i, { context: e.target.value })}
              />
              <button style={smallButtonStyle} title="Remove outfit" onClick={() => removeOutfit(i)}>
                ✕
              </button>
            </div>
            <input
              style={inputStyle}
              value={o.description}
              placeholder="description: garments, fabric, colour, accessories"
              onChange={(e) => setOutfit(i, { description: e.target.value })}
            />
          </div>
        ))}
      </div>
      {onAddReference && (
        <ReferenceGallery
          character={character}
          onAddReference={onAddReference}
          {...(onRemoveReference ? { onRemoveReference } : {})}
          {...(getReferenceImage ? { getReferenceImage } : {})}
        />
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
        {saved && <span style={{ color: "#7dd87f", fontSize: 12 }}>✓ saved</span>}
        <button style={buttonStyle} disabled={!dirty} onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
});

/**
 * Up to MAX_CHARACTER_REFS uploaded reference photos per character (ideally different
 * angles of the same face), shown as removable thumbnails. Used by the local ComfyUI
 * engine via IP-Adapter; other image providers ignore them.
 */
function ReferenceGallery({
  character,
  onAddReference,
  onRemoveReference,
  getReferenceImage,
}: {
  character: Character;
  onAddReference: (characterId: string, image: { bytes: ArrayBuffer; mimeType: string }) => void;
  onRemoveReference?: (characterId: string, refId: string) => void;
  getReferenceImage?: (refId: string) => Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined>;
}) {
  const refIds = referenceIdsOf(character.anchor);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
      <span style={labelStyle}>
        Reference images ({refIds.length}/{MAX_CHARACTER_REFS})
      </span>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {refIds.map((refId) => (
          <ReferenceThumb
            key={refId}
            refId={refId}
            {...(getReferenceImage ? { getReferenceImage } : {})}
            {...(onRemoveReference ? { onRemove: () => onRemoveReference(character.id, refId) } : {})}
          />
        ))}
        {refIds.length < MAX_CHARACTER_REFS && (
          <label style={{ ...buttonStyle, cursor: "pointer", fontSize: 12 }}>
            + Add
            <input
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const bytes = await file.arrayBuffer();
                onAddReference(character.id, { bytes, mimeType: file.type || "image/png" });
                e.target.value = ""; // allow re-selecting the same file later
              }}
            />
          </label>
        )}
      </div>
      <span style={{ opacity: 0.5, fontSize: 11 }}>
        Used by the local ComfyUI engine (IP-Adapter). 2–3 angles of the same face work best.
      </span>
    </div>
  );
}

/** One reference thumbnail (bytes fetched lazily) with its remove button. */
function ReferenceThumb({
  refId,
  getReferenceImage,
  onRemove,
}: {
  refId: string;
  getReferenceImage?: (refId: string) => Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined>;
  onRemove?: () => void;
}) {
  const [url, setUrl] = useState<string | undefined>();
  useEffect(() => {
    if (!getReferenceImage) return;
    let objectUrl: string | undefined;
    let cancelled = false;
    void getReferenceImage(refId).then((img) => {
      if (!img || cancelled) return;
      objectUrl = URL.createObjectURL(new Blob([img.bytes], { type: img.mimeType }));
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [refId, getReferenceImage]);
  return (
    <span style={thumbStyle}>
      {url ? (
        <img src={url} alt="character reference" decoding="async" style={thumbImgStyle} />
      ) : (
        <span style={{ opacity: 0.4, fontSize: 11 }}>…</span>
      )}
      {onRemove && (
        <button style={thumbRemoveStyle} title="Remove this reference" onClick={onRemove}>
          ✕
        </button>
      )}
    </span>
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

const smallButtonStyle = {
  ...buttonStyle,
  padding: "2px 8px",
  fontSize: 12,
} as const;

const thumbStyle = {
  position: "relative",
  width: 56,
  height: 56,
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.18)",
  background: "rgba(255,255,255,0.04)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
} as const;

const thumbImgStyle = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
} as const;

const thumbRemoveStyle = {
  position: "absolute",
  top: 1,
  right: 1,
  background: "rgba(0,0,0,0.55)",
  border: "none",
  color: "#fff",
  borderRadius: 4,
  fontSize: 10,
  lineHeight: "14px",
  width: 16,
  height: 16,
  padding: 0,
  cursor: "pointer",
} as const;

const outfitRowStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: 8,
  border: "1px solid rgba(255,255,255,0.10)",
  borderRadius: 6,
} as const;
