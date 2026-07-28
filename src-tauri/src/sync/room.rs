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
    write_var_bytes, write_var_uint, Reader, MSG_ASSET, MSG_AWARENESS, MSG_QUERY_AWARENESS,
    MSG_SYNC, SYNC_STEP1, SYNC_STEP2, SYNC_UPDATE,
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
    /// One named connection, and nobody else.
    ///
    /// A megabyte of photograph has exactly one peer that asked for it, and
    /// `Others` would hand it to everybody on the board (D-28).
    Peer(u64),
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
            MSG_ASSET => self.receive_asset(from, &mut reader),
            // `AUTH` is ours to send and not ours to receive, and anything else
            // is a peer from the future.
            _ => Vec::new(),
        }
    }

    /// Forward one asset frame, without looking inside it.
    ///
    /// The relay holds no bytes and answers no `WANT`; the peers do that between
    /// themselves and this is the wire they do it over (D-28). So the two client
    /// ids are read, the rest is a tail, and the tail is copied.
    ///
    /// **The sender's id is not taken from the frame.** Whatever it wrote there
    /// is discarded and replaced with the id this connection has spoken awareness
    /// for, which makes `from` a fact rather than a claim — a peer cannot answer
    /// `NACK` in somebody else's name, and the requester's bookkeeping does not
    /// have to be sceptical about who replied.
    ///
    /// The price is that a connection which has not published awareness yet has
    /// no id to substitute, and its frame is dropped. That is why the exchange
    /// opens on `synced` rather than on the socket: by then the provider has
    /// published, and the relay knows who is asking.
    fn receive_asset(&mut self, from: u64, reader: &mut Reader<'_>) -> Vec<Outbound> {
        let (Ok(_claimed), Ok(to)) = (reader.var_uint(), reader.var_uint()) else {
            return Vec::new();
        };
        let Some(sender) = self.client_of(from) else {
            return Vec::new();
        };
        let frame = asset_frame(sender, to, reader.rest());

        if to == 0 {
            return vec![Outbound {
                target: Target::Others,
                frame,
            }];
        }
        // Addressed to somebody who is not here — a peer that closed the tab
        // between asking and being answered. The requester's own timeout is what
        // recovers from this; there is nobody to tell.
        let Some(connection) = self.connection_holding(to) else {
            return Vec::new();
        };
        vec![Outbound {
            target: Target::Peer(connection),
            frame,
        }]
    }

    /// The awareness client id a connection speaks as.
    ///
    /// The lowest, when there is more than one. A socket carries one document
    /// and so normally controls exactly one client; the tie-break exists so that
    /// two frames from the same connection can never disagree about who sent
    /// them, which a `HashSet` iteration order would otherwise allow.
    fn client_of(&self, connection: u64) -> Option<u64> {
        self.peers.get(&connection)?.controls.iter().min().copied()
    }

    fn connection_holding(&self, client: u64) -> Option<u64> {
        self.peers
            .iter()
            .find(|(_, peer)| peer.controls.contains(&client))
            .map(|(id, _)| *id)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::wire::write_var_string;

    /// A room with two connections, each having spoken awareness for one client.
    /// 10 and 20 are the connections; 101 and 201 are the client ids they gave.
    fn two_peers() -> Room {
        let mut room = Room::new();
        room.join(10);
        room.join(20);
        room.receive(10, &awareness_from(101));
        room.receive(20, &awareness_from(201));
        room
    }

    fn awareness_from(client: u64) -> Vec<u8> {
        let mut payload = Vec::new();
        write_var_uint(&mut payload, 1);
        write_var_uint(&mut payload, client);
        write_var_uint(&mut payload, 1);
        write_var_string(&mut payload, r#"{"user":{}}"#);
        awareness_frame(&payload)
    }

    /// `[MSG_ASSET][from][to]` and a tail this side never interprets.
    fn asset(from: u64, to: u64, tail: &[u8]) -> Vec<u8> {
        asset_frame(from, to, tail)
    }

    fn parse(frame: &[u8]) -> (u64, u64, Vec<u8>) {
        let mut reader = Reader::new(frame);
        assert_eq!(reader.var_uint(), Ok(MSG_ASSET));
        let from = reader.var_uint().expect("from");
        let to = reader.var_uint().expect("to");
        (from, to, reader.rest().to_vec())
    }

    #[test]
    fn an_addressed_frame_goes_to_one_connection() {
        let mut room = two_peers();
        let out = room.receive(10, &asset(0, 201, b"chunk"));

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].target, Target::Peer(20));
        assert_eq!(parse(&out[0].frame), (101, 201, b"chunk".to_vec()));
    }

    #[test]
    fn a_frame_addressed_to_zero_is_for_the_room() {
        // Which is HAVE, and only HAVE. Anything carrying bytes is addressed.
        let mut room = two_peers();
        let out = room.receive(10, &asset(0, 0, b"have"));

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].target, Target::Others);
        assert_eq!(parse(&out[0].frame), (101, 0, b"have".to_vec()));
    }

    #[test]
    fn the_sender_cannot_choose_who_the_frame_is_from() {
        // The whole reason `from` is worth trusting downstream: a peer writing
        // somebody else's client id into it gets its own back out.
        let mut room = two_peers();
        let out = room.receive(10, &asset(201, 201, b"nack"));

        assert_eq!(parse(&out[0].frame).0, 101);
    }

    #[test]
    fn a_connection_that_has_not_spoken_yet_cannot_trade() {
        // It has no client id for the relay to substitute, so there is nothing
        // honest to forward. The exchange opens on `synced` to stay clear of it.
        let mut room = Room::new();
        room.join(10);
        room.join(20);
        room.receive(20, &awareness_from(201));

        assert!(room.receive(10, &asset(0, 201, b"want")).is_empty());
    }

    #[test]
    fn a_frame_for_a_peer_who_left_is_dropped_rather_than_broadcast() {
        // The failure that matters: falling back to `Others` here would hand a
        // megabyte of photograph to every peer on the board.
        let mut room = two_peers();
        room.leave(20);

        assert!(room.receive(10, &asset(0, 201, b"chunk")).is_empty());
    }

    #[test]
    fn a_truncated_asset_frame_is_dropped_rather_than_panicking() {
        let mut room = two_peers();
        let mut short = Vec::new();
        write_var_uint(&mut short, MSG_ASSET);
        write_var_uint(&mut short, 0);

        assert!(room.receive(10, &short).is_empty());
    }
}

fn asset_frame(from: u64, to: u64, tail: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(tail.len() + 8);
    write_var_uint(&mut out, MSG_ASSET);
    write_var_uint(&mut out, from);
    write_var_uint(&mut out, to);
    out.extend_from_slice(tail);
    out
}

fn awareness_frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 2);
    write_var_uint(&mut out, MSG_AWARENESS);
    write_var_bytes(&mut out, payload);
    out
}
