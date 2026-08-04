//! `.schizo` bundle read and write (T-84).
//!
//! > **Bundle format** — `.schizo`, a zip containing:
//! >
//! > ```text
//! > manifest.json      schemaVersion, title, asset list
//! > snapshot.bin       document state
//! > assets/<sha256>    the bytes
//! > ```
//! >
//! > **Export always embeds assets.** A board you hand to someone is never half
//! > a board.
//! > — DATA-MODEL section 12
//!
//! ## This module reads a manifest and never reads a board
//!
//! Rust owns bytes and no schema (ARCHITECTURE section 4), and a bundle is the
//! one place that rule is under real pressure — the file *looks* like it wants
//! a schema, because half of what goes in it comes out of the document. It does
//! not get one. The frontend hands over the snapshot as opaque bytes, the title
//! as a string, the schema version as a number and the asset list as hashes,
//! and this module puts those four things in a zip. It never opens
//! `snapshot.bin`, which is why `yrs` is not in scope here even though the
//! binary already links it for the relay.
//!
//! That is also why the asset list has to be passed in rather than derived.
//! Only the document knows which photographs a board references, and only the
//! frontend can read the document.
//!
//! ## The manifest is the index, and the archive is only addressed through it
//!
//! Reading is the dangerous direction: a `.schizo` is a file that arrived from
//! somebody else, and every zip reader ever written has had the same bug, which
//! is that an entry called `../../.bashrc` is a filename until you join it onto
//! a path. So no name from the archive is ever turned into a path here.
//! [`read`] walks `manifest.assets`, checks each entry is 64 hex characters
//! with [`assets::valid_hash`], looks it up by name, and hands the bytes to
//! [`AssetStore::ingest_bytes`] — which derives the destination from a hash it
//! computes itself. Entries the manifest does not list are never looked at at
//! all, so an archive can carry whatever it likes and reach nothing.
//!
//! The hash is checked *before* ingestion rather than after. An entry named for
//! one hash holding bytes that are another is the signature of a tampered
//! bundle, and finding out afterwards means the store has already written the
//! bytes it was about to reject.
//!
//! ## What a missing photograph does, in each direction
//!
//! Not symmetric, and deliberately.
//!
//! **Writing:** an asset the document references but this disk does not hold is
//! reported and skipped, not fatal. DESIGN section 11.1's fourth risk — "in LAN
//! mode an asset can exist only on a peer who has since left" — is a board
//! state a user can genuinely be in, and refusing to export it would mean one
//! lost photograph makes a board permanently un-handable. The manifest lists
//! what is actually in the zip, so it never claims something it does not carry;
//! [`Written::missing`] is how the caller learns to say so out loud.
//!
//! **Reading:** a hash the manifest lists but the archive does not contain is
//! also survivable, because the placeholder states from T-75 are exactly the
//! machinery for an asset that is not here yet. It comes back in
//! [`Opened::missing`] rather than as an error.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::assets::{self, AssetStore};

/// The extension, without the dot. Note the collision worth keeping in mind:
/// `schizo://` is the *invite* scheme (T-163) and `.schizo` is this file. They
/// are unrelated, and the only thing they share is the word.
pub const EXTENSION: &str = "schizo";

pub const MANIFEST: &str = "manifest.json";
pub const SNAPSHOT: &str = "snapshot.bin";
pub const ASSET_PREFIX: &str = "assets/";

/// Stamped into every manifest and checked on the way back in.
///
/// This is a *file format* check and not a schema check, which is the whole
/// reason it can live in Rust: it answers "is this one of ours", where
/// `schemaVersion` answers "is this a board this build understands" and only
/// the frontend can decide that. So a wrong `format` is refused here and a
/// surprising `schemaVersion` is handed upward untouched.
pub const FORMAT: &str = "schizoboard/bundle";

/// A document that will not fit in this is not a document.
///
/// Well above anything real — a board of five hundred photographs is a few
/// megabytes of document, because the bytes are never in it — and here only to
/// bound a decompression from a file somebody else wrote.
const MAX_SNAPSHOT_BYTES: u64 = 256 * 1024 * 1024;

/// The manifest is a few hundred bytes per asset. Anything past this is not a
/// manifest being parsed, it is a parser being fed.
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;

/// How many entries a bundle may claim before the claim itself is the attack.
/// A board holding this many distinct photographs does not exist.
const MAX_ASSETS: usize = 100_000;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    Io(io::Error),
    /// The file is not a zip, or the zip is damaged.
    Zip(String),
    /// It is a zip, and it is not one of ours.
    NotABundle(String),
    /// It is one of ours and it is lying — a hash that is not a hash, an entry
    /// whose bytes are not what it is named for, an entry too big to be real.
    Corrupt(String),
    Asset(assets::Error),
    Json(String),
    /// Somebody else has written this pack since we last did (T-368).
    ///
    /// **Its own variant because of what must not happen next.** Every other
    /// error out of [`append`] means "there is nothing here to append to", and
    /// `save_pack`'s answer is to write the whole file again from the document
    /// this machine still holds — which is right for a torn append and is the
    /// worst possible answer to this one: it would rename our file over theirs
    /// and take every generation they wrote with it. So this is the one append
    /// failure that must not fall back, and a `Corrupt(String)` nobody could
    /// tell apart from the others would have been exactly that bug.
    Interleaved {
        /// The generation this installation last wrote, and therefore expected
        /// to still be the newest.
        ours: u32,
        /// What is actually the newest in the file now.
        theirs: u32,
    },
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Io(e) => write!(f, "{e}"),
            Error::Zip(why) => write!(f, "not a readable zip: {why}"),
            Error::NotABundle(why) => write!(f, "not a Schizoboard bundle: {why}"),
            Error::Corrupt(why) => write!(f, "this bundle is damaged: {why}"),
            Error::Asset(e) => write!(f, "{e}"),
            Error::Json(why) => write!(f, "the manifest could not be read: {why}"),
            Error::Interleaved { ours, theirs } => write!(
                f,
                "another window has written this board's file since this one did \
                 (it is at generation {theirs}, and this window last wrote {ours})"
            ),
        }
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e)
    }
}

impl From<assets::Error> for Error {
    fn from(e: assets::Error) -> Self {
        Error::Asset(e)
    }
}

impl From<zip::result::ZipError> for Error {
    fn from(e: zip::result::ZipError) -> Self {
        Error::Zip(e.to_string())
    }
}

/// `manifest.json`, exactly as DATA-MODEL section 12 lists it, plus the format
/// tag that lets a reader refuse somebody else's zip before it starts trusting
/// the names inside it.
///
/// `assets` is what is *in the archive*, not what the board references. Those
/// differ when a photograph has gone missing, and the manifest describes the
/// file rather than the board's intentions — a manifest that lists what it does
/// not carry is one every reader has to defend against.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    /// Which file this is (T-359).
    ///
    /// **`None` on every `.schizo` written before T-356**, which is what makes
    /// this additive: an older bundle has no pack id, reads perfectly well
    /// without one, and is given one the first time it is written again.
    ///
    /// It names the *file* and never the room, which is the whole reason it is
    /// allowed to be in here at all — `board.rs`'s module note has the
    /// argument, and the short version is that a board id would put every
    /// machine opening this file into the exporter's sync room and a pack id
    /// grants nothing to anybody.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack_id: Option<String>,
    /// `meta.schemaVersion`, straight through. Migration is the frontend's, run
    /// on the merged document (DATA-MODEL section 12) — nothing here acts on
    /// this number, it is only carried so that side can.
    pub schema_version: u32,
    pub title: String,
    pub assets: Vec<String>,
}

/// What the frontend has to say to get a bundle written. Four things, none of
/// them a document.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub schema_version: u32,
    pub title: String,
    /// Every hash the document references. Order and duplicates do not matter;
    /// [`write`] sorts and dedups, so a bundle of the same board is the same
    /// bundle whatever order the frontend walked its assets in.
    pub assets: Vec<String>,
}

/// What a completed export turned out to be, for the caller to report.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    /// What this file is called from now on — minted here when the caller had
    /// none, so that the one place a pack id comes into existence is the one
    /// place a pack does.
    pub pack_id: String,
    pub embedded: usize,
    /// Referenced by the board, absent from this disk, and therefore absent
    /// from the file. Empty is the normal case and the one worth not
    /// announcing.
    pub missing: Vec<String>,
    pub bytes: u64,
}

/// What an export would weigh, asked before there is a file to measure — see
/// [`weigh`].
///
/// `missing` is a count where [`Written`]'s is a list, and the difference is
/// what each is for: this one is a number in a sentence somebody reads while
/// deciding whether to export at all, and that one is the record of what a file
/// on the disk turned out not to contain.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Weighed {
    pub embedded: usize,
    pub missing: usize,
    /// The sum of the originals. See [`weigh`] for what it does not include.
    pub bytes: u64,
}

/// What came out of a bundle. The snapshot is opaque here and stays opaque —
/// what to *do* with it is the frontend's, and Q-111's.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub manifest: Manifest,
    #[serde(skip)]
    pub snapshot: Vec<u8>,
    /// Hashes that arrived out of this archive just now.
    pub ingested: Vec<String>,
    /// Hashes this machine already held, whose entries were **never read**
    /// (T-359).
    ///
    /// This used to be folded into `ingested`, whose comment said "whether they
    /// arrived just now or were already here" — true, and it meant reopening
    /// your own six-gigabyte board decompressed and re-hashed six gigabytes to
    /// arrive back where it started. Once a pack is the board rather than an
    /// export, that is not an import cost paid once; it is what opening a board
    /// costs.
    ///
    /// Separated rather than merely skipped because the caller acts on the
    /// difference: `bundle_open` schedules variants for what came in, and
    /// scheduling them for these would decode every picture on the board on
    /// every open. The bounded consequence, stated rather than left to be
    /// discovered: an asset held with its variants missing does not get them
    /// rebuilt here. `AssetStore::resolve` falls back to the original, so the
    /// picture still draws — heavier, and correct.
    pub already: Vec<String>,
    /// Listed by the manifest and not actually in the archive.
    pub missing: Vec<String>,
}

// --- the wire shape ---------------------------------------------------------

/// Both bundle commands carry a little JSON in front of a lot of bytes, framed
/// as `[u32 le json length][json][snapshot]`.
///
/// A snapshot is binary and the thing beside it is not, and Tauri's raw body is
/// all-or-nothing: a command takes an [`InvokeBody::Raw`] or it takes JSON
/// arguments, never both. The alternatives were sending the snapshot as a JSON
/// array of numbers — a third larger and a serialisation stall on every export,
/// which ARCHITECTURE section 4.4 already rejected for asset bytes — or putting
/// the manifest in a header, where a five-hundred-photograph board's asset list
/// is thirty kilobytes of header.
///
/// The framing is `docstore::DocState::into_blob`'s, for the same reason it is
/// not JSON there either.
///
/// [`InvokeBody::Raw`]: tauri::ipc::InvokeBody::Raw
pub fn split_payload(body: &[u8]) -> Result<(&[u8], &[u8])> {
    let header: [u8; 4] = body
        .get(..4)
        .and_then(|h| h.try_into().ok())
        .ok_or_else(|| Error::Corrupt("the payload has no length header".into()))?;
    let len = u32::from_le_bytes(header) as usize;
    let json = body
        .get(4..4 + len)
        .ok_or_else(|| Error::Corrupt(format!("the payload claims {len} bytes of manifest")))?;
    Ok((json, &body[4 + len..]))
}

/// The other direction.
///
/// Uncalled between T-360 and T-366 — nothing hands a document *back* across the
/// IPC boundary any more, because a board is opened by pointing this window's
/// log at it rather than by shipping its snapshot to the webview. It was kept
/// rather than deleted on the grounds that generations would be this exact
/// framing, and they are: [`append`] writes one `gen/<n>` entry holding
/// `[u32 le json len][json][snapshot]`, which is this function and
/// [`split_payload`] verbatim, tests and all.
pub fn join_payload(json: &[u8], bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + json.len() + bytes.len());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(json);
    out.extend_from_slice(bytes);
    out
}

// --- writing ----------------------------------------------------------------

/// Which of the board's assets this disk can actually put in the file, and
/// which it cannot.
///
/// **One walk, used by both the weighing and the writing**, which is the whole
/// reason it is a function. A forecast derived from a different list than the
/// one the writer embeds is a forecast that can be wrong in the direction
/// nobody would ever check — it would say six gigabytes and write four, and the
/// person would conclude the number is decorative.
fn plan(store: &AssetStore, spec: &Spec) -> (Vec<String>, Vec<String>) {
    let mut wanted: Vec<String> = spec.assets.clone();
    wanted.sort();
    wanted.dedup();

    let mut embedded = Vec::new();
    let mut missing = Vec::new();
    for hash in wanted {
        // A malformed hash is missing rather than fatal, and for the same
        // reason a lost photograph is: this is the export path, the user is
        // trying to hand their board to somebody, and the least useful moment
        // to refuse is the one where they have already picked a filename.
        if assets::valid_hash(&hash) && store.has(&hash) {
            embedded.push(hash);
        } else {
            missing.push(hash);
        }
    }
    (embedded, missing)
}

/// What a bundle of this board would weigh, before a byte of it is written —
/// T-291, Q-314.
///
/// ## Why this exists, given that [`Written`] already reports a size
///
/// Because that one arrives too late to be a decision. A board with three
/// interviews on it is several gigabytes, and D-64 measured why that cannot be
/// fixed by compressing it: film and recordings are already compressed, and
/// deflating them spends the whole export re-proving it. So the size is a fact
/// about the board rather than a fault in the format — and the honest thing to
/// do with a fact somebody is about to spend two minutes and six gigabytes of
/// disk on is to say it first.
///
/// **An upper bound, not a measurement.** It is the sum of the originals, and
/// three things move the real file off it: the snapshot, which the caller adds
/// because it is the caller that holds it; the zip's own per-entry overhead,
/// which is tens of bytes; and deflate, which takes a little off the manifest
/// and off any transcript or WAV in the board (see [`fill`]). Everything that
/// makes a bundle big is stored byte for byte, so the bound is tight where it
/// matters and the word for it on the way out is "about".
pub fn weigh(store: &AssetStore, spec: &Spec) -> Weighed {
    let (embedded, missing) = plan(store, spec);
    // A file that vanished between this walk and the `metadata` call counts as
    // nothing rather than failing the forecast. Weighing is not the export and
    // must never be the thing that stops one: `write` walks the store again and
    // reports what it actually found.
    let bytes = embedded
        .iter()
        .filter_map(|hash| fs::metadata(store.original_path(hash)).ok())
        .map(|meta| meta.len())
        .sum();
    Weighed {
        embedded: embedded.len(),
        missing: missing.len(),
        bytes,
    }
}

/// Zip up a board.
///
/// `dest` is a path this module validates nothing about, on the same standing
/// as [`AssetStore::export`]: it comes from a native save dialog, never from
/// the webview (ARCHITECTURE section 4.4).
///
/// Written through a temporary beside the destination and renamed, which is not
/// the same politeness [`assets`] shows itself. There the address is a hash and
/// a truncated file would be trusted forever; here it is that the destination
/// is very often the *previous* export of the same board, and a disk filling up
/// halfway through should not cost the user the copy they already had.
pub fn write(
    store: &AssetStore,
    spec: &Spec,
    pack_id: Option<&str>,
    snapshot: &[u8],
    dest: &Path,
) -> Result<Written> {
    write_expecting(store, spec, pack_id, snapshot, dest, None)
}

/// [`write`], refusing the rename if the destination has grown a generation
/// since `expect_newest` was read out of it (T-375).
///
/// The guard [`compact`] folds under. [`append`] checks `newest != ours` out of
/// the read it was already making, but a compaction's read and its rename are
/// separated by rewriting the whole file — seconds, on the packs worth
/// compacting — and a generation another window appends in between would go
/// under the rename and out of existence, with its writer told the save
/// succeeded. Re-reading the central directory here closes that window to the
/// gap between two adjacent calls; it is not zero, on [`append`]'s own honesty:
/// an interleave is *caught*, not prevented.
///
/// `None` is every other caller: a copy, a first home, a torn-append recovery —
/// writes whose destination is not a file some other window believes it is
/// appending to, or is a file whose directory is already gone.
fn write_expecting(
    store: &AssetStore,
    spec: &Spec,
    pack_id: Option<&str>,
    snapshot: &[u8],
    dest: &Path,
    expect_newest: Option<u32>,
) -> Result<Written> {
    let (embedded, missing) = plan(store, spec);
    // Minted here when there is none, and **the caller is Rust** — this is not
    // on `Spec`, so it cannot arrive from the webview. That is deliberate and it
    // is the rule the whole register turns on: a pack id is the key `board.rs`
    // looks a board up by, so a webview that could name one could name a board
    // it is not on. `bundle_save_as` passes `None` because a copy is a
    // different board; a flush passes the register's, because it is the same
    // file being written again.
    let pack_id = pack_id.map(str::to_string).unwrap_or_else(crate::board::mint_pack_id);

    let manifest = Manifest {
        format: FORMAT.to_string(),
        pack_id: Some(pack_id.clone()),
        schema_version: spec.schema_version,
        title: spec.title.clone(),
        assets: embedded.clone(),
    };

    let temp = temp_beside(dest);
    let result = fill(store, &manifest, snapshot, &embedded, &temp);
    match result {
        Ok(bytes) => {
            if let Some(ours) = expect_newest {
                // A destination that will not answer is treated the same as one
                // that has moved: somebody may be mid-append, and renaming over
                // a file in an unknown state is the loss this guard exists to
                // refuse.
                let theirs = generation_of(dest).inspect_err(|_| {
                    let _ = fs::remove_file(&temp);
                })?;
                if theirs != ours {
                    let _ = fs::remove_file(&temp);
                    return Err(Error::Interleaved { ours, theirs });
                }
            }
            fs::rename(&temp, dest).inspect_err(|_| {
                let _ = fs::remove_file(&temp);
            })?;
            Ok(Written {
                pack_id,
                embedded: embedded.len(),
                missing,
                bytes,
            })
        }
        Err(e) => {
            let _ = fs::remove_file(&temp);
            Err(e)
        }
    }
}

/// Where a generation lives, and the only name in this format that carries a
/// number.
///
/// Parsing an integer out of `gen/<n>` is not what this module's note forbids.
/// That rule is about a name from an archive becoming a **path**, and this name
/// becomes a `u32` — it is never joined onto anything, and the generation's own
/// manifest is still the only index into `assets/`.
const GEN_PREFIX: &str = "gen/";

/// How many generations a pack may carry before the file is a queue rather than
/// a board.
///
/// At one flush per idle interval this is many hours of continuous work, and
/// T-367's compaction folds them away long before it. Here so that a `.schizo`
/// somebody else wrote cannot make the reader walk a directory of a million
/// names looking for the highest.
const MAX_GENERATIONS: u32 = 100_000;

/// The highest generation in an archive, and how many there are.
///
/// `None` for a pack with none at all — every `.schizo` written before T-366,
/// which is the property that keeps the T-84 corpus green without touching it:
/// such a file is a pack with zero generations and reads as its `manifest.json`
/// plus `snapshot.bin`.
///
/// A name that is not `gen/<integer>` is **ignored rather than refused**. It is
/// a name in an archive somebody else wrote, and the alternative — failing the
/// whole open — would let one junk entry make a board unopenable.
fn newest_generation<R: Read + io::Seek>(zip: &ZipArchive<R>) -> Option<u32> {
    zip.file_names()
        .filter_map(|name| name.strip_prefix(GEN_PREFIX))
        .filter_map(|n| n.parse::<u32>().ok())
        .filter(|n| *n >= 1 && *n <= MAX_GENERATIONS)
        .max()
}

/// What generation a pack is at, for a caller taking it up (T-368).
///
/// `0` for a pack with no generations, which is every `.schizo` written before
/// T-366 and every one just compacted — the same zero [`append`] expects to be
/// told when the file has none.
///
/// **Opening somebody else's pack sets this to whatever it is already at**,
/// which is the difference between a belief about the file and a count of our
/// own writes. A pack sent to you at generation five is not one you are five
/// behind on; it is one you have just caught up with, and calling it zero would
/// make your first flush read as somebody else's interleave.
///
/// Costs the central directory and reads no entry.
pub fn generation_of(src: &Path) -> Result<u32> {
    let zip = ZipArchive::new(BufReader::new(File::open(src)?))?;
    Ok(newest_generation(&zip).unwrap_or(0))
}

/// Write the board into a pack that already exists, as one appended entry.
///
/// **This is the whole of stage 2** (T-366, D-70). A flush used to be
/// [`write`] — a whole new zip beside the old one and a rename — which costs
/// O(the file) and the free space twice over, so on a board of photographs it
/// was gigabytes of copying every time somebody paused. It is now one entry
/// appended to the end, which costs O(the snapshot) whatever the pack weighs.
///
/// ## Why an entry rather than a second `snapshot.bin`
///
/// `ZipWriter::new_append` exists, and `insert_file_data` refuses a duplicate
/// name with no removal API beside it — so a second `snapshot.bin` is
/// impossible. A uniquely named entry is the shape the crate will actually
/// give, and once the name has to be unique it may as well be the ordering.
///
/// The payload is `[u32 le json len][json][snapshot]`, which is
/// [`join_payload`] and [`split_payload`] verbatim: the framing already written
/// for the IPC boundary, with its own tests.
///
/// ## And why not append past the old central directory
///
/// That shape claims to delegate parsing and does not. `ZipArchive` does not
/// expose `dir_start`, so you find the EOCD yourself — that is the backward
/// scan, and it is parsing. Carrying the existing entries into a fresh
/// directory means re-emitting their records, and `ZipFileData` is not public,
/// so you parse each 46-byte record plus name plus extra plus comment to find
/// the next. And a six-gigabyte pack is past 4 GiB, so zip64 is mandatory —
/// which is the *two ways of saying the same offset* that `Cargo.toml`'s
/// standing argument against hand-rolling a zip names by name.
///
/// ## What a torn append costs, which is nothing
///
/// `new_append` leaves the cursor at the first byte of the old EOCD, so the
/// first byte of any append destroys it and there is no previous directory to
/// scan back to. **That does not matter, and the reason is the shape of the
/// whole design rather than a mitigation.** The pack is not the only copy: the
/// workshop is a crash-safe log with an fsynced snapshot, and the asset store
/// holds every byte content-addressed. A pack that will not open is rewritten
/// whole by the next flush (`write_pack` in `lib.rs`), out of a document the
/// frontend still holds, and nothing is lost.
///
/// A forward `PK\x03\x04` repair scan is **deliberately not built**: it is the
/// hand-rolled zip reading this crate exists to avoid, it would run
/// approximately never, and it recovers strictly less than the workshop already
/// does.
pub fn append(
    store: &AssetStore,
    spec: &Spec,
    pack_id: &str,
    snapshot: &[u8],
    dest: &Path,
    ours: u32,
) -> Result<Written> {
    let (embedded, missing) = plan(store, spec);

    // Read first, append second, in two opens rather than one. The read is the
    // central directory only — a few bytes per entry — and it answers the two
    // questions the append needs: which generation this becomes, and which
    // photographs are already in the file. `insert_file_data` refuses a
    // duplicate name, so writing an asset twice is an error rather than waste.
    let (newest, present) = {
        let zip = ZipArchive::new(BufReader::new(File::open(dest)?))?;
        let newest = newest_generation(&zip).unwrap_or(0);
        let present: HashSet<String> = zip.file_names().map(str::to_string).collect();
        (newest, present)
    };
    // **Detected here rather than prevented anywhere** (T-368, D-67 risk 4). Two
    // processes cannot be stopped from opening one file, so what this refuses is
    // writing into a file that has moved under us — the same shape as
    // `docstore.rs`'s `ours`, which establishes once that a log is not this
    // application's and declines every operation afterwards rather than trying to
    // share it.
    //
    // Checked out of the read that was already being made, so the window between
    // looking and appending is as small as one process can make it. It is not
    // zero and cannot be: the honest claim is that an interleave is *caught*, not
    // that it cannot begin.
    //
    // `!=` rather than `<`, though behind is the case that happens. A file whose
    // newest generation is lower than ours has been compacted or replaced by
    // somebody else, which is the same fact — this is not the file we last wrote
    // — arriving from the other direction.
    if newest != ours {
        return Err(Error::Interleaved {
            ours,
            theirs: newest,
        });
    }
    let generation = newest + 1;
    if generation > MAX_GENERATIONS {
        return Err(Error::Corrupt(format!(
            "that board's file already holds {MAX_GENERATIONS} generations"
        )));
    }

    let manifest = Manifest {
        format: FORMAT.to_string(),
        pack_id: Some(pack_id.to_string()),
        schema_version: spec.schema_version,
        title: spec.title.clone(),
        assets: embedded.clone(),
    };
    let json = serde_json::to_vec_pretty(&manifest).map_err(|e| Error::Json(e.to_string()))?;

    let file = File::options().read(true).write(true).open(dest)?;
    let mut zip = ZipWriter::new_append(file)?;

    // Only what is not in there already. A pack holds every asset any of its
    // generations ever listed, which is a little more than the newest manifest
    // names — T-367's compaction is what drops the surplus, and until then
    // carrying it is the cost of not rewriting the file.
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    for hash in &embedded {
        let name = format!("{ASSET_PREFIX}{hash}");
        if present.contains(&name) {
            continue;
        }
        let mut source = File::open(store.original_path(hash))?;
        zip.start_file(&name, stored)?;
        io::copy(&mut source, &mut zip)?;
    }

    // The generation last, so that a torn append can only ever lose the entry
    // that names the newest document — never an asset an *earlier* generation
    // is still the index for.
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file(format!("{GEN_PREFIX}{generation}"), deflated)?;
    zip.write_all(&join_payload(&json, snapshot))?;

    let file = zip.finish()?;
    // The board is on this disk in two places by now, so this is not what makes
    // it safe — it is what makes the *pack* worth the append. Without it a power
    // cut leaves a file whose directory the operating system has and whose bytes
    // it does not, which is the one way an append can be worse than a rewrite:
    // `write` renames a fully-flushed temporary over the destination and cannot
    // produce that state at all.
    file.sync_all()?;
    let bytes = file.metadata()?.len();

    Ok(Written {
        pack_id: pack_id.to_string(),
        embedded: embedded.len(),
        missing,
        bytes,
    })
}

/// Fold a pack's generations back into one file (T-367).
///
/// A pack grows by an entry per flush and never shrinks, and every generation
/// but the newest is superseded the moment the next one lands. Compaction is
/// what reclaims them: read the newest, write the whole file again from it, and
/// the superseded generations — and any photograph nothing on the board
/// references any more — do not go into the new one.
///
/// **It is [`write`] and nothing else**, which is the property D-70 leaned on
/// and is worth saying out loud: the shape a compaction emits is exactly the
/// shape T-84 wrote in the first place, so a compacted pack is a pack with zero
/// generations and every test in this file that predates T-366 is a test of a
/// compacted pack. *Save a copy…* is this same call to a different path, which
/// is why exporting and saving stopped being two things.
///
/// ## The store is topped up first, and it is not an optimisation
///
/// [`write`] embeds what it finds in the *asset store* and reports the rest as
/// missing. So compacting a pack whose photographs this machine has swept —
/// which is exactly what happens to every board you are not currently on — would
/// read them out of no store, write a file without them, and report it as a
/// success. The pack is the only copy of those bytes by then, so that is the
/// whole board's photographs gone in one call that looks like housekeeping.
///
/// [`top_up`] puts them back first, at the cost of an index scan on a pack whose
/// bytes this machine already holds (T-359).
///
/// ## Nothing reads out of the pack, and that was decided rather than deferred
///
/// This used to say what stage 3 would need from it: if `asset://` ever served
/// ranges straight out of the pack, a compaction would rewrite every offset
/// underneath a reader holding the file open, so it would have to lock against
/// reads and `protocol.rs` would have to answer 503 for the length of one.
///
/// That cost was one of the three that decided against building it (D-71,
/// T-369) — a compaction runs on every board switch worth it, over a file that
/// may be six gigabytes, and 503ing every image for the length of one is a stall
/// on a path that is instant today. So the lock is not missing. It is not needed,
/// and the sentence is kept because the next person to have the idea deserves
/// the argument rather than a blank.
pub fn compact(store: &AssetStore, pack_id: &str, dest: &Path) -> Result<Tidied> {
    let before = fs::metadata(dest)?.len();
    // Everything the pack holds and this machine does not, back into the store
    // before anything reads the store to decide what goes in the new file.
    top_up(store, dest)?;

    // The newest generation and the document it holds, out of one open — the
    // number is what the fold's rename is conditional on (T-375).
    let (newest, (manifest, snapshot)) = {
        let mut zip = ZipArchive::new(BufReader::new(File::open(dest)?))?;
        (newest_generation(&zip).unwrap_or(0), current(&mut zip)?)
    };
    let spec = Spec {
        schema_version: manifest.schema_version,
        title: manifest.title,
        assets: manifest.assets,
    };
    // T-375's race, made constructible: a test may land an append right here,
    // between the read above and the write below. Compiled only into tests and
    // a no-op unless one is installed.
    #[cfg(test)]
    tests::MID_FOLD.with(|hook| {
        if let Some(f) = hook.borrow_mut().as_mut() {
            f()
        }
    });
    // The register's pack id, not the manifest's, for `write`'s reason: a
    // compaction is the same file being written again, so it keeps its id where
    // a copy mints one. Conditional on the file still being at the generation
    // read above — a generation appended during the fold must survive it
    // (T-375), and `Interleaved` here is `append`'s: the file has moved under
    // us, and this window stops writing it.
    let written = write_expecting(store, &spec, Some(pack_id), &snapshot, dest, Some(newest))?;
    Ok(Tidied {
        // A *fraction* rather than a count of bytes reclaimed, and that is a
        // wording decision rather than a technical one. `lib/filesize.ts`
        // floors at 1 MB on purpose — "0 MB" reads as nothing having been
        // written — which is right for a sentence about a file somebody is
        // about to hand over and wrong for this one: tidying a board of notes
        // takes eight kilobytes down to one and a half, and "1 MB" is both
        // uninformative and, read quickly, alarming. A proportion says what
        // happened at every scale.
        reclaimed: if before == 0 {
            0.0
        } else {
            (before.saturating_sub(written.bytes)) as f64 / before as f64
        },
        written,
    })
}

/// What came of folding a pack back into one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tidied {
    #[serde(flatten)]
    pub written: Written,
    /// How much of the file went away, as a fraction of what it was. `0.0` when
    /// a compaction found nothing to reclaim, which is the honest answer to
    /// somebody who asked for one anyway.
    pub reclaimed: f64,
}

/// What fraction of a pack a compaction would reclaim (T-367, Q-350).
///
/// Every generation but the newest is superseded the moment the next one lands,
/// and the central directory already knows what each one weighs — so this costs
/// an open and reads no entry at all.
///
/// **It deliberately undercounts.** A photograph the board has stopped
/// referencing is also reclaimable and is not in this number, because working
/// that out means reading the newest manifest and comparing it against every
/// `assets/` entry. Undercounting is the safe direction for what this is *for*:
/// deciding whether a rewrite is worth stalling somebody for. A number that
/// erred the other way would promise a saving the compaction then did not make.
///
/// `0.0` for a pack with no generations, which is every pack that has not been
/// flushed since it was written — and every pack that has just been compacted.
pub fn reclaimable(dest: &Path) -> Result<f64> {
    let mut zip = ZipArchive::new(BufReader::new(File::open(dest)?))?;
    let Some(newest) = newest_generation(&zip) else {
        return Ok(0.0);
    };

    let mut total = 0u64;
    let mut superseded = 0u64;
    for i in 0..zip.len() {
        let file = zip.by_index_raw(i)?;
        let size = file.compressed_size();
        total += size;
        let is_superseded = file
            .name()
            .strip_prefix(GEN_PREFIX)
            .and_then(|n| n.parse::<u32>().ok())
            .is_some_and(|n| n != newest);
        if is_superseded {
            superseded += size;
        }
    }
    if total == 0 {
        return Ok(0.0);
    }
    Ok(superseded as f64 / total as f64)
}

/// Past this, leaving a board compacts it on the way out (Q-350).
///
/// A fifth, and the shape of the rule matters more than the number. Compaction
/// is O(the pack) where a flush is O(the snapshot), so a rule that fired on
/// *every* switch would put back the stall T-366 spent itself removing, at the
/// one moment somebody is already waiting for a window to come back. Tying it to
/// the waste instead makes the cost proportional to the thing being reclaimed
/// rather than to the board.
///
/// It also lands the right way round on both kinds of board without being told
/// about either. A board of films is mostly `assets/`, so its superseded
/// generations are a rounding error and it is almost never compacted on a
/// switch — which is exactly the board where a rewrite hurts. A board of notes
/// is mostly documents, so it crosses this quickly and is cheap to rewrite when
/// it does.
pub const COMPACT_AT: f64 = 0.2;

/// Whether this pack has enough superseded in it to be worth rewriting.
///
/// One function rather than the comparison written at each of its two callers —
/// `board_compact_on_leaving`, which acts on it, and `board_worth_tidying`,
/// which decides whether the row exists. Those two disagreeing means a row that
/// offers to reclaim what leaving already reclaimed, or worse, one that never
/// appears because leaving always beats it to it.
///
/// A pack that is not there, or will not open, is not worth compacting — this
/// is housekeeping and a file it cannot measure is a file it should not rewrite.
pub fn worth_compacting(dest: &Path) -> bool {
    dest.is_file() && reclaimable(dest).is_ok_and(|waste| waste >= COMPACT_AT)
}

/// The zip itself. Split out so that every failure between `File::create` and
/// the last byte lands in one place, where the half-written temporary can be
/// swept up.
fn fill(
    store: &AssetStore,
    manifest: &Manifest,
    snapshot: &[u8],
    embedded: &[String],
    temp: &Path,
) -> Result<u64> {
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    // Photographs are already compressed. Deflating a JPEG spends the whole
    // export re-proving that, and the bundle comes out the size it started.
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    let mut zip = ZipWriter::new(BufWriter::new(File::create(temp)?));

    // Manifest first, so a reader knows what it is holding before it has read
    // anything it would have to trust.
    zip.start_file(MANIFEST, deflated)?;
    let json = serde_json::to_vec_pretty(manifest).map_err(|e| Error::Json(e.to_string()))?;
    zip.write_all(&json)?;

    zip.start_file(SNAPSHOT, deflated)?;
    zip.write_all(snapshot)?;

    for hash in embedded {
        // The original, byte for byte — the same variant `asset_export` saves,
        // and the only one that can be named by this hash. Variants are a
        // local derivative and are rebuilt on the far side.
        let mut source = File::open(store.original_path(hash))?;
        let method = if worth_deflating(&mut source)? {
            deflated
        } else {
            stored
        };
        zip.start_file(format!("{ASSET_PREFIX}{hash}"), method)?;
        io::copy(&mut source, &mut zip)?;
    }

    let mut file = zip.finish()?;
    file.flush()?;
    let file = file.into_inner().map_err(|e| Error::Io(e.into_error()))?;
    let bytes = file.metadata()?.len();
    file.sync_all()?;
    Ok(bytes)
}

/// Whether deflating this asset would buy anything — T-291, D-64.
///
/// **Measured rather than assumed, and the measurement is on the board's own
/// corpus.** Deflate at the level a zip writes takes a 46 MiB mp4 to 100.0% of
/// itself, a photograph to 99.6%, an mp3 to 95% and two real PDFs to 99.7% and
/// 89.4% — so everything that makes a bundle heavy is stored byte for byte, and
/// the export does not spend a second per fifty megabytes proving it again.
///
/// Two kinds pay, and they are the two that were never compressed to begin
/// with. A transcript is the common one: an hour of subtitle cues is about 100
/// KiB and comes out at 7% of that, which is small beside the recording it
/// belongs to but is most of the sidecar. A WAV is the one that is big as well
/// as compressible, at 45% off.
///
/// Judged on the *bytes*, like everything else on this board: sixty-four of
/// them, through the same [`assets::sniff_mime`] the ingest gate uses, so a
/// `.txt` holding a zip is a zip here and gets stored. A file whose head says
/// nothing is stored, which is what every asset did before this existed.
///
/// What this deliberately does not do is *sample* — deflate the first 64 KiB
/// and decide from the ratio. That would also catch a PDF written without
/// stream compression, which is the one real case a mime cannot see (D-64
/// measured one at 98% off), at the cost of a millisecond and a half per asset
/// on a board that may hold five hundred. The mime rule is what Q-314 chose and
/// it is the one that costs nothing; the sample is the thing to reach for if a
/// real board ever turns up with uncompressed documents on it.
fn worth_deflating(source: &mut File) -> Result<bool> {
    let mut head = [0u8; assets::SNIFF_BYTES];
    let read = read_head(source, &mut head)?;
    // Back to the start, or the entry would be written without its own first
    // sixty-four bytes — a corruption that no test asserting *sizes* would ever
    // see, and which would arrive on the far side as a file that will not open.
    source.rewind()?;
    Ok(match assets::sniff_mime(&head[..read]) {
        Some(mime) => mime.starts_with("text/") || mime == "audio/wav",
        None => false,
    })
}

/// Fill `head` from the start of `source`, tolerating a short file.
fn read_head(source: &mut File, head: &mut [u8]) -> Result<usize> {
    let mut read = 0;
    while read < head.len() {
        match source.read(&mut head[read..])? {
            0 => break,
            n => read += n,
        }
    }
    Ok(read)
}

/// A sibling of the destination, so the rename is within one directory and
/// therefore within one filesystem. Unique per call for the same reason
/// `assets::write_atomic`'s is: two exports of two boards to one folder must
/// not share a temporary.
fn temp_beside(dest: &Path) -> PathBuf {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    dest.with_extension(format!(
        "{EXTENSION}.part{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
}

// --- reading ----------------------------------------------------------------

/// Read just the manifest, touching nothing else.
///
/// Exists because Q-112 put a confirmation in front of the replace, and the
/// order that implies is: pick the file, find out what it is, *then* ask. Asking
/// first would be asking about a file that might turn out not to be a bundle at
/// all, and reading the whole thing first would mean a stranger's photographs
/// entering this machine's store before anyone agreed to open their board.
pub fn peek(src: &Path) -> Result<Manifest> {
    let mut zip = ZipArchive::new(BufReader::new(File::open(src)?))?;
    // The newest generation's, because this answers "which board is that, and
    // what is it called" and both of those move (T-366). A pack whose title was
    // changed after it was first written would otherwise be offered in the
    // picker under the name it had when it was created.
    newest_manifest(&mut zip)
}

/// How much of a bundle's title may appear in a dialog.
///
/// Long enough to recognise a board by, short enough not to push the buttons
/// off a message box.
const MAX_TITLE_CHARS: usize = 60;

/// The title of a board somebody else made, reduced to something that can only
/// be a line of text in a dialog.
///
/// A `safe_stem` for prose, and it is guarding the same kind of door. The string
/// came out of a file this machine did not write, and it is about to be shown in
/// a *native* dialog — so a newline in it is not a formatting problem, it is a
/// second sentence appearing above the buttons in the operating system's own
/// voice. Control characters go, runs of whitespace collapse, and the whole
/// thing is truncated.
pub fn display_title(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let mut out = String::new();
    for word in cleaned.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        if out.chars().count() + word.chars().count() > MAX_TITLE_CHARS {
            out.extend(word.chars().take(MAX_TITLE_CHARS - out.chars().count()));
            out.push('…');
            return out;
        }
        out.push_str(word);
    }
    if out.is_empty() {
        "an untitled board".to_string()
    } else {
        out
    }
}

/// Open a bundle and put its photographs in this machine's store.
///
/// Returns the snapshot rather than applying it, because applying it is a
/// question about *boards* — replace, merge or open beside — and this side owns
/// bytes.
pub fn read(store: &AssetStore, src: &Path) -> Result<Opened> {
    let mut zip = ZipArchive::new(BufReader::new(File::open(src)?))?;

    let (manifest, snapshot) = current(&mut zip)?;

    let taken = take_assets(store, &mut zip, &manifest)?;
    Ok(Opened {
        manifest,
        snapshot,
        ingested: taken.ingested,
        already: taken.already,
        missing: taken.missing,
    })
}

/// Put a pack's photographs in this machine's store, and read nothing else.
///
/// [`read`]'s asset half without its document half, for the open that is *not*
/// seeding a workshop (T-363).
///
/// ## The hole this closes, which is the one D-67 called stage 1's worst
///
/// `assets/` is one store for the whole installation and `AssetStore::gc` takes
/// one keep-set — the board this window is on. So the first sweep after a
/// switch trashes every photograph belonging to every board you are *not* on.
/// That was argued to be safe because the packs hold the archive copies and
/// reopening a board brings them back, and it was not: `take_up` reads a pack
/// only when the workshop is *empty*, and a board you have opened before always
/// has a workshop. Nothing re-ingested those hashes, so `restore_from_trash`
/// never fired, and after thirty days the photographs were gone — the board
/// drawing them torn and naming nobody.
///
/// Driven before this existed: paste a photograph, switch to a new board, wait
/// out the sweep, switch back. One blank polaroid and `1 missing` on the HUD.
///
/// ## What it costs, which is nearly nothing
///
/// The manifest and one `AssetStore::has` per listed hash. An entry whose bytes
/// this machine already holds is never read out of the archive at all (T-359),
/// so reopening your own six-gigabyte board reads a few kilobytes of index. The
/// snapshot is not read either, which is the whole difference from [`read`] —
/// on a large board that alone is tens of megabytes that this caller has no use
/// for, because the workshop it is topping up is newer than it by construction.
pub fn top_up(store: &AssetStore, src: &Path) -> Result<Restored> {
    let mut zip = ZipArchive::new(BufReader::new(File::open(src)?))?;
    let manifest = newest_manifest(&mut zip)?;
    let taken = take_assets(store, &mut zip, &manifest)?;
    Ok(taken)
}

/// The board this pack currently holds — its manifest and its document.
///
/// **The highest generation wins, and with none it falls back to
/// `manifest.json` plus `snapshot.bin`** (T-366). That fallback is not a
/// compatibility shim bolted on: every `.schizo` written before generations
/// existed *is* a pack with zero of them, which is why T-84's round-trip corpus
/// stayed green through this change without a line being touched, and why a
/// compaction (T-367) is [`write`] unchanged.
///
/// A generation that will not parse is a torn append, and it is an **error**
/// rather than a silent fall back to the one below it. Falling back would hand
/// the caller a board as of some earlier moment while reporting success, which
/// is the failure DATA-MODEL section 12 spends its whole length preventing one
/// tier down. The caller's recovery is the workshop, which is newer than any
/// generation by construction.
fn current<R: Read + io::Seek>(zip: &mut ZipArchive<R>) -> Result<(Manifest, Vec<u8>)> {
    let Some(generation) = newest_generation(zip) else {
        let manifest = read_manifest(zip)?;
        let snapshot = entry(zip, SNAPSHOT, MAX_SNAPSHOT_BYTES)?
            .ok_or_else(|| Error::NotABundle(format!("no {SNAPSHOT}")))?;
        return Ok((manifest, snapshot));
    };

    // `read_manifest`'s checks are run against the *base* manifest as well,
    // because that is the entry that says whether this file is one of ours at
    // all, and a generation is only meaningful inside a file that is.
    read_manifest(zip)?;

    let name = format!("{GEN_PREFIX}{generation}");
    let payload = entry(zip, &name, MAX_MANIFEST_BYTES + MAX_SNAPSHOT_BYTES)?
        .ok_or_else(|| Error::Corrupt(format!("{name} is in the directory and not in the file")))?;
    let (json, snapshot) = split_payload(&payload)?;
    let manifest = check_manifest(
        serde_json::from_slice(json).map_err(|e| Error::Json(e.to_string()))?,
    )?;
    Ok((manifest, snapshot.to_vec()))
}

/// The manifest that indexes `assets/` right now — the newest generation's, or
/// the base one on a pack with no generations.
///
/// [`top_up`]'s half of [`current`], which reads no document at all: on a large
/// board the snapshot is tens of megabytes that a caller topping up the asset
/// store has no use for.
fn newest_manifest<R: Read + io::Seek>(zip: &mut ZipArchive<R>) -> Result<Manifest> {
    let base = read_manifest(zip)?;
    let Some(generation) = newest_generation(zip) else {
        return Ok(base);
    };
    let name = format!("{GEN_PREFIX}{generation}");
    let payload = entry(zip, &name, MAX_MANIFEST_BYTES + MAX_SNAPSHOT_BYTES)?
        .ok_or_else(|| Error::Corrupt(format!("{name} is in the directory and not in the file")))?;
    let (json, _) = split_payload(&payload)?;
    check_manifest(serde_json::from_slice(json).map_err(|e| Error::Json(e.to_string()))?)
}

/// What a pack turned out to be holding for this machine's store.
pub struct Restored {
    pub ingested: Vec<String>,
    pub already: Vec<String>,
    pub missing: Vec<String>,
}

/// `manifest.json`, checked — the first act of every read.
fn read_manifest<R: Read + io::Seek>(zip: &mut ZipArchive<R>) -> Result<Manifest> {
    let raw = entry(zip, MANIFEST, MAX_MANIFEST_BYTES)?
        .ok_or_else(|| Error::NotABundle(format!("no {MANIFEST}")))?;
    check_manifest(serde_json::from_slice(&raw).map_err(|e| Error::Json(e.to_string()))?)
}

/// What a manifest has to be true of before anything acts on it.
///
/// Separate from the read because a generation's manifest arrives out of a
/// framed payload rather than out of its own entry (T-366), and it has to pass
/// exactly the same gate — a `gen/<n>` is a manifest a stranger wrote just as
/// surely as `manifest.json` is.
fn check_manifest(manifest: Manifest) -> Result<Manifest> {
    if manifest.format != FORMAT {
        return Err(Error::NotABundle(format!(
            "its format is {:?}, not {FORMAT:?}",
            manifest.format
        )));
    }
    if manifest.assets.len() > MAX_ASSETS {
        return Err(Error::Corrupt(format!(
            "{} assets listed, which is more than a board has",
            manifest.assets.len()
        )));
    }
    Ok(manifest)
}

/// Every photograph the manifest lists that this machine does not already hold.
///
/// One copy, two callers, deliberately: [`read`] and [`top_up`] are the same
/// act on the assets and differ only in what else they take out of the file. A
/// second copy of this loop is a second place for the hash check below to be
/// got wrong.
fn take_assets(
    store: &AssetStore,
    zip: &mut ZipArchive<BufReader<File>>,
    manifest: &Manifest,
) -> Result<Restored> {
    let mut ingested = Vec::new();
    let mut already = Vec::new();
    let mut missing = Vec::new();
    let mut seen = HashSet::new();
    for hash in &manifest.assets {
        if !assets::valid_hash(hash) {
            return Err(Error::Corrupt(format!("{hash:?} is not a sha256")));
        }
        if !seen.insert(hash.as_str()) {
            continue;
        }
        // Bytes this machine already holds are not read out of the archive at
        // all (T-359) — not decompressed, not hashed, not handed to the store.
        //
        // **Nothing is weakened by that**, and it is worth saying why rather
        // than trusting it. The check below proves an entry's bytes are what
        // its *name* says; it defends the store against an archive that lies.
        // A hash the store already has is bytes that went through that same
        // gate when they arrived, and content addressing is what makes that
        // still true today — so the question this skips is one that has already
        // been answered about the very bytes that would be used. The archive's
        // copy is never consulted, so an archive lying about it cannot matter.
        //
        // `has` is the original's presence, so an asset sitting in the 30-day
        // trash is *not* held: it falls through and `ingest_bytes` restores it,
        // which is the behaviour it had before this existed.
        if store.has(hash) {
            already.push(hash.clone());
            continue;
        }
        let Some(bytes) = entry(
            zip,
            &format!("{ASSET_PREFIX}{hash}"),
            assets::MAX_ASSET_BYTES,
        )?
        else {
            missing.push(hash.clone());
            continue;
        };
        // Before the store sees them, not after. See the module note.
        let actual = assets::sha256_hex(&bytes);
        if actual != *hash {
            return Err(Error::Corrupt(format!(
                "{ASSET_PREFIX}{hash} holds bytes that are {actual}"
            )));
        }
        store.ingest_bytes(&bytes, None)?;
        ingested.push(hash.clone());
    }

    Ok(Restored {
        ingested,
        already,
        missing,
    })
}

/// One entry by name, bounded.
///
/// `Ok(None)` is "no such entry", which is a thing several callers survive; a
/// `ZipError` that is not `FileNotFound` is a damaged archive and is not
/// survivable.
///
/// The bound is on the *decompressed* stream and is enforced by reading one
/// byte past it, because the sizes in a zip header are a claim made by whoever
/// wrote the file. A `.schizo` that says it holds four kilobytes and then
/// expands forever is the oldest trick this format has.
fn entry<R: Read + io::Seek>(
    zip: &mut ZipArchive<R>,
    name: &str,
    limit: u64,
) -> Result<Option<Vec<u8>>> {
    let mut file = match zip.by_name(name) {
        Ok(file) => file,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    // The central directory's claim about what this expands to. It is the same
    // shape of promise the file system makes to `AssetStore::ingest_path`, and
    // it is held to in the same way and for the same reason: checked against the
    // limit before a byte is allocated, used to size the buffer so `read_to_end`
    // never has to double its way up, and then read one byte past to find out
    // whether the archive was telling the truth.
    //
    // Reading it into `Vec::new()` and bounding it afterwards — which is what
    // this did until T-307 — costs `next_power_of_two(limit) * 1.5`, because the
    // allocator keeps every outgrown half. That was 768 MiB when the limit was
    // 448 MiB and it would have become **1536 MiB** the moment the limit moved
    // to 768, which is over the whole ingest budget: the ceiling would have gone
    // up here without anybody raising it, on the one road that is reading an
    // archive somebody else wrote.
    let claimed = file.size();
    if claimed > limit {
        return Err(Error::Corrupt(format!(
            "{name} says it expands past {limit} bytes"
        )));
    }
    // A lying archive can make this allocate against nothing, since the claim is
    // read before the bytes are. Bounded and left that way on purpose: the worst
    // it can ask for is what one honest entry at the ceiling asks for, which is
    // inside the budget by construction — and a compressible entry could already
    // reach the same figure by actually expanding to it.
    //
    // `SizeMismatch` back from here means the entry expanded past what the
    // directory said it would, which for an archive is damage rather than a
    // race — so it is reported as such and not passed on as an asset error.
    let bytes = assets::read_promised(file.by_ref(), claimed).map_err(|e| match e {
        assets::Error::SizeMismatch => Error::Corrupt(format!(
            "{name} expands past the {claimed} bytes it declares"
        )),
        other => Error::Asset(other),
    })?;
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    thread_local! {
        /// The seam [`compact`] exposes to T-375's race test: a closure run
        /// between the fold's read and its write, on this thread only. Tests
        /// each run on their own thread, so an installed hook cannot leak into
        /// a neighbour.
        pub(super) static MID_FOLD: std::cell::RefCell<Option<Box<dyn FnMut()>>> =
            const { std::cell::RefCell::new(None) };
    }

    /// The T-84 call shape: `write` with no pack id, so a fresh one is minted.
    ///
    /// A shim rather than an edit to thirty call sites, and that is the point —
    /// every test below is the one T-84 wrote, character for character, so what
    /// they still assert is evidence about this change rather than about a
    /// rewrite of them. The tests that are *about* the pack id call
    /// `super::write` directly.
    fn write(store: &AssetStore, spec: &Spec, snapshot: &[u8], dest: &Path) -> Result<Written> {
        super::write(store, spec, None, snapshot, dest)
    }

    /// A one-pixel PNG, so `ingest_bytes` has something it can actually probe.
    const PIXEL: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    fn store(dir: &tempfile::TempDir, name: &str) -> AssetStore {
        AssetStore::new(dir.path().join(name)).expect("store")
    }

    fn spec(assets: Vec<String>) -> Spec {
        Spec {
            schema_version: 1,
            title: "A board".into(),
            assets,
        }
    }

    /// Append the way the shell does: read where the file has got to, then
    /// append onto that.
    ///
    /// Every test in this module except the interleave ones is about something
    /// other than T-368's check, and threading a generation number through each
    /// of them by hand would be twenty chances to write the wrong one — and a
    /// wrong one would fail as an interleave, which is a confusing way to be told
    /// your fixture is off. The tests that *are* about the check call [`append`]
    /// directly, with the number stated.
    fn appended(
        store: &AssetStore,
        spec: &Spec,
        pack_id: &str,
        snapshot: &[u8],
        dest: &Path,
    ) -> Result<Written> {
        append(store, spec, pack_id, snapshot, dest, generation_of(dest)?)
    }

    /// The round trip ARCHITECTURE section 6 asks for: out of one machine's
    /// store and into another's, with nothing shared but the file.
    #[test]
    fn round_trips_through_a_second_store() {
        let dir = tempfile::tempdir().unwrap();
        let here = store(&dir, "here");
        let there = store(&dir, "there");

        let photo = here.ingest_bytes(PIXEL, None).unwrap();
        let other = here
            .ingest_bytes(b"not an image, still bytes", None)
            .unwrap();
        let snapshot = b"opaque document state".to_vec();

        let dest = dir.path().join("board.schizo");
        let written = write(
            &here,
            &spec(vec![photo.sha256.clone(), other.sha256.clone()]),
            &snapshot,
            &dest,
        )
        .unwrap();
        assert_eq!(written.embedded, 2);
        assert!(written.missing.is_empty());
        assert!(written.bytes > 0);
        assert!(dest.is_file());

        assert!(!there.has(&photo.sha256));
        let opened = read(&there, &dest).unwrap();
        assert_eq!(opened.snapshot, snapshot);
        assert_eq!(opened.manifest.title, "A board");
        assert_eq!(opened.manifest.schema_version, 1);
        assert!(opened.missing.is_empty());
        assert_eq!(opened.ingested.len(), 2);
        assert!(there.has(&photo.sha256));
        assert!(there.has(&other.sha256));
    }

    /// T-291, D-64. A transcript is deflated and a photograph is not, and the
    /// difference is measured on the archive rather than asserted about the
    /// code.
    #[test]
    fn compresses_what_is_worth_compressing_and_stores_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let here = store(&dir, "here");
        // Text that repeats, which is what a transcript is: an hour of subtitle
        // cues came out at 7% of itself on the real corpus.
        let cues =
            "1\n00:00:01,000 --> 00:00:04,000\nHe came up from Wexford on the Tuesday train.\n\n"
                .repeat(200);
        let transcript = here.ingest_bytes(cues.as_bytes(), None).unwrap();
        let photo = here.ingest_bytes(PIXEL, None).unwrap();

        let dest = dir.path().join("board.schizo");
        write(
            &here,
            &spec(vec![transcript.sha256.clone(), photo.sha256.clone()]),
            b"doc",
            &dest,
        )
        .unwrap();

        let mut zip = ZipArchive::new(BufReader::new(File::open(&dest).unwrap())).unwrap();
        let written = zip
            .by_name(&format!("{ASSET_PREFIX}{}", transcript.sha256))
            .unwrap();
        assert_eq!(written.compression(), CompressionMethod::Deflated);
        // And it actually paid — the reason the rule exists is the ratio, not
        // the method.
        assert!(
            written.compressed_size() < written.size() / 4,
            "{} of {}",
            written.compressed_size(),
            written.size()
        );
        drop(written);

        let stored = zip
            .by_name(&format!("{ASSET_PREFIX}{}", photo.sha256))
            .unwrap();
        // A PNG is already compressed. Deflating it spends the export proving
        // that and the entry comes out the size it started, or a shade larger.
        assert_eq!(stored.compression(), CompressionMethod::Stored);
        assert_eq!(stored.compressed_size(), stored.size());
    }

    /// The half of the compression rule that is easy to lose: the entry has to
    /// still be the file.
    #[test]
    fn a_deflated_asset_is_the_same_bytes_on_the_far_side() {
        let dir = tempfile::tempdir().unwrap();
        let here = store(&dir, "here");
        let there = store(&dir, "there");
        // Sixty-four bytes of it are read to decide the method, and a `rewind`
        // that was not there would drop exactly those from the entry — which
        // reading back is the only thing that catches, because the hash is
        // computed from the bytes rather than from the name.
        let words = "the same words, twice over, and again\n".repeat(50);
        let transcript = here.ingest_bytes(words.as_bytes(), None).unwrap();

        let dest = dir.path().join("board.schizo");
        write(&here, &spec(vec![transcript.sha256.clone()]), b"doc", &dest).unwrap();
        let opened = read(&there, &dest).unwrap();

        assert_eq!(opened.ingested, vec![transcript.sha256.clone()]);
        assert!(opened.missing.is_empty());
        assert!(there.has(&transcript.sha256));
    }

    /// T-291, Q-314: what it will weigh, before there is a file to measure.
    #[test]
    fn weighs_a_board_before_it_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let here = store(&dir, "here");
        let photo = here.ingest_bytes(PIXEL, None).unwrap();
        let other = here.ingest_bytes(b"a second file entirely", None).unwrap();

        let absent = "b".repeat(64);
        let forecast = weigh(
            &here,
            &spec(vec![
                photo.sha256.clone(),
                other.sha256.clone(),
                absent.clone(),
                // The same photograph twice is one entry, because `plan` sorts
                // and dedups exactly as the writer does.
                photo.sha256.clone(),
            ]),
        );
        assert_eq!(forecast.embedded, 2);
        assert_eq!(forecast.missing, 1);
        assert_eq!(forecast.bytes, photo.size + other.size);

        // And it is the bound it claims to be: the file that comes out carries
        // the snapshot and the zip's own overhead on top, and nothing in it
        // that was not weighed.
        let dest = dir.path().join("board.schizo");
        let written = write(
            &here,
            &spec(vec![photo.sha256.clone(), other.sha256.clone(), absent]),
            b"opaque document state",
            &dest,
        )
        .unwrap();
        assert_eq!(written.embedded, forecast.embedded);
        assert_eq!(written.missing.len(), forecast.missing);
    }

    /// The invariant that gives the format its one sentence in DATA-MODEL:
    /// every hash the manifest names is bytes you can actually get at.
    #[test]
    fn every_listed_asset_is_in_the_archive() {
        let dir = tempfile::tempdir().unwrap();
        let here = store(&dir, "here");
        let photo = here.ingest_bytes(PIXEL, None).unwrap();
        let dest = dir.path().join("board.schizo");
        write(&here, &spec(vec![photo.sha256.clone()]), b"doc", &dest).unwrap();

        let mut zip = ZipArchive::new(BufReader::new(File::open(&dest).unwrap())).unwrap();
        let manifest: Manifest = serde_json::from_slice(
            &entry(&mut zip, MANIFEST, MAX_MANIFEST_BYTES)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        for hash in &manifest.assets {
            assert!(
                entry(
                    &mut zip,
                    &format!("{ASSET_PREFIX}{hash}"),
                    assets::MAX_ASSET_BYTES
                )
                .unwrap()
                .is_some(),
                "{hash} is listed and not embedded"
            );
        }
    }

    /// A photograph that is only on a peer who has left (DESIGN 11.1, risk 4)
    /// must not make the board un-exportable.
    #[test]
    fn an_absent_asset_is_reported_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let here = store(&dir, "here");
        let photo = here.ingest_bytes(PIXEL, None).unwrap();
        let gone = "0".repeat(64);

        let dest = dir.path().join("board.schizo");
        let written = write(
            &here,
            &spec(vec![photo.sha256.clone(), gone.clone()]),
            b"doc",
            &dest,
        )
        .unwrap();

        assert_eq!(written.embedded, 1);
        assert_eq!(written.missing, vec![gone]);
        // And the manifest describes the file rather than the board, so a
        // reader is never told about something that is not there.
        let opened = read(&store(&dir, "there"), &dest).unwrap();
        assert_eq!(opened.manifest.assets, vec![photo.sha256]);
        assert!(opened.missing.is_empty());
    }

    /// The same board exported twice is the same manifest, whichever order the
    /// caller happened to walk its assets in.
    #[test]
    fn the_asset_list_is_sorted_and_deduped() {
        let dir = tempfile::tempdir().unwrap();
        let here = store(&dir, "here");
        let a = here.ingest_bytes(PIXEL, None).unwrap().sha256;
        let b = here.ingest_bytes(b"second", None).unwrap().sha256;

        let one = dir.path().join("one.schizo");
        let two = dir.path().join("two.schizo");
        write(
            &here,
            &spec(vec![a.clone(), b.clone(), a.clone()]),
            b"doc",
            &one,
        )
        .unwrap();
        write(&here, &spec(vec![b.clone(), a.clone()]), b"doc", &two).unwrap();

        let there = store(&dir, "there");
        let first = read(&there, &one).unwrap().manifest.assets;
        let second = read(&there, &two).unwrap().manifest.assets;
        assert_eq!(first, second);
        let mut expected = vec![a, b];
        expected.sort();
        assert_eq!(first, expected);
    }

    /// An entry named for one hash holding another's bytes is a tampered
    /// bundle, and it is refused before the store writes anything.
    #[test]
    fn bytes_that_are_not_what_they_are_named_for_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("liar.schizo");
        let claimed = assets::sha256_hex(PIXEL);

        {
            let mut zip = ZipWriter::new(File::create(&dest).unwrap());
            let plain = SimpleFileOptions::default();
            zip.start_file(MANIFEST, plain).unwrap();
            zip.write_all(
                &serde_json::to_vec(&Manifest {
                    format: FORMAT.into(),
                    pack_id: None,
                    schema_version: 1,
                    title: "Trust me".into(),
                    assets: vec![claimed.clone()],
                })
                .unwrap(),
            )
            .unwrap();
            zip.start_file(SNAPSHOT, plain).unwrap();
            zip.write_all(b"doc").unwrap();
            zip.start_file(format!("{ASSET_PREFIX}{claimed}"), plain)
                .unwrap();
            zip.write_all(b"these are somebody else's bytes").unwrap();
            zip.finish().unwrap();
        }

        let there = store(&dir, "there");
        let error = read(&there, &dest).unwrap_err();
        assert!(matches!(error, Error::Corrupt(_)), "{error}");
        // And nothing reached the store on the way to finding out.
        assert!(!there.has(&claimed));
        assert!(!there.has(&assets::sha256_hex(b"these are somebody else's bytes")));
    }

    /// An entry name is a filename until somebody joins it onto a path. Nothing
    /// here does, so a traversal entry is simply never read — the manifest is
    /// the only index.
    #[test]
    fn entries_the_manifest_does_not_list_are_never_touched() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("slippery.schizo");
        {
            let mut zip = ZipWriter::new(File::create(&dest).unwrap());
            let plain = SimpleFileOptions::default();
            zip.start_file(MANIFEST, plain).unwrap();
            zip.write_all(
                &serde_json::to_vec(&Manifest {
                    format: FORMAT.into(),
                    pack_id: None,
                    schema_version: 1,
                    title: "Nothing to see".into(),
                    assets: vec![],
                })
                .unwrap(),
            )
            .unwrap();
            zip.start_file(SNAPSHOT, plain).unwrap();
            zip.write_all(b"doc").unwrap();
            zip.start_file("../../escaped.txt", plain).unwrap();
            zip.write_all(b"owned").unwrap();
            zip.finish().unwrap();
        }

        let opened = read(&store(&dir, "there"), &dest).unwrap();
        assert!(opened.ingested.is_empty());
        assert!(!dir.path().parent().unwrap().join("escaped.txt").exists());
    }

    /// A hash-shaped thing that is not a hash never becomes a lookup.
    #[test]
    fn a_manifest_hash_that_is_not_a_hash_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("bad.schizo");
        {
            let mut zip = ZipWriter::new(File::create(&dest).unwrap());
            let plain = SimpleFileOptions::default();
            zip.start_file(MANIFEST, plain).unwrap();
            zip.write_all(
                &serde_json::to_vec(&Manifest {
                    format: FORMAT.into(),
                    pack_id: None,
                    schema_version: 1,
                    title: "..".into(),
                    assets: vec!["../../../etc/passwd".into()],
                })
                .unwrap(),
            )
            .unwrap();
            zip.start_file(SNAPSHOT, plain).unwrap();
            zip.write_all(b"doc").unwrap();
            zip.finish().unwrap();
        }
        let error = read(&store(&dir, "there"), &dest).unwrap_err();
        assert!(matches!(error, Error::Corrupt(_)), "{error}");
    }

    /// The format tag earns its place on a zip that *does* have a
    /// `manifest.json` — which is most of them. Web bundles, browser
    /// extensions and half of npm ship a file by that name, so "it has a
    /// manifest" is not evidence of anything and the tag is what the refusal
    /// actually rests on.
    ///
    /// Written after a mutation check: removing the `format` comparison
    /// altogether left every test green, because the only zip being refused
    /// had no manifest and was failing one step earlier.
    #[test]
    fn somebody_elses_manifest_is_not_a_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("webapp.zip");
        {
            let mut zip = ZipWriter::new(File::create(&dest).unwrap());
            let plain = SimpleFileOptions::default();
            zip.start_file(MANIFEST, plain).unwrap();
            zip.write_all(
                br#"{"format":"web-extension","schemaVersion":3,"title":"Toolbar","assets":[]}"#,
            )
            .unwrap();
            zip.start_file(SNAPSHOT, plain).unwrap();
            zip.write_all(b"not ours").unwrap();
            zip.finish().unwrap();
        }
        let error = read(&store(&dir, "there"), &dest).unwrap_err();
        assert!(matches!(error, Error::NotABundle(_)), "{error}");
    }

    /// And a `manifest.json` that is not even manifest-shaped is a parse
    /// failure rather than a panic.
    #[test]
    fn a_manifest_that_is_not_one_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("odd.schizo");
        {
            let mut zip = ZipWriter::new(File::create(&dest).unwrap());
            zip.start_file(MANIFEST, SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"[1, 2, 3]").unwrap();
            zip.finish().unwrap();
        }
        let error = read(&store(&dir, "there"), &dest).unwrap_err();
        assert!(matches!(error, Error::Json(_)), "{error}");
    }

    /// Somebody else's zip is refused as a file format, before any name in it
    /// has been believed.
    #[test]
    fn a_foreign_zip_is_not_a_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("holiday.zip");
        {
            let mut zip = ZipWriter::new(File::create(&dest).unwrap());
            zip.start_file("readme.txt", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"hello").unwrap();
            zip.finish().unwrap();
        }
        let error = read(&store(&dir, "there"), &dest).unwrap_err();
        assert!(matches!(error, Error::NotABundle(_)), "{error}");
    }

    /// Not a zip at all.
    #[test]
    fn a_file_that_is_not_a_zip_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.schizo");
        fs::write(&dest, PIXEL).unwrap();
        let error = read(&store(&dir, "there"), &dest).unwrap_err();
        assert!(matches!(error, Error::Zip(_)), "{error}");
    }

    /// The version is carried and never acted on — a bundle from a build that
    /// knows more than this one still opens, and the frontend decides.
    #[test]
    fn a_future_schema_version_is_carried_not_judged() {
        let dir = tempfile::tempdir().unwrap();
        let here = store(&dir, "here");
        let dest = dir.path().join("future.schizo");
        write(
            &here,
            &Spec {
                schema_version: 99,
                title: "From next year".into(),
                assets: vec![],
            },
            b"doc",
            &dest,
        )
        .unwrap();
        let opened = read(&store(&dir, "there"), &dest).unwrap();
        assert_eq!(opened.manifest.schema_version, 99);
    }

    /// A store with a hole in it exports cleanly.
    ///
    /// Not the same case as the one above: the document references the asset,
    /// the store *believes* it has it, and the file underneath has gone —
    /// interrupted collection, a half-restored backup, someone in the app data
    /// directory. It has to come out as a report rather than as an error for
    /// the same reason a departed peer's photograph does.
    #[test]
    fn an_asset_whose_file_has_gone_is_reported_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let here = store(&dir, "here");
        let photo = here.ingest_bytes(PIXEL, None).unwrap();
        fs::remove_file(here.original_path(&photo.sha256)).unwrap();

        let dest = dir.path().join("board.schizo");
        let written = write(&here, &spec(vec![photo.sha256.clone()]), b"doc", &dest).unwrap();
        assert_eq!(written.embedded, 0);
        assert_eq!(written.missing, vec![photo.sha256]);
        assert!(dest.is_file());
    }

    fn strays(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".part"))
            .collect()
    }

    /// The rename is the only moment `dest` is touched, so it is the only
    /// moment a previous export is at risk — and a failure there must leave
    /// both it and the temporary in the state they were in.
    ///
    /// A directory at the destination is the portable way to make a rename
    /// fail. The failures this stands in for — a disk filling, a drive going
    /// away mid-copy — are not reachable from a unit test on any platform, and
    /// the branch they would take is this one.
    #[test]
    fn a_failed_rename_leaves_no_wreckage() {
        let dir = tempfile::tempdir().unwrap();
        let here = store(&dir, "here");
        let photo = here.ingest_bytes(PIXEL, None).unwrap();

        let dest = dir.path().join("board.schizo");
        fs::create_dir(&dest).unwrap();
        fs::write(dest.join("occupied"), b"in the way").unwrap();

        let error = write(&here, &spec(vec![photo.sha256]), b"doc", &dest).unwrap_err();
        assert!(matches!(error, Error::Io(_)), "{error}");
        assert!(dest.join("occupied").is_file());
        assert!(strays(dir.path()).is_empty(), "{:?}", strays(dir.path()));
    }

    /// And a failure on the way *in* to the temporary is an error rather than
    /// an empty file at the destination.
    #[test]
    fn a_write_that_cannot_start_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let nowhere = dir.path().join("no").join("such").join("board.schizo");
        let error = write(&store(&dir, "here"), &spec(vec![]), b"doc", &nowhere).unwrap_err();
        assert!(matches!(error, Error::Io(_)), "{error}");
        assert!(!nowhere.exists());
        assert!(strays(dir.path()).is_empty());
    }

    /// The bound is on what comes *out* of the decompressor, not on what the
    /// header claims — a `.schizo` that says four kilobytes and expands forever
    /// is the oldest trick the format has.
    ///
    /// Exercised through `entry` with a small limit rather than by building a
    /// 256 MB bomb, because the limit is the argument and the mechanism is the
    /// same one at any size.
    #[test]
    fn an_entry_that_expands_past_its_bound_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("bomb.schizo");
        {
            let mut zip = ZipWriter::new(File::create(&dest).unwrap());
            zip.start_file(
                SNAPSHOT,
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
            )
            .unwrap();
            // Deflates to a few hundred bytes, so the archive on disk says
            // nothing about what reading it costs.
            zip.write_all(&vec![0u8; 4 * 1024 * 1024]).unwrap();
            zip.finish().unwrap();
        }
        assert!(fs::metadata(&dest).unwrap().len() < 64 * 1024);

        let mut zip = ZipArchive::new(BufReader::new(File::open(&dest).unwrap())).unwrap();
        let error = entry(&mut zip, SNAPSHOT, 1024).unwrap_err();
        assert!(matches!(error, Error::Corrupt(_)), "{error}");
        // And the same entry inside its bound is fine, so the refusal is the
        // size and not the entry.
        let taken = entry(&mut zip, SNAPSHOT, 8 * 1024 * 1024).unwrap().unwrap();

        // **Sized from what the entry declares, never from the limit.** Reading
        // it into a buffer the size of the *bound* would keep every peak in this
        // file at `MAX_ASSET_BYTES` — three quarters of a gigabyte to open a
        // bundle holding one photograph — and nothing else here would notice,
        // because the bytes that come back are identical either way. Capacity is
        // the only place the difference is visible.
        assert_eq!(taken.len(), 4 * 1024 * 1024);
        assert_eq!(
            taken.capacity(),
            taken.len(),
            "the entry was read into a buffer sized from something other than itself"
        );
    }

    // --- which file this is (T-359) -----------------------------------------

    /// A pack that is written for the first time is given a name of its own,
    /// and a pack being written *again* keeps the one it had. That difference
    /// is the whole of the register's key.
    #[test]
    fn a_pack_id_is_minted_when_there_is_none_and_kept_when_there_is() {
        let dir = tempfile::tempdir().unwrap();
        let here = store(&dir, "here");
        let dest = dir.path().join("board.schizo");

        let first = super::write(&here, &spec(vec![]), None, b"doc", &dest).unwrap();
        assert!(crate::board::is_pack_id(&first.pack_id));
        assert_eq!(
            peek(&dest).unwrap().pack_id.as_deref(),
            Some(first.pack_id.as_str())
        );

        // The same file written again — a flush, once a pack is the board.
        let again =
            super::write(&here, &spec(vec![]), Some(&first.pack_id), b"doc two", &dest).unwrap();
        assert_eq!(again.pack_id, first.pack_id);
        assert_eq!(peek(&dest).unwrap().pack_id, Some(first.pack_id));
    }

    /// **A copy is a different board**, and this is the rule that makes it one.
    ///
    /// Two files sharing a pack id are two files the register cannot tell
    /// apart: open the copy and you would be put in the original's sync room,
    /// holding a document that is not the one those peers have.
    #[test]
    fn a_copy_is_not_the_board_it_was_copied_from() {
        let dir = tempfile::tempdir().unwrap();
        let here = store(&dir, "here");
        let original = dir.path().join("original.schizo");
        let copy = dir.path().join("copy.schizo");

        let first = super::write(&here, &spec(vec![]), None, b"doc", &original).unwrap();
        // `bundle_save_as` passes `None`, which is what makes this true.
        let second = super::write(&here, &spec(vec![]), None, b"doc", &copy).unwrap();

        assert_ne!(first.pack_id, second.pack_id);
    }

    /// The additive half: a `.schizo` from before any of this has no `packId`
    /// key at all, and still opens.
    #[test]
    fn a_bundle_from_before_pack_ids_still_reads() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("old.schizo");
        {
            let mut zip = ZipWriter::new(File::create(&dest).unwrap());
            let plain = SimpleFileOptions::default();
            zip.start_file(MANIFEST, plain).unwrap();
            // Written out by hand rather than through `Manifest`, because the
            // thing under test is the *absent key* and a serialiser that
            // started emitting one would make this pass for the wrong reason.
            zip.write_all(
                br#"{"format":"schizoboard/bundle","schemaVersion":1,"title":"From before","assets":[]}"#,
            )
            .unwrap();
            zip.start_file(SNAPSHOT, plain).unwrap();
            zip.write_all(b"an older document").unwrap();
            zip.finish().unwrap();
        }

        let opened = read(&store(&dir, "there"), &dest).unwrap();
        assert_eq!(opened.manifest.pack_id, None);
        assert_eq!(opened.manifest.title, "From before");
        assert_eq!(opened.snapshot, b"an older document");
        assert_eq!(peek(&dest).unwrap().pack_id, None);
    }

    /// Bytes this machine already holds are not read out of the archive.
    ///
    /// **The oracle is a lie in the file.** The entry for the held hash carries
    /// somebody else's bytes, which `read` refuses as `Corrupt` the moment it
    /// looks — so an archive that opens cleanly is an archive whose entry was
    /// never opened. Asserting on `already` alone would pass just as well if
    /// the bytes had been decompressed, hashed and thrown away, which is the
    /// entire cost this exists to avoid.
    #[test]
    fn an_asset_this_machine_holds_is_never_read_out_of_the_archive() {
        let dir = tempfile::tempdir().unwrap();
        let here = store(&dir, "here");
        let held = here.ingest_bytes(PIXEL, None).unwrap().sha256;
        let fresh = assets::sha256_hex(b"bytes nobody here has yet");

        let dest = dir.path().join("board.schizo");
        {
            let mut zip = ZipWriter::new(File::create(&dest).unwrap());
            let plain = SimpleFileOptions::default();
            zip.start_file(MANIFEST, plain).unwrap();
            zip.write_all(
                &serde_json::to_vec(&Manifest {
                    format: FORMAT.into(),
                    pack_id: Some(crate::board::mint_pack_id()),
                    schema_version: 1,
                    title: "Two photographs".into(),
                    assets: vec![held.clone(), fresh.clone()],
                })
                .unwrap(),
            )
            .unwrap();
            zip.start_file(SNAPSHOT, plain).unwrap();
            zip.write_all(b"doc").unwrap();
            // Named for a hash this machine holds, holding something else.
            zip.start_file(format!("{ASSET_PREFIX}{held}"), plain)
                .unwrap();
            zip.write_all(b"these are somebody elses bytes").unwrap();
            zip.start_file(format!("{ASSET_PREFIX}{fresh}"), plain)
                .unwrap();
            zip.write_all(b"bytes nobody here has yet").unwrap();
            zip.finish().unwrap();
        }

        let opened = read(&here, &dest).unwrap();
        assert_eq!(opened.already, vec![held.clone()]);
        assert_eq!(opened.ingested, vec![fresh.clone()]);
        assert!(opened.missing.is_empty());

        // And the store still holds the real photograph rather than the lie.
        assert_eq!(fs::read(here.original_path(&held)).unwrap(), PIXEL);
        assert!(here.has(&fresh));
    }

    /// The other side of it: a machine holding none of them reads them all, so
    /// the skip is about what is held and not about the archive.
    #[test]
    fn a_machine_holding_none_of_them_reads_all_of_them() {
        let dir = tempfile::tempdir().unwrap();
        let here = store(&dir, "here");
        let photo = here.ingest_bytes(PIXEL, None).unwrap().sha256;
        let dest = dir.path().join("board.schizo");
        write(&here, &spec(vec![photo.clone()]), b"doc", &dest).unwrap();

        let there = store(&dir, "there");
        let opened = read(&there, &dest).unwrap();
        assert_eq!(opened.ingested, vec![photo.clone()]);
        assert!(opened.already.is_empty());

        // Opened a second time on the same machine, nothing is read again.
        let again = read(&there, &dest).unwrap();
        assert!(again.ingested.is_empty());
        assert_eq!(again.already, vec![photo]);
    }

    /// An asset in the thirty-day trash is **not** held, so it falls through to
    /// the ingest that restores it — the behaviour it had before the skip
    /// existed, and the one case where "the store knows this hash" and "the
    /// store has these bytes" are different questions.
    #[test]
    fn an_asset_in_the_trash_is_restored_rather_than_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let here = store(&dir, "here");
        let photo = here.ingest_bytes(PIXEL, None).unwrap().sha256;
        let dest = dir.path().join("board.schizo");
        write(&here, &spec(vec![photo.clone()]), b"doc", &dest).unwrap();

        here.gc(&HashSet::new()).unwrap();
        assert!(!here.has(&photo), "the sweep left the original in place");

        let opened = read(&here, &dest).unwrap();
        assert_eq!(opened.ingested, vec![photo.clone()]);
        assert!(opened.already.is_empty());
        assert!(here.has(&photo));
    }

    #[test]
    fn the_payload_frame_round_trips() {
        let joined = join_payload(br#"{"a":1}"#, b"\x00\x01\x02snapshot");
        let (json, bytes) = split_payload(&joined).unwrap();
        assert_eq!(json, br#"{"a":1}"#);
        assert_eq!(bytes, b"\x00\x01\x02snapshot");

        // An empty snapshot is a frame, an empty payload is not.
        let empty = join_payload(b"{}", b"");
        let (json, bytes) = split_payload(&empty).unwrap();
        assert_eq!(json, b"{}");
        assert!(bytes.is_empty());
        assert!(split_payload(b"").is_err());
        assert!(split_payload(b"\xff\xff\xff\xff").is_err());
    }

    #[test]
    fn peeking_reads_the_manifest_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let here = store(&dir, "here");
        let photo = here.ingest_bytes(PIXEL, None).unwrap();
        let dest = dir.path().join("board.schizo");
        write(&here, &spec(vec![photo.sha256.clone()]), b"doc", &dest).unwrap();

        let there = store(&dir, "there");
        let manifest = peek(&dest).unwrap();
        assert_eq!(manifest.title, "A board");
        assert_eq!(manifest.assets, vec![photo.sha256.clone()]);
        // The point of it: nobody's photographs arrive before anybody agrees.
        assert!(!there.has(&photo.sha256));
    }

    #[test]
    fn peeking_refuses_what_read_would_refuse() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("webapp.zip");
        {
            let mut zip = ZipWriter::new(File::create(&dest).unwrap());
            zip.start_file(MANIFEST, SimpleFileOptions::default())
                .unwrap();
            zip.write_all(
                br#"{"format":"web-extension","schemaVersion":3,"title":"x","assets":[]}"#,
            )
            .unwrap();
            zip.finish().unwrap();
        }
        assert!(matches!(peek(&dest).unwrap_err(), Error::NotABundle(_)));

        let plain = dir.path().join("photo.schizo");
        fs::write(&plain, PIXEL).unwrap();
        assert!(matches!(peek(&plain).unwrap_err(), Error::Zip(_)));
    }

    /// A title out of somebody else's file is about to be read out in the
    /// operating system's own voice, so it is reduced first.
    #[test]
    fn a_title_from_a_stranger_cannot_write_its_own_dialog() {
        assert_eq!(display_title("Murder wall"), "Murder wall");
        // A newline here is not a formatting problem — it is a second sentence
        // appearing above the buttons.
        assert_eq!(
            display_title("Holiday\n\nYour password has expired. Enter it below:"),
            "Holiday Your password has expired. Enter it below:"
        );
        assert_eq!(display_title("a\r\nb\tc\u{0}d"), "a b c d");
        assert_eq!(display_title("   "), "an untitled board");
        assert_eq!(display_title(""), "an untitled board");

        let long = display_title(&"wall ".repeat(200));
        assert!(long.chars().count() <= MAX_TITLE_CHARS + 1, "{long:?}");
        assert!(long.ends_with('…'), "{long:?}");

        // One unbroken word is truncated too, rather than surviving whole
        // because it never hit a space.
        let solid = display_title(&"x".repeat(400));
        assert!(solid.chars().count() <= MAX_TITLE_CHARS + 1, "{solid:?}");
    }

    /// An empty board is a board.
    #[test]
    fn a_board_with_no_photographs_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("empty.schizo");
        write(&store(&dir, "here"), &spec(vec![]), b"doc", &dest).unwrap();
        let opened = read(&store(&dir, "there"), &dest).unwrap();
        assert!(opened.manifest.assets.is_empty());
        assert_eq!(opened.snapshot, b"doc");
    }

    // --- generations (T-366) ------------------------------------------------

    /// AC-1023. The reader takes the highest `gen/<n>`, so what a pack holds is
    /// the last thing appended to it and never the first.
    #[test]
    fn the_newest_generation_is_the_board() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&store, &spec(vec![]), Some(&id), b"as of the export", &pack).unwrap();

        appended(&store, &spec(vec![]), &id, b"an hour later", &pack).unwrap();
        appended(&store, &spec(vec![]), &id, b"an hour after that", &pack).unwrap();

        let opened = read(&store, &pack).unwrap();
        assert_eq!(opened.snapshot, b"an hour after that");
        // And the pack id is the same file's throughout — a flush preserves it
        // where a copy mints one, which is what stops two files sharing a room.
        assert_eq!(opened.manifest.pack_id.as_deref(), Some(id.as_str()));
    }

    /// The generation is a number and the ordering has to be numeric, which
    /// `10` against `9` is the whole of: a lexicographic max would have stopped
    /// at nine and served an hour-old board for ever after.
    #[test]
    fn generations_are_ordered_as_numbers_and_not_as_names() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&store, &spec(vec![]), Some(&id), b"gen 0", &pack).unwrap();

        for n in 1..=11 {
            appended(&store, &spec(vec![]), &id, format!("gen {n}").as_bytes(), &pack).unwrap();
        }

        assert_eq!(read(&store, &pack).unwrap().snapshot, b"gen 11");
    }

    // --- two windows on one file (T-368) ------------------------------------

    /// AC-1032. A second instance is not stopped from opening the file — nothing
    /// can stop that — so what has to happen is that its append is *caught*
    /// rather than laid on top of work it never read.
    #[test]
    fn an_append_onto_somebody_else_s_writing_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&store, &spec(vec![]), Some(&id), b"the export", &pack).unwrap();

        // This window flushes, and believes the file is at generation 1.
        appended(&store, &spec(vec![]), &id, b"our afternoon", &pack).unwrap();
        // The other window flushes twice while we were not looking.
        appended(&store, &spec(vec![]), &id, b"their afternoon", &pack).unwrap();
        appended(&store, &spec(vec![]), &id, b"their evening", &pack).unwrap();

        let refused = append(&store, &spec(vec![]), &id, b"ours again", &pack, 1);

        assert!(
            matches!(refused, Err(Error::Interleaved { ours: 1, theirs: 3 })),
            "{refused:?}"
        );
    }

    /// The refusal has to happen **before** anything is written, or catching an
    /// interleave would be a way of causing one.
    #[test]
    fn a_refused_append_leaves_the_file_exactly_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&store, &spec(vec![]), Some(&id), b"the export", &pack).unwrap();
        appended(&store, &spec(vec![]), &id, b"theirs", &pack).unwrap();
        let before = fs::read(&pack).unwrap();

        assert!(append(&store, &spec(vec![]), &id, b"ours", &pack, 0).is_err());

        assert_eq!(fs::read(&pack).unwrap(), before);
        assert_eq!(read(&store, &pack).unwrap().snapshot, b"theirs");
    }

    /// A file whose newest generation is *lower* than ours — somebody else
    /// compacted it, or replaced it. The same fact arriving from the other
    /// direction, and refused on the same terms.
    #[test]
    fn an_append_onto_a_file_that_has_been_folded_up_under_us_is_refused_too() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&store, &spec(vec![]), Some(&id), b"the export", &pack).unwrap();
        appended(&store, &spec(vec![]), &id, b"one", &pack).unwrap();
        appended(&store, &spec(vec![]), &id, b"two", &pack).unwrap();
        // Their compaction: the generations fold away and the file is at zero.
        compact(&store, &id, &pack).unwrap();

        let refused = append(&store, &spec(vec![]), &id, b"ours", &pack, 2);

        assert!(
            matches!(refused, Err(Error::Interleaved { ours: 2, theirs: 0 })),
            "{refused:?}"
        );
    }

    /// **Opening somebody's `.schizo` is not an interleave**, which is the case
    /// that would have made this whole check unusable: a pack at generation five
    /// is one you have just caught up with, not one you are five behind on.
    #[test]
    fn taking_up_a_pack_somebody_else_wrote_is_catching_up_and_not_colliding() {
        let dir = tempfile::tempdir().unwrap();
        let theirs = store(&dir, "theirs");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&theirs, &spec(vec![]), Some(&id), b"their export", &pack).unwrap();
        for n in 1..=5 {
            appended(&theirs, &spec(vec![]), &id, format!("their {n}").as_bytes(), &pack).unwrap();
        }

        // What `note_generation` does the moment the board is taken up.
        let mine = store(&dir, "mine");
        let caught_up = generation_of(&pack).unwrap();
        assert_eq!(caught_up, 5);

        append(&mine, &spec(vec![]), &id, b"mine", &pack, caught_up).unwrap();
        assert_eq!(read(&mine, &pack).unwrap().snapshot, b"mine");
    }

    /// Zero for a pack with none, which is every `.schizo` written before T-366
    /// and every one just compacted — the same zero `append` expects to be told.
    #[test]
    fn a_pack_with_no_generations_is_at_generation_zero() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&store, &spec(vec![]), Some(&id), b"the export", &pack).unwrap();

        assert_eq!(generation_of(&pack).unwrap(), 0);

        appended(&store, &spec(vec![]), &id, b"one", &pack).unwrap();
        assert_eq!(generation_of(&pack).unwrap(), 1);
    }

    // --- a fold against a concurrent writer (T-375) --------------------------

    /// AC-1055, AC-1056, AC-1058. A generation appended between a fold's read
    /// and its rename survives, because the rename is refused.
    ///
    /// The race is constructed at the seam where it is decided: `expect_newest`
    /// *is* the fold's read, so an append landing after it is exactly an append
    /// landing mid-fold — no clock or thread needed. And the two beliefs here
    /// are both real, neither a register's: the folder's came out of the file it
    /// read, the appender's out of the file it appended to.
    #[test]
    fn a_generation_appended_during_a_fold_survives_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&store, &spec(vec![]), Some(&id), b"the export", &pack).unwrap();

        // The fold reads the file here: newest is 0, the document "the export".
        // The other instance's flush lands while the fold is rewriting:
        appended(&store, &spec(vec![]), &id, b"their flush", &pack).unwrap();

        let refused =
            write_expecting(&store, &spec(vec![]), Some(&id), b"the export", &pack, Some(0));

        assert!(
            matches!(refused, Err(Error::Interleaved { ours: 0, theirs: 1 })),
            "{refused:?}"
        );
        // Their flush is still the board — nothing went under a rename.
        assert_eq!(read(&store, &pack).unwrap().snapshot, b"their flush");
    }

    /// AC-1057. The writer whose generation the fold refused to take is not
    /// damaged by the refusal: its next flush appends as if the fold had never
    /// been tried, because it was not — the file is exactly as that writer left
    /// it.
    #[test]
    fn the_writer_a_fold_stood_down_for_keeps_writing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&store, &spec(vec![]), Some(&id), b"the export", &pack).unwrap();
        appended(&store, &spec(vec![]), &id, b"their flush", &pack).unwrap();
        let before = fs::read(&pack).unwrap();

        write_expecting(&store, &spec(vec![]), Some(&id), b"the export", &pack, Some(0))
            .unwrap_err();

        assert_eq!(fs::read(&pack).unwrap(), before);
        append(&store, &spec(vec![]), &id, b"their evening", &pack, 1).unwrap();
        assert_eq!(read(&store, &pack).unwrap().snapshot, b"their evening");
    }

    /// The refusal cleans up after itself: the temporary the fold had already
    /// filled does not stay behind beside the pack.
    #[test]
    fn a_refused_fold_leaves_no_temporary_beside_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&store, &spec(vec![]), Some(&id), b"the export", &pack).unwrap();
        appended(&store, &spec(vec![]), &id, b"their flush", &pack).unwrap();

        write_expecting(&store, &spec(vec![]), Some(&id), b"the export", &pack, Some(0))
            .unwrap_err();

        let strays: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name != "case one.schizo" && name != "mine")
            .collect();
        assert!(strays.is_empty(), "{strays:?}");
    }

    /// AC-1056, through `compact` itself rather than the seam underneath it: an
    /// append genuinely lands between the fold's read and its write, and the
    /// appended generation is what the file holds afterwards. This is the test
    /// that pins `compact` *passing* the newest it read — the three above would
    /// all survive a `compact` that handed `write_expecting` nothing.
    #[test]
    fn an_append_landing_mid_fold_survives_the_fold() {
        let dir = tempfile::tempdir().unwrap();
        // The other instance's store first, before the helper's name is
        // shadowed: its own `AssetStore` over the same directory, the way a
        // second process would hold one.
        let their_store = store(&dir, "mine");
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&store, &spec(vec![]), Some(&id), b"the export", &pack).unwrap();
        appended(&store, &spec(vec![]), &id, b"one", &pack).unwrap();

        // The other instance, striking between compact's read and its rename.
        let their_pack = pack.clone();
        let their_id = id.clone();
        MID_FOLD.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                appended(&their_store, &spec(vec![]), &their_id, b"their flush", &their_pack)
                    .unwrap();
            }))
        });
        let refused = compact(&store, &id, &pack);
        MID_FOLD.with(|hook| *hook.borrow_mut() = None);

        assert!(
            matches!(refused, Err(Error::Interleaved { ours: 1, theirs: 2 })),
            "{refused:?}"
        );
        assert_eq!(read(&store, &pack).unwrap().snapshot, b"their flush");
    }

    /// And a fold nobody raced does what it always did — `compact` hands
    /// `write_expecting` the newest it read, they agree, and the file folds.
    /// (Every `compact` test in this file exercises the same agreement; this
    /// one exists to pin it *with* generations in the file to fold away.)
    #[test]
    fn a_fold_nobody_raced_still_folds() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&store, &spec(vec![]), Some(&id), b"the export", &pack).unwrap();
        appended(&store, &spec(vec![]), &id, b"one", &pack).unwrap();
        appended(&store, &spec(vec![]), &id, b"two", &pack).unwrap();

        compact(&store, &id, &pack).unwrap();

        assert_eq!(generation_of(&pack).unwrap(), 0);
        assert_eq!(read(&store, &pack).unwrap().snapshot, b"two");
    }

    /// AC-1024. The point of appending rather than rewriting is that the bytes
    /// already in the file are not touched — so a stored photograph has to come
    /// back out of a pack that has been appended to, byte for byte.
    ///
    /// Fifty megabytes rather than a pixel, because the thing being asserted is
    /// that a *large* stored entry survives an append: the sizes and offsets in
    /// the central directory are what an append rewrites, and a small file
    /// would pass this without exercising the arithmetic that matters.
    #[test]
    fn a_stored_photograph_comes_back_unchanged_after_an_append() {
        let dir = tempfile::tempdir().unwrap();
        let mine = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();

        // Incompressible, so `Stored` is genuinely storing rather than the zip
        // quietly doing the work: a run of zeroes would deflate to nothing and
        // prove much less.
        let big: Vec<u8> = (0..50 * 1024 * 1024u32).map(|i| (i.wrapping_mul(2654435761) >> 24) as u8).collect();
        let photo = mine.ingest_bytes(&big, None).unwrap().sha256;

        super::write(&mine, &spec(vec![photo.clone()]), Some(&id), b"first", &pack).unwrap();
        appended(&mine, &spec(vec![photo.clone()]), &id, b"second", &pack).unwrap();

        // Still a zip, still readable, and on a machine that has never seen
        // those bytes — which is the only way to prove they came out of the file
        // rather than out of a store that already had them.
        let theirs = store(&dir, "theirs");
        let opened = read(&theirs, &pack).unwrap();
        assert_eq!(opened.snapshot, b"second");
        assert_eq!(opened.ingested, vec![photo.clone()]);
        assert!(opened.missing.is_empty());
        assert_eq!(std::fs::read(theirs.original_path(&photo)).unwrap(), big);
    }

    /// A photograph that arrived after the pack was written goes in with the
    /// generation that first references it, and one already in the file is not
    /// written twice — `insert_file_data` refuses a duplicate name, so this is
    /// an error rather than waste if it is got wrong.
    #[test]
    fn an_append_carries_only_the_photographs_the_file_does_not_have() {
        let dir = tempfile::tempdir().unwrap();
        let mine = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();

        let first = mine.ingest_bytes(PIXEL, None).unwrap().sha256;
        super::write(&mine, &spec(vec![first.clone()]), Some(&id), b"one", &pack).unwrap();
        let before = std::fs::metadata(&pack).unwrap().len();

        // The same board again: nothing new to carry.
        appended(&mine, &spec(vec![first.clone()]), &id, b"two", &pack).unwrap();
        let after_nothing_new = std::fs::metadata(&pack).unwrap().len();
        assert!(
            after_nothing_new - before < 4096,
            "an append that carried nothing new grew the file by {}",
            after_nothing_new - before
        );

        // And a photograph that arrived since.
        let second = mine.ingest_bytes(&[0u8; 40_000], None).unwrap().sha256;
        appended(&mine, &spec(vec![first.clone(), second.clone()]), &id, b"three", &pack).unwrap();

        let theirs = store(&dir, "theirs");
        let opened = read(&theirs, &pack).unwrap();
        assert_eq!(opened.snapshot, b"three");
        let mut got = opened.ingested;
        got.sort();
        let mut want = vec![first, second];
        want.sort();
        assert_eq!(got, want);
    }

    /// AC-1025, said out loud rather than left as a property of the corpus.
    ///
    /// Every `.schizo` written before T-366 is a pack with zero generations, so
    /// the fallback to `manifest.json` plus `snapshot.bin` is not a
    /// compatibility shim — it is what the reader does when there is nothing
    /// newer, which is also why T-84's round-trip tests above are untouched.
    #[test]
    fn a_pack_from_before_generations_reads_as_its_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let mine = store(&dir, "mine");
        let pack = dir.path().join("an old export.schizo");
        let photo = mine.ingest_bytes(PIXEL, None).unwrap().sha256;
        // Exactly what T-84 wrote: no pack id, no generations.
        write(&mine, &spec(vec![photo.clone()]), b"the old shape", &pack).unwrap();

        let theirs = store(&dir, "theirs");
        let opened = read(&theirs, &pack).unwrap();

        assert_eq!(opened.snapshot, b"the old shape");
        assert_eq!(opened.ingested, vec![photo]);
        assert_eq!(peek(&pack).unwrap().title, "A board");
    }

    /// AC-1027. A snapshot is opaque bytes from a document this module never
    /// reads, so it can contain anything at all — including the four bytes that
    /// end a zip. A reader that found its way about by scanning for those would
    /// be reading the document as though it were the archive.
    #[test]
    fn a_document_carrying_an_end_of_archive_signature_is_still_read() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();

        // `PK\x05\x06` and `PK\x03\x04` — the end of a central directory and the
        // start of a local file header — with a plausible tail behind each, so a
        // scan would not merely find them but believe them.
        let mut nasty = Vec::new();
        nasty.extend_from_slice(b"before");
        nasty.extend_from_slice(b"PK\x05\x06");
        nasty.extend_from_slice(&[0u8; 18]);
        nasty.extend_from_slice(b"PK\x03\x04");
        nasty.extend_from_slice(&[0u8; 26]);
        nasty.extend_from_slice(b"after");

        super::write(&store, &spec(vec![]), Some(&id), b"first", &pack).unwrap();
        appended(&store, &spec(vec![]), &id, &nasty, &pack).unwrap();

        assert_eq!(read(&store, &pack).unwrap().snapshot, nasty);

        // And once more, so the nasty generation is in the middle of the file
        // rather than at the end of it.
        appended(&store, &spec(vec![]), &id, b"third", &pack).unwrap();
        assert_eq!(read(&store, &pack).unwrap().snapshot, b"third");
    }

    /// A `gen/` entry that is not a number is a name from a file somebody else
    /// wrote. Ignored rather than refused — failing the open would let one junk
    /// entry make a board unopenable, and the numbers beside it are still good.
    #[test]
    fn a_generation_that_is_not_a_number_is_passed_over() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&store, &spec(vec![]), Some(&id), b"base", &pack).unwrap();
        appended(&store, &spec(vec![]), &id, b"the real one", &pack).unwrap();

        {
            let file = File::options().read(true).write(true).open(&pack).unwrap();
            let mut zip = ZipWriter::new_append(file).unwrap();
            for name in ["gen/../secrets", "gen/9999999999999999999", "gen/", "gen/2x"] {
                zip.start_file(name, SimpleFileOptions::default()).unwrap();
                zip.write_all(b"not a generation").unwrap();
            }
            zip.finish().unwrap();
        }

        assert_eq!(read(&store, &pack).unwrap().snapshot, b"the real one");
    }

    /// A photograph that arrived *after* the base write is listed only by the
    /// generation that carries it — so a top-up reading `manifest.json` would
    /// walk a list from before that photograph existed and quietly not restore
    /// it.
    ///
    /// That is T-363's hole reopening one layer up: the sweep trashes another
    /// board's photographs on the promise that reopening that board brings them
    /// back, and a top-up looking at the wrong manifest breaks the promise for
    /// exactly the photographs added most recently.
    #[test]
    fn a_top_up_restores_what_the_newest_generation_lists() {
        let dir = tempfile::tempdir().unwrap();
        let mine = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();

        let old = mine.ingest_bytes(PIXEL, None).unwrap().sha256;
        super::write(&mine, &spec(vec![old.clone()]), Some(&id), b"first", &pack).unwrap();
        // Arrived from a peer after the pack was written, and went in with the
        // generation that first referenced it.
        let fresh = mine.ingest_bytes(&[7u8; 20_000], None).unwrap().sha256;
        appended(&mine, &spec(vec![old.clone(), fresh.clone()]), &id, b"second", &pack).unwrap();

        let theirs = store(&dir, "theirs");
        let restored = top_up(&theirs, &pack).unwrap();

        let mut got = restored.ingested;
        got.sort();
        let mut want = vec![old, fresh];
        want.sort();
        assert_eq!(got, want, "the top-up read the wrong manifest");
        assert!(restored.missing.is_empty());
    }

    /// A `gen/<n>` is a manifest a stranger wrote just as surely as
    /// `manifest.json` is, and it has to pass the same gate. Otherwise the one
    /// entry in this format that is *not* checked is the one that decides what
    /// the whole file means.
    #[test]
    fn a_generation_whose_manifest_is_not_ours_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&store, &spec(vec![]), Some(&id), b"base", &pack).unwrap();

        // A generation claiming to be some other format entirely. Appended by
        // hand, because `append` could not produce one.
        {
            let file = File::options().read(true).write(true).open(&pack).unwrap();
            let mut zip = ZipWriter::new_append(file).unwrap();
            zip.start_file("gen/1", SimpleFileOptions::default()).unwrap();
            let json = br#"{"format":"somebody/else","schemaVersion":1,"title":"x","assets":[]}"#;
            zip.write_all(&join_payload(json, b"a document")).unwrap();
            zip.finish().unwrap();
        }

        // Refused rather than falling back to the base manifest below it.
        // Falling back would hand the caller a board as of an earlier moment
        // while reporting success, which is the one failure this format spends
        // its whole length preventing.
        assert!(matches!(read(&store, &pack), Err(Error::NotABundle(_))));
        assert!(matches!(top_up(&store, &pack), Err(Error::NotABundle(_))));
    }

    /// The same gate, on the count rather than the tag.
    #[test]
    fn a_generation_claiming_more_assets_than_a_board_has_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&store, &spec(vec![]), Some(&id), b"base", &pack).unwrap();

        {
            let file = File::options().read(true).write(true).open(&pack).unwrap();
            let mut zip = ZipWriter::new_append(file).unwrap();
            zip.start_file("gen/1", SimpleFileOptions::default()).unwrap();
            let assets: Vec<String> = (0..MAX_ASSETS + 1).map(|i| format!("{i:064x}")).collect();
            let manifest = Manifest {
                format: FORMAT.to_string(),
                pack_id: Some(id.clone()),
                schema_version: 1,
                title: "x".into(),
                assets,
            };
            let json = serde_json::to_vec(&manifest).unwrap();
            zip.write_all(&join_payload(&json, b"a document")).unwrap();
            zip.finish().unwrap();
        }

        assert!(matches!(read(&store, &pack), Err(Error::Corrupt(_))));
    }

    // --- compaction (T-367) --------------------------------------------------

    /// AC-1029. The file shrinks, has no generations left, and reads the same
    /// board — which is the whole of what a compaction promises.
    #[test]
    fn compaction_reclaims_the_generations_and_keeps_the_board() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&store, &spec(vec![]), Some(&id), b"the export", &pack).unwrap();

        // A working afternoon: ten flushes, each superseding the one before.
        for n in 1..=10 {
            let doc = format!("an afternoon, at {n}").repeat(200);
            appended(&store, &spec(vec![]), &id, doc.as_bytes(), &pack).unwrap();
        }
        let grown = std::fs::metadata(&pack).unwrap().len();
        let newest = read(&store, &pack).unwrap().snapshot;

        let tidied = compact(&store, &id, &pack).unwrap();

        let after = std::fs::metadata(&pack).unwrap().len();
        assert!(after < grown, "{after} is not smaller than {grown}");
        assert_eq!(tidied.written.bytes, after);
        // What the row says, and it is a fraction rather than a byte count
        // because `lib/filesize.ts` floors at 1 MB — right for a file somebody
        // is handing over, and uninformative about eight kilobytes becoming one.
        assert!(tidied.reclaimed > 0.5, "reclaimed {}", tidied.reclaimed);
        // Not one generation left, so what a compaction emits is the shape T-84
        // wrote in the first place — and every test above this one is therefore
        // a test of a compacted pack.
        let zip = ZipArchive::new(BufReader::new(File::open(&pack).unwrap())).unwrap();
        assert!(
            !zip.file_names().any(|n| n.starts_with(GEN_PREFIX)),
            "{:?}",
            zip.file_names().collect::<Vec<_>>()
        );
        drop(zip);

        // The same board, and the same file.
        let reopened = read(&store, &pack).unwrap();
        assert_eq!(reopened.snapshot, newest);
        assert_eq!(reopened.manifest.pack_id.as_deref(), Some(id.as_str()));
        // And it is a pack again rather than a finished thing: the next flush
        // starts a fresh generation 1.
        appended(&store, &spec(vec![]), &id, b"the evening", &pack).unwrap();
        assert_eq!(read(&store, &pack).unwrap().snapshot, b"the evening");
    }

    /// **The line that makes a compaction safe rather than a way to lose a
    /// board.** `write` embeds what it finds in the *store*, so compacting a
    /// pack whose photographs this machine has swept — which is what happens to
    /// every board you are not currently on — would write a file without them
    /// and report success. The pack is the only copy by then.
    #[test]
    fn compaction_does_not_drop_a_photograph_this_machine_has_swept() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        let photo = store.ingest_bytes(PIXEL, None).unwrap().sha256;
        super::write(&store, &spec(vec![photo.clone()]), Some(&id), b"first", &pack).unwrap();
        appended(&store, &spec(vec![photo.clone()]), &id, b"second", &pack).unwrap();

        // The sweep, while this window was on some other board.
        store.gc(&HashSet::new()).unwrap();
        assert!(!store.has(&photo), "the sweep should have trashed it");

        let tidied = compact(&store, &id, &pack).unwrap();

        assert_eq!(tidied.written.embedded, 1);
        assert!(tidied.written.missing.is_empty(), "{:?}", tidied.written.missing);
        // And it is genuinely in the file, on a machine that has never held it.
        let theirs = AssetStore::new(dir.path().join("theirs")).unwrap();
        let opened = read(&theirs, &pack).unwrap();
        assert_eq!(opened.ingested, vec![photo]);
        assert_eq!(opened.snapshot, b"second");
    }

    /// The other half of reclaiming: a photograph the board has stopped
    /// referring to does not go into the new file.
    #[test]
    fn compaction_leaves_behind_a_photograph_the_board_no_longer_refers_to() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        let kept = store.ingest_bytes(PIXEL, None).unwrap().sha256;
        let dropped = store.ingest_bytes(&[3u8; 30_000], None).unwrap().sha256;

        super::write(
            &store,
            &spec(vec![kept.clone(), dropped.clone()]),
            Some(&id),
            b"both",
            &pack,
        )
        .unwrap();
        // Somebody took it off the board, so the newest generation stops listing it.
        appended(&store, &spec(vec![kept.clone()]), &id, b"one of them", &pack).unwrap();

        compact(&store, &id, &pack).unwrap();

        let zip = ZipArchive::new(BufReader::new(File::open(&pack).unwrap())).unwrap();
        let names: Vec<&str> = zip.file_names().collect();
        assert!(names.contains(&format!("{ASSET_PREFIX}{kept}").as_str()), "{names:?}");
        assert!(!names.contains(&format!("{ASSET_PREFIX}{dropped}").as_str()), "{names:?}");
    }

    /// Q-350's number, and what it is measured against.
    #[test]
    fn what_a_compaction_would_reclaim_is_the_superseded_generations() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        super::write(&store, &spec(vec![]), Some(&id), b"the export", &pack).unwrap();

        // Nothing superseded yet, so nothing to reclaim — which is also what a
        // pack that has just been compacted reads as.
        assert_eq!(reclaimable(&pack).unwrap(), 0.0);
        appended(&store, &spec(vec![]), &id, &vec![b'a'; 40_000], &pack).unwrap();
        assert_eq!(reclaimable(&pack).unwrap(), 0.0, "one generation supersedes nothing");

        for _ in 0..8 {
            appended(&store, &spec(vec![]), &id, &vec![b'b'; 40_000], &pack).unwrap();
        }
        let waste = reclaimable(&pack).unwrap();
        assert!(waste > COMPACT_AT, "a board of documents should cross it: {waste}");
        assert!(worth_compacting(&pack));

        compact(&store, &id, &pack).unwrap();
        assert_eq!(reclaimable(&pack).unwrap(), 0.0);
        // And straight away it is not worth doing again, which is what stops a
        // switch rewriting a file it has just rewritten.
        assert!(!worth_compacting(&pack));
    }

    /// The board the threshold exists for. A pack that is mostly photographs
    /// barely moves however long somebody works on it — which is exactly the
    /// board where rewriting the whole file on the way out would hurt.
    #[test]
    fn a_pack_that_is_mostly_photographs_does_not_cross_the_threshold() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir, "mine");
        let pack = dir.path().join("case one.schizo");
        let id = crate::board::mint_pack_id();
        // Incompressible, so it is genuinely stored rather than deflated away.
        let big: Vec<u8> = (0..4 * 1024 * 1024u32)
            .map(|i| (i.wrapping_mul(2654435761) >> 24) as u8)
            .collect();
        let photo = store.ingest_bytes(&big, None).unwrap().sha256;
        super::write(&store, &spec(vec![photo.clone()]), Some(&id), b"first", &pack).unwrap();

        for _ in 0..20 {
            appended(&store, &spec(vec![photo.clone()]), &id, &vec![b'c'; 20_000], &pack).unwrap();
        }

        let waste = reclaimable(&pack).unwrap();
        assert!(waste < COMPACT_AT, "a board of photographs crossed it at {waste}");
        // So leaving it does not rewrite four megabytes to reclaim a few
        // hundred kilobytes of superseded document.
        assert!(!worth_compacting(&pack));

        // And a file that is not there, or will not open, is not worth
        // rewriting either - housekeeping does not get to guess.
        assert!(!worth_compacting(&dir.path().join("nothing.schizo")));
        let rubbish = dir.path().join("rubbish.schizo");
        std::fs::write(&rubbish, b"not a zip").unwrap();
        assert!(!worth_compacting(&rubbish));
    }
}
