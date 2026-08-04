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

/// The other direction, for a response.
///
/// Uncalled since T-360 took `bundle_open` out — nothing hands a document *back*
/// across the boundary any more, because a board is opened by pointing this
/// window's log at it rather than by shipping its snapshot to the webview. Kept
/// rather than deleted because T-366's generations are this exact framing: a
/// flush appends one `gen/<n>` entry holding `[u32 le json len][json][snapshot]`,
/// which is this function and [`split_payload`] verbatim, tests and all.
#[allow(dead_code)]
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
    let raw = entry(&mut zip, MANIFEST, MAX_MANIFEST_BYTES)?
        .ok_or_else(|| Error::NotABundle(format!("no {MANIFEST}")))?;
    let manifest: Manifest =
        serde_json::from_slice(&raw).map_err(|e| Error::Json(e.to_string()))?;
    if manifest.format != FORMAT {
        return Err(Error::NotABundle(format!(
            "its format is {:?}, not {FORMAT:?}",
            manifest.format
        )));
    }
    Ok(manifest)
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

    let manifest: Manifest = {
        let raw = entry(&mut zip, MANIFEST, MAX_MANIFEST_BYTES)?
            .ok_or_else(|| Error::NotABundle(format!("no {MANIFEST}")))?;
        serde_json::from_slice(&raw).map_err(|e| Error::Json(e.to_string()))?
    };
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

    let snapshot = entry(&mut zip, SNAPSHOT, MAX_SNAPSHOT_BYTES)?
        .ok_or_else(|| Error::NotABundle(format!("no {SNAPSHOT}")))?;

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
            &mut zip,
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

    Ok(Opened {
        manifest,
        snapshot,
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
}
