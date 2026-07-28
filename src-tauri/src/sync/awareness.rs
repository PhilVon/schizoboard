//! Who is in the room, and how recently they said so.
//!
//! Awareness is a map from client id to `(clock, state)`, and the whole
//! protocol is one rule: **a higher clock wins**. Everything else — cursors
//! appearing, cursors vanishing when a laptop lid closes, a peer coming back
//! after a reconnect — falls out of that one comparison.
//!
//! The relay holds this map so that a board opened second is not an empty room
//! until somebody happens to move their mouse. It never looks inside a state:
//! the JSON is a string here and stays one.
//!
//! ## The removal rule, which is the subtle half
//!
//! Removing a client we do not *own* deletes its state but **keeps its clock**.
//! That is not an oversight in the reference implementation, it is the thing
//! that makes reconnection work: the returning client re-announces at
//! `clock + 1`, which beats what we kept, and it is visible again immediately.
//! Bumping the clock on removal would make its announcement look stale and it
//! would stay invisible until the fifteen-second heartbeat happened to fire.
//! (T-68 hit exactly that from the other side.)

use std::collections::HashMap;

use crate::sync::wire::{write_var_string, write_var_uint, Reader, WireError};

#[derive(Clone)]
struct ClientState {
    clock: u64,
    /// `None` once the client has gone. The clock outlives the state.
    json: Option<String>,
}

#[derive(Default)]
pub struct Awareness {
    clients: HashMap<u64, ClientState>,
}

impl Awareness {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every client we have ever heard from, gone or not.
    ///
    /// The departed are included on purpose: a peer that never learned somebody
    /// was here still needs to be told they are not, or it will accept a stale
    /// announcement from a third party later.
    pub fn clients(&self) -> Vec<u64> {
        self.clients.keys().copied().collect()
    }

    /// Client ids with a state right now.
    pub fn present(&self) -> Vec<u64> {
        self.clients
            .iter()
            .filter(|(_, state)| state.json.is_some())
            .map(|(id, _)| *id)
            .collect()
    }

    /// Apply an awareness update, and report which clients actually changed.
    ///
    /// An empty result means the whole frame was stale — which is common and
    /// not an error. Nothing is broadcast for it, which is most of what keeps a
    /// room with several peers in it from echoing forever.
    pub fn apply(&mut self, update: &[u8]) -> Result<Vec<u64>, WireError> {
        let mut reader = Reader::new(update);
        let count = reader.var_uint()?;
        let mut changed = Vec::new();

        for _ in 0..count {
            let client = reader.var_uint()?;
            let clock = reader.var_uint()?;
            let json = reader.var_string()?;
            // `null` is the protocol's "this client is gone", and it is a JSON
            // literal rather than a flag — so this is the only place the relay
            // looks at the content of a state at all, and only to compare four
            // characters.
            let state = if json == "null" { None } else { Some(json) };

            match self.clients.get(&client) {
                Some(known) if clock > known.clock => {}
                // Equal clocks: a removal still wins over a live state. That is
                // how a peer tells the room about somebody *else* dropping out.
                Some(known) if clock == known.clock && state.is_none() && known.json.is_some() => {}
                Some(_) => continue,
                None => {}
            }

            self.clients.insert(client, ClientState { clock, json: state });
            changed.push(client);
        }

        Ok(changed)
    }

    /// Encode the given clients as one awareness update payload.
    ///
    /// A client we have never heard of encodes as gone at clock zero, which is
    /// what the caller wants when it is answering a query about someone who has
    /// just left.
    pub fn encode(&self, clients: &[u64]) -> Vec<u8> {
        let mut out = Vec::new();
        write_var_uint(&mut out, clients.len() as u64);
        for client in clients {
            let state = self.clients.get(client);
            write_var_uint(&mut out, *client);
            write_var_uint(&mut out, state.map_or(0, |s| s.clock));
            write_var_string(&mut out, state.and_then(|s| s.json.as_deref()).unwrap_or("null"));
        }
        out
    }

    /// Mark clients as gone, keeping their clocks. Returns those that changed.
    ///
    /// Called when a connection closes, for whatever that connection was
    /// speaking for. A peer whose network went is not going to send a goodbye.
    pub fn remove(&mut self, clients: &[u64]) -> Vec<u64> {
        let mut changed = Vec::new();
        for client in clients {
            if let Some(state) = self.clients.get_mut(client) {
                if state.json.is_some() {
                    state.json = None;
                    changed.push(*client);
                }
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::wire::{write_var_string, write_var_uint};

    fn update(entries: &[(u64, u64, &str)]) -> Vec<u8> {
        let mut out = Vec::new();
        write_var_uint(&mut out, entries.len() as u64);
        for (client, clock, json) in entries {
            write_var_uint(&mut out, *client);
            write_var_uint(&mut out, *clock);
            write_var_string(&mut out, json);
        }
        out
    }

    fn state_of(awareness: &Awareness, client: u64) -> Option<String> {
        awareness.clients.get(&client).and_then(|s| s.json.clone())
    }

    #[test]
    fn a_new_client_arrives() {
        let mut awareness = Awareness::new();
        let changed = awareness.apply(&update(&[(7, 1, r#"{"name":"Phil"}"#)])).unwrap();

        assert_eq!(changed, vec![7]);
        assert_eq!(state_of(&awareness, 7).as_deref(), Some(r#"{"name":"Phil"}"#));
    }

    #[test]
    fn a_higher_clock_wins_and_a_lower_one_is_ignored() {
        let mut awareness = Awareness::new();
        awareness.apply(&update(&[(7, 5, "\"five\"")])).unwrap();

        assert_eq!(awareness.apply(&update(&[(7, 6, "\"six\"")])).unwrap(), vec![7]);
        assert_eq!(state_of(&awareness, 7).as_deref(), Some("\"six\""));

        // Late, out of order, or a duplicate. Nothing changes, and nothing is
        // broadcast — which is what stops a room of peers echoing each other.
        assert!(awareness.apply(&update(&[(7, 4, "\"four\"")])).unwrap().is_empty());
        assert!(awareness.apply(&update(&[(7, 6, "\"again\"")])).unwrap().is_empty());
        assert_eq!(state_of(&awareness, 7).as_deref(), Some("\"six\""));
    }

    #[test]
    fn a_removal_wins_at_an_equal_clock() {
        let mut awareness = Awareness::new();
        awareness.apply(&update(&[(7, 3, "\"here\"")])).unwrap();

        // How one peer tells the room that a third party has gone.
        assert_eq!(awareness.apply(&update(&[(7, 3, "null")])).unwrap(), vec![7]);
        assert_eq!(state_of(&awareness, 7), None);
    }

    #[test]
    fn a_client_that_comes_back_is_visible_again_at_once() {
        let mut awareness = Awareness::new();
        awareness.apply(&update(&[(7, 4, "\"here\"")])).unwrap();
        awareness.remove(&[7]);
        assert_eq!(state_of(&awareness, 7), None);

        // The clock was kept, so the client's own bump beats it. Had `remove`
        // bumped the clock instead, this announcement would read as stale and
        // the peer would stay invisible for fifteen seconds.
        let changed = awareness.apply(&update(&[(7, 5, "\"back\"")])).unwrap();

        assert_eq!(changed, vec![7]);
        assert_eq!(state_of(&awareness, 7).as_deref(), Some("\"back\""));
    }

    #[test]
    fn re_announcing_at_the_same_clock_does_not_come_back() {
        // The other side of the same rule, and the bug T-68 fixed in the
        // client: a peer that re-sends its state unchanged after a reconnect
        // stays invisible. It is the client's job to bump, not ours to guess.
        let mut awareness = Awareness::new();
        awareness.apply(&update(&[(7, 4, "\"here\"")])).unwrap();
        awareness.remove(&[7]);

        assert!(awareness.apply(&update(&[(7, 4, "\"here\"")])).unwrap().is_empty());
        assert_eq!(state_of(&awareness, 7), None);
    }

    #[test]
    fn removing_someone_already_gone_changes_nothing() {
        let mut awareness = Awareness::new();
        awareness.apply(&update(&[(7, 1, "\"here\"")])).unwrap();

        assert_eq!(awareness.remove(&[7]), vec![7]);
        assert!(awareness.remove(&[7]).is_empty());
        assert!(awareness.remove(&[99]).is_empty());
    }

    #[test]
    fn what_is_encoded_reads_back_the_same() {
        let mut awareness = Awareness::new();
        awareness
            .apply(&update(&[(7, 2, "\"phil\""), (8, 9, "\"sam\"")]))
            .unwrap();

        let mut echo = Awareness::new();
        let mut clients = awareness.clients();
        clients.sort_unstable();
        echo.apply(&awareness.encode(&clients)).unwrap();

        assert_eq!(state_of(&echo, 7).as_deref(), Some("\"phil\""));
        assert_eq!(state_of(&echo, 8).as_deref(), Some("\"sam\""));
    }

    #[test]
    fn a_departure_encodes_as_null_at_the_clock_we_kept() {
        let mut awareness = Awareness::new();
        awareness.apply(&update(&[(7, 3, "\"here\"")])).unwrap();
        awareness.remove(&[7]);

        let encoded = awareness.encode(&[7]);
        let mut reader = Reader::new(&encoded);
        assert_eq!(reader.var_uint(), Ok(1));
        assert_eq!(reader.var_uint(), Ok(7));
        assert_eq!(reader.var_uint(), Ok(3));
        assert_eq!(reader.var_string().as_deref(), Ok("null"));
    }

    #[test]
    fn present_and_clients_disagree_once_somebody_leaves() {
        let mut awareness = Awareness::new();
        awareness.apply(&update(&[(7, 1, "\"a\""), (8, 1, "\"b\"")])).unwrap();
        awareness.remove(&[7]);

        assert_eq!(awareness.present(), vec![8]);
        let mut all = awareness.clients();
        all.sort_unstable();
        assert_eq!(all, vec![7, 8]);
    }

    #[test]
    fn a_truncated_update_is_refused_rather_than_half_applied() {
        let mut awareness = Awareness::new();
        // Claims two clients, carries one.
        let mut bytes = update(&[(7, 1, "\"a\"")]);
        bytes[0] = 2;

        assert!(awareness.apply(&bytes).is_err());
    }
}
