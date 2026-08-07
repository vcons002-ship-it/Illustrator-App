import { t } from "./design/tokens.js";
import { memo, useEffect, useMemo, useState } from "react";
import type { BibleEntityKind, Creature, Environment, VisualBible } from "@visual-reader/core";
import { RemovedBibleEntries } from "./RemovedBibleEntries.js";
import { SUCCESS_GREEN } from "./tokens.js";
import { cx } from "./design/classes.js";

/**
 * Read + correct the Visual Bible's CREATURES and PLACES — the two lists that had no window of
 * their own.
 *
 * Characters have had one since the start, and everything that made it necessary is just as true
 * here: these entries are written by a model from the prose, they accumulate across chapters, and
 * they go into every picture their subject appears in. A place's description is where a world's
 * atmosphere lives; a nickname on either is what makes a word in a prompt resolve to it — and a
 * wrong one puts its whole description wherever that word appears. All of that was invisible and
 * uncorrectable.
 *
 * Same contract as the character bible: saved immediately, existing images untouched, the edit
 * lands on the next render.
 */

/** A patch the host forwards to `engine.updateCreature`. */
export interface CreatureEdit {
  name?: string;
  aliases?: string[];
  kind?: string;
  description?: string[];
}

/** A patch the host forwards to `engine.updateEnvironment`. */
export interface EnvironmentEdit {
  name?: string;
  aliases?: string[];
  description?: string[];
}

export interface WorldBibleProps {
  bible: VisualBible | undefined;
  onSaveCreature: (creatureId: string, patch: CreatureEdit) => void;
  onSavePlace: (environmentId: string, patch: EnvironmentEdit) => void;
  /** Delete an entry outright. Remembered, so reading on can't put it back. */
  onRemove?: (kind: BibleEntityKind, id: string) => void;
  /** Undo a deletion — the entry returns with everything it had. */
  onRestore?: (kind: BibleEntityKind, id: string) => void;
  /** Which list to show first — the button the reader pressed. */
  initialTab?: "creatures" | "places";
  onClose: () => void;
}

export function WorldBible({
  bible,
  onSaveCreature,
  onSavePlace,
  onRemove,
  onRestore,
  initialTab,
  onClose,
}: WorldBibleProps) {
  const creatures = bible?.creatures ?? [];
  const places = bible?.environments ?? [];
  const [tab, setTab] = useState<"creatures" | "places">(initialTab ?? "places");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const shown = useMemo(() => {
    const hay = (parts: readonly (string | undefined)[]) => parts.filter(Boolean).join(" ").toLowerCase();
    if (tab === "creatures") {
      return creatures.filter((c) => !q || hay([c.name, c.kind, ...c.aliases, ...c.description]).includes(q));
    }
    return places.filter((e) => !q || hay([e.name, ...(e.aliases ?? []), ...e.description]).includes(q));
  }, [tab, q, creatures, places]);

  const total = tab === "creatures" ? creatures.length : places.length;
  // Each tab shows only its OWN deletions: a place and a creature can share a name, and a footnote
  // that mixed them would say nothing about which list an entry is missing from.
  const removed = useMemo(
    () => (bible?.removed ?? []).filter((r) => r.kind === (tab === "creatures" ? "creature" : "environment")),
    [bible?.removed, tab],
  );
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <strong>World bible</strong>
          <span style={{ display: "flex", gap: 6 }}>
            <button style={tab === "places" ? activeTabStyle : tabStyle} onClick={() => setTab("places")}>
              Places ({places.length})
            </button>
            <button style={tab === "creatures" ? activeTabStyle : tabStyle} onClick={() => setTab("creatures")}>
              Creatures ({creatures.length})
            </button>
          </span>
          <button className={cx.btn} style={buttonStyle} onClick={onClose}>
            Close
          </button>
        </div>
        <p style={{ opacity: 0.65, fontSize: 12, margin: "0 0 8px" }}>
          {tab === "places"
            ? "A place's description is used whenever a scene is set there — it's where the look and atmosphere of your world lives. Fix anything wrong; saved instantly, and it applies to new or re-rendered images."
            : "A creature's description is used in every picture it appears in. Fix anything wrong; saved instantly, and it applies to new or re-rendered images."}
        </p>
        {total > 0 && (
          <input
            style={searchStyle}
            value={query}
            placeholder={tab === "places" ? "Search places…" : "Search creatures…"}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        {total === 0 ? (
          <p style={{ opacity: 0.7 }}>
            {tab === "places"
              ? "No places yet — they appear here as the book is read."
              : "No creatures yet — they appear here as the book is read. (Not every story has any.)"}
          </p>
        ) : shown.length === 0 ? (
          <p style={{ opacity: 0.7 }}>Nothing matches “{query}”.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {tab === "creatures"
              ? (shown as Creature[]).map((c) => (
                  <CreatureCard
                    key={c.id}
                    creature={c}
                    onSave={onSaveCreature}
                    {...(onRemove ? { onRemove: () => onRemove("creature", c.id) } : {})}
                  />
                ))
              : (shown as Environment[]).map((e) => (
                  <PlaceCard
                    key={e.id}
                    place={e}
                    onSave={onSavePlace}
                    {...(onRemove ? { onRemove: () => onRemove("environment", e.id) } : {})}
                  />
                ))}
          </div>
        )}
        {onRestore && (
          <RemovedBibleEntries
            entries={removed.map((r) => ({ id: r.entity.id, name: r.entity.name }))}
            what={tab === "creatures" ? "creature" : "place"}
            onRestore={(id) => onRestore(tab === "creatures" ? "creature" : "environment", id)}
          />
        )}
      </div>
    </div>
  );
}

/** One description line per row — that's how they're stored (accumulated per chapter), and editing
 * them as one blob would silently merge lines the extractor keeps apart. */
function linesToText(lines: readonly string[]): string {
  return lines.join("\n");
}
function textToLines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

const CreatureCard = memo(function CreatureCard({
  creature,
  onSave,
  onRemove,
}: {
  creature: Creature;
  onSave: (creatureId: string, patch: CreatureEdit) => void;
  onRemove?: () => void;
}) {
  const [name, setName] = useState(creature.name);
  const [kind, setKind] = useState(creature.kind);
  const [aliases, setAliases] = useState(() => creature.aliases.join(", "));
  const [description, setDescription] = useState(() => linesToText(creature.description));
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setName(creature.name);
    setKind(creature.kind);
    setAliases(creature.aliases.join(", "));
    setDescription(linesToText(creature.description));
  }, [creature]);

  const clean = useMemo(
    () => ({
      name: name.trim() || creature.name,
      kind: kind.trim(),
      aliases: splitAliases(aliases),
      description: textToLines(description),
    }),
    [name, kind, aliases, description, creature.name],
  );
  const dirty =
    clean.name !== creature.name ||
    clean.kind !== creature.kind ||
    JSON.stringify(clean.aliases) !== JSON.stringify(creature.aliases) ||
    JSON.stringify(clean.description) !== JSON.stringify(creature.description);

  return (
    <div style={cardStyle}>
      <div style={rowStyle}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Name</span>
          <input className={cx.input} style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Kind (dragon, hound, drone…)</span>
          <input className={cx.input} style={inputStyle} value={kind} onChange={(e) => setKind(e.target.value)} />
        </label>
      </div>
      <AliasField value={aliases} onChange={setAliases} />
      <DescriptionField value={description} onChange={setDescription} what="creature" />
      <SaveRow
        saved={saved}
        dirty={dirty}
        onSave={() => {
          onSave(creature.id, clean);
          setSaved(true);
          setTimeout(() => setSaved(false), 1500);
        }}
        {...(onRemove ? { onDelete: () => confirmDelete(creature.name, "creature", onRemove) } : {})}
      />
    </div>
  );
});

const PlaceCard = memo(function PlaceCard({
  place,
  onSave,
  onRemove,
}: {
  place: Environment;
  onSave: (environmentId: string, patch: EnvironmentEdit) => void;
  onRemove?: () => void;
}) {
  const [name, setName] = useState(place.name);
  const [aliases, setAliases] = useState(() => (place.aliases ?? []).join(", "));
  const [description, setDescription] = useState(() => linesToText(place.description));
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setName(place.name);
    setAliases((place.aliases ?? []).join(", "));
    setDescription(linesToText(place.description));
  }, [place]);

  const clean = useMemo(
    () => ({
      name: name.trim() || place.name,
      aliases: splitAliases(aliases),
      description: textToLines(description),
    }),
    [name, aliases, description, place.name],
  );
  const dirty =
    clean.name !== place.name ||
    JSON.stringify(clean.aliases) !== JSON.stringify(place.aliases ?? []) ||
    JSON.stringify(clean.description) !== JSON.stringify(place.description);

  return (
    <div style={cardStyle}>
      <label style={fieldStyle}>
        <span style={labelStyle}>Name</span>
        <input className={cx.input} style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <AliasField value={aliases} onChange={setAliases} />
      <DescriptionField value={description} onChange={setDescription} what="place" />
      <SaveRow
        saved={saved}
        dirty={dirty}
        onSave={() => {
          onSave(place.id, clean);
          setSaved(true);
          setTimeout(() => setSaved(false), 1500);
        }}
        {...(onRemove ? { onDelete: () => confirmDelete(place.name, "place", onRemove) } : {})}
      />
    </div>
  );
});

function splitAliases(text: string): string[] {
  return text.split(",").map((a) => a.trim()).filter(Boolean);
}

function AliasField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label style={fieldStyle}>
      <span style={labelStyle}>Also known as (comma-separated)</span>
      <input
        className={cx.input} style={inputStyle}
        value={value}
        placeholder="other names the story uses for this"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function DescriptionField({
  value,
  onChange,
  what,
}: {
  value: string;
  onChange: (v: string) => void;
  what: "creature" | "place";
}) {
  return (
    <label style={fieldStyle}>
      <span style={labelStyle}>Description — one detail per line</span>
      <textarea
        style={{ ...inputStyle, minHeight: 68, resize: "vertical", fontFamily: "inherit" }}
        value={value}
        placeholder={
          what === "place"
            ? "e.g. low stone taproom, warm firelight\nlong oak bar"
            : "e.g. bronze scales, torn left wing"
        }
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** The model writes down things that aren't entries at all — a simile read as a beast, a metaphor
 * read as a place — and while one exists it goes into pictures. Deleting says so; the wording says
 * what deleting actually does, including that it survives reading on and can be undone. */
function confirmDelete(name: string, what: string, onRemove: () => void): void {
  if (
    window.confirm(
      `Delete “${name}” from the bible?\n\nThis ${what} stops appearing in new images, and reading on won't add it back. Existing images are kept. You can undo this from “Deleted” at the bottom of this list.`,
    )
  ) {
    onRemove();
  }
}

function SaveRow({
  saved,
  dirty,
  onSave,
  onDelete,
}: {
  saved: boolean;
  dirty: boolean;
  onSave: () => void;
  onDelete?: () => void;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
      {saved && <span style={{ color: SUCCESS_GREEN, fontSize: 12 }}>✓ saved</span>}
      {onDelete && (
        <button style={dangerButtonStyle} onClick={onDelete}>
          Delete
        </button>
      )}
      <button className={cx.btn} style={buttonStyle} disabled={!dirty} onClick={onSave}>
        Save
      </button>
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
  background: t.surface.card,
  border: `1px solid ${t.border.input}`,
  borderRadius: 12,
  padding: 16,
  fontFamily: "system-ui, sans-serif",
  color: t.text.base,
} as const;

const headerStyle = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  justifyContent: "space-between",
  marginBottom: 8,
  flexWrap: "wrap",
} as const;

const tabStyle = {
  background: "transparent",
  color: "inherit",
  border: `1px solid ${t.border.button}`,
  borderRadius: 999,
  padding: "3px 12px",
  fontSize: 12,
  cursor: "pointer",
} as const;

const activeTabStyle = {
  ...tabStyle,
  borderColor: t.accent.edge,
  background: t.accent.edge,
  color: t.accent.text,
  fontWeight: 600,
} as const;

const buttonStyle = {
  background: "transparent",
  color: "inherit",
  border: `1px solid ${t.border.button}`,
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 13,
  cursor: "pointer",
} as const;

const dangerButtonStyle = {
  ...buttonStyle,
  borderColor: t.state.danger,
  color: t.state.danger,
} as const;

const searchStyle = {
  width: "100%",
  boxSizing: "border-box",
  background: t.fill.subtle,
  color: "inherit",
  border: `1px solid ${t.border.button}`,
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 13,
  marginBottom: 10,
} as const;

const cardStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  border: `1px solid ${t.border.subtle}`,
  borderRadius: 10,
  padding: 12,
  background: t.fill.subtle,
} as const;

const rowStyle = { display: "flex", gap: 8, flexWrap: "wrap" } as const;
const fieldStyle = { display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 180 } as const;
const labelStyle = { fontSize: 11, opacity: 0.6 } as const;
const inputStyle = {
  background: t.fill.subtle,
  color: "inherit",
  border: `1px solid ${t.border.button}`,
  borderRadius: 6,
  padding: "5px 8px",
  fontSize: 13,
  width: "100%",
  boxSizing: "border-box",
} as const;
