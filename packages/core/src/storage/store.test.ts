import { describe, it, expect } from "vitest";
import { InMemoryStore, libraryTypeOf } from "./store.js";
import { createEmptyBible } from "../visual-bible/bible.js";
import type { BookSource } from "../types/book.js";

function book(id: string, title: string, author?: string): BookSource {
  return { id, title, ...(author ? { author } : {}), chapters: [], pages: [] };
}

const EMPTY_BIBLE = createEmptyBible("a");

describe("libraryTypeOf (library tag derivation)", () => {
  it("derives a type tag from the book's kind / contentMode / data", () => {
    expect(libraryTypeOf({ kind: "story" })).toBe("story");
    expect(libraryTypeOf({ data: {} })).toBe("data");
    expect(libraryTypeOf({ contentMode: "code" })).toBe("code");
    expect(libraryTypeOf({ contentMode: "technical" })).toBe("technical");
    expect(libraryTypeOf({ contentMode: "fiction" })).toBe("fiction");
    expect(libraryTypeOf({})).toBe("fiction"); // default
    // A story or a data table wins over its contentMode.
    expect(libraryTypeOf({ kind: "story", contentMode: "technical" })).toBe("story");
    expect(libraryTypeOf({ data: {}, contentMode: "fiction" })).toBe("data");
  });
});

describe("listBooks tags each summary with its type", () => {
  it("includes the derived type tag", async () => {
    const store = new InMemoryStore();
    await store.putBook({ id: "d", title: "Budget", chapters: [], pages: [], contentMode: "technical", data: { columns: [], rows: [] } as never });
    const list = await store.listBooks();
    expect(list[0]!.type).toBe("data");
  });
});

describe("InMemoryStore library", () => {
  it("stores, lists most-recent-first, gets, and removes books", async () => {
    const store = new InMemoryStore();
    await store.putBook(book("a", "Alpha", "X. Author"));
    await new Promise((r) => setTimeout(r, 2)); // ensure distinct addedAt
    await store.putBook(book("b", "Beta"));

    const list = await store.listBooks();
    expect(list.map((b) => b.id)).toEqual(["b", "a"]); // newest first
    expect(list[1]!.author).toBe("X. Author");

    expect((await store.getBook("a"))?.title).toBe("Alpha");

    await store.removeBook("a");
    expect(await store.getBook("a")).toBeUndefined();
    expect((await store.listBooks()).map((b) => b.id)).toEqual(["b"]);
  });

  it("a pasted-text book round-trips through the library with its contentMode intact", async () => {
    const store = new InMemoryStore();
    const pasted: BookSource = {
      id: "text-abc123",
      title: "My Paper",
      author: "Pasted text",
      contentMode: "technical",
      chapters: [{ id: "ch-0", index: 0, title: "My Paper" }],
      pages: [
        { id: "pg-0", index: 0, chapterId: "ch-0", paragraphs: [{ id: "pg-0-0", index: 0, text: "Abstract." }] },
      ],
    };
    await store.putBook(pasted);

    const reopened = await store.getBook("text-abc123");
    expect(reopened?.contentMode).toBe("technical"); // technical prompts survive reopen
    expect(reopened?.pages[0]!.paragraphs[0]!.text).toBe("Abstract.");
    const listed = (await store.listBooks()).find((b) => b.id === "text-abc123");
    expect(listed?.title).toBe("My Paper");
    expect(listed?.author).toBe("Pasted text"); // provenance visible in the library
  });

  it("removeBook reclaims the book's images and bible (no leaked storage)", async () => {
    const store = new InMemoryStore();
    const bytes = new Uint8Array([1]).buffer;
    await store.putBook(book("a", "Alpha"));
    await store.putBible({ ...EMPTY_BIBLE, bookId: "a" });
    await store.putImage("a:p0", bytes, "image/png");
    await store.putImage("a:charref:char-x", bytes, "image/png"); // a reference upload
    await store.putBook(book("b", "Beta"));
    await store.putImage("b:p0", bytes, "image/png");

    await store.removeBook("a");

    expect(await store.getBible("a")).toBeUndefined();
    expect(await store.getImage("a:p0")).toBeUndefined();
    expect(await store.getImage("a:charref:char-x")).toBeUndefined();
    // A different book is untouched.
    expect(await store.getImage("b:p0")).toBeDefined();
  });

  it("deletes a bible, a single image, and clears all images for a book", async () => {
    const store = new InMemoryStore();
    const bytes = new Uint8Array([1]).buffer;
    await store.putImage("book1:p0", bytes, "image/png");
    await store.putImage("book1:p1", bytes, "image/png");
    await store.putImage("book2:p0", bytes, "image/png");

    await store.deleteImage("book1:p0");
    expect(await store.getImage("book1:p0")).toBeUndefined();
    expect(await store.getImage("book1:p1")).toBeDefined();

    await store.clearImages("book1");
    expect(await store.getImage("book1:p1")).toBeUndefined();
    // A different book's images are untouched.
    expect(await store.getImage("book2:p0")).toBeDefined();
  });
});

describe("chat image blobs (externalized message bytes)", () => {
  it("puts and gets a blob keyed by (chatId, id)", async () => {
    const store = new InMemoryStore();
    const bytes = new Uint8Array([7, 8, 9]).buffer;
    await store.putImageBlob("chat-1", "img-a", bytes, "image/png");
    const got = await store.getImageBlob("chat-1", "img-a");
    expect(got).toEqual({ bytes, mimeType: "image/png" });
    // Same id under a DIFFERENT chat is a different blob (no cross-chat collision).
    expect(await store.getImageBlob("chat-2", "img-a")).toBeUndefined();
  });

  it("drops a chat's blobs when its history is deleted, leaving other chats intact", async () => {
    const store = new InMemoryStore();
    const bytes = new Uint8Array([1]).buffer;
    await store.putImageBlob("chat-1", "img-a", bytes, "image/png");
    await store.putImageBlob("chat-1", "img-b", bytes, "image/png");
    await store.putImageBlob("chat-2", "img-a", bytes, "image/png");

    await store.deleteChatHistory("chat-1");

    expect(await store.getImageBlob("chat-1", "img-a")).toBeUndefined();
    expect(await store.getImageBlob("chat-1", "img-b")).toBeUndefined();
    expect(await store.getImageBlob("chat-2", "img-a")).toBeDefined();
  });

  it("removeBook drops the book's chat blobs too", async () => {
    const store = new InMemoryStore();
    const bytes = new Uint8Array([2]).buffer;
    await store.putBook(book("bk", "Book"));
    await store.putImageBlob("bk", "img-x", bytes, "image/png");
    await store.removeBook("bk");
    expect(await store.getImageBlob("bk", "img-x")).toBeUndefined();
  });
});
