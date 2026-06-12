import type { VisualBible } from "../types/bible.js";
import type { BookSource } from "../types/book.js";
import { MAX_CHAT_HISTORY, type BookSummary, type StoredChatMessage, type VisualReaderStore } from "./store.js";

/**
 * IndexedDB-backed store for the web app: caches the Visual Bible and rendered
 * images so re-reads are instant and continuity survives reloads, and keeps a
 * library of opened books so the reader can switch between them.
 */
const DB_NAME = "visual-reader";
// v3 adds the per-book chat-history store; v4 adds "memos" (the chat's long-term
// reader memory). Additive upgrades — existing stores untouched.
const DB_VERSION = 4;
const BIBLE_STORE = "bibles";
const IMAGE_STORE = "images";
const BOOK_STORE = "books";
const CHAT_STORE = "chats";
const MEMO_STORE = "memos";

interface BookRecord extends BookSource {
  addedAt: number;
}

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

  async putImage(requestId: string, bytes: ArrayBuffer, mimeType: string, prompt?: string): Promise<void> {
    // `prompt` is additive on the stored record — old records simply lack it.
    return this.put(IMAGE_STORE, requestId, { bytes, mimeType, ...(prompt ? { prompt } : {}) });
  }

  async getImage(
    requestId: string,
  ): Promise<{ bytes: ArrayBuffer; mimeType: string; prompt?: string } | undefined> {
    return this.get(IMAGE_STORE, requestId);
  }

  async deleteBible(bookId: string): Promise<void> {
    return this.delete(BIBLE_STORE, bookId);
  }

  async deleteImage(requestId: string): Promise<void> {
    return this.delete(IMAGE_STORE, requestId);
  }

  /** Delete every image whose key starts with `${bookId}:` via a key cursor. */
  async clearImages(bookId: string): Promise<void> {
    const db = await this.dbPromise;
    const range = IDBKeyRange.bound(`${bookId}:`, `${bookId}:￿`);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGE_STORE, "readwrite");
      const req = tx.objectStore(IMAGE_STORE).openKeyCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          tx.objectStore(IMAGE_STORE).delete(cursor.key);
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async putBook(book: BookSource): Promise<void> {
    const record: BookRecord = { ...book, addedAt: Date.now() };
    return this.put(BOOK_STORE, book.id, record);
  }

  async getBook(id: string): Promise<BookSource | undefined> {
    // BookRecord is a BookSource plus addedAt; the extra field is harmless.
    return this.get<BookRecord>(BOOK_STORE, id);
  }

  async listBooks(): Promise<BookSummary[]> {
    const records = await this.getAll<BookRecord>(BOOK_STORE);
    return records
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((b) => ({ id: b.id, title: b.title, ...(b.author ? { author: b.author } : {}), addedAt: b.addedAt }));
  }

  async removeBook(id: string): Promise<void> {
    // Reclaim everything the book owns so a removed book leaks no storage: its cached
    // images (including character reference uploads keyed `${id}:charref:…`) and its
    // Visual Bible, alongside the library record.
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(BOOK_STORE, "readwrite");
      tx.objectStore(BOOK_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await this.delete(BIBLE_STORE, id);
    await this.clearImages(id);
    await this.deleteChatHistory(id);
  }

  async getChatHistory(bookId: string): Promise<StoredChatMessage[] | undefined> {
    return this.get<StoredChatMessage[]>(CHAT_STORE, bookId);
  }

  async putChatHistory(bookId: string, messages: StoredChatMessage[]): Promise<void> {
    return this.put(CHAT_STORE, bookId, messages.slice(-MAX_CHAT_HISTORY));
  }

  async deleteChatHistory(bookId: string): Promise<void> {
    return this.delete(CHAT_STORE, bookId);
  }

  async getMemo(key: string): Promise<string | undefined> {
    return this.get<string>(MEMO_STORE, key);
  }

  async putMemo(key: string, text: string): Promise<void> {
    return this.put(MEMO_STORE, key, text);
  }

  async deleteMemo(key: string): Promise<void> {
    return this.delete(MEMO_STORE, key);
  }

  private async get<T>(store: string, key: string): Promise<T | undefined> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, "readonly").objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  private async getAll<T>(store: string): Promise<T[]> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, "readonly").objectStore(store).getAll();
      req.onsuccess = () => resolve((req.result as T[]) ?? []);
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

  private async delete(store: string, key: string): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
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
      if (!db.objectStoreNames.contains(BOOK_STORE)) db.createObjectStore(BOOK_STORE);
      if (!db.objectStoreNames.contains(CHAT_STORE)) db.createObjectStore(CHAT_STORE);
      if (!db.objectStoreNames.contains(MEMO_STORE)) db.createObjectStore(MEMO_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
