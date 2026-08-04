//! Which boards this installation knows about.
//!
//! This file used to hold one string — the board id, which is the *sync room*
//! and never the document — because a board was a thing you only ever had one
//! of. `docstore.rs` said what would end that:
//!
//! > One document per installation for now. Bundles (T-84) are how a board
//! > becomes a file you can hand to someone; **multi-board arrives with them**.
//!
//! They have arrived (T-356). A board is a `.schizo` at a path the user chose,
//! and this module is the register: which boards there are, which room each one
//! is in, where each one's workshop is, and which is open now.
//!
//! ## The key is a pack id, and not a path
//!
//! The obvious key is the file's path, and it is wrong in a way nothing
//! announces. A board renamed, or dragged into another folder, is a path this
//! register has never seen — so it would mint a fresh board id under Q-114 and
//! **silently leave its sync room**. The person who renamed a file would find
//! their collaborator gone and nothing on screen would say why.
//!
//! So the key is a `packId` carried in `manifest.json`: 128 bits naming *the
//! file*, minted when a pack is first written and never changed while it is
//! rewritten in place.
//!
//! ## Why a pack id may travel where a board id may not
//!
//! The section below this one used to be the whole of this file's argument, and
//! it still stands — but it is now sharper, because there is a counter-example
//! sitting beside it that has to be explained rather than waved at.
//!
//! A **board id** is not in the document and must not be, on two grounds. It
//! would sync, and it is the one value that separates this window from the peers
//! it has left. And it would arrive *inside the bundle*: every machine opening
//! that file would adopt the exporter's id and expect to be in their room.
//!
//! A **pack id** is in the file and is safe there, because it is neither of
//! those things. It is not a room name — it never reaches `sync/`, never becomes
//! a file under `secrets/` and never goes on the wire. It is not a secret — it
//! grants nothing, and a stranger holding it can do exactly what a stranger
//! holding the file could already do. It says only *which file this is*, which
//! is a fact about the file and therefore belongs to it.
//!
//! **Q-114 survives verbatim**, which is the test of the whole design: a pack id
//! this register has never seen mints a fresh board id, so a `.schizo` somebody
//! sends you does not put you in their room; a pack id it has keeps its room, so
//! your own board is still yours however often it moves.
//!
//! And the corollary, which is the rule that stops two files sharing one room:
//! **a flush preserves the pack id; a copy mints one.** `bundle_save_as` is a
//! copy.
//!
//! ## What this does not do
//!
//! It does not clean up after itself, and the reasoning is the one this file
//! carried before. A board that is forgotten leaves its secret behind in
//! `secrets/` — 32 bytes naming a room. Deleting it would be tidier and is not
//! obviously safe: the same name may be one this machine is later invited back
//! to, and there is no cost to being wrong in this direction.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::sync::secret::is_board_name;

/// 128 bits, as 32 hex characters — `sync/secret.rs`'s shape, for the same
/// reason: it is long enough that two boards never collide by accident, and
/// there is nothing to parse.
const PACK_ID_BYTES: usize = 16;

/// What a board id looks like when this side mints one.
///
/// The prefix is `app/sync.ts`'s, kept because the value's next stop is a room
/// name on the wire and a file under `secrets/`, and a name that says what it is
/// is worth the six characters in a log.
const BOARD_ID_PREFIX: &str = "board-";

/// The workshop of a board adopted from before T-356.
///
/// It stays `doc/` **forever**, which is the whole of the migration's safety
/// argument: moving a document is the one operation that can lose it, and a
/// field in this register costs less than a rename that half-succeeds. It also
/// means reverting T-356 leaves `DocStore::new(data.join("doc"))` finding the
/// same log, byte for byte.
pub const LEGACY_WORKSHOP: &str = "doc";

/// Where every board minted after T-356 keeps its log and snapshot, under the
/// data root.
const WORKSHOP_ROOT: &str = "boards";

/// A register is a few hundred bytes per board. Past this it is not a register
/// being parsed, it is a parser being fed — `bundle.rs`'s constants carry the
/// same sentence and it means the same thing here.
const MAX_REGISTER_BYTES: u64 = 8 * 1024 * 1024;

/// The file's own shape, so a later version can be told from this one without
/// guessing. Nothing reads it yet; it is here because adding it afterwards
/// means guessing.
const REGISTER_VERSION: u32 = 1;

/// One board this installation knows about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Names the *file*, never the room. See the module note for why this one
    /// may live inside the pack and `board_id` may not.
    pub pack_id: String,
    /// The sync room. Minted here on first sight of a `pack_id`, kept for every
    /// re-open (T-195, Q-114). Never written to the pack.
    pub board_id: String,
    /// `None` for a board that has never been given a home — the adopted
    /// pre-T-356 document, and the only way an entry can lack one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    /// Relative to the data root. Recorded rather than derived, so that the
    /// adopted board's workshop is never moved. See [`LEGACY_WORKSHOP`].
    pub workshop: PathBuf,
    pub title: String,
    /// Epoch seconds. Only ever used to order the list.
    pub last_opened: u64,
}

impl Entry {
    /// Whether this board has a file of its own yet.
    pub fn homed(&self) -> bool {
        self.path.is_some()
    }
}

/// The file, as it is written down.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Register {
    #[serde(default)]
    version: u32,
    /// The `pack_id` of the board this window opens. `None` on an installation
    /// that has never opened one, which resolves to the same nothing
    /// `BoardStore::get` used to resolve to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    current: Option<String>,
    #[serde(default)]
    boards: Vec<Entry>,
}

/// `boards.json`, and the lock around it.
///
/// The same standing [`crate::sync::secret::SecretStore`] is on: anything that
/// does not read as a register is treated as though it were not there. What is
/// *not* the same is what happens to the unreadable file — a secret can be
/// regenerated and a list of boards cannot, so it is renamed aside rather than
/// overwritten. The boards themselves are still on the disk; what has been lost
/// is only the knowledge of where.
pub struct BoardStore {
    path: PathBuf,
    state: Mutex<Register>,
}

impl BoardStore {
    /// `path` is the file itself. Its directory is created if it is missing, so
    /// this can be constructed before anything else has touched the data root.
    pub fn new(path: PathBuf) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let state = read_register(&path);
        Ok(BoardStore {
            path,
            state: Mutex::new(state),
        })
    }

    /// Every board, most recently opened first.
    pub fn list(&self) -> Vec<Entry> {
        let state = self.lock();
        let mut boards = state.boards.clone();
        boards.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
        boards
    }

    /// The board this window is on.
    pub fn current(&self) -> Option<Entry> {
        let state = self.lock();
        let current = state.current.as_deref()?;
        state.boards.iter().find(|e| e.pack_id == current).cloned()
    }

    /// The entry for this pack id, if this installation has one.
    pub fn find(&self, pack_id: &str) -> Option<Entry> {
        let state = self.lock();
        state.boards.iter().find(|e| e.pack_id == pack_id).cloned()
    }

    /// The entry whose file is at this path, if there is one.
    ///
    /// **A fallback, and never the key** — the module note above is about why
    /// keying on the path would silently drop a renamed board out of its sync
    /// room. Its one caller is a `.schizo` written before T-359, which carries no
    /// pack id at all: without this, opening the same old export twice would mint
    /// a second id for it and the register would hold two boards where the disk
    /// holds one. The first flush writes an id into the file and nothing consults
    /// this again.
    pub fn by_path(&self, path: &Path) -> Option<Entry> {
        let state = self.lock();
        state
            .boards
            .iter()
            .find(|e| e.path.as_deref() == Some(path))
            .cloned()
    }

    /// The entry for this pack, minting a board id if it is new here.
    ///
    /// **This is Q-114, and it is the whole design in four lines.** A pack id
    /// this register has never seen is a board this window has never been in the
    /// room of, so it gets a room of its own; one it has seen keeps the room it
    /// had, however far the file has moved since.
    ///
    /// The path and the title are refreshed on every call, because both are
    /// facts about the file that this register is merely remembering — the file
    /// is where it is, and its title is whatever the manifest now says.
    pub fn admit(&self, pack_id: &str, path: &Path, title: &str) -> io::Result<Entry> {
        if !is_pack_id(pack_id) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{pack_id:?} is not a pack id"),
            ));
        }
        let mut state = self.lock();
        let entry = match state.boards.iter_mut().find(|e| e.pack_id == pack_id) {
            Some(existing) => {
                existing.path = Some(path.to_path_buf());
                existing.title = title.to_string();
                existing.clone()
            }
            none => {
                drop(none);
                let board_id = mint_board_id();
                let entry = Entry {
                    pack_id: pack_id.to_string(),
                    workshop: workshop_for(&board_id),
                    board_id,
                    path: Some(path.to_path_buf()),
                    title: title.to_string(),
                    last_opened: 0,
                };
                state.boards.push(entry.clone());
                entry
            }
        };
        write_register(&self.path, &state)?;
        Ok(entry)
    }

    /// This is the board from now on.
    ///
    /// Stamps `last_opened`, which is the only thing that orders the list, so
    /// this is also what makes the recents a recents.
    pub fn open(&self, pack_id: &str) -> io::Result<Option<Entry>> {
        let mut state = self.lock();
        let Some(entry) = state.boards.iter_mut().find(|e| e.pack_id == pack_id) else {
            return Ok(None);
        };
        entry.last_opened = now();
        let entry = entry.clone();
        state.current = Some(entry.pack_id.clone());
        write_register(&self.path, &state)?;
        Ok(Some(entry))
    }

    /// A board that had no file now has one — the migration's last step.
    pub fn set_home(&self, pack_id: &str, path: &Path) -> io::Result<()> {
        self.amend(pack_id, |entry| entry.path = Some(path.to_path_buf()))
    }

    /// What the board calls itself, for the menu.
    pub fn set_title(&self, pack_id: &str, title: &str) -> io::Result<()> {
        self.amend(pack_id, |entry| entry.title = title.to_string())
    }

    /// Drop a board from the register.
    ///
    /// **Its room goes with it**, which is the cost worth stating: reopening
    /// that file mints a fresh board id and it is no longer where its
    /// collaborators are. Nothing on disk is deleted — the pack and the
    /// workshop both survive.
    pub fn forget(&self, pack_id: &str) -> io::Result<()> {
        let mut state = self.lock();
        state.boards.retain(|e| e.pack_id != pack_id);
        if state.current.as_deref() == Some(pack_id) {
            state.current = None;
        }
        write_register(&self.path, &state)
    }

    /// Take up a data directory from before T-356.
    ///
    /// A document at `doc/` and no register at all. It is adopted **in place**:
    /// the entry records `workshop: "doc"` and no path, so the log stays exactly
    /// where it is and this change stays reversible. The board id comes from the
    /// old `board-id` file, so a collaboration that is live right now is not
    /// dropped by the upgrade.
    ///
    /// Does nothing if the register already has boards in it, or if there is no
    /// document to adopt. Both are the ordinary case on the second launch.
    pub fn adopt_legacy(&self, data_root: &Path) -> io::Result<Option<Entry>> {
        {
            let state = self.lock();
            if !state.boards.is_empty() {
                return Ok(None);
            }
        }
        if !data_root.join(LEGACY_WORKSHOP).is_dir() {
            return Ok(None);
        }
        let board_id = legacy_board_id(&data_root.join("board-id")).unwrap_or_else(mint_board_id);
        let entry = Entry {
            pack_id: mint_pack_id(),
            board_id,
            path: None,
            workshop: PathBuf::from(LEGACY_WORKSHOP),
            // Rust holds no schema and cannot read `meta.title` (ARCHITECTURE
            // section 4.2). The frontend replaces this the moment it has the
            // document open, which is before anybody sees a menu.
            title: String::new(),
            last_opened: now(),
        };
        let mut state = self.lock();
        state.current = Some(entry.pack_id.clone());
        state.boards.push(entry.clone());
        write_register(&self.path, &state)?;
        Ok(Some(entry))
    }

    /// A board that has never existed anywhere before — *New board…*.
    ///
    /// It has **no home**: it is a board before it is a file, exactly as an
    /// adopted one is, and the same row gives it one (`board_home`). What it does
    /// have is a workshop, because the alternative to a workshop is a window with
    /// nothing to write to.
    ///
    /// Minted without becoming current, because a board whose workshop will not
    /// open is not a board this window may be moved onto — see `board_new`, which
    /// takes it back out of the register when that happens.
    pub fn mint(&self) -> io::Result<Entry> {
        let board_id = mint_board_id();
        let entry = Entry {
            pack_id: mint_pack_id(),
            workshop: workshop_for(&board_id),
            board_id,
            path: None,
            title: String::new(),
            last_opened: now(),
        };
        let mut state = self.lock();
        state.boards.push(entry.clone());
        write_register(&self.path, &state)?;
        Ok(entry)
    }

    /// A board to be on, whatever else has happened.
    ///
    /// [`Self::adopt_legacy`] answers for a data directory from before T-356.
    /// This answers for the other two ways of arriving with no board: an
    /// installation that has never been launched at all, and one whose register
    /// was set aside because it could not be read.
    pub fn ensure_current(&self) -> io::Result<Entry> {
        if let Some(entry) = self.current() {
            return Ok(entry);
        }
        let entry = self.mint()?;
        // `mint` does not make a board current, and here it has to be: this is
        // the boot path, and the alternative to being on this one is being on
        // none at all.
        self.open(&entry.pack_id)
            .map(|opened| opened.unwrap_or(entry))
    }

    /// The room the open board is in, for `board_remembered`.
    ///
    /// The one method that survives from the version of this file that held a
    /// single string, with the same signature and the same meaning, so that
    /// `app/invite.ts` and `app/sync.ts` do not change at all.
    pub fn get(&self) -> Option<String> {
        self.current().map(|entry| entry.board_id)
    }

    fn amend(&self, pack_id: &str, change: impl FnOnce(&mut Entry)) -> io::Result<()> {
        let mut state = self.lock();
        let Some(entry) = state.boards.iter_mut().find(|e| e.pack_id == pack_id) else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("no board {pack_id:?}"),
            ));
        };
        change(entry);
        write_register(&self.path, &state)
    }

    /// A poisoned lock is a panic somewhere else, and the register is still the
    /// register. Recovering it beats taking the whole shell down over a board
    /// list.
    fn lock(&self) -> std::sync::MutexGuard<'_, Register> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// --- reading and writing ----------------------------------------------------

/// The register, or an empty one.
///
/// Every way of failing lands on "empty", and the one that is not merely absent
/// takes the file out of the way first. See [`BoardStore`]'s note.
fn read_register(path: &Path) -> Register {
    let Ok(meta) = fs::metadata(path) else {
        return Register::default();
    };
    if meta.len() > MAX_REGISTER_BYTES {
        set_aside(path);
        return Register::default();
    }
    let Ok(raw) = fs::read(path) else {
        return Register::default();
    };
    match serde_json::from_slice::<Register>(&raw) {
        Ok(register) => repair(register),
        Err(_) => {
            set_aside(path);
            Register::default()
        }
    }
}

/// What a parsed register has to be true of before anything is allowed to
/// believe it.
///
/// Validated on the way *out* of the file rather than trusted, which is the
/// rule the single-string version of this module already followed: the values
/// leave here and become a room name on the wire, a file name under `secrets/`
/// and a directory under the data root. This is the first of several checks and
/// it is the one that decides whether the file is worth anything at all.
fn repair(mut register: Register) -> Register {
    let mut seen = std::collections::HashSet::new();
    register.boards.retain_mut(|entry| {
        if !is_pack_id(&entry.pack_id) || !seen.insert(entry.pack_id.clone()) {
            return false;
        }
        // A board id that is not one is *re-minted* rather than dropped, and the
        // difference matters: dropping the entry would lose the board, where
        // re-minting it loses only the room — the same thing that happens to a
        // board this installation has never opened.
        if !is_board_name(&entry.board_id) {
            entry.board_id = mint_board_id();
            entry.workshop = workshop_for(&entry.board_id);
        }
        if !is_workshop(&entry.workshop) {
            entry.workshop = workshop_for(&entry.board_id);
        }
        true
    });
    if register
        .current
        .as_ref()
        .is_some_and(|current| !register.boards.iter().any(|e| &e.pack_id == current))
    {
        register.current = None;
    }
    register
}

/// Move an unreadable register out of the way, keeping it.
///
/// Overwriting it would be the tidy thing and the wrong one. A register names
/// the rooms every board on this machine is in, and those cannot be recovered
/// from anything — the boards themselves are still on disk, so what is at stake
/// is one file's worth of knowledge that nothing else holds a copy of.
fn set_aside(path: &Path) {
    let aside = path.with_extension(format!("unreadable.{}", std::process::id()));
    if fs::rename(path, &aside).is_err() {
        // Nothing else to try, and nothing to be done about it. The register
        // reads as empty either way, which is the outcome this function exists
        // to make safe rather than to prevent.
        eprintln!("board: {} could not be read or set aside", path.display());
    }
}

fn write_register(path: &Path, register: &Register) -> io::Result<()> {
    let mut register = register.clone();
    register.version = REGISTER_VERSION;
    let json = serde_json::to_vec_pretty(&register)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    write_atomic(path, &json)
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

// --- names ------------------------------------------------------------------

/// A new id for a file.
///
/// `getrandom` for `sync/secret.rs`'s reason: the CSPRNG the OS already has,
/// and nothing that anybody could later reach for the fast version of by
/// mistake.
pub fn mint_pack_id() -> String {
    let mut bytes = [0u8; PACK_ID_BYTES];
    getrandom::fill(&mut bytes).expect("the operating system should have randomness");
    bytes.iter().fold(String::new(), |mut out, byte| {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
        out
    })
}

/// A new room.
///
/// The mint moved here from `app/sync.ts`'s `freshBoardId` under T-356, because
/// it is the *register* that knows whether this pack has been seen before, and
/// a mint made anywhere else is a mint made without that answer.
pub fn mint_board_id() -> String {
    format!("{BOARD_ID_PREFIX}{}", mint_pack_id())
}

/// Whether a string out of a manifest is a pack id.
///
/// It never becomes a path and never reaches `sync/`, so this is not load
/// bearing the way [`is_board_name`] is. It is here because the value arrives
/// from a file somebody else wrote and becomes a key in this register, and a key
/// that can be any string at all is a key that can be one already in use.
pub fn is_pack_id(id: &str) -> bool {
    id.len() == PACK_ID_BYTES * 2
        && id
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase())
}

fn workshop_for(board_id: &str) -> PathBuf {
    Path::new(WORKSHOP_ROOT).join(board_id)
}

/// Whether a workshop out of the register may be joined onto the data root.
///
/// The register is this application's own file, so this is defence in depth
/// rather than a door — but it is the one field here that *does* become a path,
/// and `bundle.rs`'s module note is about exactly what happens when a name from
/// a file is joined onto one.
///
/// Public because `workshop.rs` checks it again at the line where the value
/// actually becomes a path, on the standing `is_board_name` is on: this is the
/// first of two, not the only one.
pub fn is_workshop(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

/// The board id from before T-356, if there is one worth having.
///
/// The file is left where it is. Reading it is the whole of what this change
/// needs from it, and deleting it would remove the one thing that makes the
/// adoption reversible.
fn legacy_board_id(path: &Path) -> Option<String> {
    let stored = fs::read_to_string(path).ok()?;
    let name = stored.trim();
    is_board_name(name).then(|| name.to_string())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, BoardStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = BoardStore::new(dir.path().join("boards.json")).unwrap();
        (dir, store)
    }

    fn pack(dir: &tempfile::TempDir, name: &str) -> PathBuf {
        dir.path().join(name)
    }

    #[test]
    fn an_installation_nobody_has_moved_is_on_no_particular_board() {
        let (_dir, store) = store();
        assert_eq!(store.get(), None);
        assert_eq!(store.current(), None);
        assert!(store.list().is_empty());
    }

    /// Q-114, the first direction: a `.schizo` somebody sent you is a pack this
    /// register has never seen, so it does not put you in their room.
    #[test]
    fn a_pack_this_machine_has_never_seen_mints_a_room_of_its_own() {
        let (dir, store) = store();
        let mine = store
            .admit(&mint_pack_id(), &pack(&dir, "mine.schizo"), "Mine")
            .unwrap();
        let theirs = store
            .admit(&mint_pack_id(), &pack(&dir, "theirs.schizo"), "Theirs")
            .unwrap();
        assert_ne!(mine.board_id, theirs.board_id);
        assert!(is_board_name(&mine.board_id));
        assert!(is_board_name(&theirs.board_id));
        // And two boards never share a workshop, or one would be reading the
        // other's log.
        assert_ne!(mine.workshop, theirs.workshop);
    }

    /// Q-114, the other direction, and **the test the whole design rests on**.
    ///
    /// The key is the pack id rather than the path precisely so that this is
    /// true. Keyed on the path, renaming a board would mint a fresh room and
    /// the person who renamed it would find their collaborator gone with
    /// nothing on screen saying why.
    #[test]
    fn a_pack_that_has_moved_keeps_its_room() {
        let (dir, store) = store();
        let id = mint_pack_id();
        let before = store
            .admit(&id, &pack(&dir, "case one.schizo"), "Case one")
            .unwrap();
        let after = store
            .admit(&id, &pack(&dir, "archive/renamed.schizo"), "Case one")
            .unwrap();

        assert_eq!(before.board_id, after.board_id);
        assert_eq!(before.workshop, after.workshop);
        // The register followed the file rather than the other way round.
        assert_eq!(after.path, Some(pack(&dir, "archive/renamed.schizo")));
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn a_board_and_its_room_survive_a_relaunch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("boards.json");
        let id = mint_pack_id();

        let board_id = {
            let store = BoardStore::new(path.clone()).unwrap();
            let entry = store.admit(&id, &pack(&dir, "a.schizo"), "A").unwrap();
            store.open(&id).unwrap();
            entry.board_id
        };

        let store = BoardStore::new(path).unwrap();
        assert_eq!(store.get().as_deref(), Some(board_id.as_str()));
        assert_eq!(store.current().unwrap().pack_id, id);
    }

    #[test]
    fn the_list_is_most_recently_opened_first() {
        let (dir, store) = store();
        let first = mint_pack_id();
        let second = mint_pack_id();
        store
            .admit(&first, &pack(&dir, "first.schizo"), "First")
            .unwrap();
        store
            .admit(&second, &pack(&dir, "second.schizo"), "Second")
            .unwrap();

        store.open(&first).unwrap();
        // `last_opened` is in seconds, so two opens inside one tick would tie
        // and the order would be whatever `sort_by` happened to do. Stamped
        // apart deliberately rather than by sleeping.
        store
            .amend(&second, |entry| entry.last_opened = now() + 1)
            .unwrap();

        let listed: Vec<String> = store.list().into_iter().map(|e| e.pack_id).collect();
        assert_eq!(listed, vec![second, first]);
    }

    #[test]
    fn opening_a_board_nobody_has_heard_of_is_not_an_error() {
        let (_dir, store) = store();
        assert_eq!(store.open(&mint_pack_id()).unwrap(), None);
        assert_eq!(store.current(), None);
    }

    /// The value arrives from a file this machine did not write.
    #[test]
    fn a_pack_id_that_is_not_one_is_refused_rather_than_kept() {
        let (dir, store) = store();
        for rubbish in [
            "",
            "..",
            "../secrets",
            "a/b",
            &"f".repeat(63),
            &"F".repeat(32),
            "not hex at all, no",
        ] {
            assert!(
                store.admit(rubbish, &pack(&dir, "x.schizo"), "X").is_err(),
                "{rubbish:?} was admitted"
            );
        }
        assert!(store.list().is_empty());
    }

    /// Half a write, a stray editor, somebody's idea of a helpful comment. The
    /// single-string version of this module read all of those as "nobody has
    /// said"; this one reads them the same way and **keeps the file**.
    #[test]
    fn an_unreadable_register_reads_as_empty_and_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("boards.json");
        fs::write(&path, b"{ this is not json").unwrap();

        let store = BoardStore::new(path.clone()).unwrap();
        assert!(store.list().is_empty());
        assert_eq!(store.get(), None);

        // Not overwritten. The boards are still on the disk; what was lost is
        // the knowledge of which rooms they are in, and nothing else holds a
        // copy of that.
        assert!(!path.exists());
        let strays: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("unreadable"))
            .collect();
        assert_eq!(strays.len(), 1, "{strays:?}");
    }

    /// An entry whose room is not a name is re-minted rather than dropped,
    /// because dropping it would lose the board and re-minting loses only the
    /// room — which is what a board this machine has never opened gets anyway.
    #[test]
    fn an_entry_whose_board_id_is_not_a_name_is_re_minted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("boards.json");
        let id = mint_pack_id();
        fs::write(
            &path,
            format!(
                r#"{{"version":1,"current":"{id}","boards":[
                    {{"packId":"{id}","boardId":"../secrets","workshop":"boards/x",
                      "title":"Still a board","lastOpened":7}}]}}"#
            ),
        )
        .unwrap();

        let store = BoardStore::new(path).unwrap();
        let entry = store.current().expect("the board survived");
        assert_eq!(entry.pack_id, id);
        assert_eq!(entry.title, "Still a board");
        assert!(is_board_name(&entry.board_id));
        // And the workshop follows the new name, or it would keep pointing at
        // the log of a board that no longer has that id.
        assert_eq!(entry.workshop, workshop_for(&entry.board_id));
    }

    /// The one field in this file that becomes a path.
    #[test]
    fn a_workshop_that_is_not_a_relative_name_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("boards.json");
        let id = mint_pack_id();
        for escape in ["../../elsewhere", "/etc", "", "boards/../.."] {
            fs::write(
                &path,
                format!(
                    r#"{{"version":1,"boards":[{{"packId":"{id}","boardId":"board-one",
                       "workshop":"{escape}","title":"X","lastOpened":1}}]}}"#
                ),
            )
            .unwrap();
            let store = BoardStore::new(path.clone()).unwrap();
            let entry = &store.list()[0];
            assert!(is_workshop(&entry.workshop), "{escape:?} survived");
        }
    }

    #[test]
    fn a_register_naming_a_board_it_does_not_hold_is_on_no_board() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("boards.json");
        fs::write(
            &path,
            format!(r#"{{"version":1,"current":"{}","boards":[]}}"#, mint_pack_id()),
        )
        .unwrap();
        let store = BoardStore::new(path).unwrap();
        assert_eq!(store.current(), None);
        assert_eq!(store.get(), None);
    }

    #[test]
    fn the_same_pack_listed_twice_is_one_board() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("boards.json");
        let id = mint_pack_id();
        fs::write(
            &path,
            format!(
                r#"{{"version":1,"boards":[
                    {{"packId":"{id}","boardId":"board-one","workshop":"boards/board-one",
                      "title":"First","lastOpened":1}},
                    {{"packId":"{id}","boardId":"board-two","workshop":"boards/board-two",
                      "title":"Second","lastOpened":2}}]}}"#
            ),
        )
        .unwrap();
        let store = BoardStore::new(path).unwrap();
        let boards = store.list();
        assert_eq!(boards.len(), 1);
        assert_eq!(boards[0].title, "First");
    }

    // --- adoption -----------------------------------------------------------

    /// The upgrade path, and the one thing in T-356 that must not go wrong.
    #[test]
    fn a_data_directory_from_before_this_change_adopts_its_board_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        fs::create_dir_all(data.join("doc")).unwrap();
        fs::write(data.join("doc").join("log.bin"), b"SZBDLOG1").unwrap();
        fs::write(data.join("board-id"), "board-abc123\r\n").unwrap();

        let store = BoardStore::new(data.join("boards.json")).unwrap();
        let entry = store.adopt_legacy(data).unwrap().expect("adopted");

        // The room it was already in, so a collaboration that is live right now
        // is not dropped by the upgrade.
        assert_eq!(entry.board_id, "board-abc123");
        // In place. Not `boards/<id>/doc`.
        assert_eq!(entry.workshop, PathBuf::from(LEGACY_WORKSHOP));
        assert!(!entry.homed());
        assert_eq!(store.current().unwrap().pack_id, entry.pack_id);

        // And nothing moved. This is the assertion that makes T-356 reversible:
        // an older binary still finds the same log, byte for byte.
        assert!(data.join("doc").join("log.bin").is_file());
        assert!(data.join("board-id").is_file());
    }

    #[test]
    fn an_installation_with_no_document_adopts_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = BoardStore::new(dir.path().join("boards.json")).unwrap();
        assert_eq!(store.adopt_legacy(dir.path()).unwrap(), None);
        assert!(store.list().is_empty());
    }

    #[test]
    fn adoption_happens_once() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        fs::create_dir_all(data.join("doc")).unwrap();

        let store = BoardStore::new(data.join("boards.json")).unwrap();
        let first = store.adopt_legacy(data).unwrap().expect("adopted");
        assert_eq!(store.adopt_legacy(data).unwrap(), None);
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.current().unwrap().pack_id, first.pack_id);
    }

    /// A pre-T-356 installation that never opened a bundle has no `board-id`
    /// file at all, and `app/sync.ts` resolved that to `DEFAULT_BOARD`. It gets
    /// a minted room here instead, which is a *different room from the one it
    /// was in* — worth a test saying so out loud rather than a surprise.
    #[test]
    fn an_adopted_board_with_no_remembered_room_is_given_one() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        fs::create_dir_all(data.join("doc")).unwrap();

        let store = BoardStore::new(data.join("boards.json")).unwrap();
        let entry = store.adopt_legacy(data).unwrap().expect("adopted");
        assert!(is_board_name(&entry.board_id));
        assert_ne!(entry.board_id, "board");
    }

    // --- amendments ---------------------------------------------------------

    #[test]
    fn a_board_that_had_no_file_gets_one() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        fs::create_dir_all(data.join("doc")).unwrap();
        let store = BoardStore::new(data.join("boards.json")).unwrap();
        let entry = store.adopt_legacy(data).unwrap().unwrap();
        assert!(!entry.homed());

        let home = data.join("Untitled board.schizo");
        store.set_home(&entry.pack_id, &home).unwrap();
        store.set_title(&entry.pack_id, "Untitled board").unwrap();

        let entry = store.current().unwrap();
        assert!(entry.homed());
        assert_eq!(entry.path, Some(home));
        assert_eq!(entry.title, "Untitled board");
        // The workshop does not follow the home. It never moves.
        assert_eq!(entry.workshop, PathBuf::from(LEGACY_WORKSHOP));
    }

    #[test]
    fn amending_a_board_nobody_has_heard_of_is_an_error() {
        let (dir, store) = store();
        let error = store.set_home(&mint_pack_id(), &pack(&dir, "x.schizo"));
        assert_eq!(error.unwrap_err().kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn a_forgotten_board_leaves_the_register_and_nothing_else() {
        let (dir, store) = store();
        let id = mint_pack_id();
        let home = pack(&dir, "gone.schizo");
        fs::write(&home, b"a pack").unwrap();
        store.admit(&id, &home, "Gone").unwrap();
        store.open(&id).unwrap();

        store.forget(&id).unwrap();
        assert!(store.list().is_empty());
        assert_eq!(store.current(), None);
        // Nothing on disk was deleted — this is a register, not a bin.
        assert!(home.is_file());
    }

    // --- minting and finding -------------------------------------------------

    /// *New board…*: a board before it is a file, and not the one this window is
    /// on until somebody says so.
    #[test]
    fn a_minted_board_has_a_workshop_and_no_home_and_is_not_current() {
        let (_dir, store) = store();
        let entry = store.mint().unwrap();

        assert!(is_board_name(&entry.board_id));
        assert_eq!(entry.workshop, workshop_for(&entry.board_id));
        assert!(!entry.homed());
        // In the register, and not underfoot: `board_new` switches the workshop
        // before it commits to the board, and a mint that made itself current
        // would leave the window on a board that then failed to open.
        assert_eq!(store.current(), None);
        assert_eq!(store.list().len(), 1);

        let second = store.mint().unwrap();
        assert_ne!(entry.pack_id, second.pack_id);
        assert_ne!(entry.workshop, second.workshop);
    }

    #[test]
    fn a_board_can_be_looked_up_by_the_id_this_side_issued() {
        let (dir, store) = store();
        let id = mint_pack_id();
        store.admit(&id, &pack(&dir, "one.schizo"), "One").unwrap();

        assert_eq!(store.find(&id).unwrap().title, "One");
        assert_eq!(store.find(&mint_pack_id()), None);
    }

    /// The fallback for a `.schizo` written before pack ids existed. Keyed on
    /// the path *here only*, so that opening the same old export twice is one
    /// board rather than two.
    #[test]
    fn a_pack_with_no_id_of_its_own_is_found_again_by_where_it_is() {
        let (dir, store) = store();
        let old = pack(&dir, "before-t359.schizo");
        let id = mint_pack_id();
        store.admit(&id, &old, "An old export").unwrap();

        assert_eq!(store.by_path(&old).unwrap().pack_id, id);
        assert_eq!(store.by_path(&pack(&dir, "elsewhere.schizo")), None);
        // A board that has never been given a file is not at any path, so it can
        // never be found by this and answer for another one.
        store.mint().unwrap();
        assert_eq!(store.by_path(Path::new("")), None);
    }

    // --- names --------------------------------------------------------------

    #[test]
    fn a_pack_id_is_thirty_two_lowercase_hex_characters() {
        let id = mint_pack_id();
        assert_eq!(id.len(), PACK_ID_BYTES * 2);
        assert!(is_pack_id(&id));
        assert_ne!(id, mint_pack_id());
    }

    /// It becomes a room name on the wire and a file under `secrets/` on the
    /// very next launch, so it has to pass the strictest of the three copies of
    /// that rule and not merely look plausible.
    #[test]
    fn a_minted_board_id_is_a_board_name() {
        let id = mint_board_id();
        assert!(is_board_name(&id));
        assert!(id.starts_with(BOARD_ID_PREFIX));
        assert_ne!(id, mint_board_id());
    }
}
