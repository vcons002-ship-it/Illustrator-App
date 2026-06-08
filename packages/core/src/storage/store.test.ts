import { describe, it, expect } from "vitest";
import { InMemoryStore } from "./store.js";
import type { BookSource } from "../types/book.js";

function book(id: string, title: string, author?: string): BookSource {
  return { id, title, ...(author ? { author } : {}), chapters: [], pages: [] };
}

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
