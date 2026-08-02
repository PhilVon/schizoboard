//! The append-only document log.
//!
//! > **Document log.** Append-only, length-prefixed opaque frames, flushed on a
//! > batch. Rust doesn't need a Yjs implementation for this — it appends bytes.
//! > The frontend periodically emits a snapshot and Rust atomically swaps it in
//! > and truncates the log. — docs/ARCHITECTURE.md section 4.1
//!
//! Nothing in this file knows what an item, a pin or a string is, and nothing
//! in it can decode a frame. A frame is bytes with a length and a checksum, and
//! the only questions this module can answer about one are "is it whole?" and
//! "what order did it arrive in?". That is section 4.2 again — Rust owns bytes,
//! the frontend owns meaning — and it is why there is no Yjs implementation
//! here to keep in step with the schema.
//!
//! ## Layout
//!
//! ```text
//! doc/snapshot.bin   the whole document as of the last compaction
//! doc/log.bin        SZBDLOG1 followed by every frame appended since
//! ```
//!
//! One document per installation for now. Bundles (T-84) are how a board
//! becomes a file you can hand to someone; multi-board arrives with them.
//!
//! ## The two crash windows
//!
//! **Mid-append.** A frame carries its length and a checksum of its payload, so
//! a half-written tail is detectable rather than something the frontend gets
//! handed as if it were a document. [`DocStore::load`] stops at the first frame
//! that does not add up, keeps everything before it, and truncates the file
//! there — because leaving the wreckage in place would put every later append
//! behind bytes nothing can get past.
//!
//! **Mid-compaction.** The snapshot is written and renamed into place *before*
//! the log is truncated, never the other way round. Dying between the two
//! leaves a snapshot plus a log of updates the snapshot already contains, and
//! applying an update twice is something Yjs does not mind at all. Dying
//! between them in the other order would lose every edit since the last
//! compaction, which is most of a session.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

const LOG_FILE: &str = "log.bin";
const SNAPSHOT_FILE: &str = "snapshot.bin";

/// First bytes of `log.bin`. Present so a file that is not ours — a stale
/// format, someone else's data, a half-restored backup — is refused instead of
/// being read as frames and then appended to.
const MAGIC: &[u8; 8] = b"SZBDLOG1";

/// `[u32 length][u64 checksum]`, little-endian.
const FRAME_HEADER: usize = 12;

/// One batch, ceiling. The frontend coalesces at roughly 32 kB, so this is
/// three orders of magnitude of headroom and exists only so that a length read
/// out of corrupt bytes cannot ask for a 4 GB allocation.
const MAX_FRAME_BYTES: u64 = 64 * 1024 * 1024;

/// The whole log is read into memory on load. Compaction keeps it near a
/// megabyte; this is the point past which something has gone wrong enough that
/// failing loudly beats trying.
const MAX_LOG_BYTES: u64 = 512 * 1024 * 1024;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    Io(io::Error),
    /// The log is not ours, or the store is unusable for a reason that will not
    /// resolve itself. Never a torn tail — that is repaired, not reported.
    Corrupt(String),
    TooLarge(u64),
    Unavailable(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Io(e) => write!(f, "{e}"),
            Error::Corrupt(why) => write!(f, "{why}"),
            Error::TooLarge(bytes) => write!(f, "{bytes} bytes is more than the log will hold"),
            Error::Unavailable(why) => write!(f, "{why}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e)
    }
}

/// Everything on disk for this document, as opaque frames.
pub struct DocState {
    /// The last snapshot, or `None` on a document that has never been compacted.
    pub snapshot: Option<Vec<u8>>,
    /// Frames appended since that snapshot, in the order they were appended.
    pub updates: Vec<Vec<u8>>,
}

impl DocState {
    /// The whole state as one raw response body:
    ///
    /// ```text
    /// blob  := frame(snapshot) frame(update)*
    /// frame := [u32 le length][length bytes]
    /// ```
    ///
    /// A JSON `{snapshot: number[], updates: number[][]}` would be the obvious
    /// shape and is the same mistake as base64-ing a photograph across IPC
    /// (ARCHITECTURE section 4.3): a ten-megabyte snapshot becomes forty
    /// megabytes of decimal digits, and both sides pay to parse it.
    ///
    /// No checksums here — this crosses a function call inside one process, not
    /// a disk. An absent snapshot is a zero-length frame, which is
    /// indistinguishable from an empty one; [`DocStore::compact`] refuses to
    /// write an empty snapshot precisely so those two cases never overlap.
    pub fn into_blob(self) -> Vec<u8> {
        let capacity = 4
            + self.snapshot.as_ref().map_or(0, Vec::len)
            + self.updates.iter().map(|u| 4 + u.len()).sum::<usize>();
        let mut out = Vec::with_capacity(capacity);
        push_frame(&mut out, self.snapshot.as_deref().unwrap_or(&[]));
        for update in &self.updates {
            push_frame(&mut out, update);
        }
        out
    }
}

fn push_frame(out: &mut Vec<u8>, payload: &[u8]) {
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
}

/// FNV-1a, 64-bit.
///
/// Deliberately not a CRC: the failure this guards against is a frame the
/// operating system only got halfway through writing, not a bit flipped in
/// transit by a hostile party. Any hash whose output moves when the input is
/// truncated catches that, and this one is nine lines and no dependency. If
/// frames ever start arriving over the wire, this is the line to revisit.
fn checksum(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

pub struct DocStore {
    root: PathBuf,
    /// Held open across appends, and the lock that serialises them against
    /// compaction. Opened read-write rather than append-only because
    /// compaction truncates through this same handle, and a Windows handle
    /// opened for append does not carry the access right that needs.
    log: Mutex<File>,
    /// False when `log.bin` was already there and did not start with [`MAGIC`].
    /// Every operation refuses, so a file we cannot read is also a file we
    /// never write over.
    ours: bool,
}

impl DocStore {
    /// `root` is the document directory itself, created if it is not there.
    /// A log that does not exist yet is created with its header.
    pub fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root)?;
        let mut log = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join(LOG_FILE))?;

        let ours = if log.metadata()?.len() == 0 {
            log.write_all(MAGIC)?;
            log.sync_all()?;
            true
        } else {
            let mut header = [0u8; MAGIC.len()];
            log.seek(SeekFrom::Start(0))?;
            log.read_exact(&mut header).is_ok() && &header == MAGIC
        };

        log.seek(SeekFrom::End(0))?;
        Ok(Self {
            root,
            log: Mutex::new(log),
            ours,
        })
    }

    fn snapshot_path(&self) -> PathBuf {
        self.root.join(SNAPSHOT_FILE)
    }

    fn lock(&self) -> Result<MutexGuard<'_, File>> {
        if !self.ours {
            return Err(Error::Corrupt(
                "this board's log file was not written by this application".into(),
            ));
        }
        self.log
            .lock()
            .map_err(|_| Error::Corrupt("the document log lock was poisoned by a panic".into()))
    }

    /// Append one frame. The caller has already merged a batch's worth of
    /// updates into these bytes — this side never looks inside them.
    ///
    /// Written with a single `write_all` so that the length, the checksum and
    /// the payload reach the kernel together: a frame torn across two writes
    /// would be the one shape this format cannot tell from a short read.
    ///
    /// **Not fsynced.** A frame that has reached the page cache survives the
    /// application crashing, which is what the log is for; surviving the
    /// *machine* losing power costs an fsync every couple of hundred
    /// milliseconds for the whole life of the session. The snapshot half of
    /// compaction is synced, because that one is rewriting the only complete
    /// copy of the document there is.
    pub fn append(&self, update: &[u8]) -> Result<()> {
        if update.is_empty() {
            return Ok(());
        }
        let len = update.len() as u64;
        if len > MAX_FRAME_BYTES {
            return Err(Error::TooLarge(len));
        }

        let mut frame = Vec::with_capacity(FRAME_HEADER + update.len());
        frame.extend_from_slice(&(update.len() as u32).to_le_bytes());
        frame.extend_from_slice(&checksum(update).to_le_bytes());
        frame.extend_from_slice(update);

        let mut log = self.lock()?;
        log.write_all(&frame)?;
        log.flush()?;
        Ok(())
    }

    /// The snapshot and every frame appended since it, in order.
    ///
    /// Also the only place the log is repaired: a tail that does not decode is
    /// truncated away here, so the next append lands on bytes the next load can
    /// still read.
    pub fn load(&self) -> Result<DocState> {
        let mut log = self.lock()?;

        let snapshot = match fs::read(self.snapshot_path()) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(Error::Io(e)),
        };

        let size = log.metadata()?.len();
        if size > MAX_LOG_BYTES {
            return Err(Error::TooLarge(size));
        }
        let mut bytes = Vec::with_capacity(size as usize);
        log.seek(SeekFrom::Start(0))?;
        log.read_to_end(&mut bytes)?;

        let (updates, good) = decode_frames(&bytes);
        if good < bytes.len() {
            eprintln!(
                "docstore: dropping {} unreadable bytes from the end of the log",
                bytes.len() - good
            );
            log.set_len(good as u64)?;
        }
        log.seek(SeekFrom::End(0))?;

        Ok(DocState { snapshot, updates })
    }

    /// Swap in a fresh snapshot and start the log again.
    ///
    /// The ordering is the whole point and is described at the top of this
    /// file: snapshot first, truncate second. The caller's other half of the
    /// contract is that `snapshot` already contains every frame it has
    /// appended — which it does, because the frontend takes it from the live
    /// document and nothing can append while this holds the lock.
    pub fn compact(&self, snapshot: &[u8]) -> Result<()> {
        if snapshot.is_empty() {
            // An empty snapshot would truncate the log in exchange for nothing.
            // Yjs never encodes a document — even an empty one — to zero bytes,
            // so these are not a document.
            return Err(Error::Corrupt("refusing to snapshot zero bytes".into()));
        }
        let mut log = self.lock()?;

        write_atomic(&self.snapshot_path(), snapshot)?;

        log.set_len(0)?;
        // `set_len` moves the end of the file, not the handle's position, and
        // this one is sitting wherever the last append left it. Without the
        // seek the header lands at that offset and everything before it is a
        // hole full of zeroes.
        log.seek(SeekFrom::Start(0))?;
        log.write_all(MAGIC)?;
        log.flush()?;
        Ok(())
    }
}

/// Decode frames until one does not add up. Returns what was readable and the
/// offset it stopped at, which is where the file should end.
fn decode_frames(bytes: &[u8]) -> (Vec<Vec<u8>>, usize) {
    let mut frames = Vec::new();
    let mut at = MAGIC.len();
    if bytes.len() < at {
        return (frames, bytes.len());
    }

    while at + FRAME_HEADER <= bytes.len() {
        let len = u32::from_le_bytes(bytes[at..at + 4].try_into().expect("four bytes")) as usize;
        let sum = u64::from_le_bytes(bytes[at + 4..at + FRAME_HEADER].try_into().expect("eight"));
        let start = at + FRAME_HEADER;
        let Some(end) = start.checked_add(len).filter(|end| *end <= bytes.len()) else {
            break;
        };
        let payload = &bytes[start..end];
        if checksum(payload) != sum {
            break;
        }
        frames.push(payload.to_vec());
        at = end;
    }

    (frames, at)
}

/// Write through a temporary file and rename, so that a crash mid-write cannot
/// leave a truncated snapshot at the address of the only complete copy of the
/// document there is.
///
/// Unlike the asset store's version there is no "someone else already wrote
/// this" fallback: two writers producing the same file is what content
/// addressing guarantees and what a snapshot cannot, so a rename that fails
/// here is a genuine failure and the log must not be truncated behind it.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let temp = path.with_extension(format!(
        "part{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    {
        let mut file = File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    if let Err(e) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(Error::Io(e));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, DocStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = DocStore::new(dir.path().join("doc")).unwrap();
        (dir, store)
    }

    #[test]
    fn a_fresh_document_loads_as_nothing_at_all() {
        let (_dir, store) = store();
        let state = store.load().unwrap();
        assert!(state.snapshot.is_none());
        assert!(state.updates.is_empty());
    }

    #[test]
    fn frames_come_back_in_the_order_they_were_appended() {
        let (_dir, store) = store();
        store.append(b"one").unwrap();
        store.append(b"two").unwrap();
        store.append(b"three").unwrap();

        let state = store.load().unwrap();
        assert_eq!(
            state.updates,
            vec![b"one".to_vec(), b"two".to_vec(), b"three".to_vec()]
        );
    }

    #[test]
    fn a_reopened_store_appends_after_what_is_already_there() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("doc");
        {
            let store = DocStore::new(root.clone()).unwrap();
            store.append(b"before").unwrap();
        }
        let store = DocStore::new(root).unwrap();
        store.append(b"after").unwrap();

        let state = store.load().unwrap();
        assert_eq!(state.updates, vec![b"before".to_vec(), b"after".to_vec()]);
    }

    #[test]
    fn compaction_swaps_the_snapshot_in_and_starts_the_log_again() {
        let (_dir, store) = store();
        store.append(b"one").unwrap();
        store.append(b"two").unwrap();
        store.compact(b"the whole document").unwrap();

        let state = store.load().unwrap();
        assert_eq!(state.snapshot.as_deref(), Some(&b"the whole document"[..]));
        assert!(state.updates.is_empty());
    }

    #[test]
    fn updates_appended_after_a_compaction_survive_it() {
        let (_dir, store) = store();
        store.append(b"before").unwrap();
        store.compact(b"snapshot one").unwrap();
        store.append(b"after").unwrap();
        store.append(b"later").unwrap();

        let state = store.load().unwrap();
        assert_eq!(state.snapshot.as_deref(), Some(&b"snapshot one"[..]));
        assert_eq!(state.updates, vec![b"after".to_vec(), b"later".to_vec()]);
    }

    #[test]
    fn a_second_compaction_replaces_the_first_snapshot() {
        let (_dir, store) = store();
        store.compact(b"snapshot one").unwrap();
        store.compact(b"snapshot two").unwrap();

        let state = store.load().unwrap();
        assert_eq!(state.snapshot.as_deref(), Some(&b"snapshot two"[..]));
    }

    #[test]
    fn an_empty_snapshot_is_refused_rather_than_truncating_the_log() {
        let (_dir, store) = store();
        store.append(b"work").unwrap();
        assert!(matches!(store.compact(b""), Err(Error::Corrupt(_))));
        assert_eq!(store.load().unwrap().updates, vec![b"work".to_vec()]);
    }

    /// The crash-mid-append case: the frame's header made it to disk and some
    /// of its payload did not.
    #[test]
    fn a_torn_tail_frame_is_dropped_and_the_file_repaired() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("doc");
        let path = root.join(LOG_FILE);
        {
            let store = DocStore::new(root.clone()).unwrap();
            store.append(b"whole").unwrap();
            store.append(b"torn in half").unwrap();
        }

        let full = fs::metadata(&path).unwrap().len();
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(full - 5)
            .unwrap();

        let store = DocStore::new(root).unwrap();
        assert_eq!(store.load().unwrap().updates, vec![b"whole".to_vec()]);

        // Repaired, not merely tolerated: the next append has to be readable,
        // and it would not be if it landed behind the wreckage.
        store.append(b"next session").unwrap();
        assert_eq!(
            store.load().unwrap().updates,
            vec![b"whole".to_vec(), b"next session".to_vec()]
        );
    }

    #[test]
    fn a_frame_whose_payload_changed_underneath_us_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("doc");
        let path = root.join(LOG_FILE);
        {
            let store = DocStore::new(root.clone()).unwrap();
            store.append(b"good").unwrap();
            store.append(b"rotten").unwrap();
        }

        let mut bytes = fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        fs::write(&path, &bytes).unwrap();

        let store = DocStore::new(root).unwrap();
        assert_eq!(store.load().unwrap().updates, vec![b"good".to_vec()]);
    }

    #[test]
    fn a_log_that_is_not_ours_is_refused_rather_than_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("doc");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(LOG_FILE), b"somebody else's file entirely").unwrap();

        let store = DocStore::new(root.clone()).unwrap();
        assert!(matches!(store.load(), Err(Error::Corrupt(_))));
        assert!(matches!(store.append(b"nope"), Err(Error::Corrupt(_))));
        assert!(matches!(store.compact(b"nope"), Err(Error::Corrupt(_))));
        assert_eq!(
            fs::read(root.join(LOG_FILE)).unwrap(),
            b"somebody else's file entirely"
        );
    }

    #[test]
    fn the_blob_frames_the_snapshot_first_then_every_update() {
        let state = DocState {
            snapshot: Some(b"snap".to_vec()),
            updates: vec![b"a".to_vec(), b"bb".to_vec()],
        };
        assert_eq!(
            state.into_blob(),
            [
                &4u32.to_le_bytes()[..],
                b"snap",
                &1u32.to_le_bytes()[..],
                b"a",
                &2u32.to_le_bytes()[..],
                b"bb",
            ]
            .concat()
        );
    }

    #[test]
    fn a_document_with_no_snapshot_still_leads_with_a_frame() {
        let state = DocState {
            snapshot: None,
            updates: vec![b"a".to_vec()],
        };
        assert_eq!(
            state.into_blob(),
            [&0u32.to_le_bytes()[..], &1u32.to_le_bytes()[..], b"a"].concat()
        );
    }
}
