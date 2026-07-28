import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { IndexedDbStore } from "./indexeddb-store.js";
import { MAX_CHAT_HISTORY, type StoreBackup, type StoredChatMessage } from "./store.js";
import { createEmptyBible } from "../visual-bible/bible.js";
import type { BookSource } from "../types/book.js";

/** Each test gets a FRESH in-memory IndexedDB so state never leaks across tests. */
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function book(id: string, title: string): BookSource {
  return { id, title, chapters: [], pages: [] };
}

const bytes = (...ns: number[]): ArrayBuffer => new Uint8Array(ns).buffer;
const msg = (text: string, at = 1): StoredChatMessage => ({ role: "user", text, at });

describe("IndexedDbStore schema", () => {
  it("the version upgrade creates all six object stores", async () => {
    const store = new IndexedDbStore();
    await store.putMemo("k", "v"); // force the open + upgrade
    const names = await new Promise<string[]>((resolve, reject) => {
      const req = indexedDB.open("visual-reader");
      req.onsuccess = () => {
        const list = req.result.objectStoreNames;
        resolve(Array.from({ length: list.length }, (_, i) => String(list.item(i))));
        req.result.close();
      };
      req.onerror = () => reject(req.error);
    });
    expect([...names].sort()).toEqual(["bibles", "books", "chatblobs", "chats", "images", "memos"]);
  });
});

describe("IndexedDbStore roundtrips", () => {
  it("bible: put/get by bookId; a miss is undefined", async () => {
    const store = new IndexedDbStore();
    const bible = createEmptyBible("b1");
    await store.putBible(bible);
    expect(await store.getBible("b1")).toEqual(bible);
    expect(await store.getBible("nope")).toBeUndefined();
    await store.deleteBible("b1");
    expect(await store.getBible("b1")).toBeUndefined();
  });

  it("image: bytes + mimeType + optional prompt survive the trip", async () => {
    const store = new IndexedDbStore();
    await store.putImage("b1:p0", bytes(1, 2, 3), "image/png", "a cat");
    const got = await store.getImage("b1:p0");
    expect(new Uint8Array(got!.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(got!.mimeType).toBe("image/png");
    expect(got!.prompt).toBe("a cat");
    await store.deleteImage("b1:p0");
    expect(await store.getImage("b1:p0")).toBeUndefined();
  });

  it("books: put/get/list (newest first)", async () => {
    const store = new IndexedDbStore();
    await store.putBook(book("a", "Alpha"));
    await new Promise((r) => setTimeout(r, 2)); // ensure distinct addedAt
    await store.putBook(book("b", "Beta"));
    expect((await store.getBook("a"))?.title).toBe("Alpha");
    expect((await store.listBooks()).map((b) => b.id)).toEqual(["b", "a"]);
  });

  it("chat history: put/get, trimmed to the most recent MAX_CHAT_HISTORY messages", async () => {
    const store = new IndexedDbStore();
    const many = Array.from({ length: MAX_CHAT_HISTORY + 2 }, (_, i) => msg(`m${i}`, i));
    await store.putChatHistory("b1", many);
    const got = await store.getChatHistory("b1");
    expect(got).toHaveLength(MAX_CHAT_HISTORY);
    expect(got![0]!.text).toBe("m2"); // the two OLDEST were dropped
    expect(got![got!.length - 1]!.text).toBe(`m${MAX_CHAT_HISTORY + 1}`);
  });

  it("memos: put/get/delete", async () => {
    const store = new IndexedDbStore();
    await store.putMemo("notes", "remember this");
    expect(await store.getMemo("notes")).toBe("remember this");
    await store.deleteMemo("notes");
    expect(await store.getMemo("notes")).toBeUndefined();
  });

  it("chat image blobs: keyed by (chatId, id); deleteImageBlob drops just the one", async () => {
    const store = new IndexedDbStore();
    await store.putImageBlob("c1", "img-a", bytes(7), "image/png");
    await store.putImageBlob("c1", "img-b", bytes(8), "image/png");
    const got = await store.getImageBlob("c1", "img-a");
    expect(new Uint8Array(got!.bytes)).toEqual(new Uint8Array([7]));
    expect(await store.getImageBlob("c2", "img-a")).toBeUndefined(); // no cross-chat bleed
    await store.deleteImageBlob("c1", "img-a");
    expect(await store.getImageBlob("c1", "img-a")).toBeUndefined();
    expect(await store.getImageBlob("c1", "img-b")).toBeDefined();
  });
});

describe("IndexedDbStore prefix-ranged deletes", () => {
  it("clearImages deletes only `${bookId}:` keys — a book id sharing a prefix is safe", async () => {
    const store = new IndexedDbStore();
    await store.putImage("a:p0", bytes(1), "image/png");
    await store.putImage("a:charref:x", bytes(1), "image/png");
    await store.putImage("ab:p0", bytes(1), "image/png"); // sibling id "ab" shares the "a" prefix
    await store.putImage("a", bytes(1), "image/png"); // bare key without the separator

    await store.clearImages("a");

    expect(await store.getImage("a:p0")).toBeUndefined();
    expect(await store.getImage("a:charref:x")).toBeUndefined();
    // The `:`…`￿` bound keeps the range inside book "a" — "ab:*" and the bare "a" survive.
    expect(await store.getImage("ab:p0")).toBeDefined();
    expect(await store.getImage("a")).toBeDefined();
  });

  it("deleteChatHistory also drops the chat's `${chatId}::` blobs, not a sibling chat's", async () => {
    const store = new IndexedDbStore();
    await store.putChatHistory("c1", [msg("hello")]);
    await store.putImageBlob("c1", "img-a", bytes(1), "image/png");
    await store.putImageBlob("c1", "img-b", bytes(2), "image/png");
    await store.putImageBlob("c12", "img-a", bytes(3), "image/png"); // shares the "c1" prefix

    await store.deleteChatHistory("c1");

    expect(await store.getChatHistory("c1")).toBeUndefined();
    expect(await store.getImageBlob("c1", "img-a")).toBeUndefined();
    expect(await store.getImageBlob("c1", "img-b")).toBeUndefined();
    expect(await store.getImageBlob("c12", "img-a")).toBeDefined();
  });

  it("removeBook cascades: book + bible + images + chat history + chat blobs", async () => {
    const store = new IndexedDbStore();
    await store.putBook(book("a", "Alpha"));
    await store.putBible(createEmptyBible("a"));
    await store.putImage("a:p0", bytes(1), "image/png");
    await store.putImage("a:charref:char-x", bytes(1), "image/png");
    await store.putChatHistory("a", [msg("hi")]);
    await store.putImageBlob("a", "img-x", bytes(1), "image/png");
    // A sibling book whose id shares the prefix must be untouched.
    await store.putBook(book("ab", "Abba"));
    await store.putImage("ab:p0", bytes(2), "image/png");
    await store.putImageBlob("ab", "img-x", bytes(2), "image/png");

    await store.removeBook("a");

    expect(await store.getBook("a")).toBeUndefined();
    expect(await store.getBible("a")).toBeUndefined();
    expect(await store.getImage("a:p0")).toBeUndefined();
    expect(await store.getImage("a:charref:char-x")).toBeUndefined();
    expect(await store.getChatHistory("a")).toBeUndefined();
    expect(await store.getImageBlob("a", "img-x")).toBeUndefined();
    expect((await store.listBooks()).map((b) => b.id)).toEqual(["ab"]);
    expect(await store.getImage("ab:p0")).toBeDefined();
    expect(await store.getImageBlob("ab", "img-x")).toBeDefined();
  });
});

/**
 * "It's in my library but clicking it does nothing." listBooks reads each record's own `id`, getBook
 * reads the KEY — so anything that stores a book under a key that isn't its id lists a row that can
 * never be opened, and a record with no id at all lists a row with NO id, which the click drops on
 * the floor. Both are repaired on read.
 */
describe("a listed book always opens", () => {
  /** Write straight into the object store, bypassing putBook, so the key can disagree with the id. */
  async function rawPut(key: string, value: unknown): Promise<void> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("visual-reader", 5);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("books", "readwrite");
      tx.objectStore("books").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  it("a book stored under the WRONG key still opens by the id the library lists", async () => {
    const store = new IndexedDbStore();
    await store.putBook(book("a", "Alpha")); // forces the upgrade before the raw write
    await rawPut("stale-key", { ...book("real-id", "Misfiled"), addedAt: 5 });

    expect((await store.listBooks()).map((b) => b.id)).toContain("real-id");
    expect((await store.getBook("real-id"))?.title).toBe("Misfiled");
  });

  it("the misfiled book is re-keyed on that first open, and doesn't end up listed twice", async () => {
    const store = new IndexedDbStore();
    await store.putBook(book("a", "Alpha"));
    await rawPut("stale-key", { ...book("real-id", "Misfiled"), addedAt: 5 });

    await store.getBook("real-id");

    // Now a plain key hit — and exactly one row for it.
    expect((await store.getBook("real-id"))?.title).toBe("Misfiled");
    expect((await store.listBooks()).filter((b) => b.id === "real-id")).toHaveLength(1);
    expect((await store.listBooks()).map((b) => b.id).sort()).toEqual(["a", "real-id"]);
  });

  it("a record with NO id of its own is listed under its key — so it opens", async () => {
    const store = new IndexedDbStore();
    await store.putBook(book("a", "Alpha"));
    await rawPut("orphan", { title: "No id", chapters: [], pages: [], addedAt: 7 });

    const listed = (await store.listBooks()).find((b) => b.title === "No id");
    expect(listed?.id).toBe("orphan");
    expect((await store.getBook(listed!.id))?.title).toBe("No id");
  });

  it("Remove takes the misfiled record too — otherwise the row survives the delete", async () => {
    const store = new IndexedDbStore();
    await store.putBook(book("a", "Alpha"));
    await rawPut("stale-key", { ...book("real-id", "Misfiled"), addedAt: 5 });

    await store.removeBook("real-id");

    expect((await store.listBooks()).map((b) => b.id)).toEqual(["a"]);
  });

  it("a genuinely absent book is still a miss — the scan must not invent one", async () => {
    const store = new IndexedDbStore();
    await store.putBook(book("a", "Alpha"));
    expect(await store.getBook("never-stored")).toBeUndefined();
  });
});

describe("IndexedDbStore backup export/import", () => {
  it("round-trips through JSON, preserving ArrayBuffers via the {__ab} base64 tagging", async () => {
    const store = new IndexedDbStore();
    await store.putBook(book("a", "Alpha"));
    await store.putBible(createEmptyBible("a"));
    await store.putChatHistory("a", [
      { role: "assistant", text: "hi", at: 1, image: { bytes: bytes(1, 2, 3), mimeType: "image/png" } },
    ]);
    await store.putMemo("notes", "remember");
    await store.putImageBlob("a", "img", bytes(9, 8), "image/jpeg");
    await store.putImage("a:p0", bytes(1), "image/png"); // rendered image — re-derivable, NOT backed up

    const backup = await store.exportData();
    expect(backup.app).toBe("visual-reader");
    expect(backup.version).toBe(5);
    expect(Object.keys(backup.stores).sort()).toEqual(["bibles", "books", "chatblobs", "chats", "memos"]);
    // The backup is JSON-safe: buffers were replaced with {__ab: base64} tags.
    const wire = JSON.parse(JSON.stringify(backup)) as StoreBackup;
    expect(JSON.stringify(wire.stores["chatblobs"] ?? [])).toContain("__ab");

    // Restore into a completely FRESH database.
    vi.stubGlobal("indexedDB", new IDBFactory());
    const restored = new IndexedDbStore();
    await restored.importData(wire);

    const blob = await restored.getImageBlob("a", "img");
    expect(blob!.bytes).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(blob!.bytes)).toEqual(new Uint8Array([9, 8]));
    expect(blob!.mimeType).toBe("image/jpeg");
    const history = await restored.getChatHistory("a");
    expect(history?.[0]?.text).toBe("hi");
    const image = history?.[0]?.image as { bytes: ArrayBuffer; mimeType: string };
    expect(new Uint8Array(image.bytes)).toEqual(new Uint8Array([1, 2, 3])); // nested buffer decoded too
    expect(await restored.getMemo("notes")).toBe("remember");
    expect((await restored.listBooks()).map((b) => b.id)).toEqual(["a"]);
    expect(await restored.getBible("a")).toEqual(createEmptyBible("a"));
    expect(await restored.getImage("a:p0")).toBeUndefined(); // images stayed out of the backup
  });

  it("encodes only a typed-array SUBVIEW's own bytes (byteOffset/byteLength), not the whole buffer", async () => {
    const store = new IndexedDbStore();
    // A 3-byte window over a larger backing buffer (byteOffset 3) — the classic subarray view. The
    // structured clone into IndexedDB preserves the offset + the full backing buffer, so encoding via
    // `.buffer` alone would smuggle the foreign 9s into the backup.
    const backing = new Uint8Array([9, 9, 9, 1, 2, 3, 9, 9]);
    const sub = backing.subarray(3, 6);
    await store.putImageBlob("a", "sub", sub as unknown as ArrayBuffer, "image/png");

    const wire = JSON.parse(JSON.stringify(await store.exportData())) as StoreBackup;

    vi.stubGlobal("indexedDB", new IDBFactory());
    const restored = new IndexedDbStore();
    await restored.importData(wire);
    const blob = await restored.getImageBlob("a", "sub");
    // Just the subview window survives the round-trip — no foreign bytes from the shared buffer.
    expect(new Uint8Array(blob!.bytes)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("importData merges into existing data (same-key records overwritten, others kept)", async () => {
    const donor = new IndexedDbStore();
    await donor.putMemo("clobber", "new");
    const backup = await donor.exportData();

    vi.stubGlobal("indexedDB", new IDBFactory()); // a separate target database
    const store = new IndexedDbStore();
    await store.putMemo("keep", "old");
    await store.putMemo("clobber", "old");
    await store.importData(backup);

    expect(await store.getMemo("keep")).toBe("old");
    expect(await store.getMemo("clobber")).toBe("new");
  });

  it("rejects a file that isn't a Visual Reader backup", async () => {
    const store = new IndexedDbStore();
    await expect(store.importData({} as StoreBackup)).rejects.toThrow(/Not a Visual Reader backup/);
    await expect(store.importData({ app: "other", stores: {} } as unknown as StoreBackup)).rejects.toThrow(
      /Not a Visual Reader backup/,
    );
  });
});
