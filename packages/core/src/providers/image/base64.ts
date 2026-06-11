/** Decode a base64 string to image bytes. Shared by the image providers that
 * receive images inline (Flux / OpenAI / Gemini-Imagen) rather than by URL. */
export function base64ToBytes(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Encode image bytes to base64 — for providers that send reference images inline
 * (the native multimodal mode passes character photos in the request body). Chunked
 * so a large image never overflows the argument list of `String.fromCharCode`. */
export function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
