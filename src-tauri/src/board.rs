//! Which board this installation is on.
//!
//! One string, one file, and it exists because of one specific way of being
//! wrong.
//!
//! Until now the answer was a constant: `app/sync.ts`'s `DEFAULT_BOARD`, the
//! word `board`, with `?board=` on the address bar as the only way to say
//! otherwise — and in a packaged application there is no address bar, so every
//! launch of every installation opened a board of the same name. That was
//! survivable while a board was a thing you only ever had one of.
//!
//! Opening a bundle ended that (T-84, Q-111): a `.schizo` **replaces** the
//! document on disk and the window reloads. On a board with nobody else on it
//! that is the whole story. On a board with a peer it is not, and T-195 is what
//! went wrong:
//!
//! > **Prefer additive migrations.** In a CRDT, destructive migrations are
//! > genuinely dangerous: an old client that reconnects can resurrect the old
//! > shape, and the merge will accept it. — docs/DATA-MODEL.md section 12
//!
//! The same sentence one level up. The relay *holds a document* (`sync/room.rs`),
//! so a window that replaces its board and then reconnects **to the same room**
//! is answered with everything it just discarded — and the user is looking at
//! two boards at once, having been told one of them was gone. Q-114 settled the
//! fix: a bundle open **mints a new board id**, so the reloaded window is simply
//! not in the old room. The secret follows for free, because
//! `sync/secret.rs` keeps one per board name and invents one for a name it has
//! never seen.
//!
//! ## Why this is on disk and not only in the URL
//!
//! Because the window that opens a bundle reloads with the fresh id in its own
//! query string, and that gets it through the reload — but the *next launch*
//! starts with no query string at all. Without a persisted copy, quitting and
//! reopening would put the window back in the old room, with a document that no
//! longer has anything to do with it, and the merge would happen then instead.
//! A bug that waits for a relaunch is worse than the one it replaced.
//!
//! ## Why it is not in the document
//!
//! It would sync, which is the one thing it must not do. The board id is what
//! separates this window from the peers it has left; a field in the document is
//! a field they can write. It would also arrive *inside the bundle* — every
//! machine opening that file would adopt the exporter's id and expect to be in
//! their room.
//!
//! ## What it does not do
//!
//! It does not clean up after itself. Each mint leaves the previous board's
//! secret behind in `secrets/` — 32 bytes naming a board this machine can no
//! longer reach, since its document has been replaced. Deleting it would be
//! tidier and is not obviously safe: the same name may be one this machine is
//! later invited back to, and there is no cost to being wrong in this direction.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::sync::secret::is_board_name;

/// The file holding this installation's board id, and nothing else.
///
/// The same shape as [`crate::sync::secret::SecretStore`] and for the same
/// reasons: the file *is* the value, so there is no format to parse and no
/// half-read state that could look valid; and anything that does not read as a
/// board id is treated as though it were not there, which resolves to the
/// default — the same thing that happens on an installation that has never
/// opened a bundle.
pub struct BoardStore {
    path: PathBuf,
}

impl BoardStore {
    /// `path` is the file itself. Its directory is created if it is missing, so
    /// this can be constructed before anything else has touched the data root.
    pub fn new(path: PathBuf) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(BoardStore { path })
    }

    /// This installation's board, if it has been told one that reads as a name.
    ///
    /// Validated on the way out rather than trusted, because the value leaves
    /// here and becomes three other things: a room name on the wire, a file
    /// name under `secrets/`, and a query parameter. Every one of those checks
    /// it again — this is the first of four, not the only one, and it is the
    /// one that decides whether the file is worth anything at all.
    pub fn get(&self) -> Option<String> {
        let stored = fs::read_to_string(&self.path).ok()?;
        let name = stored.trim();
        is_board_name(name).then(|| name.to_string())
    }

    /// This is the board from now on.
    ///
    /// Written whole or not at all, so a crash mid-write cannot leave an
    /// installation holding half a board name — which would read as no name,
    /// which is the old room, which is the bug.
    pub fn remember(&self, board: &str) -> io::Result<()> {
        if !is_board_name(board) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{board:?} is not a board name"),
            ));
        }
        write_atomic(&self.path, board.as_bytes())
    }
}

/// The third copy of this in the tree, and the comment `secret.rs` carries about
/// the second applies here too: it is four lines, and the alternative is a
/// module three files exist only to share.
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

    fn store() -> (tempfile::TempDir, BoardStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = BoardStore::new(dir.path().join("board-id")).unwrap();
        (dir, store)
    }

    #[test]
    fn an_installation_nobody_has_moved_is_on_no_particular_board() {
        let (_dir, store) = store();
        assert_eq!(store.get(), None);
    }

    #[test]
    fn a_board_survives_a_relaunch() {
        // The whole point. Without this the next launch rejoins the room the
        // replaced board was in, and the merge that T-195 is about happens
        // then instead of now.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("board-id");

        BoardStore::new(path.clone())
            .unwrap()
            .remember("board-abc123")
            .unwrap();
        assert_eq!(
            BoardStore::new(path).unwrap().get().as_deref(),
            Some("board-abc123")
        );
    }

    #[test]
    fn the_latest_one_wins() {
        let (_dir, store) = store();
        store.remember("board-one").unwrap();
        store.remember("board-two").unwrap();
        assert_eq!(store.get().as_deref(), Some("board-two"));
    }

    #[test]
    fn a_file_that_is_not_a_board_name_is_no_board_at_all() {
        // Half a write, a stray editor, somebody's idea of a helpful comment.
        // Every one of them reads as "nobody has said", which resolves to the
        // default rather than to a room named after rubbish.
        let (_dir, store) = store();
        for rubbish in [
            "",
            "   ",
            "two words",
            "a/b",
            "..",
            &"x".repeat(65),
            "board.1",
        ] {
            fs::write(&store.path, rubbish).unwrap();
            assert_eq!(store.get(), None, "{rubbish:?} read back as a board");
        }
    }

    #[test]
    fn a_name_that_is_not_one_is_refused_rather_than_kept() {
        // The name arrives from the frontend, which minted it — but so does
        // every other string that has ever come across that boundary, and this
        // one becomes a file name under `secrets/` on the very next launch.
        let (dir, store) = store();
        for escape in [
            "",
            "..",
            "../secrets",
            "a/b",
            "a\\b",
            &"x".repeat(65),
            "demo.",
        ] {
            assert!(store.remember(escape).is_err(), "{escape:?} was written");
            assert_eq!(store.get(), None);
        }
        assert!(!dir.path().join("secrets").exists());
    }

    #[test]
    fn a_board_survives_the_whitespace_a_text_editor_adds() {
        let (_dir, store) = store();
        fs::write(&store.path, "board-abc123\r\n").unwrap();
        assert_eq!(store.get().as_deref(), Some("board-abc123"));
    }
}
