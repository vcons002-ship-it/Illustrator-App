import type { VisualBible } from "../types/bible.js";
import type { BookSource } from "../types/book.js";

/** Lightweight library entry for the "switch between books" picker. */
export interface BookSummary {
  id: string;
  title: string;
  author?: string;
  /** When the book was last opened (ms epoch), for recency ordering. */
  addedAt: number;
}

/** One persisted reading-companion chat message (per book). Image bytes are kept
 * so a generated/retrieved picture survives reload; `links` keep search sources. */
export interface StoredChatMessage {
  role: "user" | "assistant" | "tool";
  /** Display text (what the panel shows). */
  text: string;
  /** ms epoch. */
  at: number;
  image?: { bytes: ArrayBuffer; mimeType: string } | { sourceUrl: string };
  links?: { url: string; title?: string }[];
  /** Clickable local-file results (the desktop `/find` command); each opens on click. */
  files?: { path: string; name: string }[];
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

  /** Small keyed text blobs (the chat's long-term reader memory). Optional. */
  getMemo?(key: string): Promise<string | undefined>;
  putMemo?(key: string, text: string): Promise<void>;
  deleteMemo?(key: string): Promise<void>;
}

/** In-memory store — used by tests and as a fallback when no persistence exists. */
export class InMemoryStore implements VisualReaderStore {
  private bibles = new Map<string, VisualBible>();
  private images = new Map<string, { bytes: ArrayBuffer; mimeType: string; prompt?: string }>();
  private books = new Map<string, { book: BookSource; addedAt: number }>();
  private chats = new Map<string, StoredChatMessage[]>();

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
      }));
  }
  async removeBook(id: string): Promise<void> {
    // Deleting a book reclaims everything it owns — its cached images (including any
    // character reference uploads, keyed `${id}:charref:…`), its Visual Bible, and
    // its chat history — so removed books don't leak storage.
    this.books.delete(id);
    this.bibles.delete(id);
    this.chats.delete(id);
    await this.clearImages(id);
  }

  async getChatHistory(bookId: string): Promise<StoredChatMessage[] | undefined> {
    return this.chats.get(bookId);
  }
  async putChatHistory(bookId: string, messages: StoredChatMessage[]): Promise<void> {
    this.chats.set(bookId, messages.slice(-MAX_CHAT_HISTORY));
  }
  async deleteChatHistory(bookId: string): Promise<void> {
    this.chats.delete(bookId);
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
