/**
 * Class-name constants for the semantic classes in styles/*.css.
 *
 * Typo-proofing, and — more usefully — a list a test can iterate to assert every class named
 * here actually exists as a selector in the sheets. A `className` that matches nothing fails
 * silently and looks exactly like "the animation didn't work".
 */

export const cx = {
  /** The app shell. Everything global in base.css hangs off this rather than <body>, because
   * the extension mounts these components into arbitrary websites with no shadow DOM. */
  app: "vr-app",
  /** Portalled surfaces that land on a bare <body> and inherit nothing. */
  portalRoot: "vr-portal-root",

  btn: "vr-btn",
  input: "vr-input",
  card: "vr-card",

  modalOverlay: "vr-modal-overlay",
  modalCard: "vr-modal-card",

  /** Children get a computed delay from `--vr-i`; capped past the twelfth. */
  stagger: "vr-stagger",

  /** On the chat dock itself: reads --vr-dock-h, which the three mode classes set. */
  dock: "vr-dock",
  /** On the app shell, while the reader is in conversation — dims the book, never moves it. */
  shellChatting: "vr-shell--chatting",

  dockBar: "vr-dock--bar",
  dockPeek: "vr-dock--peek",
  dockFull: "vr-dock--full",
  dockMsgs: "vr-dock-msgs",
  readerYield: "vr-reader-yield",

  reader: "vr-reader",
  readerInline: "vr-reader--inline",
  readerRail: "vr-reader--rail",
  readerWide: "vr-reader--wide",
  readerData: "vr-reader--data",
  rail: "vr-rail",
  artPane: "vr-art-pane",

  progressFill: "vr-progress-fill",
  breathing: "vr-breathing",
  settle: "vr-settle",
  arrive: "vr-arrive",
  arriveSheen: "vr-arrive-sheen",

  /** Applied by the pointer handlers, not by a component's own render. */
  isPress: "is-press",
  isTap: "is-tap",

  /** A chat message, arriving. */
  msg: "vr-msg",
  /** The model is reasoning — a highlight travels along the text. */
  thinking: "vr-thinking",
  /** The model is producing words — a caret at the end of the streamed text. */
  typing: "vr-typing",
  /** Still working: a gradient travels around this element's edge. On the streaming bubble AND
   * the thinking block, so "it is running" is visible without looking for it. */
  live: "vr-live",
  /** One-shot, on the composer, when a message is sent. */
  sent: "vr-sent",
  /** Being written: no bubble at all, just glowing letters on the field. */
  forming: "vr-msg--forming",
  /** The bubble condensing around a reply that just finished. */
  solidify: "vr-msg--solidify",

  /** The dock with its panel chrome removed — messages float on the page instead. */
  chatOpen: "vr-chat-open",
  /** A message bubble as a floating pane: translucent, blurred, legible over the field. */
  msgFloat: "vr-msg-float",
  /** The particle canvas. */
  field: "vr-field",
  /** Anything that must paint above the field. */
  aboveField: "vr-above-field",

  /** Sanitized article HTML rendered with dangerouslySetInnerHTML. */
  articleHtml: "vr-article-html",
} as const;

/** The dock's three heights. Replaces a boolean whose single open state was a hard
 * `min(62vh, 560px)` that defaulted to OPEN — the reason the chat out-measured the book. */
export type DockMode = "bar" | "peek" | "full";

export const DOCK_CLASS: Record<DockMode, string> = {
  bar: cx.dockBar,
  peek: cx.dockPeek,
  full: cx.dockFull,
};

/** How the reader spends width. Chosen per book and remembered; the prose measure is the same
 * in every one of them. */
export type ReaderLayout = "side" | "inline" | "rail";

export const READER_CLASS: Record<ReaderLayout, string> = {
  side: cx.reader,
  inline: cx.readerInline,
  rail: cx.readerRail,
};
