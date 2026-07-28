//! One board, its peers, and the protocol between them.
//!
//! Deliberately knows nothing about sockets. `receive` takes bytes and returns
//! the bytes that answer them, exactly as `crdt/sync/protocol.ts` does on the
//! other side — which is what lets every rule in D-26 be tested with two
//! documents, no runtime and no port.
//!
//! ## The relay holds a document
//!
//! It has to. A peer's first word is a state vector, and the only possible
//! answer is the difference — which nobody can compute without the document.
//! It is also what "an always-on, always-seeding peer" (ARCHITECTURE section
//! 5.1) means: a board whose two humans are asleep is still on the relay.
//!
//! The document here is opaque. No items, no pins, no strings, no schema — the
//! relay merges and forwards updates it never looks inside.

use std::collections::{HashMap, HashSet};

use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use crate::sync::awareness::Awareness;
use crate::sync::wire::{
    write_var_bytes, write_var_uint, Reader, MSG_AWARENESS, MSG_QUERY_AWARENESS, MSG_SYNC,
    SYNC_STEP1, SYNC_STEP2, SYNC_UPDATE,
};

/// Who a frame is for.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Target {
    /// The connection that just spoke.
    Sender,
    /// Everybody in the room except the connection that just spoke.
    Others,
    /// Everybody, including the one that spoke. Used when nobody spoke.
    All,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Outbound {
    pub target: Target,
    pub frame: Vec<u8>,
}

#[derive(Default)]
struct Peer {
    /// Awareness clients this connection has spoken for.
    ///
    /// A socket that goes takes its peers' cursors with it, and this is how the
    /// relay knows whose. Nothing else can tell: awareness client ids are the
    /// document's, not the connection's.
    controls: HashSet<u64>,
}

pub struct Room {
    doc: Doc,
    awareness: Awareness,
    peers: HashMap<u64, Peer>,
}

impl Default for Room {
    fn default() -> Self {
        Self::new()
    }
}

impl Room {
    pub fn new() -> Self {
        Room {
            doc: Doc::new(),
            awareness: Awareness::new(),
            peers: HashMap::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.peers.is_empty()
    }

    pub fn peer_count(&self) -> usize {
        self.peers.len()
    }

    /// A connection arrived. What to say to it, before it says anything.
    ///
    /// **The state vector is the half that matters.** Answering a client's
    /// step 1 tells it what *we* have; sending our own asks what *it* has, and
    /// without that a peer which edited while the relay was down is never asked
    /// for the difference. Its work sits there looking synced (D-26).
    pub fn join(&mut self, id: u64) -> Vec<Outbound> {
        self.peers.insert(id, Peer::default());

        let mut greeting = vec![Outbound {
            target: Target::Sender,
            frame: self.sync_step1(),
        }];

        // Who is already here, unasked. Our own client asks anyway, so this is
        // belt and braces against a client that does not.
        let present = self.awareness.present();
        if !present.is_empty() {
            greeting.push(Outbound {
                target: Target::Sender,
                frame: awareness_frame(&self.awareness.encode(&present)),
            });
        }
        greeting
    }

    /// A connection went. Take its peers' cursors with it.
    pub fn leave(&mut self, id: u64) -> Vec<Outbound> {
        let Some(peer) = self.peers.remove(&id) else {
            return Vec::new();
        };
        let controlled: Vec<u64> = peer.controls.into_iter().collect();
        let gone = self.awareness.remove(&controlled);
        if gone.is_empty() {
            return Vec::new();
        }
        // `All`, not `Others`: the connection this belonged to is already out
        // of the map, so there is no sender left to exclude.
        vec![Outbound {
            target: Target::All,
            frame: awareness_frame(&self.awareness.encode(&gone)),
        }]
    }

    /// One frame in, and whatever answers it out.
    ///
    /// A frame that will not parse is dropped and the connection is left alone.
    /// Every frame is its own message, so the next one arrives intact — and
    /// dropping a connection because a peer is one version ahead of us is a
    /// worse failure than ignoring a byte we do not understand.
    pub fn receive(&mut self, from: u64, frame: &[u8]) -> Vec<Outbound> {
        let mut reader = Reader::new(frame);
        let Ok(kind) = reader.var_uint() else {
            return Vec::new();
        };

        match kind {
            MSG_SYNC => self.receive_sync(from, &mut reader),
            MSG_AWARENESS => self.receive_awareness(from, &mut reader),
            MSG_QUERY_AWARENESS => {
                let present = self.awareness.present();
                if present.is_empty() {
                    return Vec::new();
                }
                vec![Outbound {
                    target: Target::Sender,
                    frame: awareness_frame(&self.awareness.encode(&present)),
                }]
            }
            // `AUTH` is ours to send and not ours to receive, and anything else
            // is a peer from the future.
            _ => Vec::new(),
        }
    }

    fn receive_sync(&mut self, _from: u64, reader: &mut Reader<'_>) -> Vec<Outbound> {
        let Ok(sub) = reader.var_uint() else {
            return Vec::new();
        };
        let Ok(payload) = reader.var_bytes() else {
            return Vec::new();
        };

        match sub {
            SYNC_STEP1 => {
                let Ok(theirs) = StateVector::decode_v1(payload) else {
                    return Vec::new();
                };
                let diff = self.doc.transact().encode_state_as_update_v1(&theirs);
                vec![Outbound {
                    target: Target::Sender,
                    frame: sync_frame(SYNC_STEP2, &diff),
                }]
            }

            // Step 2 and a plain update are the same bytes to Yjs. Both are
            // "here is some document", and both get merged and passed on.
            SYNC_STEP2 | SYNC_UPDATE => {
                let Ok(update) = Update::decode_v1(payload) else {
                    return Vec::new();
                };
                if self.doc.transact_mut().apply_update(update).is_err() {
                    return Vec::new();
                }
                // The bytes as they arrived, rather than what the merge
                // produced. Cheaper, and identical for every other peer — an
                // update they already hold applies to nothing.
                vec![Outbound {
                    target: Target::Others,
                    frame: sync_frame(SYNC_UPDATE, payload),
                }]
            }

            _ => Vec::new(),
        }
    }

    fn receive_awareness(&mut self, from: u64, reader: &mut Reader<'_>) -> Vec<Outbound> {
        let Ok(payload) = reader.var_bytes() else {
            return Vec::new();
        };
        let Ok(changed) = self.awareness.apply(payload) else {
            return Vec::new();
        };

        if let Some(peer) = self.peers.get_mut(&from) {
            for client in &changed {
                peer.controls.insert(*client);
            }
        }

        // Nothing changed means the whole frame was stale. Staying quiet is
        // what stops a room of peers echoing one another indefinitely.
        if changed.is_empty() {
            return Vec::new();
        }
        vec![Outbound {
            target: Target::Others,
            frame: awareness_frame(&self.awareness.encode(&changed)),
        }]
    }

    fn sync_step1(&self) -> Vec<u8> {
        let sv = self.doc.transact().state_vector();
        sync_frame(SYNC_STEP1, &yrs::updates::encoder::Encode::encode_v1(&sv))
    }
}

fn sync_frame(sub: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 4);
    write_var_uint(&mut out, MSG_SYNC);
    write_var_uint(&mut out, sub);
    write_var_bytes(&mut out, payload);
    out
}

fn awareness_frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 2);
    write_var_uint(&mut out, MSG_AWARENESS);
    write_var_bytes(&mut out, payload);
    out
}
