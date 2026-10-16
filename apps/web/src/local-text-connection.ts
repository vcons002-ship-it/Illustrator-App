import { DirectTransport, LocalServerLLMProvider, type LocalTextServerId } from "@visual-reader/core";

/** Only the installed, default loopback Ollama can be started by this app. Never start a
 * local process to "repair" a remote/custom server or change its bind/CORS settings. */
export function canStartLocalOllama(server: LocalTextServerId, url: string): boolean {
  try {
    const u = new URL(url);
    return server === "ollama" && u.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && u.port === "11434" &&
      !u.username && !u.password && /^\/(?:v1\/?|)$/.test(u.pathname);
  } catch {
    return false;
  }
}

export async function connectLocalText(
  server: LocalTextServerId,
  url: string,
  options: { desktopFetch?: typeof fetch; ensureOllama?: () => Promise<void> } = {},
) {
  // Discovery must use the SAME native bridge as inference. A packaged Tauri origin is not
  // a browser localhost origin; direct discovery failed even when native chat worked.
  const transport = options.desktopFetch ? new DirectTransport(options.desktopFetch) : undefined;
  try {
    return await LocalServerLLMProvider.listModels(url, transport);
  } catch (error) {
    if (!options.ensureOllama || !options.desktopFetch || !canStartLocalOllama(server, url)) throw error;
    await options.ensureOllama();
    return LocalServerLLMProvider.listModels(url, transport);
  }
}
