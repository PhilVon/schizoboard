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
use std::io::{self, BufReader, BufWriter, Read, Write};
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
    pub embedded: usize,
    /// Referenced by the board, absent from this disk, and therefore absent
    /// from the file. Empty is the normal case and the one worth not
    /// announcing.
    pub missing: Vec<String>,
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
    /// Hashes now in this machine's store, whether they arrived just now or
    /// were already here.
    pub ingested: Vec<String>,
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
pub fn join_payload(json: &[u8], bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + json.len() + bytes.len());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(json);
    out.extend_from_slice(bytes);
    out
}

// --- writing ----------------------------------------------------------------

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
pub fn write(store: &AssetStore, spec: &Spec, snapshot: &[u8], dest: &Path) -> Result<Written> {
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

    let manifest = Manifest {
        format: FORMAT.to_string(),
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
        zip.start_file(format!("{ASSET_PREFIX}{hash}"), stored)?;
        // The original, byte for byte — the same variant `asset_export` saves,
        // and the only one that can be named by this hash. Variants are a
        // local derivative and are rebuilt on the far side.
        let mut source = File::open(store.original_path(hash))?;
        io::copy(&mut source, &mut zip)?;
    }

    let mut file = zip.finish()?;
    file.flush()?;
    let file = file.into_inner().map_err(|e| Error::Io(e.into_error()))?;
    let bytes = file.metadata()?.len();
    file.sync_all()?;
    Ok(bytes)
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
    let mut missing = Vec::new();
    let mut seen = HashSet::new();
    for hash in &manifest.assets {
        if !assets::valid_hash(hash) {
            return Err(Error::Corrupt(format!("{hash:?} is not a sha256")));
        }
        if !seen.insert(hash.as_str()) {
            continue;
        }
        let Some(bytes) = entry(&mut zip, &format!("{ASSET_PREFIX}{hash}"), assets::MAX_ASSET_BYTES)?
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
    let mut bytes = Vec::new();
    file.by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(Error::Io)?;
    if bytes.len() as u64 > limit {
        return Err(Error::Corrupt(format!(
            "{name} expands past {limit} bytes"
        )));
    }
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let other = here.ingest_bytes(b"not an image, still bytes", None).unwrap();
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
        let manifest: Manifest =
            serde_json::from_slice(&entry(&mut zip, MANIFEST, MAX_MANIFEST_BYTES).unwrap().unwrap())
                .unwrap();
        for hash in &manifest.assets {
            assert!(
                entry(&mut zip, &format!("{ASSET_PREFIX}{hash}"), assets::MAX_ASSET_BYTES)
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
        write(&here, &spec(vec![a.clone(), b.clone(), a.clone()]), b"doc", &one).unwrap();
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
                    schema_version: 1,
                    title: "Trust me".into(),
                    assets: vec![claimed.clone()],
                })
                .unwrap(),
            )
            .unwrap();
            zip.start_file(SNAPSHOT, plain).unwrap();
            zip.write_all(b"doc").unwrap();
            zip.start_file(format!("{ASSET_PREFIX}{claimed}"), plain).unwrap();
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
        assert!(entry(&mut zip, SNAPSHOT, 8 * 1024 * 1024).unwrap().is_some());
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
