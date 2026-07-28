import type { VisualBible } from "../types/bible.js";
import type { BookSource } from "../types/book.js";
import { base64ToBytes, bytesToBase64 } from "../providers/image/base64.js";
import { MAX_CHAT_HISTORY, libraryTypeOf, type BookSummary, type StoreBackup, type StoredChatMessage, type VisualReaderStore } from "./store.js";

/**
 * IndexedDB-backed store for the web app: caches the Visual Bible and rendered
 * images so re-reads are instant and continuity survives reloads, and keeps a
 * library of opened books so the reader can switch between them.
 */
const DB_NAME = "visual-reader";
// v3 adds the per-book chat-history store; v4 adds "memos" (the chat's long-term
// reader memory); v5 adds "chatblobs" (chat image bytes externalized out of the
// chat-history array so it stays small). Additive upgrades — existing stores untouched.
const DB_VERSION = 5;
const BIBLE_STORE = "bibles";
const IMAGE_STORE = "images";
const BOOK_STORE = "books";
const CHAT_STORE = "chats";
const MEMO_STORE = "memos";
const CHAT_BLOB_STORE = "chatblobs";

/** Stores included in a backup: the reader's DATA. The IMAGE_STORE (rendered illustrations) is
 * skipped — it's large and re-derivable, so a backup stays small and portable. CHAT_BLOB_STORE IS
 * included (chat images are NOT re-derivable, and were part of CHAT_STORE before externalization). */
const BACKUP_STORES = [BIBLE_STORE, BOOK_STORE, CHAT_STORE, MEMO_STORE, CHAT_BLOB_STORE] as const;

interface BookRecord extends BookSource {
  addedAt: number;
}

/** Read every [key, value] pair from a store, base64-tagging any ArrayBuffer so it's JSON-safe. */
function dumpStore(db: IDBDatabase, name: string): Promise<{ key: string; value: unknown }[]> {
  return new Promise((resolve, reject) => {
    const out: { key: string; value: unknown }[] = [];
    const req = db.transaction(name, "readonly").objectStore(name).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) {
        resolve(out);
        return;
      }
      out.push({ key: String(cur.key), value: encodeBuffers(cur.value) });
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/** Recursively replace ArrayBuffers with `{ __ab: <base64> }` so a value round-trips through JSON. */
function encodeBuffers(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return { __ab: bytesToBase64(value) };
  if (ArrayBuffer.isView(value)) {
    // Encode ONLY the view's own window. A typed-array/DataView subview (e.g. `u8.subarray(4, 8)`)
    // shares a larger backing buffer; `.buffer` alone would embed the whole thing — foreign bytes and
    // all — so slice out exactly [byteOffset, byteOffset + byteLength).
    const v = value as ArrayBufferView;
    return { __ab: bytesToBase64((v.buffer as ArrayBuffer).slice(v.byteOffset, v.byteOffset + v.byteLength)) };
  }
  if (Array.isArray(value)) return value.map(encodeBuffers);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = encodeBuffers(v);
    return out;
  }
  return value;
}

/** Reverse {@link encodeBuffers}: `{ __ab }` tags become ArrayBuffers again. */
function decodeBuffers(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const tag = (value as { __ab?: unknown }).__ab;
    if (typeof tag === "string") return base64ToBytes(tag);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeBuffers(v);
    return out;
  }
  if (Array.isArray(value)) return value.map(decodeBuffers);
  return value;
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
    const direct = await this.get<BookRecord>(BOOK_STORE, id);
    return direct ?? this.rekeyBook(id);
  }

  /**
   * Every book record with the KEY it's stored under. listBooks and getBook disagree about what a
   * book's id is — one reads the record's `id` field, the other the key — so the key has to travel
   * with the record for the two to be reconciled (see {@link rekeyBook}).
   */
  private async allBooks(): Promise<{ key: string; value: BookRecord }[]> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const out: { key: string; value: BookRecord }[] = [];
      const req = db.transaction(BOOK_STORE, "readonly").objectStore(BOOK_STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) {
          resolve(out);
          return;
        }
        const value = cur.value as BookRecord | undefined;
        if (value && typeof value === "object") out.push({ key: String(cur.key), value });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * A book the library LISTS but a key lookup MISSES. These two reads have always disagreed about
   * what a book's id is — listBooks takes each record's own `id` field, getBook takes the key — so a
   * record stored under a key that isn't its id is listed and un-openable, and the click just fails
   * with nothing to see. Find it by its own id, then re-store it under that id (and drop the old
   * key, or the same book would list twice) so every later open is an ordinary hit.
   *
   * Returns undefined when the id really isn't in the store — a listed-but-missing book is a
   * different fault, and this must not disguise it.
   */
  private async rekeyBook(id: string): Promise<BookSource | undefined> {
    const found = (await this.allBooks().catch(() => [])).find((r) => r.value.id === id && r.key !== id);
    if (!found) return undefined;
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(BOOK_STORE, "readwrite");
      tx.objectStore(BOOK_STORE).put(found.value, id);
      tx.objectStore(BOOK_STORE).delete(found.key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return found.value;
  }

  async listBooks(): Promise<BookSummary[]> {
    const rows = await this.allBooks();
    return rows
      .map(({ key, value }) => ({ ...value, id: value.id || key, addedAt: value.addedAt || 0 }))
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((b) => ({ id: b.id, title: b.title, ...(b.author ? { author: b.author } : {}), addedAt: b.addedAt, type: libraryTypeOf(b) }));
  }

  async removeBook(id: string): Promise<void> {
    // Reclaim everything the book owns so a removed book leaks no storage: its cached
    // images (including character reference uploads keyed `${id}:charref:…`) and its
    // Visual Bible, alongside the library record.
    const db = await this.dbPromise;
    // Delete by key AND by the record's own id: a misfiled book (key ≠ id) is listed under its id,
    // so "remove it" has to mean the row the reader is actually looking at, or Remove does nothing.
    const misfiled = (await this.allBooks().catch(() => [])).filter((r) => r.value.id === id && r.key !== id);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(BOOK_STORE, "readwrite");
      tx.objectStore(BOOK_STORE).delete(id);
      for (const r of misfiled) tx.objectStore(BOOK_STORE).delete(r.key);
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
    await this.delete(CHAT_STORE, bookId);
    await this.clearChatBlobs(bookId);
  }

  /** Externalized chat image bytes, keyed `${chatId}::${id}` so a chat's blobs delete together. */
  async putImageBlob(chatId: string, id: string, bytes: ArrayBuffer, mimeType: string): Promise<void> {
    return this.put(CHAT_BLOB_STORE, `${chatId}::${id}`, { bytes, mimeType });
  }

  async getImageBlob(chatId: string, id: string): Promise<{ bytes: ArrayBuffer; mimeType: string } | undefined> {
    return this.get(CHAT_BLOB_STORE, `${chatId}::${id}`);
  }

  async deleteImageBlob(chatId: string, id: string): Promise<void> {
    return this.delete(CHAT_BLOB_STORE, `${chatId}::${id}`);
  }

  /** Drop every externalized image blob for a chat (keys prefixed `${chatId}::`) via a key cursor. */
  private async clearChatBlobs(chatId: string): Promise<void> {
    const db = await this.dbPromise;
    const range = IDBKeyRange.bound(`${chatId}::`, `${chatId}::￿`);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CHAT_BLOB_STORE, "readwrite");
      const req = tx.objectStore(CHAT_BLOB_STORE).openKeyCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          tx.objectStore(CHAT_BLOB_STORE).delete(cursor.key);
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
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

  /** Dump the reader's DATA stores (not the re-renderable images) to a JSON-safe backup. */
  async exportData(): Promise<StoreBackup> {
    const db = await this.dbPromise;
    const stores: Record<string, { key: string; value: unknown }[]> = {};
    for (const name of BACKUP_STORES) {
      stores[name] = await dumpStore(db, name);
    }
    return { app: "visual-reader", version: DB_VERSION, at: Date.now(), stores };
  }

  /** Restore a backup, MERGING each [key, value] into its store (overwriting same-key records). */
  async importData(backup: StoreBackup): Promise<void> {
    if (!backup || backup.app !== "visual-reader" || !backup.stores) throw new Error("Not a Visual Reader backup file.");
    const db = await this.dbPromise;
    for (const name of BACKUP_STORES) {
      const rows = backup.stores[name];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, "readwrite");
        const os = tx.objectStore(name);
        for (const { key, value } of rows) os.put(decodeBuffers(value), key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
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
      if (!db.objectStoreNames.contains(CHAT_BLOB_STORE)) db.createObjectStore(CHAT_BLOB_STORE);
    };
    // An older tab still holding the DB open blocks a version upgrade FOREVER — without this handler
    // the open request just never settles and every store call upstream hangs silently.
    req.onblocked = () =>
      reject(new Error("The app's storage is locked by another open tab — close other Visual Reader tabs and reload."));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
