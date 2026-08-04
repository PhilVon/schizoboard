//! The document store of whichever board is open.
//!
//! **The only thing in this application that changes identity without the
//! process restarting**, which is the whole reason it exists as a module rather
//! than as a line in `lib.rs`'s `setup`.
//!
//! Until T-356 there was one document per installation, so `DocStore` could be
//! constructed once and `app.manage`d, and `docstore_of` could hand out a
//! `tauri::State` that was the same store for the life of the window. A board is
//! a file now, and opening another one is a thing that happens *while the shell
//! is running*, so the store behind `doc_append_update` has to be able to
//! become a different store.
//!
//! ## What a workshop is
//!
//! `docstore.rs` describes two crash windows and one layout, and none of that
//! changes here — a board's log and snapshot are exactly what they were, at
//! exactly the same filenames. What changes is *where*:
//!
//! ```text
//! <data>/doc/                      the board adopted from before T-356, in place
//! <data>/boards/<board-id>/doc/    every board minted since
//! ```
//!
//! The path comes out of the register (`board.rs`), which records it rather than
//! deriving it, so that the adopted board's workshop is never moved.
//!
//! And the name is the point: a workshop is where the work happens, and it is
//! **not** where the board lives. The board is the `.schizo`. A workshop is
//! rebuildable from its pack and is safe to delete — what it buys is the
//! fine-grained crash safety that appending a whole snapshot every 200 ms could
//! not, and it is the copy that wins when a pack was not flushed before the
//! window went away.
//!
//! ## `DocStore` itself does not change
//!
//! Not one line of it, and that is worth saying out loud because it is the
//! payoff of how it was written: it takes its root as an argument, holds no
//! global state, and keeps its own lock. Making the *store* swappable would have
//! meant reaching into the file handle and the `ours` flag underneath it. Making
//! the *reference* swappable is this file, and the crash semantics below it are
//! untouched.
//!
//! ## Switching, and the order that makes it safe
//!
//! An append that arrives after a switch and belongs to the board before it
//! would be written into the wrong log — the one failure this module could have
//! that nothing would notice until the next launch.
//!
//! It is closed on the *frontend* side, and it was closed before this existed —
//! though by a narrower margin than it looks. `crdt/persistence.ts`'s `close()`
//! unsubscribes and **then** awaits `flush()`, and that order is the whole of
//! it: unsubscribing second would leave an edit that landed *during* the flush
//! sitting in `pending` with a timer armed behind it, and that timer would fire
//! against whichever log this module had swapped in by then. Which is this
//! hazard, arriving by the one road that looks safe. `persistence.test.ts` has
//! the case, and it took a mutation to find rather than a reading.
//!
//! `replaceWith` has relied on the same property since T-84. So the order a
//! board switch has to follow is:
//!
//! ```text
//! pack.flushNow()  ->  persistence.close()  ->  board_open  ->  reload
//! ```
//!
//! and it is `persistence.close()` awaiting, not anything here, that makes the
//! third line safe. This module's contribution is that switching is *possible*;
//! it deliberately does not try to make it safe on its own, because a lock here
//! would serialise appends against a switch and then let the append win.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use crate::board::{self, Entry};
use crate::docstore::{self, DocStore};

/// Which board's document is open, and the store for it.
pub struct Workshop {
    /// The data root. Every workshop is under it, and the register's paths are
    /// relative to it — see [`Workshop::switch`] for why that matters.
    root: PathBuf,
    open: RwLock<Option<Open>>,
}

struct Open {
    /// Relative, as the register holds it. Kept so that switching to the board
    /// already open costs nothing.
    workshop: PathBuf,
    store: Arc<DocStore>,
}

impl Workshop {
    /// Nothing is opened yet. `lib.rs` calls [`Workshop::switch`] as soon as the
    /// register says which board this is.
    pub fn new(root: PathBuf) -> Self {
        Workshop {
            root,
            open: RwLock::new(None),
        }
    }

    /// Open this board's workshop, creating it if it is not there.
    ///
    /// Switching to the board that is already open returns the same store
    /// rather than opening a second handle to the same log — which would be two
    /// `Mutex<File>`s over one file, and therefore two locks that do not see
    /// each other. That is not an optimisation; it is the only correct answer.
    pub fn switch(&self, entry: &Entry) -> docstore::Result<Arc<DocStore>> {
        let relative = self.checked(&entry.workshop)?;
        {
            let open = self.read();
            if let Some(current) = open.as_ref() {
                if current.workshop == relative {
                    return Ok(Arc::clone(&current.store));
                }
            }
        }
        // Constructed before the lock is taken for writing, because `new` opens
        // a file and reads its header, and a failure there must leave whatever
        // was open still open. A board that will not open is a board you are
        // told about; it is not a reason to lose the one you are on.
        let store = Arc::new(DocStore::new(self.root.join(&relative))?);
        let mut open = self.write();
        *open = Some(Open {
            workshop: relative,
            store: Arc::clone(&store),
        });
        Ok(store)
    }

    /// The open board's store, for the three document commands.
    ///
    /// `Unavailable` rather than a panic when there is none, on `docstore_of`'s
    /// existing standing: it is the same sentence the frontend already handles,
    /// and `crdt/persistence.ts` turns it into a board that says it is not being
    /// saved rather than a window that has gone.
    pub fn store(&self) -> docstore::Result<Arc<DocStore>> {
        self.read()
            .as_ref()
            .map(|open| Arc::clone(&open.store))
            .ok_or_else(|| {
                docstore::Error::Unavailable("no board is open in this window".into())
            })
    }

    /// Where the open board's workshop is, relative to the data root.
    ///
    /// For a caller that has to say which one it means — the pack flush, which
    /// has to name the board it is a flush *of*.
    pub fn current(&self) -> Option<PathBuf> {
        self.read().as_ref().map(|open| open.workshop.clone())
    }

    /// The register is this application's own file, and this is still checked.
    ///
    /// It is the fourth copy of the argument `board.rs` makes about a board name
    /// and `sync/secret.rs` makes about a file under `secrets/`: the value is
    /// about to be joined onto the data root, so it is checked *here* as well as
    /// where it was read, because this is the line where it becomes a path.
    fn checked(&self, workshop: &Path) -> docstore::Result<PathBuf> {
        if !board::is_workshop(workshop) {
            return Err(docstore::Error::Corrupt(format!(
                "{} is not a workshop",
                workshop.display()
            )));
        }
        Ok(workshop.to_path_buf())
    }

    /// A poisoned lock is a panic somewhere else, and the open board is still
    /// the open board. `board.rs` recovers its own for the same reason.
    fn read(&self) -> std::sync::RwLockReadGuard<'_, Option<Open>> {
        self.open.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Option<Open>> {
        self.open.write().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn entry(board_id: &str, workshop: &str) -> Entry {
        Entry {
            pack_id: board::mint_pack_id(),
            board_id: board_id.to_string(),
            path: None,
            workshop: PathBuf::from(workshop),
            title: String::new(),
            last_opened: 0,
        }
    }

    #[test]
    fn nothing_is_open_until_a_board_is() {
        let dir = tempfile::tempdir().unwrap();
        let workshop = Workshop::new(dir.path().to_path_buf());
        assert!(workshop.current().is_none());
        assert!(matches!(
            workshop.store().map(|_| ()).unwrap_err(),
            docstore::Error::Unavailable(_)
        ));
    }

    /// The whole reason this module exists.
    #[test]
    fn two_switches_give_two_logs_and_neither_sees_the_others_frames() {
        let dir = tempfile::tempdir().unwrap();
        let workshop = Workshop::new(dir.path().to_path_buf());

        let one = workshop.switch(&entry("board-one", "boards/board-one")).unwrap();
        one.append(b"the first board's frame").unwrap();

        let two = workshop.switch(&entry("board-two", "boards/board-two")).unwrap();
        two.append(b"the second board's frame").unwrap();

        // Each holds its own and only its own.
        let first = one.load().unwrap();
        let second = two.load().unwrap();
        assert_eq!(first.updates, vec![b"the first board's frame".to_vec()]);
        assert_eq!(second.updates, vec![b"the second board's frame".to_vec()]);

        // And on disk, which is what would actually be wrong on the next launch.
        assert!(dir.path().join("boards/board-one/log.bin").is_file());
        assert!(dir.path().join("boards/board-two/log.bin").is_file());
    }

    /// Switching back finds what was left there, which is the difference
    /// between switching boards and replacing one.
    #[test]
    fn a_board_switched_away_from_and_back_still_holds_its_work() {
        let dir = tempfile::tempdir().unwrap();
        let workshop = Workshop::new(dir.path().to_path_buf());
        let one = entry("board-one", "boards/board-one");
        let two = entry("board-two", "boards/board-two");

        workshop.switch(&one).unwrap().append(b"drawn here").unwrap();
        workshop.switch(&two).unwrap().append(b"and here").unwrap();

        let back = workshop.switch(&one).unwrap();
        assert_eq!(back.load().unwrap().updates, vec![b"drawn here".to_vec()]);
    }

    /// Two handles on one log are two `Mutex<File>`s that do not see each
    /// other. Returning the same store is the only correct answer, not an
    /// optimisation.
    #[test]
    fn switching_to_the_board_already_open_is_the_same_store() {
        let dir = tempfile::tempdir().unwrap();
        let workshop = Workshop::new(dir.path().to_path_buf());
        let one = entry("board-one", "boards/board-one");

        let first = workshop.switch(&one).unwrap();
        let again = workshop.switch(&one).unwrap();
        assert!(Arc::ptr_eq(&first, &again));

        // The same entry by value rather than by identity, since a second
        // `board_open` of the same board builds a fresh `Entry` from the file.
        let rebuilt = Entry {
            pack_id: board::mint_pack_id(),
            last_opened: 99,
            ..one.clone()
        };
        assert!(Arc::ptr_eq(&first, &workshop.switch(&rebuilt).unwrap()));
    }

    #[test]
    fn the_open_store_is_the_one_the_commands_get() {
        let dir = tempfile::tempdir().unwrap();
        let workshop = Workshop::new(dir.path().to_path_buf());
        let store = workshop.switch(&entry("board-one", "boards/board-one")).unwrap();
        assert!(Arc::ptr_eq(&store, &workshop.store().unwrap()));
        assert_eq!(workshop.current(), Some(PathBuf::from("boards/board-one")));
    }

    /// The adopted pre-T-356 board, whose workshop is `doc/` and stays there.
    #[test]
    fn the_adopted_board_opens_the_document_that_was_already_there() {
        let dir = tempfile::tempdir().unwrap();
        // A log written by the build before this one.
        std::fs::create_dir_all(dir.path().join("doc")).unwrap();
        let before = DocStore::new(dir.path().join("doc")).unwrap();
        before.append(b"from the old build").unwrap();
        drop(before);

        let workshop = Workshop::new(dir.path().to_path_buf());
        let store = workshop
            .switch(&entry("board-legacy", board::LEGACY_WORKSHOP))
            .unwrap();
        assert_eq!(
            store.load().unwrap().updates,
            vec![b"from the old build".to_vec()]
        );
        // Not under `boards/`. It never moves.
        assert!(!dir.path().join("boards").exists());
    }

    /// The line where a value out of the register becomes a path.
    #[test]
    fn a_workshop_that_is_not_a_relative_name_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let workshop = Workshop::new(dir.path().to_path_buf());
        for escape in ["../elsewhere", "boards/../../elsewhere", ""] {
            let error = workshop
                .switch(&entry("board-one", escape))
                .map(|_| ())
                .unwrap_err();
            assert!(
                matches!(error, docstore::Error::Corrupt(_)),
                "{escape:?} gave {error}"
            );
        }
        // Nothing was opened on the way to finding out.
        assert!(workshop.current().is_none());
    }

    /// A board that will not open is a board you are told about. It is not a
    /// reason to lose the one you are on.
    #[test]
    fn a_board_that_cannot_be_opened_leaves_the_open_one_open() {
        let dir = tempfile::tempdir().unwrap();
        let workshop = Workshop::new(dir.path().to_path_buf());
        let good = entry("board-one", "boards/board-one");
        let store = workshop.switch(&good).unwrap();
        store.append(b"still here").unwrap();

        // A file where the workshop's directory needs to be, which is the
        // portable way to make `create_dir_all` fail.
        std::fs::write(dir.path().join("occupied"), b"in the way").unwrap();
        assert!(workshop
            .switch(&entry("board-two", "occupied"))
            .is_err());

        assert_eq!(workshop.current(), Some(PathBuf::from("boards/board-one")));
        assert!(Arc::ptr_eq(&store, &workshop.store().unwrap()));
        assert_eq!(
            workshop.store().unwrap().load().unwrap().updates,
            vec![b"still here".to_vec()]
        );
    }
}
