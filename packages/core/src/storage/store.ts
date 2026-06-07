import type { VisualBible } from "../types/bible.js";

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
}

/** In-memory store — used by tests and as a fallback when no persistence exists. */
export class InMemoryStore implements VisualReaderStore {
  private bibles = new Map<string, VisualBible>();
  private images = new Map<string, { bytes: ArrayBuffer; mimeType: string }>();

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
}
