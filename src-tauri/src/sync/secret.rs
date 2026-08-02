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

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

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

/// What a board may be called, when the name is about to become a file name.
///
/// This matters more than it looks. The board name arriving here is not one this
/// application chose: it comes off an invite link (T-160), which is a string a
/// stranger sent and a user clicked. Matching `app/sync.ts`'s `BOARD_NAME`
/// exactly is the point — the frontend refuses the same names, so a name that
/// gets this far has already been refused once.
///
/// **The allowlist is what stops traversal**, and specifically the absence of
/// `/` and `\` from it: `../../boom` is refused because of the slashes, not
/// because of the dots. That is worth stating because it is easy to get
/// backwards — the test below was written believing the dot was doing the work,
/// and allowing dots back in did not make it fail. Allowing separators did,
/// immediately, by writing outside the store.
///
/// The dot is excluded anyway, one notch stricter than `sync/mod.rs`'s
/// `room_name` — which can afford it, because there a name only ever keys a
/// `HashMap` and `..` is a perfectly good map key. Two smaller reasons to keep
/// it out of a file name: Windows silently strips a trailing dot, so `demo.` and
/// `demo` would be one board with two names and one of them would quietly host
/// the other's secret; and `..` on its own resolves to the parent directory,
/// which is refused today only because you cannot `File::create` a directory —
/// an accident, and not one to rely on.
fn board_file(board: &str) -> Option<String> {
    is_board_name(board).then(|| board.to_string())
}

/// The rule above, for the one other place a board name is written down.
///
/// `board.rs` keeps which board this installation is *on*, and that value's
/// next stop is this file: it becomes the name under `secrets/` on the launch
/// after the one that minted it. So it is checked against the strictest of the
/// three copies of this rule rather than against a fourth of its own — see the
/// comment above for what each of them can afford.
pub fn is_board_name(board: &str) -> bool {
    !board.is_empty()
        && board.len() <= 64
        && board
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Where a board's secret is kept between sessions (Q-75).
///
/// Until this existed the shell invented a secret per launch, which meant an
/// invite link was good until whoever sent it quit — and that to every other
/// peer, a relaunch was a different board wearing the same name. Q-75 settled
/// it: **the secret is persisted beside the document**, so a board keeps its
/// identity and an invite outlives the window that produced it.
///
/// ## One file per board, holding one line
///
/// No format, no serialisation, nothing to parse: the file *is* the secret. That
/// is not laziness — a file whose whole content is 32 hex characters cannot be
/// half-read into something that looks valid, so there is no corrupt-file case
/// to design for. A file that does not read as a secret is treated as though it
/// were not there, which regenerates one, which is the same thing that happens
/// on a board nobody has opened before.
///
/// ## What this does not do
///
/// It does not encrypt anything. The secret sits in the application data
/// directory in plain text, readable by anything running as this user — which is
/// also true of the document it guards, sitting in the next directory along. A
/// secret held to a higher standard than the board it protects would be
/// security theatre; the threat model here is still section 5.1's, other
/// machines on the network, and this is not a defence against the one you are
/// sitting at.
pub struct SecretStore {
    root: PathBuf,
}

impl SecretStore {
    /// `root` is the directory secrets live in, created if it is not there.
    pub fn new(root: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&root)?;
        Ok(SecretStore { root })
    }

    fn path(&self, board: &str) -> Option<PathBuf> {
        board_file(board).map(|name| self.root.join(name))
    }

    /// This board's secret, if it has one that reads as one.
    ///
    /// A name that could not be a file has no secret rather than an error: the
    /// caller's answer to both is to make one up and not persist it, and a board
    /// whose name the frontend would have refused is not a case worth two
    /// branches.
    pub fn get(&self, board: &str) -> Option<String> {
        let stored = fs::read_to_string(self.path(board)?).ok()?;
        let secret = stored.trim();
        looks_like_a_secret(secret).then(|| secret.to_string())
    }

    /// Keep `secret` as this board's, replacing whatever was there.
    ///
    /// This is the invite arriving: somebody else opened the board and this
    /// machine has just been told its secret, so from here on that is the one to
    /// host with and the one to advertise a fingerprint of.
    pub fn remember(&self, board: &str, secret: &str) -> io::Result<()> {
        let Some(path) = self.path(board) else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{board:?} is not a board name"),
            ));
        };
        if !looks_like_a_secret(secret) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "that is not a board secret",
            ));
        }
        write_atomic(&path, secret.as_bytes())
    }

    /// This board's secret, making and keeping one the first time it is asked.
    ///
    /// The whole of the persistence story in one call: whoever opens a board
    /// first invents its secret, and every launch after that finds the same one.
    pub fn ensure(&self, board: &str) -> String {
        if let Some(existing) = self.get(board) {
            return existing;
        }
        let fresh = generate();
        // A secret that cannot be written is still a secret, and a board that
        // refuses to open because its data directory is read-only would be a
        // much worse outcome than an invite that stops working at quit — which
        // is exactly the behaviour this replaced, and was survivable.
        if let Err(error) = self.remember(board, &fresh) {
            eprintln!("[sync] this board's secret is not being kept: {error}");
        }
        fresh
    }
}

/// Whether a string is shaped like one of ours.
///
/// The same rule as `app/sync.ts`'s `SECRET`, and it is a length check as much
/// as a character one: a four-character secret would be checked exactly as
/// carefully as a real one and would be worth nothing.
fn looks_like_a_secret(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase())
}

/// Written whole or not at all, so a crash mid-write cannot leave a board
/// holding half a secret — which would lock out every peer including this one.
/// The same shape as `docstore.rs`'s, for the same reason.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let temp = path.with_extension(format!("part{}", std::process::id()));
    {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_is_thirty_two_hex_characters() {
        let secret = generate();
        assert_eq!(secret.len(), SECRET_BYTES * 2);
        assert!(secret
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
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

    fn store() -> (tempfile::TempDir, SecretStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SecretStore::new(dir.path().join("secrets")).unwrap();
        (dir, store)
    }

    #[test]
    fn a_board_keeps_its_secret_across_a_relaunch() {
        // The point of Q-75, and the whole reason this type exists: an invite
        // link handed out this morning still works this afternoon.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("secrets");

        let first = SecretStore::new(root.clone()).unwrap().ensure("board");
        let second = SecretStore::new(root).unwrap().ensure("board");
        assert_eq!(first, second);
    }

    #[test]
    fn two_boards_are_two_secrets() {
        let (_dir, store) = store();
        assert_ne!(store.ensure("mine"), store.ensure("theirs"));
    }

    #[test]
    fn an_invite_replaces_what_was_there() {
        let (_dir, store) = store();
        let ours = store.ensure("board");
        let theirs = generate();
        store.remember("board", &theirs).unwrap();
        assert_eq!(store.get("board").as_deref(), Some(theirs.as_str()));
        assert_ne!(ours, theirs);
    }

    #[test]
    fn a_board_nobody_has_opened_has_no_secret() {
        let (_dir, store) = store();
        assert_eq!(store.get("board"), None);
    }

    #[test]
    fn a_file_that_is_not_a_secret_is_no_secret_at_all() {
        // Half a write, a stray editor, somebody's idea of a helpful comment.
        // Every one of them regenerates rather than being hosted with.
        let (_dir, store) = store();
        for rubbish in [
            "",
            "   ",
            "not hex",
            "abc",
            &"f".repeat(129),
            "ABCDEF0123456789",
        ] {
            std::fs::write(store.root.join("board"), rubbish).unwrap();
            assert_eq!(
                store.get("board"),
                None,
                "{rubbish:?} read back as a secret"
            );
        }
    }

    #[test]
    fn a_secret_survives_the_whitespace_a_text_editor_adds() {
        let (_dir, store) = store();
        let secret = generate();
        std::fs::write(store.root.join("board"), format!("{secret}\r\n")).unwrap();
        assert_eq!(store.get("board").as_deref(), Some(secret.as_str()));
    }

    #[test]
    fn a_board_name_from_a_link_cannot_escape_the_directory() {
        // The name arrives off an invite link, which is a string a stranger sent
        // and a user clicked.
        //
        // What actually holds this line is the *separator*, not the dot — see
        // `board_file`. Allowing `.` back into the allowlist leaves this test
        // green; allowing `/` fails it on `../../boom` inside a second. The
        // trailing-dot pair at the end is the other thing the dot rule buys, and
        // it is a distinct hazard: Windows strips it, so those two names would
        // otherwise be one file reachable by two spellings.
        let (dir, store) = store();
        for escape in [
            "..",
            "../secrets",
            "../../boom",
            "a/b",
            "a\\b",
            "C:/Windows/System32/drivers/etc/hosts",
            "",
            &"x".repeat(65),
            "demo.",
            "demo..",
        ] {
            assert!(
                store.remember(escape, &generate()).is_err(),
                "{escape:?} was written"
            );
            assert_eq!(store.get(escape), None);
        }
        // Nothing was created outside the store, and the store is still empty.
        assert_eq!(std::fs::read_dir(&store.root).unwrap().count(), 0);
        assert!(!dir.path().join("boom").exists());
    }

    #[test]
    fn a_secret_that_is_not_one_is_refused_rather_than_kept() {
        let (_dir, store) = store();
        assert!(store.remember("board", "hello").is_err());
        assert!(store.remember("board", "").is_err());
        assert!(store.remember("board", &"0".repeat(129)).is_err());
        assert_eq!(store.get("board"), None);
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
