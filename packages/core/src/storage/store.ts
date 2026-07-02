import type { VisualBible } from "../types/bible.js";
import type { BookSource } from "../types/book.js";
import type { DataTable } from "../data/data-table.js";
import type { AnalyzeChart } from "../data/analyze.js";

/** A library book's type tag — what kind of thing it is, used to filter the library and to pick the
 * reader format it opens in. Derived from the book's kind/contentMode/data via {@link libraryTypeOf}. */
export type LibraryType = "fiction" | "technical" | "code" | "data" | "story";

/** Derive a book's library type tag from its stored shape. */
export function libraryTypeOf(book: { kind?: "story"; contentMode?: "fiction" | "technical" | "code"; data?: unknown }): LibraryType {
  if (book.kind === "story") return "story";
  if (book.data) return "data";
  if (book.contentMode === "code") return "code";
  if (book.contentMode === "technical") return "technical";
  return "fiction";
}

/** Lightweight library entry for the "switch between books" picker. */
export interface BookSummary {
  id: string;
  title: string;
  author?: string;
  /** When the book was last opened (ms epoch), for recency ordering. */
  addedAt: number;
  /** The book's type tag (see {@link LibraryType}) — drives the library filter + reader format. */
  type?: LibraryType;
}

/** A file surfaced in a chat message — created by the assistant (a code block, spreadsheet,
 * export, generated image) or found on the PC (a `/find` hit). Persisted so its action card
 * survives reload. Structurally mirrors the UI's `FileRef` (bytes stored as ArrayBuffer). */
export interface ChatFileRef {
  name: string;
  mime: string;
  kind: "code" | "doc" | "data" | "image" | "video" | "text" | "found" | "export";
  content?: string;
  bytes?: ArrayBuffer;
  path?: string;
  /** Stable id for a bytes-bearing file card. The chat MIRROR strips heavy bytes from older cards to
   * stay tunnel-safe (see boundChatHistoryForMirror); a linked phone uses this id to fetch the full
   * bytes back from the desktop ON DEMAND (vrcmd:fetchFile) when the reader opens/downloads it. */
  id?: string;
}

/** One persisted reading-companion chat message (per book). Image bytes are kept
 * so a generated/retrieved picture survives reload; `links` keep search sources. */
export interface StoredChatMessage {
  role: "user" | "assistant" | "tool";
  /** Display text (what the panel shows). */
  text: string;
  /** ms epoch. */
  at: number;
  /** Inline image: raw bytes (an optional `id` remembers the blob it was re-hydrated from so re-persist
   * reuses the same blob), a hotlinkable URL, OR a byte-less `{ id }` reference whose bytes were
   * externalized to the chat blob store (re-hydrated on demand, keyed by the same id). */
  image?:
    | { bytes: ArrayBuffer; mimeType: string; id?: string }
    | { sourceUrl: string }
    | { id: string; mimeType: string };
  /** An image-to-video render's output clip, shown inline as a looping <video>/animated image. Like
   * `image`, a large clip's bytes are externalized to the chat blob store on persist AND stripped from
   * the phone mirror — leaving a byte-less `{ id }` reference whose bytes re-hydrate on demand (video
   * clips are far bigger than images, so this keeps the mirror frame tunnel-safe and the disk small). */
  video?:
    | { bytes: ArrayBuffer; mimeType: string; id?: string }
    | { id: string; mimeType: string };
  links?: { url: string; title?: string }[];
  /** A set of retrieved images shown as an inline thumbnail gallery (a multi-hit
   * `search_images`); each thumbnail enlarges in place on click. This is what lets
   * "show me 3 images of X" actually display several, not just the first. */
  gallery?: { thumb: string; full: string; title?: string }[];
  /** A grounded analyze_data result table (rendered inline, with an optional chart). */
  analysis?: { table: DataTable; summary?: string; chart?: AnalyzeChart };
  /** Clickable local-file results (the desktop `/find` command); each opens on click. */
  files?: { path: string; name: string }[];
  /** Files surfaced by the turn (created OR found), shown as a universal file card with
   * Download / Open in app / Open in library / Open on PC actions. Mirrors the UI's `FileRef`. */
  attachments?: ChatFileRef[];
  /** Quick-reply action buttons (e.g. what to do with a pasted link). */
  actions?: { label: string; send: string }[];
  /** The model's reasoning for this turn (a thinking model's scratchpad), shown as a collapsible
   * on the settled message so it isn't lost when the turn ends. */
  thinking?: string;
  /**
   * The MODEL-FACING turns this message represents (tool messages carry the model's
   * JSON call + the formatted result; plain messages omit this and map 1:1). Keeps
   * the rebuilt conversation identical to what the model actually saw.
   */
  turns?: { role: "system" | "user" | "assistant"; content: string }[];
}

/** Persisted chat history is trimmed to this many most-recent messages per book.
 * Generous on purpose — the MODEL-facing window is budgeted separately (and per
 * provider) via `trimChatHistory`; this only bounds what IndexedDB holds. */
export const MAX_CHAT_HISTORY = 500;

/**
 * Persistence seam. The engine depends only on this interface, so each
 * front-end supplies its own backing store: the web app uses IndexedDB; the
 * extension can use `chrome.storage`; tests use the in-memory implementation.
 */
export interface VisualReaderStore {
  getBible(bookId: string): Promise<VisualBible | undefined>;
  putBible(bible: VisualBible): Promise<void>;

  /** Cache a rendered image (optionally with the exact prompt it was rendered
   * from, so the UI can show a STABLE per-image description across sessions).
   * Keyed by request id. */
  putImage(requestId: string, bytes: ArrayBuffer, mimeType: string, prompt?: string): Promise<void>;
  getImage(
    requestId: string,
  ): Promise<{ bytes: ArrayBuffer; mimeType: string; prompt?: string } | undefined>;

  /** Regeneration support (optional — not every backend implements these). */
  deleteBible?(bookId: string): Promise<void>;
  deleteImage?(requestId: string): Promise<void>;
  /** Drop every cached image for a book (keys prefixed `${bookId}:`). */
  clearImages?(bookId: string): Promise<void>;

  /** Library: remember opened books so the reader can switch back to them. */
  putBook(book: BookSource): Promise<void>;
  getBook(id: string): Promise<BookSource | undefined>;
  listBooks(): Promise<BookSummary[]>;
  removeBook(id: string): Promise<void>;

  /** Reading-companion chat history per book (optional — older backends lack it). */
  getChatHistory?(bookId: string): Promise<StoredChatMessage[] | undefined>;
  putChatHistory?(bookId: string, messages: StoredChatMessage[]): Promise<void>;
  deleteChatHistory?(bookId: string): Promise<void>;

  /**
   * Externalized chat IMAGE bytes (optional). A chat message's image/attachment bytes are moved OUT of
   * the persisted message into this keyed blob store so the chat-history array stays small (a long
   * image-heavy session no longer re-writes megabytes on every turn) and the in-RAM message array can
   * stay byte-free, with images re-loaded lazily on demand and bounded by an LRU. Keyed by (chatId, id)
   * so a chat's blobs are dropped with its history. `deleteChatHistory` also drops the chat's blobs.
   */
  putImageBlob?(chatId: string, id: string, bytes: ArrayBuffer, mimeType: string): Promise<void>;
  getImageBlob?(chatId: string, id: string): Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined>;
  /** Drop ONE externalized blob (the Creations gallery's per-item delete). */
  deleteImageBlob?(chatId: string, id: string): Promise<void>;

  /** Small keyed text blobs (the chat's long-term reader memory). Optional. */
  getMemo?(key: string): Promise<string | undefined>;
  putMemo?(key: string, text: string): Promise<void>;
  deleteMemo?(key: string): Promise<void>;

  /** Dump every persisted data store (library, bibles, chats, memories/tasks/skills) to a
   * JSON-safe object for a backup; rendered images are skipped (re-derivable). Optional. */
  exportData?(): Promise<StoreBackup>;
  /** Restore a backup produced by {@link exportData}, MERGING it into this store. Optional. */
  importData?(backup: StoreBackup): Promise<void>;
}

/** A portable backup of the persisted data stores (ArrayBuffers are base64-tagged so it's JSON-safe).
 * Moves a reader's library/chats/tasks/memories/skills between environments (e.g. dev → packaged). */
export interface StoreBackup {
  app: "visual-reader";
  /** The IndexedDB schema version it was taken at. */
  version: number;
  at: number;
  /** Per object-store: the [key, value] pairs (values may hold `{ __ab }` base64 ArrayBuffer tags). */
  stores: Record<string, { key: string; value: unknown }[]>;
}

/** In-memory store — used by tests and as a fallback when no persistence exists. */
export class InMemoryStore implements VisualReaderStore {
  private bibles = new Map<string, VisualBible>();
  private images = new Map<string, { bytes: ArrayBuffer; mimeType: string; prompt?: string }>();
  private books = new Map<string, { book: BookSource; addedAt: number }>();
  private chats = new Map<string, StoredChatMessage[]>();
  /** Externalized chat image bytes, keyed `${chatId}::${id}`. */
  private chatBlobs = new Map<string, { bytes: ArrayBuffer; mimeType: string }>();

  async getBible(bookId: string): Promise<VisualBible | undefined> {
    return this.bibles.get(bookId);
  }
  async putBible(bible: VisualBible): Promise<void> {
    this.bibles.set(bible.bookId, bible);
  }
  async putImage(requestId: string, bytes: ArrayBuffer, mimeType: string, prompt?: string): Promise<void> {
    this.images.set(requestId, { bytes, mimeType, ...(prompt ? { prompt } : {}) });
  }
  async getImage(
    requestId: string,
  ): Promise<{ bytes: ArrayBuffer; mimeType: string; prompt?: string } | undefined> {
    return this.images.get(requestId);
  }
  async deleteBible(bookId: string): Promise<void> {
    this.bibles.delete(bookId);
  }
  async deleteImage(requestId: string): Promise<void> {
    this.images.delete(requestId);
  }
  async clearImages(bookId: string): Promise<void> {
    const prefix = `${bookId}:`;
    for (const key of [...this.images.keys()]) {
      if (key.startsWith(prefix)) this.images.delete(key);
    }
  }
  async putBook(book: BookSource): Promise<void> {
    this.books.set(book.id, { book, addedAt: Date.now() });
  }
  async getBook(id: string): Promise<BookSource | undefined> {
    return this.books.get(id)?.book;
  }
  async listBooks(): Promise<BookSummary[]> {
    return [...this.books.values()]
      .sort((a, b) => b.addedAt - a.addedAt)
      .map(({ book, addedAt }) => ({
        id: book.id,
        title: book.title,
        ...(book.author ? { author: book.author } : {}),
        addedAt,
        type: libraryTypeOf(book),
      }));
  }
  async removeBook(id: string): Promise<void> {
    // Deleting a book reclaims everything it owns — its cached images (including any
    // character reference uploads, keyed `${id}:charref:…`), its Visual Bible, and
    // its chat history — so removed books don't leak storage.
    this.books.delete(id);
    this.bibles.delete(id);
    await this.clearImages(id);
    await this.deleteChatHistory(id);
  }

  async getChatHistory(bookId: string): Promise<StoredChatMessage[] | undefined> {
    return this.chats.get(bookId);
  }
  async putChatHistory(bookId: string, messages: StoredChatMessage[]): Promise<void> {
    this.chats.set(bookId, messages.slice(-MAX_CHAT_HISTORY));
  }
  async deleteChatHistory(bookId: string): Promise<void> {
    this.chats.delete(bookId);
    const prefix = `${bookId}::`;
    for (const key of [...this.chatBlobs.keys()]) {
      if (key.startsWith(prefix)) this.chatBlobs.delete(key);
    }
  }

  async putImageBlob(chatId: string, id: string, bytes: ArrayBuffer, mimeType: string): Promise<void> {
    this.chatBlobs.set(`${chatId}::${id}`, { bytes, mimeType });
  }
  async getImageBlob(chatId: string, id: string): Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined> {
    return this.chatBlobs.get(`${chatId}::${id}`);
  }
  async deleteImageBlob(chatId: string, id: string): Promise<void> {
    this.chatBlobs.delete(`${chatId}::${id}`);
  }

  private memos = new Map<string, string>();
  async getMemo(key: string): Promise<string | undefined> {
    return this.memos.get(key);
  }
  async putMemo(key: string, text: string): Promise<void> {
    this.memos.set(key, text);
  }
  async deleteMemo(key: string): Promise<void> {
    this.memos.delete(key);
  }
}
