/**
 * Passphrase-free encrypted storage for bring-your-own API keys.
 *
 * Keys are encrypted at rest with AES-GCM. The encryption key is generated once
 * as a NON-EXTRACTABLE WebCrypto key and kept in IndexedDB, so it survives
 * reloads but its raw bytes can never be exported by JS or read by anyone
 * inspecting storage. Only the ciphertext (iv + bytes) is written to the app's
 * settings store (localStorage / chrome.storage) — keys are therefore never at
 * rest in plaintext, with zero UX cost (no passphrase prompt).
 *
 * Works anywhere there is `crypto.subtle` + IndexedDB: the web page, the engine
 * Web Worker, and the extension's background service worker. It is
 * defence-in-depth for a client-only app, not a substitute for a hosted backend.
 */

const DB_NAME = "visual-reader-secure";
const DB_VERSION = 1;
const STORE = "vault";
const KEY_ID = "device-key";
const IV_BYTES = 12;

export interface EncryptedSecrets {
  iv: number[];
  ciphertext: number[];
}

/** Allocate an ArrayBuffer-backed view so types satisfy WebCrypto's BufferSource. */
function buf(source: ArrayLike<number> | number): Uint8Array<ArrayBuffer> {
  return typeof source === "number" ? new Uint8Array(new ArrayBuffer(source)) : Uint8Array.from(source);
}

export async function encryptSecrets(secrets: Record<string, string>): Promise<EncryptedSecrets> {
  const key = await getDeviceKey();
  const iv = crypto.getRandomValues(buf(IV_BYTES));
  const plaintext = buf([...new TextEncoder().encode(JSON.stringify(secrets))]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { iv: [...iv], ciphertext: [...new Uint8Array(ciphertext)] };
}

export async function decryptSecrets(blob: EncryptedSecrets): Promise<Record<string, string>> {
  const key = await getDeviceKey();
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(blob.iv) }, key, buf(blob.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, string>;
}

let keyPromise: Promise<CryptoKey> | undefined;
function getDeviceKey(): Promise<CryptoKey> {
  if (!keyPromise) keyPromise = loadOrGenerateKey();
  return keyPromise;
}

async function loadOrGenerateKey(): Promise<CryptoKey> {
  const db = await openDb();
  try {
    const existing = await idb<CryptoKey>(db, "readonly", (store) => store.get(KEY_ID));
    if (existing) return existing;
    // Non-extractable: stored in IndexedDB via structured clone, never exportable.
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await idb(db, "readwrite", (store) => store.put(key, KEY_ID));
    return key;
  } finally {
    db.close();
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}
