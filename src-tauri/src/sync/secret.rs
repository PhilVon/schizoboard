//! The secret that makes a LAN board somebody's rather than everybody's.
//!
//! > we own uptime, authentication and NAT traversal
//! > — docs/ARCHITECTURE.md section 5.1
//!
//! This is the authentication half, at the smallest size that is honest. Q-59
//! settled the shape: **a secret in the invite link, checked at connect**. So a
//! board has one secret, whoever holds it is a peer, and whoever does not is
//! refused by `sync/mod.rs` before they are in a room.
//!
//! ## What this is not
//!
//! It is not a key exchange, and there is no per-peer identity: two people
//! holding the same secret are indistinguishable to the relay, and revoking one
//! of them means changing the board's secret. It is not confidentiality either
//! — the wire is plain `ws://`, so anybody already able to read the network can
//! read the board.
//!
//! Both are the right level for what section 5.1 asks of LAN mode ("two people
//! at a table") and neither should be quietly forgotten if this ever grows past
//! that. What it *does* buy is the thing that was actually blocking: the relay
//! can bind an address other than loopback without offering a read-write board
//! to every machine on the network.

use sha2::{Digest, Sha256};

/// 128 bits, as 32 hex characters.
///
/// Long enough that guessing is not a strategy, short enough to survive being
/// in a URL and — once the invite link lands — being read down a table.
const SECRET_BYTES: usize = 16;

/// How much of the hash is advertised. Eight hex characters is 32 bits: enough
/// that two boards on one network do not collide by accident, and far too few
/// to be worth reversing even if the secret were guessable. See
/// [`fingerprint`].
const FINGERPRINT_CHARS: usize = 8;

/// Domain separation, so a fingerprint can never be confused with — or replayed
/// as — a hash of the same bytes computed for any other purpose.
const FINGERPRINT_DOMAIN: &[u8] = b"schizoboard/mdns-fingerprint/v1\0";

/// A new board secret, from the operating system's randomness.
///
/// `getrandom` rather than `rand`: this wants the CSPRNG the OS already has and
/// nothing else — no distributions, no seedable generator, no chance of
/// somebody later reaching for the fast one by mistake.
pub fn generate() -> String {
    let mut bytes = [0u8; SECRET_BYTES];
    // The failure mode is the OS having no entropy source at all, which on
    // every platform this ships to means something is badly wrong. Refusing to
    // continue beats inventing a secret that is not one.
    getrandom::fill(&mut bytes).expect("the operating system should have randomness");
    hex(&bytes)
}

/// What a board says about its secret out loud.
///
/// mDNS is broadcast to the whole network, so the advertisement cannot carry
/// the secret. But a peer that has been given the secret still needs to tell
/// *which* of the advertised boards is the one it was invited to — board names
/// are short, human and collide ("board", "demo", "notes"), and dialling the
/// wrong one is a failed connection and a puzzled user.
///
/// So the advertisement carries a truncated hash instead: a peer holding the
/// secret can compute it and recognise its board; a peer that is not invited
/// learns 32 bits of a hash of something it cannot guess.
pub fn fingerprint(secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(FINGERPRINT_DOMAIN);
    hasher.update(secret.as_bytes());
    hex(&hasher.finalize())[..FINGERPRINT_CHARS].to_string()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut out, byte| {
        out.push_str(&format!("{byte:02x}"));
        out
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_is_thirty_two_hex_characters() {
        let secret = generate();
        assert_eq!(secret.len(), SECRET_BYTES * 2);
        assert!(secret.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
    }

    #[test]
    fn two_secrets_are_not_the_same_secret() {
        // Not a test of the CSPRNG — a test that we are calling it once per
        // board rather than caching one and handing it out twice.
        let many: std::collections::HashSet<String> = (0..64).map(|_| generate()).collect();
        assert_eq!(many.len(), 64);
    }

    #[test]
    fn a_fingerprint_is_stable_and_short() {
        let secret = generate();
        assert_eq!(fingerprint(&secret), fingerprint(&secret));
        assert_eq!(fingerprint(&secret).len(), FINGERPRINT_CHARS);
    }

    #[test]
    fn a_fingerprint_is_not_the_secret() {
        let secret = generate();
        let advertised = fingerprint(&secret);
        assert!(!secret.contains(&advertised));
        assert!(!secret.starts_with(&advertised));
    }

    #[test]
    fn different_secrets_fingerprint_differently() {
        assert_ne!(fingerprint("a"), fingerprint("b"));
        // The domain prefix means this is not simply sha256 of the secret, so
        // a fingerprint cannot be replayed as one taken somewhere else.
        let plain = {
            let mut hasher = Sha256::new();
            hasher.update(b"secret");
            hex(&hasher.finalize())[..FINGERPRINT_CHARS].to_string()
        };
        assert_ne!(fingerprint("secret"), plain);
    }
}
