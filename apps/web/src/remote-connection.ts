/** Socket-open is not desktop-ready. Only the authenticated conversation snapshot proves that. */
export function connectRemoteDesktop(options: {
  createSocket: () => WebSocket;
  hello: string;
  onSocket: (socket: WebSocket | undefined) => void;
  onFrame: (data: string) => boolean;
  onReady: (socket: WebSocket) => void;
  onStatus: (status: string) => void;
}): () => void {
  let stopped = false;
  let attempt = 0;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let helloRetry: ReturnType<typeof setTimeout> | undefined;
  const stopHello = () => clearTimeout(helloRetry);
  const connect = () => {
    if (stopped) return;
    const ws = options.createSocket();
    socket = ws;
    options.onSocket(ws);
    let answered = false;
    ws.onopen = () => {
      options.onStatus("Connected to relay; waiting for the desktop…");
      let delay = 2_000;
      const hello = () => {
        if (stopped || answered || ws.readyState !== WebSocket.OPEN) return;
        ws.send(options.hello);
        helloRetry = setTimeout(hello, delay);
        delay = Math.min(delay * 2, 60_000);
      };
      hello();
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      if (options.onFrame(event.data) && !answered) {
        answered = true;
        attempt = 0; // Never reset backoff on an unauthenticated socket-open.
        stopHello();
        options.onStatus("Linked to a desktop");
        options.onReady(ws); // Apply snapshot BEFORE sending commands queued during the gap.
      }
    };
    ws.onerror = () => { /* onclose owns retries */ };
    ws.onclose = (event) => {
      stopHello();
      if (socket === ws) options.onSocket(undefined);
      if (stopped) return;
      if (event.code === 1008) {
        options.onStatus("Phone pairing expired. Reopen the current phone link from the desktop’s Connections menu.");
        return;
      }
      if (event.code === 1009) {
        options.onStatus("Desktop sync exceeded the connection limit. Reopen the desktop app and report this sync error.");
        return;
      }
      options.onStatus("Reconnecting to the desktop…");
      retry = setTimeout(connect, Math.min(1_000 * 2 ** Math.min(attempt++, 4), 10_000));
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    stopHello();
    options.onSocket(undefined);
    socket?.close();
  };
}
