//! The embedded relay.
//!
//! > A transport-agnostic `SyncProvider` interface [...] **with the relay
//! > embedded in the application binary**. The same code runs [as] LAN mode
//! > [and] relay mode. — docs/ARCHITECTURE.md section 5.1
//!
//! One binary, two jobs. On a desktop it is the peer that happens to be
//! hosting; on a small server it is the always-on seed. Nothing below knows
//! which it is, because there is no difference — the second is the first with
//! nobody sitting at it.
//!
//! ## Where the parts are
//!
//! - `wire` — the frame. LEB128 and message types, shared with `protocol.ts`.
//! - `awareness` — who is in the room, and the clock rule that decides it.
//! - `room` — one board: a document, its peers, and bytes in to bytes out.
//!
//! All three are sockets-free and unit-tested. This module is the part that
//! cannot be: a listener, an accept loop, and a task per connection.
//!
//! ## Why a lock and not an actor
//!
//! Rooms sit behind a plain `std::sync::Mutex`, and nothing awaits while
//! holding it. Handling a frame is pure computation — decode, merge, encode —
//! and the results go out through unbounded channels, whose `send` does not
//! await either. So the lock is held for microseconds and never across a yield,
//! which is the one rule that makes a blocking mutex safe in async code.

pub mod awareness;
pub mod discovery;
pub mod room;
pub mod secret;
pub mod wire;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;

use futures_util::future::Either;
use futures_util::{SinkExt, StreamExt};

use room::{Room, Target};

/// The query parameter a dialling peer puts its secret in.
const TOKEN_PARAM: &str = "token";

/// A board name taken from the URL path, and what it may contain.
///
/// The path is attacker-controlled — it is whatever a peer put in a URL — and
/// it keys a map that lives for the process. Bounded and restricted so that it
/// can only ever be a name, never a length or a lever.
fn room_name(path: &str) -> Option<String> {
    let name = path.trim_start_matches('/');
    let name = name.split('?').next().unwrap_or("");
    if name.is_empty() || name.len() > 128 {
        return None;
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return None;
    }
    Some(name.to_string())
}

/// The `token` out of a query string, if there is one.
///
/// Hand-rolled rather than pulled from a URL crate, for the same reason
/// `wire.rs` is: this reads bytes an unauthenticated peer chose, and the whole
/// job is four lines of splitting. No percent-decoding, because the only thing
/// that is ever put here is a secret this application generated — 32 hex
/// characters, which encode to themselves. A token that needed escaping would
/// simply fail to match, which is the safe direction to be wrong in.
fn query_token(query: &str) -> Option<&str> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == TOKEN_PARAM).then_some(value)
    })
}

/// Whether a peer presented the secret, without leaking *where* it stopped
/// matching.
///
/// A short-circuiting `==` on a secret tells anyone who can measure the
/// difference how many leading characters they got right, which turns a
/// 128-bit secret into 32 four-bit guesses. The length is not itself a secret —
/// every one of ours is the same length — so comparing it up front is free.
///
/// Nothing here is worth a dependency on `subtle`: the fold below is the whole
/// idea, and it stays constant-time because it has no branch to be fast in.
fn secret_matches(expected: &str, presented: &str) -> bool {
    if expected.len() != presented.len() {
        return false;
    }
    let difference = expected
        .as_bytes()
        .iter()
        .zip(presented.as_bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    difference == 0
}

#[derive(Default)]
struct Rooms {
    open: HashMap<String, Room>,
    /// Where to write, per connection. Cleared when the socket goes.
    outbound: HashMap<u64, UnboundedSender<Message>>,
    /// Which room each connection is in.
    membership: HashMap<u64, String>,
}

impl Rooms {
    /// Post the results of handling a frame. Never awaits, so a caller may
    /// hold the lock across it.
    fn post(&self, board: &str, sender: u64, out: Vec<room::Outbound>) {
        for message in out {
            let frame = Message::Binary(message.frame.into());
            match message.target {
                Target::Sender => self.send_one(sender, frame),
                Target::Others => self.send_room(board, Some(sender), frame),
                Target::All => self.send_room(board, None, frame),
                Target::Peer(id) => self.send_one(id, frame),
            }
        }
    }

    fn send_one(&self, id: u64, frame: Message) {
        if let Some(tx) = self.outbound.get(&id) {
            // A closed receiver means the writer task has already gone. The
            // read side will notice and clean up; there is nothing to do here.
            let _ = tx.send(frame);
        }
    }

    fn send_room(&self, board: &str, except: Option<u64>, frame: Message) {
        for (id, room) in &self.membership {
            if room != board || Some(*id) == except {
                continue;
            }
            self.send_one(*id, frame.clone());
        }
    }
}

/// A running relay. Dropping the handle stops it.
pub struct Relay {
    addr: SocketAddr,
    rooms: Arc<Mutex<Rooms>>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Relay {
    /// Bind and start accepting, open to anyone who can reach the port.
    ///
    /// Only safe on loopback, and that is what both callers use it for: the
    /// headless binary defaults to `127.0.0.1`, and `tests/sync-interop.test.ts`
    /// spawns it there to run the real client against the real relay. Anything
    /// bound wider wants [`Relay::start_guarded`].
    pub async fn start(addr: SocketAddr) -> std::io::Result<Relay> {
        Relay::start_guarded(addr, None).await
    }

    /// Bind and start accepting, refusing anyone who cannot present `secret`.
    ///
    /// Returns once the port is listening, so a caller that dials immediately
    /// afterwards will not be refused.
    ///
    /// The secret is checked once, at connect, and never again — a socket that
    /// got in is trusted for as long as it stays open. That is the same shape
    /// as the room membership around it, and it is the honest level of
    /// assurance for something whose threat model is "the other machines on
    /// this network", not "an attacker with the wire".
    pub async fn start_guarded(addr: SocketAddr, secret: Option<String>) -> std::io::Result<Relay> {
        let listener = TcpListener::bind(addr).await?;
        let bound = listener.local_addr()?;
        let rooms = Arc::new(Mutex::new(Rooms::default()));
        let (shutdown, stop) = tokio::sync::oneshot::channel();
        let secret: Option<Arc<str>> = secret.map(Arc::from);

        let accepting = Arc::clone(&rooms);
        tokio::spawn(async move {
            let mut stop = stop;
            let ids = AtomicU64::new(1);
            loop {
                // `futures_util::select` rather than `tokio::select!`, which
                // lives behind tokio's `macros` feature — and that feature
                // wants a `tokio-macros` that is not on the index at the
                // version tokio is locked to. Same race, one allocation per
                // accept, which is nothing against a TCP handshake.
                let accept = Box::pin(listener.accept());
                match futures_util::future::select(accept, &mut stop).await {
                    Either::Left((Ok((stream, _)), _)) => {
                        let id = ids.fetch_add(1, Ordering::Relaxed);
                        let rooms = Arc::clone(&accepting);
                        let secret = secret.clone();
                        tokio::spawn(async move { serve(stream, id, rooms, secret).await });
                    }
                    // One refused connection is not a reason to stop listening.
                    Either::Left((Err(_), _)) => continue,
                    Either::Right(_) => return,
                }
            }
        });

        Ok(Relay {
            addr: bound,
            rooms,
            shutdown: Some(shutdown),
        })
    }

    /// The address actually bound, which is the interesting one when the
    /// caller asked for port zero.
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// How many connections are attached, across every board.
    pub fn peers(&self) -> usize {
        self.rooms.lock().expect("relay lock").outbound.len()
    }

    /// Connection ids, as strings, for `sync_status`.
    ///
    /// Connection ids rather than awareness client ids: the relay knows which
    /// sockets are attached, and who is on the other end of one is the
    /// document's business, not the shell's.
    pub fn peer_ids(&self) -> Vec<String> {
        let rooms = self.rooms.lock().expect("relay lock");
        rooms.outbound.keys().map(u64::to_string).collect()
    }

    pub fn boards(&self) -> Vec<String> {
        let rooms = self.rooms.lock().expect("relay lock");
        rooms.open.keys().cloned().collect()
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

async fn serve(stream: TcpStream, id: u64, rooms: Arc<Mutex<Rooms>>, secret: Option<Arc<str>>) {
    // The board is in the URL, and the URL is only visible during the
    // handshake — so it has to be captured here rather than read back later.
    // The secret rides in the query for the same reason: a WebSocket opened by
    // a webview cannot carry a header of our choosing.
    let mut path = String::new();
    let mut query = String::new();
    let accepted = tokio_tungstenite::accept_hdr_async(stream, |request: &Request, response: Response| {
        path = request.uri().path().to_string();
        query = request.uri().query().unwrap_or("").to_string();
        Ok(response)
    })
    .await;

    let Ok(mut socket) = accepted else { return };
    let Some(board) = room_name(&path) else { return };

    // Refused *after* the handshake rather than during it, so the reason
    // arrives as a `PERMISSION_DENIED` the client can show a human — a 401 on
    // the upgrade is, to every WebSocket API there is, an anonymous failure to
    // connect. `provider.ts` stops retrying on this frame, which is the
    // difference between "wrong secret" and a peer hammering the port.
    if let Some(expected) = secret.as_deref() {
        if !query_token(&query).is_some_and(|token| secret_matches(expected, token)) {
            let refusal = wire::permission_denied("this board is not open to you");
            let _ = socket.send(Message::Binary(refusal.into())).await;
            let _ = socket.close(None).await;
            return;
        }
    }

    let (mut writer, mut reader) = socket.split();
    let (tx, mut rx) = unbounded_channel::<Message>();

    // One task does all the writing, so nothing else ever has to await a
    // socket — which is what keeps the lock above safe to hold synchronously.
    let writing = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if writer.send(frame).await.is_err() {
                return;
            }
        }
        let _ = writer.close().await;
    });

    {
        let mut locked = rooms.lock().expect("relay lock");
        locked.outbound.insert(id, tx);
        locked.membership.insert(id, board.clone());
        let greeting = locked.open.entry(board.clone()).or_default().join(id);
        locked.post(&board, id, greeting);
    }

    while let Some(Ok(message)) = reader.next().await {
        let frame = match message {
            Message::Binary(bytes) => bytes,
            // Ping and pong are the socket's own business, and a peer sending
            // text on a binary protocol is a peer we cannot talk to.
            Message::Close(_) => break,
            _ => continue,
        };
        let mut locked = rooms.lock().expect("relay lock");
        let Some(room) = locked.open.get_mut(&board) else { break };
        let out = room.receive(id, &frame);
        locked.post(&board, id, out);
    }

    {
        let mut locked = rooms.lock().expect("relay lock");
        locked.outbound.remove(&id);
        locked.membership.remove(&id);
        if let Some(room) = locked.open.get_mut(&board) {
            let farewell = room.leave(id);
            locked.post(&board, id, farewell);
            // A board nobody is on is still a board — but an empty one has
            // nothing worth the memory, and the next peer to arrive would only
            // be handed a document it already has.
            if locked.open.get(&board).is_some_and(Room::is_empty) {
                locked.open.remove(&board);
            }
        }
    }

    writing.abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_board_name_is_a_name() {
        assert_eq!(room_name("/board-1").as_deref(), Some("board-1"));
        assert_eq!(room_name("/board-1?token=x").as_deref(), Some("board-1"));
        assert_eq!(room_name("/a.b_c-1").as_deref(), Some("a.b_c-1"));
    }

    #[test]
    fn a_token_comes_out_of_a_query_string() {
        assert_eq!(query_token("token=abc"), Some("abc"));
        assert_eq!(query_token("board=x&token=abc"), Some("abc"));
        assert_eq!(query_token("token=abc&board=x"), Some("abc"));
        // A parameter that merely ends in the word is not the word.
        assert_eq!(query_token("mytoken=abc"), None);
        assert_eq!(query_token("token"), None);
        assert_eq!(query_token(""), None);
        // Empty is a value, and it is one that cannot match a real secret.
        assert_eq!(query_token("token="), Some(""));
    }

    #[test]
    fn a_secret_matches_only_itself() {
        assert!(secret_matches("0123456789abcdef", "0123456789abcdef"));
        assert!(!secret_matches("0123456789abcdef", "0123456789abcdee"));
        assert!(!secret_matches("0123456789abcdef", "0123456789abcde"));
        assert!(!secret_matches("0123456789abcdef", "0123456789abcdefg"));
        assert!(!secret_matches("0123456789abcdef", ""));
        // The prefix case is the one a short-circuiting compare leaks.
        assert!(!secret_matches("aaaaaaaa", "aaaaaaab"));
        assert!(!secret_matches("aaaaaaaa", "baaaaaaa"));
    }

    #[test]
    fn a_board_name_is_not_a_lever() {
        // The path is whatever a peer put in a URL, and it keys a map that
        // lives as long as the process.
        assert_eq!(room_name("/"), None);
        assert_eq!(room_name(""), None);
        assert_eq!(room_name("/../../etc/passwd"), None);
        assert_eq!(room_name("/a/b"), None);
        assert_eq!(room_name(&format!("/{}", "x".repeat(129))), None);
    }
}
