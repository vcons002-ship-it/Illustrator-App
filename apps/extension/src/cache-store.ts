import {
  IndexedDbStore,
  InMemoryStore,
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
  };
}
