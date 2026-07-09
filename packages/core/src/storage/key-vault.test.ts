import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

/**
 * Load a FRESH key-vault module instance (with its own memoized `keyPromise`) — this stands in for a
 * SEPARATE execution context (the page, the engine worker, the extension service worker) that shares
 * the same IndexedDB. The device-key generation must converge across them onto exactly one key.
 */
async function freshVault(): Promise<typeof import("./key-vault.js")> {
  vi.resetModules();
  return import("./key-vault.js");
}

const SECRETS = { openai: "sk-123", flux: "bfl-456" };

/** Count the persisted device keys in the vault store (proves no orphaned/clobbered keys). */
function countKeys(): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("visual-reader-secure", 1);
    req.onsuccess = () => {
      const db = req.result;
      const c = db.transaction("vault", "readonly").objectStore("vault").count();
      c.onsuccess = () => {
        resolve(c.result);
        db.close();
      };
      c.onerror = () => reject(c.error);
    };
    req.onerror = () => reject(req.error);
  });
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("key-vault device key", () => {
  it("round-trips secrets and a second context reuses the one persisted key", async () => {
    const a = await freshVault();
    const blob = await a.encryptSecrets(SECRETS);
    expect(await a.decryptSecrets(blob)).toEqual(SECRETS);

    // A fresh context reads the SAME persisted key (via the get-existing path) and decrypts A's blob.
    const b = await freshVault();
    expect(await b.decryptSecrets(blob)).toEqual(SECRETS);
    expect(await countKeys()).toBe(1);
  });

  it("concurrent first-time generation converges on ONE key (add-race winner)", async () => {
    const a = await freshVault();
    const b = await freshVault();
    // Both contexts generate at once: each get() sees an empty store, generates a key, and `add`s it.
    // Exactly one `add` wins; the loser hits ConstraintError, re-reads the winner, and both end on the
    // SAME key — so a secret encrypted in one context stays decryptable in the other.
    const [blobA, blobB] = await Promise.all([a.encryptSecrets(SECRETS), b.encryptSecrets({ x: "y" })]);
    expect(await a.decryptSecrets(blobB)).toEqual({ x: "y" });
    expect(await b.decryptSecrets(blobA)).toEqual(SECRETS);
    // No orphaned keys: with `put` (upsert) a racing writer could have clobbered the other's key,
    // leaving one context's ciphertext undecryptable. `add` guarantees a single persisted key.
    expect(await countKeys()).toBe(1);
  });
});
