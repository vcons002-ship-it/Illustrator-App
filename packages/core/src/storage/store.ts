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

/**
 * Persistence seam. The engine depends only on this interface, so each
 * front-end supplies its own backing store: the web app uses IndexedDB; the
 * extension can use `chrome.storage`; tests use the in-memory implementation.
 */
export interface VisualReaderStore {
  getBible(bookId: string): Promise<VisualBible | undefined>;
  putBible(bible: VisualBible): Promise<void>;

  /** Cache a rendered image, returning nothing. Keyed by request id. */
  putImage(requestId: string, bytes: ArrayBuffer, mimeType: string): Promise<void>;
  getImage(requestId: string): Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined>;

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
}

/** In-memory store — used by tests and as a fallback when no persistence exists. */
export class InMemoryStore implements VisualReaderStore {
  private bibles = new Map<string, VisualBible>();
  private images = new Map<string, { bytes: ArrayBuffer; mimeType: string }>();
  private books = new Map<string, { book: BookSource; addedAt: number }>();

  async getBible(bookId: string): Promise<VisualBible | undefined> {
    return this.bibles.get(bookId);
  }
  async putBible(bible: VisualBible): Promise<void> {
    this.bibles.set(bible.bookId, bible);
  }
  async putImage(requestId: string, bytes: ArrayBuffer, mimeType: string): Promise<void> {
    this.images.set(requestId, { bytes, mimeType });
  }
  async getImage(requestId: string): Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined> {
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
    // character reference uploads, keyed `${id}:charref:…`) and its Visual Bible —
    // so removed books don't leak storage.
    this.books.delete(id);
    this.bibles.delete(id);
    await this.clearImages(id);
  }
}
