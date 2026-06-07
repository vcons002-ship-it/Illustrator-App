/** Decode a base64 string to image bytes. Shared by the image providers that
 * receive images inline (Flux / OpenAI / Gemini-Imagen) rather than by URL. */
export function base64ToBytes(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
