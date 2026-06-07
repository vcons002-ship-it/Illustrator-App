import type { VisualBible } from "../types/bible.js";
import type { VisualReaderStore } from "./store.js";

/**
 * IndexedDB-backed store for the web app: caches the Visual Bible and rendered
 * images so re-reads are instant and continuity survives reloads.
 */
const DB_NAME = "visual-reader";
const DB_VERSION = 1;
const BIBLE_STORE = "bibles";
const IMAGE_STORE = "images";

export class IndexedDbStore implements VisualReaderStore {
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = openDb();
  }

  async getBible(bookId: string): Promise<VisualBible | undefined> {
    return this.get<VisualBible>(BIBLE_STORE, bookId);
  }

  async putBible(bible: VisualBible): Promise<void> {
    return this.put(BIBLE_STORE, bible.bookId, bible);
  }

  async putImage(requestId: string, bytes: ArrayBuffer, mimeType: string): Promise<void> {
    return this.put(IMAGE_STORE, requestId, { bytes, mimeType });
  }

  async getImage(requestId: string): Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined> {
    return this.get(IMAGE_STORE, requestId);
  }

  private async get<T>(store: string, key: string): Promise<T | undefined> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, "readonly").objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  private async put(store: string, key: string, value: unknown): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BIBLE_STORE)) db.createObjectStore(BIBLE_STORE);
      if (!db.objectStoreNames.contains(IMAGE_STORE)) db.createObjectStore(IMAGE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
