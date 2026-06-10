import {
  IndexedDbStore,
  InMemoryStore,
  type BookSource,
  type BookSummary,
  type VisualBible,
  type VisualReaderStore,
} from "@visual-reader/core";

/**
 * Resilient cache for the extension. Persists the Visual Bible + rendered images
 * in IndexedDB so re-visiting the same page doesn't re-extract or re-generate
 * (keyed by the page URL via the book id). Every op falls back to an in-memory
 * store if IndexedDB is blocked on a given site, so caching is best-effort and
 * never breaks the overlay.
 */
export function createCacheStore(): VisualReaderStore {
  let backing: VisualReaderStore;
  try {
    backing = typeof indexedDB !== "undefined" ? new IndexedDbStore() : new InMemoryStore();
  } catch {
    backing = new InMemoryStore();
  }
  const fallback = new InMemoryStore();

  return {
    async getBible(bookId: string): Promise<VisualBible | undefined> {
      try {
        return await backing.getBible(bookId);
      } catch {
        return fallback.getBible(bookId);
      }
    },
    async putBible(bible: VisualBible): Promise<void> {
      try {
        await backing.putBible(bible);
      } catch {
        await fallback.putBible(bible);
      }
    },
    async getImage(requestId: string): Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined> {
      try {
        return await backing.getImage(requestId);
      } catch {
        return fallback.getImage(requestId);
      }
    },
    async putImage(requestId: string, bytes: ArrayBuffer, mimeType: string): Promise<void> {
      try {
        await backing.putImage(requestId, bytes, mimeType);
      } catch {
        await fallback.putImage(requestId, bytes, mimeType);
      }
    },
    // Library methods exist to satisfy the store interface; the extension reads
    // the live page rather than EPUBs, so they're effectively no-ops here.
    async putBook(book: BookSource): Promise<void> {
      try {
        await backing.putBook(book);
      } catch {
        await fallback.putBook(book);
      }
    },
    async getBook(id: string): Promise<BookSource | undefined> {
      try {
        return await backing.getBook(id);
      } catch {
        return fallback.getBook(id);
      }
    },
    async listBooks(): Promise<BookSummary[]> {
      try {
        return await backing.listBooks();
      } catch {
        return fallback.listBooks();
      }
    },
    async removeBook(id: string): Promise<void> {
      try {
        await backing.removeBook(id);
      } catch {
        await fallback.removeBook(id);
      }
    },
    // Optional ops (regeneration / reference cleanup): both core stores implement
    // them, so forward rather than omit — otherwise the engine's feature-detection
    // (`store.deleteImage?.(…)`) silently no-ops behind this wrapper.
    async deleteBible(bookId: string): Promise<void> {
      try {
        await backing.deleteBible?.(bookId);
      } catch {
        await fallback.deleteBible?.(bookId);
      }
    },
    async deleteImage(requestId: string): Promise<void> {
      try {
        await backing.deleteImage?.(requestId);
      } catch {
        await fallback.deleteImage?.(requestId);
      }
    },
    async clearImages(bookId: string): Promise<void> {
      try {
        await backing.clearImages?.(bookId);
      } catch {
        await fallback.clearImages?.(bookId);
      }
    },
  };
}
