//! Bounded relay handshakes and idle keepalive. No app data or tokens are logged here.
use futures_util::{SinkExt, StreamExt};
use std::{sync::Arc, time::Duration};
use tokio::{net::TcpStream, sync::{broadcast, Notify}, time::{interval_at, Instant}};
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};

pub const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const KEEPALIVE: Duration = Duration::from_secs(20);

/// TCP can split HTTP headers anywhere. Peeking just once misclassified a partial WS
/// upgrade as an ordinary page request. Never consume bytes needed by the real parser.
pub async fn is_websocket(stream: &TcpStream) -> Result<bool, String> {
    tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        let mut head = [0u8; 32 * 1024];
        loop {
            let n = stream.peek(&mut head).await.map_err(|_| "header read failed")?;
            if n == 0 { return Err("connection closed before headers".to_string()); }
            if let Some(end) = head[..n].windows(4).position(|w| w == b"\r\n\r\n") {
                return Ok(String::from_utf8_lossy(&head[..end]).lines().any(|line| {
                    line.split_once(':').is_some_and(|(name, value)|
                        name.eq_ignore_ascii_case("upgrade") && value.trim().eq_ignore_ascii_case("websocket"))
                }));
            }
            if n == head.len() { return Err("headers too large".to_string()); }
            // The same unread prefix remains ready; don't busy-poll it while awaiting the tail.
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.map_err(|_| "header timeout".to_string())?
}

pub async fn serve_peer(
    stream: TcpStream, token: String, peer_id: u64,
    tx: broadcast::Sender<(u64, String)>, stop: Arc<Notify>,
) -> Result<(), String> {
    serve_peer_with_period(stream, token, peer_id, tx, stop, KEEPALIVE).await
}

async fn serve_peer_with_period(
    stream: TcpStream, token: String, peer_id: u64,
    tx: broadcast::Sender<(u64, String)>, stop: Arc<Notify>, period: Duration,
) -> Result<(), String> {
    let config = WebSocketConfig {
        max_message_size: Some(MAX_MESSAGE_BYTES), max_frame_size: Some(MAX_MESSAGE_BYTES),
        ..Default::default()
    };
    let ws = tokio::time::timeout(HANDSHAKE_TIMEOUT,
        tokio_tungstenite::accept_async_with_config(stream, Some(config)))
        .await.map_err(|_| "websocket handshake timeout")?
        .map_err(|_| "websocket handshake failed")?;
    let (mut write, mut read) = ws.split();
    let mut rx = tx.subscribe();
    let mut authorized = false;
    let auth_deadline = tokio::time::sleep(HANDSHAKE_TIMEOUT);
    tokio::pin!(auth_deadline);
    let mut last_seen = Instant::now();
    let mut heartbeat = interval_at(Instant::now() + period, period);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = stop.notified() => { let _ = write.close().await; return Ok(()); }
            _ = &mut auth_deadline, if !authorized => return Err("pairing timeout".into()),
            _ = heartbeat.tick(), if authorized => {
                if last_seen.elapsed() > period * 4 { return Err("peer keepalive timeout".into()); }
                // Browser WebSockets answer protocol Pings automatically, including idle phones.
                write.send(Message::Ping(Vec::new())).await.map_err(|_| "keepalive write failed")?;
            }
            incoming = read.next() => {
                let Some(msg) = incoming else { return Ok(()); };
                let msg = msg.map_err(|_| "websocket read failed (closed, malformed or oversized frame)")?;
                last_seen = Instant::now();
                match msg {
                    Message::Text(txt) => {
                        let valid = serde_json::from_str::<serde_json::Value>(&txt).ok()
                            .and_then(|v| v.get("token").and_then(|t| t.as_str())
                                .map(|t| crate::ct_eq(t.as_bytes(), token.as_bytes())))
                            .unwrap_or(false);
                        if !valid {
                            tokio::time::sleep(Duration::from_millis(500)).await;
                            return Err("invalid pairing token".into());
                        }
                        authorized = true;
                        // The first authenticated frame is a real hello, not a disposable handshake.
                        let _ = tx.send((peer_id, txt));
                    }
                    Message::Ping(_) => {
                        // tungstenite queues the automatic Pong; explicitly flush the split sink.
                        write.flush().await.map_err(|_| "pong flush failed")?;
                    }
                    Message::Close(_) => { let _ = write.close().await; return Ok(()); }
                    _ => {}
                }
            }
            frame = rx.recv() => {
                match frame {
                    Ok((from, txt)) if from != peer_id && authorized => {
                        write.send(Message::Text(txt)).await.map_err(|_| "relay write failed")?;
                    }
                    Err(broadcast::error::RecvError::Closed) => return Ok(()),
                    Err(broadcast::error::RecvError::Lagged(_)) => return Err("peer fell behind; resync required".into()),
                    _ => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::AsyncWriteExt, net::TcpListener};

    #[tokio::test(flavor = "current_thread")]
    async fn fragmented_upgrade_is_not_mistaken_for_a_page() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
        let (server, _) = listener.accept().await.unwrap();
        client.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nUpg").await.unwrap();
        let check = tokio::spawn(async move { is_websocket(&server).await.unwrap() });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!check.is_finished());
        client.write_all(b"rade:\twebsocket\r\n\r\n").await.unwrap();
        assert!(check.await.unwrap());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn idle_authenticated_peer_gets_keepalive_and_still_relays() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, mut received) = broadcast::channel(8);
        let stop = Arc::new(Notify::new());
        let stop_server = stop.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            serve_peer_with_period(stream, "test-token".into(), 1, tx, stop_server, Duration::from_millis(30)).await
        });
        let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://{address}")).await.unwrap();
        let hello = r#"{"token":"test-token","payload":{"type":"vrcmd:hello"}}"#;
        client.send(Message::Text(hello.into())).await.unwrap();
        assert_eq!(received.recv().await.unwrap().1, hello);
        for _ in 0..5 {
            let msg = tokio::time::timeout(Duration::from_secs(1), client.next()).await.unwrap().unwrap().unwrap();
            assert!(matches!(msg, Message::Ping(_)));
            client.flush().await.unwrap();
        }
        assert!(!server.is_finished());
        client.send(Message::Text(hello.into())).await.unwrap();
        assert_eq!(received.recv().await.unwrap().1, hello);
        stop.notify_waiters();
        assert!(server.await.unwrap().is_ok());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unauthenticated_peer_never_receives_broadcasts() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (tx, _rx) = broadcast::channel(8);
        let broadcast = tx.clone();
        let stop = Arc::new(Notify::new());
        let stop_server = stop.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            serve_peer(stream, "test-token".into(), 1, tx, stop_server).await
        });
        let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://{address}")).await.unwrap();
        broadcast.send((2, "private frame".into())).unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(40), client.next()).await.is_err());
        client.send(Message::Text(r#"{"token":"wrong"}"#.into())).await.unwrap();
        let outcome = tokio::time::timeout(Duration::from_secs(2), server).await.unwrap().unwrap();
        assert_eq!(outcome.unwrap_err(), "invalid pairing token");
    }
}
