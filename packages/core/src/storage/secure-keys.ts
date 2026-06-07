/**
 * Encrypted bring-your-own-key storage.
 *
 * v1 is client-only, so provider API keys live on the device. They are
 * encrypted at rest with AES-GCM via WebCrypto using a key derived from a
 * device passphrase (PBKDF2). This is defence-in-depth, not a substitute for a
 * hosted backend — when the "server-ready" proxy lands, keys move server-side
 * and this module is no longer the system of record.
 */

const SALT_BYTES = 16;
const IV_BYTES = 12;
const PBKDF2_ITERATIONS = 100_000;

export interface EncryptedKey {
  salt: number[];
  iv: number[];
  ciphertext: number[];
}

/** Allocate an ArrayBuffer-backed view, so types satisfy WebCrypto's BufferSource. */
function bytes(source: ArrayLike<number> | number): Uint8Array<ArrayBuffer> {
  return typeof source === "number"
    ? new Uint8Array(new ArrayBuffer(source))
    : Uint8Array.from(source);
}

export async function encryptKey(plaintext: string, passphrase: string): Promise<EncryptedKey> {
  const salt = crypto.getRandomValues(bytes(SALT_BYTES));
  const iv = crypto.getRandomValues(bytes(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    bytes([...new TextEncoder().encode(plaintext)]),
  );
  return {
    salt: [...salt],
    iv: [...iv],
    ciphertext: [...new Uint8Array(ciphertext)],
  };
}

export async function decryptKey(payload: EncryptedKey, passphrase: string): Promise<string> {
  const salt = bytes(payload.salt);
  const iv = bytes(payload.iv);
  const key = await deriveKey(passphrase, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    bytes(payload.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    bytes([...new TextEncoder().encode(passphrase)]),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
