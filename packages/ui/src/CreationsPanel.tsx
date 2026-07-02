import { useEffect, useRef, useState } from "react";

/** A gallery entry, byte-free: the panel hydrates media lazily through `load` (keyed by `key`),
 * so opening the gallery never pulls every stored video into RAM at once. */
export interface CreationCard {
  /** Stable identity — passed back to `load`/`onDelete`. */
  key: string;
  /** Which chat it came from (book title / assistant-session label). */
  chatLabel: string;
  /** ms epoch of the message that produced it. */
  at: number;
  kind: "image" | "video";
  mimeType: string;
  /** Caption: the file name or a snippet of the message it appeared in. */
  label?: string;
}

export interface CreationsPanelProps {
  items: CreationCard[];
  /** Fetch an item's bytes (inline or from the chat blob store). `undefined` = missing/failed. */
  load: (key: string) => Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined>;
  /** Permanently remove the creation (from its chat's history AND the blob store). */
  onDelete: (key: string) => void;
  /** Join the selected VIDEO clips (in pick order) into one mp4 — desktop only; absent hides the
   * whole select-and-stitch affordance. */
  onStitch?: (keys: string[]) => void;
  onClose: () => void;
}

/**
 * The Creations gallery: every image/video the assistant generated across all chats and books, in
 * one grid — view full-size, download, or delete. Image thumbnails hydrate as their cards mount;
 * videos hydrate on click (clips are big), showing a play tile until then.
 */
export function CreationsPanel({ items, load, onDelete, onStitch, onClose }: CreationsPanelProps) {
  const [filter, setFilter] = useState<"all" | "image" | "video">("all");
  const [viewing, setViewing] = useState<CreationCard | undefined>(undefined);
  // Stitch mode: pick video clips IN ORDER, then join them. `selected` preserves pick order —
  // that IS the final clip order.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const toggleSelected = (key: string) =>
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  // One object-URL cache for the panel's lifetime: cards fill it as they hydrate, the lightbox and
  // Download reuse it, and closing the panel revokes everything (the effect below).
  const [urls, setUrls] = useState<Record<string, string>>({});
  const urlsRef = useRef(urls); // the unmount cleanup must see the LATEST map, not render #1's
  urlsRef.current = urls;
  useEffect(() => {
    return () => {
      for (const u of Object.values(urlsRef.current)) URL.revokeObjectURL(u);
    };
    // Revoke-on-unmount only — revoking mid-session would break mounted <img>/<video> tags.
  }, []);

  const hydrate = async (card: CreationCard): Promise<string | undefined> => {
    const got = await load(card.key).catch(() => undefined);
    if (!got) return undefined;
    const url = URL.createObjectURL(new Blob([got.bytes], { type: got.mimeType || card.mimeType }));
    setUrls((prev) => {
      if (prev[card.key]) {
        URL.revokeObjectURL(url); // a parallel hydrate won — keep the first URL
        return prev;
      }
      return { ...prev, [card.key]: url };
    });
    return url;
  };

  const download = async (card: CreationCard) => {
    const url = urls[card.key] ?? (await hydrate(card));
    if (!url) return;
    const ext = (card.mimeType.split("/")[1] ?? (card.kind === "video" ? "mp4" : "png")).split("+")[0];
    const a = document.createElement("a");
    a.href = url;
    a.download = `creation-${new Date(card.at).toISOString().slice(0, 19).replace(/[T:]/g, "-")}.${ext}`;
    a.click();
  };

  const remove = (card: CreationCard) => {
    if (!window.confirm("Delete this creation? It's removed from the chat it appeared in too.")) return;
    setViewing((v) => (v?.key === card.key ? undefined : v));
    onDelete(card.key);
  };

  const shown = filter === "all" ? items : items.filter((i) => i.kind === filter);
  const counts = { image: items.filter((i) => i.kind === "image").length, video: items.filter((i) => i.kind === "video").length };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <strong>🎨 Creations</strong>
          <span style={{ opacity: 0.6, fontSize: 12 }}>
            {items.length} item{items.length === 1 ? "" : "s"}
          </span>
          {onStitch && counts.video >= 2 && (
            <button
              style={selecting ? { ...buttonStyle, borderColor: "rgba(120,180,255,0.7)" } : buttonStyle}
              title="Pick video clips in order, then join them into one video"
              onClick={() => {
                setSelected([]);
                setSelecting((s) => !s);
                if (!selecting) setFilter("video"); // stitch mode is videos-only — show them
              }}
            >
              {selecting ? "Cancel select" : "🎬 Select clips"}
            </button>
          )}
          <button style={buttonStyle} onClick={onClose}>
            Close
          </button>
        </div>
        {selecting && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ opacity: 0.7, fontSize: 12, flex: 1 }}>
              Tap video clips in the order they should play{selected.length > 0 ? ` — ${selected.length} picked` : ""}.
            </span>
            <button
              style={selected.length >= 2 ? { ...buttonStyle, borderColor: "rgba(120,220,150,0.6)" } : { ...buttonStyle, opacity: 0.5, cursor: "default" }}
              disabled={selected.length < 2}
              onClick={() => {
                onStitch?.(selected);
                setSelecting(false);
                setSelected([]);
              }}
            >
              Stitch {selected.length >= 2 ? `${selected.length} clips` : "clips"}
            </button>
          </div>
        )}
        {counts.image > 0 && counts.video > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {(["all", "image", "video"] as const).map((f) => (
              <button key={f} style={filter === f ? chipActive : chipStyle} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : f === "image" ? `🖼 Images (${counts.image})` : `🎬 Videos (${counts.video})`}
              </button>
            ))}
          </div>
        )}
        {items.length === 0 ? (
          <p style={{ opacity: 0.7 }}>
            Nothing yet — images and video clips the assistant generates in any chat will collect here.
          </p>
        ) : (
          <div style={gridStyle}>
            {shown.map((card) => (
              <CreationTile
                key={card.key}
                card={card}
                url={urls[card.key]}
                hydrate={hydrate}
                // Stitch mode: video tiles toggle selection (badge shows play order); other kinds inert.
                {...(selecting && card.kind === "video" ? { selectedIndex: selected.indexOf(card.key) } : {})}
                onView={() => {
                  if (selecting) {
                    if (card.kind === "video") toggleSelected(card.key);
                    return;
                  }
                  setViewing(card);
                }}
              />
            ))}
          </div>
        )}
      </div>
      {viewing && (
        <div style={lightboxStyle} onClick={(e) => { e.stopPropagation(); setViewing(undefined); }}>
          <div style={lightboxInner} onClick={(e) => e.stopPropagation()}>
            {urls[viewing.key] ? (
              viewing.kind === "video" ? (
                <video src={urls[viewing.key]} style={mediaStyle} controls autoPlay loop />
              ) : (
                <img src={urls[viewing.key]} style={mediaStyle} alt={viewing.label ?? "creation"} />
              )
            ) : (
              <div style={{ padding: 40, opacity: 0.7 }}>Loading…</div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ opacity: 0.7, fontSize: 12, flex: 1, minWidth: 120 }}>
                {viewing.chatLabel} · {new Date(viewing.at).toLocaleString()}
              </span>
              <button style={buttonStyle} onClick={() => void download(viewing)}>
                ⬇ Download
              </button>
              <button style={buttonStyle} onClick={() => remove(viewing)}>
                🗑 Delete
              </button>
              <button style={buttonStyle} onClick={() => setViewing(undefined)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** One grid cell. Images hydrate on mount; a video stays a play tile until clicked (then the
 * lightbox opens once its bytes arrive). */
function CreationTile({
  card,
  url,
  hydrate,
  onView,
  selectedIndex,
}: {
  card: CreationCard;
  url: string | undefined;
  hydrate: (card: CreationCard) => Promise<string | undefined>;
  onView: () => void;
  /** Stitch-select mode: this tile's pick order (-1 = selectable but unpicked; absent = normal mode). */
  selectedIndex?: number;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (card.kind !== "image" || url || failed) return;
    let cancelled = false;
    void hydrate(card).then((got) => {
      if (!cancelled && !got) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
    // hydrate is recreated per render but only closes over stable setters/load; keying on the
    // card + url keeps this to one fetch per tile.
  }, [card.key, url, failed]);
  const open = () => {
    if (!url) void hydrate(card).then((got) => { if (!got) setFailed(true); });
    onView();
  };
  const picked = selectedIndex !== undefined && selectedIndex >= 0;
  return (
    <button
      style={picked ? { ...tileStyle, position: "relative", borderColor: "rgba(120,180,255,0.8)", background: "rgba(96,170,255,0.12)" } : { ...tileStyle, position: "relative" }}
      onClick={open}
      title={card.label ?? card.chatLabel}
      aria-label={selectedIndex !== undefined ? `${picked ? "Unselect" : "Select"} clip from ${card.chatLabel}` : `View creation from ${card.chatLabel}`}
      {...(selectedIndex !== undefined ? { "aria-pressed": picked } : {})}
    >
      {picked && <span style={orderBadgeStyle}>{selectedIndex! + 1}</span>}
      {card.kind === "image" && url ? (
        <img src={url} style={thumbStyle} alt={card.label ?? "creation"} loading="lazy" />
      ) : (
        <div style={placeholderStyle}>{failed ? "⚠ missing" : card.kind === "video" ? "▶ 🎬" : "…"}</div>
      )}
      <div style={tileCaption}>
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.label ?? (card.kind === "video" ? "Video clip" : "Image")}</div>
        <div style={{ opacity: 0.55, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.chatLabel}</div>
      </div>
    </button>
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
  width: "min(820px, 100%)",
  background: "#171922",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 12,
  padding: 16,
  fontFamily: "system-ui, sans-serif",
  color: "#e9ecf2",
} as const;

const headerStyle = { display: "flex", alignItems: "center", gap: 12, marginBottom: 10 } as const;

const buttonStyle = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.3)",
  color: "inherit",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
  fontSize: 13,
} as const;

const chipStyle = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "inherit",
  borderRadius: 999,
  padding: "3px 10px",
  cursor: "pointer",
  fontSize: 12,
} as const;

const chipActive = { ...chipStyle, background: "rgba(96,170,255,0.25)", borderColor: "rgba(120,180,255,0.7)" } as const;

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
  gap: 10,
} as const;

const tileStyle = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  padding: 0,
  cursor: "pointer",
  color: "inherit",
  textAlign: "left",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
} as const;

const thumbStyle = { width: "100%", height: 110, objectFit: "cover", display: "block" } as const;

const placeholderStyle = {
  width: "100%",
  height: 110,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 22,
  background: "rgba(255,255,255,0.05)",
} as const;

const tileCaption = { padding: "6px 8px", fontSize: 11 } as const;

/** Stitch-select pick-order badge (1-based play order) on a selected video tile. */
const orderBadgeStyle = {
  position: "absolute",
  top: 6,
  left: 6,
  zIndex: 1,
  minWidth: 20,
  height: 20,
  borderRadius: 999,
  background: "rgba(96,170,255,0.9)",
  color: "#0b1220",
  fontSize: 12,
  fontWeight: 700,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 5px",
} as const;

const lightboxStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.75)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  zIndex: 60,
} as const;

const lightboxInner = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  maxWidth: "min(920px, 92vw)",
  maxHeight: "90vh",
  background: "#171922",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 12,
  padding: 12,
} as const;

const mediaStyle = {
  maxWidth: "100%",
  maxHeight: "72vh",
  objectFit: "contain",
  borderRadius: 8,
  background: "#000",
} as const;
