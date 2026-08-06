import { t } from "./design/tokens.js";
import { useEffect, useRef, useState } from "react";
import { ModalShell } from "./ModalShell.js";

/** How many tiles may hydrate (read + materialize their Blob) at once. Opening a 200-image gallery must
 * not fire 200 parallel blob reads — the rest queue behind this cap as tiles scroll into view. */
const MAX_CONCURRENT_HYDRATIONS = 4;

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
  // Download reuse it. Deleted items are revoked immediately (see `remove`); the rest on unmount.
  const [urls, setUrls] = useState<Record<string, string>>({});
  const urlsRef = useRef(urls); // the unmount cleanup + delete-revoke must see the LATEST map
  urlsRef.current = urls;
  // Keys whose bytes are missing/failed to load — so a tile shows "⚠ missing" and the lightbox shows a
  // real error instead of an eternal "Loading…".
  const [failed, setFailed] = useState<Record<string, true>>({});
  useEffect(() => {
    return () => {
      for (const u of Object.values(urlsRef.current)) URL.revokeObjectURL(u);
    };
    // Revoke-on-unmount for whatever survived — revoking a still-mounted URL would break its <img>/<video>.
  }, []);

  // Drop selections + object URLs for items the host has since deleted, so a stale key is never passed to
  // onStitch and the deleted item's URL doesn't linger until panel close.
  useEffect(() => {
    const live = new Set(items.map((i) => i.key));
    setSelected((prev) => {
      const next = prev.filter((k) => live.has(k));
      return next.length === prev.length ? prev : next;
    });
    setUrls((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [k, u] of Object.entries(prev)) {
        if (live.has(k)) next[k] = u;
        else {
          URL.revokeObjectURL(u);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [items]);

  const hydrate = async (card: CreationCard): Promise<string | undefined> => {
    const existing = urlsRef.current[card.key];
    if (existing) return existing; // already materialized — never re-read the same bytes
    const got = await load(card.key).catch(() => undefined);
    if (!got) {
      setFailed((prev) => (prev[card.key] ? prev : { ...prev, [card.key]: true }));
      return undefined;
    }
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

  // Concurrency-capped queue for scroll-in (lazy) hydrations. A direct click hydrates immediately (below);
  // only the auto-hydrate-when-visible path funnels through here.
  const gateRef = useRef<{ active: number; queue: (() => void)[] }>({ active: 0, queue: [] });
  const requestHydrate = (card: CreationCard) => {
    if (urlsRef.current[card.key] || failed[card.key]) return;
    const g = gateRef.current;
    const run = () => {
      g.active++;
      void hydrate(card).finally(() => {
        g.active--;
        g.queue.shift()?.();
      });
    };
    if (g.active < MAX_CONCURRENT_HYDRATIONS) run();
    else g.queue.push(run);
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
    // Revoke this item's object URL right away, not just on panel close.
    const url = urlsRef.current[card.key];
    if (url) URL.revokeObjectURL(url);
    setUrls((prev) => {
      if (!(card.key in prev)) return prev;
      const { [card.key]: _drop, ...rest } = prev;
      return rest;
    });
    setSelected((prev) => prev.filter((k) => k !== card.key));
    onDelete(card.key);
  };

  const shown = filter === "all" ? items : items.filter((i) => i.kind === filter);
  const counts = { image: items.filter((i) => i.kind === "image").length, video: items.filter((i) => i.kind === "video").length };

  return (
    <>
      <ModalShell title="Creations" onClose={onClose} overlayStyle={overlayStyle} cardStyle={panelCardStyle}>
        <div style={headerStyle}>
          <strong>🎨 Creations</strong>
          <span style={{ opacity: 0.6, fontSize: 12 }}>
            {items.length} item{items.length === 1 ? "" : "s"}
          </span>
          {onStitch && (counts.video >= 2 || selecting) && (
            <button
              style={selecting ? { ...buttonStyle, borderColor: t.accent.edge } : buttonStyle}
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
                failed={!!failed[card.key]}
                hydrate={hydrate}
                requestHydrate={requestHydrate}
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
      </ModalShell>
      {viewing && (
        // The lightbox is its own dialog stacked over the gallery: a single Escape closes just the
        // lightbox (ModalShell's open-shell stack routes it to the top-most), and it gets role=dialog +
        // focus handling for free.
        <ModalShell
          title={`Creation from ${viewing.chatLabel}`}
          onClose={() => setViewing(undefined)}
          overlayStyle={lightboxStyle}
          cardStyle={lightboxCardStyle}
        >
          {urls[viewing.key] ? (
            viewing.kind === "video" ? (
              <video src={urls[viewing.key]} style={mediaStyle} controls autoPlay loop />
            ) : (
              <img src={urls[viewing.key]} style={mediaStyle} alt={viewing.label ?? "creation"} />
            )
          ) : failed[viewing.key] ? (
            <div style={{ padding: 40, opacity: 0.7 }}>⚠ This creation's file is missing — it may have been cleared.</div>
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
        </ModalShell>
      )}
    </>
  );
}

/** One grid cell. Images hydrate when they scroll into view (IntersectionObserver-gated, so a big
 * gallery never issues every blob read at once); a video stays a play tile until clicked (then the
 * lightbox opens once its bytes arrive). */
function CreationTile({
  card,
  url,
  failed,
  hydrate,
  requestHydrate,
  onView,
  selectedIndex,
}: {
  card: CreationCard;
  url: string | undefined;
  /** The panel already tried and failed to load this key's bytes. */
  failed: boolean;
  hydrate: (card: CreationCard) => Promise<string | undefined>;
  /** Enqueue a visibility-triggered hydration behind the panel's concurrency cap. */
  requestHydrate: (card: CreationCard) => void;
  onView: () => void;
  /** Stitch-select mode: this tile's pick order (-1 = selectable but unpicked; absent = normal mode). */
  selectedIndex?: number;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  // Always call the LATEST requestHydrate without re-subscribing the observer on every render.
  const requestRef = useRef(requestHydrate);
  requestRef.current = requestHydrate;
  useEffect(() => {
    if (card.kind !== "image" || url || failed) return;
    const el = btnRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      // No observer (e.g. non-DOM env) — hydrate straight away so the tile still fills.
      requestRef.current(card);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          requestRef.current(card);
          io.disconnect(); // one hydration per tile — stop watching once we've asked
        }
      },
      { rootMargin: "200px" }, // start loading a little before the tile actually enters the viewport
    );
    io.observe(el);
    return () => io.disconnect();
  }, [card.key, card.kind, url, failed]);
  const open = () => {
    if (!url) void hydrate(card); // click hydrates immediately (bypasses the visibility gate)
    onView();
  };
  const picked = selectedIndex !== undefined && selectedIndex >= 0;
  return (
    <button
      ref={btnRef}
      style={picked ? { ...tileStyle, position: "relative", borderColor: t.accent.edge, background: t.accent.edge } : { ...tileStyle, position: "relative" }}
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

// Overlay/card overrides handed to ModalShell so the migrated gallery keeps its original look (no
// blur, top-aligned, its own dark surface) while gaining the shell's role=dialog / Escape / focus trap.
const overlayStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  backdropFilter: "none", // the gallery predates the shared blurred backdrop — keep it crisp
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "6vh 16px",
  zIndex: 50,
  overflowY: "auto",
} as const;

const panelCardStyle = {
  width: "min(820px, 100%)",
  background: t.surface.card,
  border: `1px solid ${t.border.input}`,
  borderRadius: 12,
  padding: 16,
  fontFamily: "system-ui, sans-serif",
  color: t.text.base,
  // Neutralize the shared card's flex/scroll defaults so the panel keeps its original block layout and
  // grows within the scrolling overlay rather than becoming an inner scroll region.
  display: "block",
  gap: 0,
  maxHeight: "none",
  overflowY: "visible",
} as const;

const headerStyle = { display: "flex", alignItems: "center", gap: 12, marginBottom: 10 } as const;

const buttonStyle = {
  background: "transparent",
  border: `1px solid ${t.border.button}`,
  color: "inherit",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
  fontSize: 13,
} as const;

const chipStyle = {
  background: t.fill.subtle,
  border: `1px solid ${t.border.button}`,
  color: "inherit",
  borderRadius: 999,
  padding: "3px 10px",
  cursor: "pointer",
  fontSize: 12,
} as const;

const chipActive = { ...chipStyle, background: t.accent.edge, borderColor: t.accent.edge } as const;

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
  gap: 10,
} as const;

const tileStyle = {
  background: t.fill.subtle,
  border: `1px solid ${t.border.subtle}`,
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
  background: t.fill.subtle,
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
  background: t.accent.edge,
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
  backdropFilter: "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  zIndex: 60, // above the gallery panel (50) so it stacks correctly as a second dialog
} as const;

const lightboxCardStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  width: "auto", // shrink to the media, not the shared card's fixed width
  maxWidth: "min(920px, 92vw)",
  maxHeight: "90vh",
  background: t.surface.card,
  border: `1px solid ${t.border.input}`,
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
