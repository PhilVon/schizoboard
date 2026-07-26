//! The content-addressed asset store.
//!
//! > **Rust owns bytes.** The content-addressed asset store, hashing, decode,
//! > EXIF orientation, and generated variants — a thumbnail, a display-size
//! > version, and the untouched original. Heavy decode runs on a thread pool;
//! > the UI thread never sees a multi-megabyte buffer.
//! > — docs/ARCHITECTURE.md section 4.1
//!
//! Nothing in this file knows what an item, a pin or a board is. It sees
//! hashes and bytes, which is the whole of the split in section 4.2: Rust owns
//! bytes, the frontend owns meaning. That is also why there is no metadata
//! sidecar on disk — `{w, h, mime, size}` lives in the document, and a second
//! copy here would be a schema this side is not allowed to have.
//!
//! ## The property the whole design exists to protect
//!
//! > Because `w` and `h` are in the document, **an item is fully formed and
//! > fully usable before its bytes arrive.** — D-6
//!
//! So ingestion returns as soon as the hash and the dimensions are known, and
//! the dimensions come from a *header probe*, not a decode: a 40-megapixel JPEG
//! gives up its size in microseconds and takes the better part of a second to
//! decode. The decode, the orientation fix and the two variants all happen
//! afterwards on a background thread, and the frontend hears about them through
//! `asset:ready`.
//!
//! ## Layout
//!
//! ```text
//! assets/<aa>/<bb>/<sha256>              the original, byte for byte
//! assets/<aa>/<bb>/<sha256>.display.jpg  (or .png, when alpha is in use)
//! assets/<aa>/<bb>/<sha256>.thumb.jpg
//! assets/.trash/<secs>.<sha256>...       deleted, recoverable for thirty days
//! ```
//!
//! The trash carries its arrival time in the *name*. `rename` preserves the
//! inode's mtime on every filesystem this runs on, so dating a trashed file
//! from its metadata would purge a photograph added a year ago in the same call
//! that deleted it.
//!
//! Two levels of fan-out from the hash's first four hex digits, because a flat
//! directory of a few thousand entries is slow to enumerate on every filesystem
//! anyone will run this on.

use std::borrow::Cow;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use image::imageops::FilterType;
use image::{DynamicImage, ImageReader};
use serde::Serialize;
use sha2::{Digest, Sha256};
// `unversioned` is ureq's own word for "this API does not follow semver yet".
// Worth the exposure: it is the only way to be the thing that resolves a
// hostname, and being that thing is what closes the gap below. The surface used
// here is three items wide and the crate commits to breaking it only in minor
// versions.
use ureq::config::Config;
use ureq::http::Uri;
use ureq::unversioned::resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{DefaultConnector, NextTimeout};

/// Longest edge of the display variant, in pixels.
///
/// A 320-unit polaroid at the 400% zoom ceiling on a 2x display is about 2560
/// device pixels across, so this is the point past which extra source detail
/// cannot reach the screen. Anything sharper is available as `original`.
const DISPLAY_MAX_EDGE: u32 = 2560;

/// Longest edge of the thumbnail. Feeds the flat-rectangle treatment below 15%
/// zoom (DESIGN section 9.1) and, later, search results.
const THUMB_MAX_EDGE: u32 = 256;

const JPEG_QUALITY_DISPLAY: u8 = 88;
const JPEG_QUALITY_THUMB: u8 = 78;

/// How long a collected asset stays recoverable — DATA-MODEL section 10.
const TRASH_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;

/// How long a `.part` file has to sit untouched before it is assumed to be the
/// wreckage of an interrupted write rather than a write in progress.
const TEMP_TTL: Duration = Duration::from_secs(60 * 60);

/// Read in one go rather than streamed, above which the caller is doing
/// something other than putting a photograph on a corkboard.
const MAX_ASSET_BYTES: u64 = 512 * 1024 * 1024;

/// Redirect hops [`AssetStore::ingest_url`] will follow, checking each one.
const MAX_REDIRECTS: u8 = 3;

/// What ingestion returns. Note what is *not* here: the bytes.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AssetMeta {
    pub sha256: String,
    pub w: u32,
    pub h: u32,
    pub mime: String,
    pub size: u64,
}

/// The answer to "what file is behind this URL".
pub struct Resolved {
    pub path: PathBuf,
    pub mime: String,
    /// True when this is the variant that was actually asked for. False means
    /// the original is standing in until the downscale finishes, and the answer
    /// is therefore temporary.
    pub exact: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    Thumb,
    Display,
    Original,
}

impl Variant {
    /// The `?v=` query the frontend sends. Anything unrecognised is `display`,
    /// which is the one every `<img>` on the board asks for.
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("thumb") => Variant::Thumb,
            Some("original") => Variant::Original,
            _ => Variant::Display,
        }
    }

    fn suffix(self) -> &'static str {
        match self {
            Variant::Thumb => "thumb",
            Variant::Display => "display",
            Variant::Original => "",
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    Io(io::Error),
    /// The hash is not 64 lowercase hex characters. Refused before it is ever
    /// turned into a path — this is the only thing standing between a remote
    /// peer and `../../`.
    BadHash,
    NotFound,
    TooLarge(u64),
    Undecodable(String),
    Fetch(String),
    /// The store itself is not there — the app data directory could not be
    /// created at startup.
    Unavailable(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Io(e) => write!(f, "{e}"),
            Error::BadHash => write!(f, "not a sha256"),
            Error::NotFound => write!(f, "no such asset"),
            Error::TooLarge(n) => write!(f, "{n} bytes is too large for one asset"),
            Error::Undecodable(why) => write!(f, "could not decode: {why}"),
            Error::Fetch(why) => write!(f, "could not fetch: {why}"),
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

/// A hash is about to become a path, so it is checked as if it came from a
/// hostile peer — because over sync, one day, it will have.
fn valid_hash(sha256: &str) -> bool {
    sha256.len() == 64
        && sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Is this address out on the internet, rather than somewhere inside the
/// user's machine or network?
fn is_routable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || a == 0
                // 100.64/10 carrier-grade NAT and 240/4 reserved.
                || (a == 100 && (v4.octets()[1] & 0xc0) == 64)
                || (a & 0xf0) == 240)
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                // Unique local, fc00::/7.
                || (first & 0xfe00) == 0xfc00
                // Link local, fe80::/10.
                || (first & 0xffc0) == 0xfe80
                // An IPv4 address wearing a hat.
                || v6.to_ipv4_mapped().is_some_and(|v4| !is_routable(IpAddr::V4(v4))))
        }
    }
}

/// The rule, in one place so the two things that apply it cannot drift apart:
/// refuse unless **every** address is out on the internet. Returns the first one
/// that is not, for the error message.
///
/// Every address, not any: a name that answers with one public and one private
/// address is still a way in.
fn first_unroutable(addresses: &[SocketAddr]) -> Option<IpAddr> {
    addresses
        .iter()
        .map(|address| address.ip())
        .find(|ip| !is_routable(*ip))
}

/// The only thing in this process that turns a hostname into an address for a
/// fetch — and therefore the only place the rule above can be enforced without a
/// race.
///
/// This is the fix for the gap [`AssetStore::ingest_url`] used to document. A
/// pre-flight lookup can only ever check a *different* lookup's answer: the HTTP
/// client resolves again when it connects, and a name that answers differently
/// the second time — DNS rebinding, a zero-TTL record flipped between the two —
/// reaches an address the check never saw. ureq connects to exactly what its
/// resolver returns, so being the resolver closes it. One lookup, checked, and
/// connected to.
///
/// It also applies to every redirect hop for free, which the pre-flight only
/// managed because `ingest_url` follows redirects by hand to make it.
#[derive(Debug, Default)]
struct PublicOnlyResolver(DefaultResolver);

impl Resolver for PublicOnlyResolver {
    fn resolve(
        &self,
        uri: &Uri,
        config: &Config,
        timeout: NextTimeout,
    ) -> std::result::Result<ResolvedSocketAddrs, ureq::Error> {
        // `DefaultResolver` already guarantees at least one address or
        // `HostNotFound`, and truncates to the 16 ureq is willing to try. Sixteen
        // is also therefore the complete set it can connect to, so checking what
        // it returned checks everything reachable — which the old pre-flight,
        // checking an unbounded list nobody was going to use, did not.
        let addresses = self.0.resolve(uri, config, timeout)?;
        if let Some(ip) = first_unroutable(&addresses) {
            // Io with PermissionDenied is what ureq asks a bespoke chain to use
            // when it wants to say *why* rather than just "connection failed".
            return Err(ureq::Error::Io(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{ip} is not a public address"),
            )));
        }
        Ok(addresses)
    }
}

/// The agent every URL ingestion goes through.
///
/// Separate from [`AssetStore::ingest_url`] so a test can prove that the
/// resolver's refusal survives ureq's connect path and comes back out as
/// something legible — which is not provable through `ingest_url`, because
/// `check_fetchable` gets there first for every URL a test could name.
fn fetch_agent() -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        // Followed by hand by the caller, so each hop can be checked.
        .max_redirects(0)
        .build();
    // `with_parts` rather than `Config::into()`: it is the only constructor that
    // takes a resolver, and the resolver is the whole point.
    ureq::Agent::with_parts(
        config,
        DefaultConnector::default(),
        PublicOnlyResolver::default(),
    )
}

/// A ureq error, made presentable.
///
/// The refusal above arrives as an io error, and "io: 10.0.0.1 is not a public
/// address" reads like a plumbing failure rather than the deliberate decision it
/// is. This is user-facing: it ends up in the frontend when a paste fails.
fn fetch_error(e: ureq::Error) -> Error {
    match &e {
        ureq::Error::Io(source) if source.kind() == io::ErrorKind::PermissionDenied => {
            Error::Fetch(source.to_string())
        }
        _ => Error::Fetch(e.to_string()),
    }
}

/// Refuse a URL that is not http(s), or whose host is anywhere but the public
/// internet. Resolved rather than pattern-matched, because `localtest.me` and
/// friends are ordinary names that answer with 127.0.0.1.
///
/// **This is a courtesy, not the boundary.** [`PublicOnlyResolver`] is the
/// boundary; it cannot be bypassed by a name that changes its answer, and this
/// can. What this buys is a clear refusal before any socket work happens, and a
/// scheme check that has to happen at the URL level because a resolver never
/// sees `file:///etc/passwd`. Deleting it would weaken the error messages and
/// nothing else — and deleting the resolver would remove the guarantee entirely,
/// so if one of the two has to go, it is this one.
fn check_fetchable(url: &str) -> Result<()> {
    let uri: Uri = url
        .parse()
        .map_err(|_| Error::Fetch("not a URL".to_string()))?;
    let https = match uri.scheme_str() {
        Some("http") => false,
        Some("https") => true,
        _ => return Err(Error::Fetch("only http and https".to_string())),
    };
    let host = uri
        .host()
        .ok_or_else(|| Error::Fetch("no host".to_string()))?;
    let port = uri.port_u16().unwrap_or(if https { 443 } else { 80 });

    let addresses: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|e| Error::Fetch(format!("{host}: {e}")))?
        .collect();
    if addresses.is_empty() {
        return Err(Error::Fetch(format!("{host} resolves to nothing")));
    }
    if let Some(ip) = first_unroutable(&addresses) {
        return Err(Error::Fetch(format!("{host} is {ip}, not a public address")));
    }
    Ok(())
}

/// Magic numbers, not the caller's word for it. A browser's idea of a
/// clipboard item's type is a hint; the first eight bytes are evidence.
pub fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// The EXIF orientation tag, 1–8. Absent, unreadable or out of range is 1.
fn exif_orientation(bytes: &[u8]) -> u32 {
    let mut cursor = io::Cursor::new(bytes);
    let Ok(reader) = exif::Reader::new().read_from_container(&mut cursor) else {
        return 1;
    };
    reader
        .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|field| field.value.get_uint(0))
        .filter(|v| (1..=8).contains(v))
        .unwrap_or(1)
}

/// Orientations 5–8 put the image on its side, so the stored width is the
/// displayed height. Getting this wrong creates every item from a phone
/// photograph in the wrong shape, and nothing later can recover it — the
/// document has already been told the aspect ratio.
fn swaps_axes(orientation: u32) -> bool {
    matches!(orientation, 5..=8)
}

fn apply_orientation(image: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        5 => image.rotate90().fliph(),
        6 => image.rotate90(),
        7 => image.rotate270().fliph(),
        8 => image.rotate270(),
        _ => image,
    }
}

/// Dimensions without decoding. Every format here carries its size in a header
/// a few dozen bytes long.
fn probe_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    let reader = ImageReader::new(io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(Error::Io)?;
    let (w, h) = reader
        .into_dimensions()
        .map_err(|e| Error::Undecodable(e.to_string()))?;
    Ok(if swaps_axes(exif_orientation(bytes)) {
        (h, w)
    } else {
        (w, h)
    })
}

fn hex(digest: &[u8]) -> String {
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Does the alpha channel actually do anything? A screenshot is RGBA and
/// completely opaque, and encoding it as a lossless PNG because of a channel
/// nobody used costs an order of magnitude in file size.
fn uses_alpha(image: &DynamicImage) -> bool {
    if !image.color().has_alpha() {
        return false;
    }
    match image.as_rgba8() {
        Some(buffer) => buffer.pixels().any(|p| p.0[3] != u8::MAX),
        // Sixteen-bit or greyscale-plus-alpha. Rare enough that paying for a
        // lossless encode beats scanning it in three more representations, and
        // guessing wrong the other way silently flattens transparency.
        None => true,
    }
}

pub struct AssetStore {
    root: PathBuf,
}

impl AssetStore {
    /// `root` is the `assets` directory itself, created if it is not there.
    pub fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    fn dir_for(&self, sha256: &str) -> PathBuf {
        self.root.join(&sha256[0..2]).join(&sha256[2..4])
    }

    fn path_for(&self, sha256: &str, variant: Variant, ext: &str) -> PathBuf {
        let name = match variant {
            Variant::Original => sha256.to_string(),
            other => format!("{sha256}.{}{ext}", other.suffix()),
        };
        self.dir_for(sha256).join(name)
    }

    pub fn original_path(&self, sha256: &str) -> PathBuf {
        self.path_for(sha256, Variant::Original, "")
    }

    fn trash_dir(&self) -> PathBuf {
        self.root.join(".trash")
    }

    pub fn has(&self, sha256: &str) -> bool {
        valid_hash(sha256) && self.original_path(sha256).is_file()
    }

    // --- ingestion ----------------------------------------------------------

    /// Hash, probe, store. **Returns as soon as the hash and the dimensions are
    /// known** (AC-46); the caller is expected to kick off [`build_variants`]
    /// afterwards and emit `asset:ready` when it finishes.
    ///
    /// `mime_hint` is only consulted when the magic numbers say nothing.
    pub fn ingest_bytes(&self, bytes: &[u8], mime_hint: Option<&str>) -> Result<AssetMeta> {
        let size = bytes.len() as u64;
        if size > MAX_ASSET_BYTES {
            return Err(Error::TooLarge(size));
        }

        let sha256 = hex(&Sha256::digest(bytes));
        let mime = sniff_mime(bytes)
            .map(str::to_string)
            .or_else(|| mime_hint.map(str::to_string))
            .unwrap_or_else(|| "application/octet-stream".to_string());

        // Dimensions before the write, so bytes that are not an image are
        // still stored — a board can hold a PDF one day, and refusing a paste
        // over a file the user cannot do anything about would break "nothing
        // blocks thinking".
        let (w, h) = probe_dimensions(bytes).unwrap_or((0, 0));

        self.restore_from_trash(&sha256);
        let target = self.original_path(&sha256);
        if !target.is_file() {
            fs::create_dir_all(self.dir_for(&sha256))?;
            write_atomic(&target, bytes)?;
        }

        Ok(AssetMeta {
            sha256,
            w,
            h,
            mime,
            size,
        })
    }

    /// Ingest a file already on disk. Read once into memory, which is what the
    /// [`MAX_ASSET_BYTES`] ceiling is for: hashing in a stream and then
    /// re-reading to probe would touch the disk twice to save a buffer that a
    /// background thread is about to allocate anyway.
    pub fn ingest_path(&self, path: &Path) -> Result<AssetMeta> {
        let file = File::open(path)?;
        let size = file.metadata()?.len();
        if size > MAX_ASSET_BYTES {
            return Err(Error::TooLarge(size));
        }
        // Bounded by the read as well as by the metadata, because a character
        // device, a FIFO and most of `/proc` all report a length of zero and
        // then hand back bytes until the allocator gives up.
        let mut bytes = Vec::new();
        BufReader::new(file)
            .take(MAX_ASSET_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_ASSET_BYTES {
            return Err(Error::TooLarge(bytes.len() as u64));
        }
        self.ingest_bytes(&bytes, None)
    }

    /// Ingest a URL. This exists because the webview has a CORS wall and the
    /// shell does not — "Image copied from a web page (HTML + remote URL) is
    /// fetched natively and works" is T-23's AC-47.
    ///
    /// ## Why this is not just `ureq::get`
    ///
    /// The URL comes out of clipboard HTML, which means it comes out of a page
    /// somebody else wrote. Fetching it from the shell is fetching it from
    /// *inside the user's network*, with no CORS and no same-origin policy —
    /// so a pasted `<img src="http://192.168.1.1/admin/config">` would hand its
    /// answer straight back to the page over `asset://`. Hence:
    ///
    ///   - **the client resolves through [`PublicOnlyResolver`]**, so the address
    ///     it connects to is the address that was vetted, rather than the answer
    ///     to a second lookup nobody checked,
    ///   - `check_fetchable` refuses obvious cases up front so the failure is a
    ///     clear message rather than a connection error,
    ///   - redirects are followed by hand, so a hop cannot skip either check,
    ///   - the body is bounded *after* decompression, since the wire limit a
    ///     client library enforces is no limit at all against gzip,
    ///   - and there is a wall-clock timeout, because the default is none and a
    ///     server that accepts a connection and then says nothing would hold a
    ///     blocking thread for the life of the process.
    ///
    /// The DNS-rebinding gap this comment used to describe — check one address,
    /// connect to another — is closed by the resolver, not by the pre-flight.
    /// See [`PublicOnlyResolver`] for why that distinction is the whole fix.
    pub fn ingest_url(&self, url: &str) -> Result<AssetMeta> {
        let agent = fetch_agent();

        let mut current = url.to_string();
        for _ in 0..=MAX_REDIRECTS {
            check_fetchable(&current)?;
            let mut response = agent.get(&current).call().map_err(fetch_error)?;

            if response.status().is_redirection() {
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| Error::Fetch("redirect without a location".into()))?;
                // Relative redirects are refused rather than resolved. Joining
                // URLs correctly is a parser's job, and being wrong about it
                // here means checking one host and fetching another.
                if !(location.starts_with("http://") || location.starts_with("https://")) {
                    return Err(Error::Fetch("relative redirect".into()));
                }
                current = location.to_string();
                continue;
            }

            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .map(|v| v.split(';').next().unwrap_or(v).trim().to_string());

            let mut bytes = Vec::new();
            response
                .body_mut()
                .as_reader()
                .take(MAX_ASSET_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| Error::Fetch(e.to_string()))?;
            if bytes.len() as u64 > MAX_ASSET_BYTES {
                return Err(Error::TooLarge(bytes.len() as u64));
            }
            return self.ingest_bytes(&bytes, content_type.as_deref());
        }
        Err(Error::Fetch("too many redirects".into()))
    }

    // --- variants -----------------------------------------------------------

    /// The slow half: full decode, EXIF orientation baked in, two downscales.
    /// Idempotent, and safe to call for an asset that is not an image — it
    /// simply produces nothing and the original is served instead.
    pub fn build_variants(&self, sha256: &str) -> Result<()> {
        if !valid_hash(sha256) {
            return Err(Error::BadHash);
        }
        let original = self.original_path(sha256);
        let bytes = fs::read(&original).map_err(|_| Error::NotFound)?;

        let orientation = exif_orientation(&bytes);
        let decoded = ImageReader::new(io::Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(Error::Io)?
            .decode()
            .map_err(|e| Error::Undecodable(e.to_string()))?;
        let image = apply_orientation(decoded, orientation);

        // No variant when the original is already small enough and already the
        // right way up: the handler falls back to it, and a byte-identical
        // second copy on disk is the one thing a content-addressed store is
        // supposed to make impossible.
        let oversized = image.width() > DISPLAY_MAX_EDGE || image.height() > DISPLAY_MAX_EDGE;
        if oversized || orientation != 1 {
            // Borrowed when the only reason for a variant is the rotation —
            // cloning a decoded 40-megapixel image to hand it straight to an
            // encoder is 160 MB of memcpy for nothing.
            let display: Cow<'_, DynamicImage> = if oversized {
                Cow::Owned(image.resize(DISPLAY_MAX_EDGE, DISPLAY_MAX_EDGE, FilterType::CatmullRom))
            } else {
                Cow::Borrowed(&image)
            };
            self.write_variant(sha256, Variant::Display, &display, JPEG_QUALITY_DISPLAY)?;
        }

        let thumb = image.resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, FilterType::Lanczos3);
        self.write_variant(sha256, Variant::Thumb, &thumb, JPEG_QUALITY_THUMB)?;
        Ok(())
    }

    fn write_variant(
        &self,
        sha256: &str,
        variant: Variant,
        image: &DynamicImage,
        quality: u8,
    ) -> Result<()> {
        fs::create_dir_all(self.dir_for(sha256))?;
        let mut encoded = Vec::new();
        let ext = if uses_alpha(image) {
            image
                .write_to(&mut io::Cursor::new(&mut encoded), image::ImageFormat::Png)
                .map_err(|e| Error::Undecodable(e.to_string()))?;
            ".png"
        } else {
            let mut encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, quality);
            encoder
                .encode_image(&image.to_rgb8())
                .map_err(|e| Error::Undecodable(e.to_string()))?;
            ".jpg"
        };
        // The other extension may be left over from a previous build with a
        // different alpha verdict, and two variants would make `resolve`'s
        // answer depend on probe order.
        let stale = self.path_for(sha256, variant, if ext == ".png" { ".jpg" } else { ".png" });
        let _ = fs::remove_file(stale);
        write_atomic(&self.path_for(sha256, variant, ext), &encoded)
    }

    // --- reading ------------------------------------------------------------

    /// What to serve, what to call it, and whether it is the real answer.
    ///
    /// Falls back to the original whenever the asked-for variant is missing,
    /// which is not an edge case: between ingestion returning and `asset:ready`
    /// firing, *every* asset is in exactly that state. It is what lets an item
    /// show its photograph the moment the bytes land rather than a second later
    /// when the downscale finishes.
    ///
    /// [`Resolved::exact`] is false for that fallback, and the handler must not
    /// let it be cached: the same URL will start answering with the downscale
    /// shortly, and a response that says `immutable` when it is about to change
    /// is a lie the browser has no way to catch.
    pub fn resolve(&self, sha256: &str, variant: Variant) -> Option<Resolved> {
        if !valid_hash(sha256) {
            return None;
        }
        if variant != Variant::Original {
            for (ext, mime) in [(".jpg", "image/jpeg"), (".png", "image/png")] {
                let path = self.path_for(sha256, variant, ext);
                if path.is_file() {
                    return Some(Resolved {
                        path,
                        mime: mime.to_string(),
                        exact: true,
                    });
                }
            }
        }
        let original = self.original_path(sha256);
        if !original.is_file() {
            return None;
        }
        // Sniffed rather than remembered, because remembering it would mean
        // keeping metadata this side of the boundary.
        let mime = read_head(&original, 12)
            .ok()
            .and_then(|head| sniff_mime(&head))
            .unwrap_or("application/octet-stream");
        Some(Resolved {
            path: original,
            mime: mime.to_string(),
            exact: variant == Variant::Original,
        })
    }

    /// Copy an original out to a path of the caller's choosing.
    ///
    /// Not wired to a command yet, and that is deliberate — see the note in
    /// `lib.rs` where `asset_export` would be registered. It stays here, and
    /// stays tested, because bundle export (T-84) needs exactly this and will
    /// call it with a path the *application* chose rather than one that came
    /// across the IPC boundary.
    #[allow(dead_code)]
    pub fn export(&self, sha256: &str, dest: &Path) -> Result<()> {
        if !valid_hash(sha256) {
            return Err(Error::BadHash);
        }
        let source = self.original_path(sha256);
        if !source.is_file() {
            return Err(Error::NotFound);
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, dest)?;
        Ok(())
    }

    // --- collection ---------------------------------------------------------

    /// Anything not in `keep` goes to the trash; anything that has been in the
    /// trash longer than [`TRASH_TTL`] is deleted for real.
    ///
    /// The two-step is DATA-MODEL section 10, and it is not politeness: the
    /// frontend computes `keep` from a CRDT that a peer may be about to merge
    /// something into. Being briefly wrong about what is referenced has to be
    /// survivable, and a thirty-day tier is what makes it so.
    ///
    /// `freedBytes` counts only what actually left the disk.
    pub fn gc(&self, keep: &HashSet<String>) -> Result<u64> {
        let trash = self.trash_dir();
        fs::create_dir_all(&trash)?;
        let mut freed = 0u64;
        let now = unix_seconds();

        for entry in walk_files(&self.root)? {
            if entry.starts_with(&trash) {
                continue;
            }
            let Some(name) = entry.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            // A temporary from a write that was interrupted. Swept only once it
            // is old enough to be certain of that: `asset_gc` and an ingest can
            // run on the blocking pool at the same time, and deleting a
            // temporary that another thread is still writing turns a paste into
            // an unexplained IO error.
            if name.contains(".part") {
                let stale = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .map(|m| m + TEMP_TTL < SystemTime::now())
                    .unwrap_or(false);
                if stale {
                    if let Ok(meta) = entry.metadata() {
                        if fs::remove_file(&entry).is_ok() {
                            freed += meta.len();
                        }
                    }
                }
                continue;
            }
            // Both `<sha>` and `<sha>.display.jpg` start with the hash. `get`
            // rather than a slice, because a stray file could be named
            // anything at all and a byte index into UTF-8 is a panic waiting
            // for the one filename with an accent in it.
            let sha = name.get(..64).unwrap_or(name);
            if !valid_hash(sha) || keep.contains(sha) {
                continue;
            }
            // The arrival time goes in the *name*, not on the inode. `rename`
            // carries the original mtime across on every filesystem this runs
            // on, so a photograph added last year would be trashed and then
            // purged by the age sweep below in the same call — the thirty-day
            // window would exist only for files that happened to be new.
            let _ = fs::rename(&entry, trash.join(format!("{now}.{name}")));
        }

        for entry in walk_files(&trash)? {
            let Some(name) = entry.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Some(arrived) = trashed_at(name) else {
                continue;
            };
            if now.saturating_sub(arrived) < TRASH_TTL_SECONDS {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if fs::remove_file(&entry).is_ok() {
                freed += meta.len();
            }
        }
        Ok(freed)
    }

    /// Re-ingesting something in the trash pulls it back out rather than
    /// writing the same bytes again.
    fn restore_from_trash(&self, sha256: &str) {
        let trash = self.trash_dir();
        let Ok(entries) = fs::read_dir(&trash) else {
            return;
        };
        let target = self.dir_for(sha256);
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(original) = name.split_once('.').map(|(_, rest)| rest) else {
                continue;
            };
            if !original.starts_with(sha256) {
                continue;
            }
            if fs::create_dir_all(&target).is_err() {
                return;
            }
            let _ = fs::rename(entry.path(), target.join(original));
        }
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The seconds prefix a trashed file was renamed with, if it has one.
fn trashed_at(name: &str) -> Option<u64> {
    name.split_once('.')?.0.parse().ok()
}

/// Write through a temporary file and rename, so a crash mid-write cannot
/// leave a truncated file sitting at the address of its own hash — which would
/// then be trusted forever, because content addressing means nothing ever
/// checks it again.
///
/// The temporary name has to be unique per *call*, not per asset: two threads
/// ingesting the same photograph at the same moment would otherwise share one
/// temporary file, and the second one's `File::create` would truncate it out
/// from under the first one's rename.
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
    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&temp);
            // Another process winning the race wrote the same bytes, by
            // definition — the name is the hash of the content.
            if path.is_file() {
                Ok(())
            } else {
                Err(Error::Io(e))
            }
        }
    }
}

fn read_head(path: &Path, n: usize) -> io::Result<Vec<u8>> {
    let mut buffer = vec![0u8; n];
    let mut file = File::open(path)?;
    let read = file.read(&mut buffer)?;
    buffer.truncate(read);
    Ok(buffer)
}

fn walk_files(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push(path);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, RgbImage, RgbaImage};

    fn store() -> (tempfile::TempDir, AssetStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = AssetStore::new(dir.path().join("assets")).unwrap();
        (dir, store)
    }

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut out = Vec::new();
        DynamicImage::ImageRgb8(RgbImage::from_pixel(w, h, image::Rgb([120, 90, 60])))
            .write_to(&mut io::Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    fn transparent_png(w: u32, h: u32) -> Vec<u8> {
        let mut out = Vec::new();
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(w, h, image::Rgba([1, 2, 3, 0])))
            .write_to(&mut io::Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn hashes_and_stores_under_a_two_level_fan_out() {
        let (_dir, store) = store();
        let meta = store.ingest_bytes(&png(8, 4), None).unwrap();

        assert_eq!(meta.w, 8);
        assert_eq!(meta.h, 4);
        assert_eq!(meta.mime, "image/png");
        assert_eq!(meta.sha256.len(), 64);
        assert!(store.has(&meta.sha256));

        let path = store.original_path(&meta.sha256);
        let mut parts = path.iter().rev().skip(1);
        assert_eq!(parts.next().unwrap(), &meta.sha256[2..4]);
        assert_eq!(parts.next().unwrap(), &meta.sha256[0..2]);
    }

    #[test]
    fn the_same_photograph_twice_costs_nothing_the_second_time() {
        let (_dir, store) = store();
        let bytes = png(16, 16);
        let first = store.ingest_bytes(&bytes, None).unwrap();
        let second = store.ingest_bytes(&bytes, None).unwrap();
        assert_eq!(first, second);
        assert_eq!(walk_files(store.root.as_path()).unwrap().len(), 1);
    }

    #[test]
    fn trusts_magic_numbers_over_the_callers_word() {
        let (_dir, store) = store();
        let meta = store.ingest_bytes(&png(2, 2), Some("image/tiff")).unwrap();
        assert_eq!(meta.mime, "image/png");
    }

    #[test]
    fn stores_bytes_it_cannot_decode_rather_than_refusing_them() {
        let (_dir, store) = store();
        // Nothing blocks thinking: a paste the user cannot fix must not fail.
        let meta = store.ingest_bytes(b"not an image at all", None).unwrap();
        assert_eq!((meta.w, meta.h), (0, 0));
        assert_eq!(meta.mime, "application/octet-stream");
        assert!(store.has(&meta.sha256));
    }

    #[test]
    fn builds_a_display_variant_only_when_it_would_differ() {
        let (_dir, store) = store();

        let small = store.ingest_bytes(&png(64, 32), None).unwrap();
        store.build_variants(&small.sha256).unwrap();
        // Already smaller than the ceiling and already upright, so serving it
        // is serving the original.
        let r = store.resolve(&small.sha256, Variant::Display).unwrap();
        assert_eq!(r.path, store.original_path(&small.sha256));
        assert!(!r.exact, "standing in for a variant that will never exist");

        let big = store.ingest_bytes(&png(3000, 1500), None).unwrap();
        store.build_variants(&big.sha256).unwrap();
        let r = store.resolve(&big.sha256, Variant::Display).unwrap();
        assert_ne!(r.path, store.original_path(&big.sha256));
        assert_eq!(r.mime, "image/jpeg");
        assert!(r.exact);
        let dims = image::image_dimensions(&r.path).unwrap();
        assert_eq!(dims.0, DISPLAY_MAX_EDGE);
    }

    #[test]
    fn keeps_alpha_by_encoding_a_transparent_variant_as_png() {
        let (_dir, store) = store();
        let meta = store
            .ingest_bytes(&transparent_png(600, 600), None)
            .unwrap();
        store.build_variants(&meta.sha256).unwrap();
        assert_eq!(
            store.resolve(&meta.sha256, Variant::Thumb).unwrap().mime,
            "image/png"
        );
    }

    #[test]
    fn does_not_pay_for_an_alpha_channel_nobody_used() {
        let (_dir, store) = store();
        let mut opaque = Vec::new();
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(600, 600, image::Rgba([9, 9, 9, 255])))
            .write_to(&mut io::Cursor::new(&mut opaque), ImageFormat::Png)
            .unwrap();
        let meta = store.ingest_bytes(&opaque, None).unwrap();
        store.build_variants(&meta.sha256).unwrap();
        assert_eq!(
            store.resolve(&meta.sha256, Variant::Thumb).unwrap().mime,
            "image/jpeg"
        );
    }

    #[test]
    fn a_thumbnail_fits_inside_its_box() {
        let (_dir, store) = store();
        let meta = store.ingest_bytes(&png(1000, 500), None).unwrap();
        store.build_variants(&meta.sha256).unwrap();
        let (w, h) =
            image::image_dimensions(store.resolve(&meta.sha256, Variant::Thumb).unwrap().path)
                .unwrap();
        assert_eq!(w, THUMB_MAX_EDGE);
        assert_eq!(h, THUMB_MAX_EDGE / 2);
    }

    #[test]
    fn serves_the_original_before_the_variants_exist() {
        let (_dir, store) = store();
        let meta = store.ingest_bytes(&png(4000, 4000), None).unwrap();
        // Every asset is in exactly this state between ingest and asset:ready.
        let r = store.resolve(&meta.sha256, Variant::Display).unwrap();
        assert_eq!(r.path, store.original_path(&meta.sha256));
        // ...and the handler must not let it be cached, because this same URL
        // starts answering with the downscale as soon as it exists.
        assert!(!r.exact);

        // The original asked for by name is not a stand-in for anything.
        assert!(
            store
                .resolve(&meta.sha256, Variant::Original)
                .unwrap()
                .exact
        );
    }

    #[test]
    fn reports_the_dimensions_a_rotated_photograph_will_display_at() {
        // Orientation 6 is the common phone portrait: stored landscape, with a
        // tag saying "turn me". The item has to be created portrait.
        let landscape = png(400, 200);
        assert!(!swaps_axes(1));
        assert!(swaps_axes(6));

        let upright = apply_orientation(image::load_from_memory(&landscape).unwrap(), 6);
        assert_eq!((upright.width(), upright.height()), (200, 400));
    }

    #[test]
    fn refuses_a_hash_that_is_trying_to_be_a_path() {
        let (_dir, store) = store();
        for bad in ["../../etc/passwd", "", "ABCDEF", &"z".repeat(64)] {
            assert!(!store.has(bad), "{bad}");
            assert!(store.resolve(bad, Variant::Display).is_none(), "{bad}");
            assert!(store.export(bad, Path::new("out")).is_err(), "{bad}");
        }
    }

    #[test]
    fn collects_what_is_unreferenced_into_the_trash_and_can_get_it_back() {
        let (_dir, store) = store();
        let kept = store.ingest_bytes(&png(8, 8), None).unwrap();
        let dropped = store.ingest_bytes(&png(9, 9), None).unwrap();

        let keep: HashSet<String> = [kept.sha256.clone()].into_iter().collect();
        let freed = store.gc(&keep).unwrap();
        // Nothing is thirty days old yet, so nothing has actually gone.
        assert_eq!(freed, 0);
        assert!(store.has(&kept.sha256));
        assert!(!store.has(&dropped.sha256));

        // Referenced again — the bytes come back out of the trash.
        let again = store.ingest_bytes(&png(9, 9), None).unwrap();
        assert_eq!(again.sha256, dropped.sha256);
        assert!(store.has(&dropped.sha256));
    }

    #[test]
    fn dates_a_trashed_file_from_when_it_was_trashed() {
        let (_dir, store) = store();
        let meta = store.ingest_bytes(&png(11, 11), None).unwrap();
        store.gc(&HashSet::new()).unwrap();

        // The arrival time is in the name and not on the inode, because
        // `rename` carries the original mtime across on every filesystem this
        // runs on — so a photograph added a year ago and deleted today would be
        // trashed and purged in the same call, and the thirty-day window would
        // only ever protect files that happened to be new.
        let entry = fs::read_dir(store.trash_dir())
            .unwrap()
            .flatten()
            .next()
            .unwrap();
        let name = entry.file_name().into_string().unwrap();
        let stamped = trashed_at(&name).expect("a trashed file carries its arrival time");
        assert!(unix_seconds() - stamped < 5);
        assert!(name.ends_with(&meta.sha256));
    }

    #[test]
    fn purges_the_trash_once_the_window_has_actually_passed() {
        let (_dir, store) = store();
        let meta = store.ingest_bytes(&png(12, 12), None).unwrap();
        let size = fs::metadata(store.original_path(&meta.sha256))
            .unwrap()
            .len();
        store.gc(&HashSet::new()).unwrap();

        // Backdate the arrival stamp in the name, which is where it lives.
        let trash = store.trash_dir();
        for entry in fs::read_dir(&trash).unwrap().flatten() {
            let name = entry.file_name().into_string().unwrap();
            let rest = name.split_once('.').unwrap().1;
            let long_ago = unix_seconds() - TRASH_TTL_SECONDS - 1;
            fs::rename(entry.path(), trash.join(format!("{long_ago}.{rest}"))).unwrap();
        }

        assert_eq!(store.gc(&HashSet::new()).unwrap(), size);
        assert!(fs::read_dir(&trash).unwrap().next().is_none());
    }

    #[test]
    fn refuses_to_fetch_anything_inside_the_house() {
        // The URL comes out of clipboard HTML, so it comes out of a page
        // somebody else wrote. None of these may be reachable from a paste.
        for hostile in [
            "http://127.0.0.1:9200/_search",
            "http://localhost/admin",
            "http://169.254.169.254/latest/meta-data/",
            "http://192.168.1.1/config",
            "http://10.0.0.1/",
            "http://172.16.5.5/",
            "http://[::1]:8080/",
            "http://0.0.0.0/",
            "file:///etc/passwd",
            "ftp://example.com/x",
            "not a url at all",
        ] {
            assert!(check_fetchable(hostile).is_err(), "{hostile}");
        }
        // ...and an ordinary public address still is.
        assert!(check_fetchable("https://93.184.216.34/photo.jpg").is_ok());
    }

    /// A timeout the resolver will accept. Non-infinite on purpose: that is the
    /// path `DefaultResolver` takes for a real lookup, so it is the one worth
    /// exercising.
    fn resolve_timeout() -> NextTimeout {
        NextTimeout {
            after: ureq::unversioned::transport::time::Duration::from_secs(5),
            reason: ureq::Timeout::Resolve,
        }
    }

    fn resolve(url: &str) -> std::result::Result<ResolvedSocketAddrs, ureq::Error> {
        let uri: Uri = url.parse().unwrap();
        PublicOnlyResolver::default().resolve(&uri, &Config::default(), resolve_timeout())
    }

    #[test]
    fn the_resolver_is_the_boundary_not_the_preflight() {
        // `check_fetchable` covers the same ground, but it cannot *guarantee*
        // anything: it checks one lookup and the client then does another. These
        // assertions are against the thing ureq actually connects through, so a
        // name that changed its answer between the two has nowhere to land.
        for hostile in [
            "http://127.0.0.1:9200/_search",
            "http://localhost/admin",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]:8080/",
            "http://0.0.0.0/",
        ] {
            let refused = resolve(hostile);
            assert!(refused.is_err(), "{hostile} was resolved");
            // And it says why, in words that can be shown to somebody.
            let message = fetch_error(refused.unwrap_err()).to_string();
            assert!(
                message.contains("not a public address"),
                "{hostile}: unhelpful message {message:?}"
            );
        }
    }

    #[test]
    fn the_resolver_leaves_an_ordinary_public_address_alone() {
        let addresses = resolve("https://93.184.216.34/photo.jpg").unwrap();
        assert_eq!(addresses.len(), 1);
        assert_eq!(addresses[0].ip(), "93.184.216.34".parse::<IpAddr>().unwrap());
        // The port comes from the scheme, and getting that wrong would mean
        // connecting somewhere other than the address that was vetted.
        assert_eq!(addresses[0].port(), 443);
    }

    #[test]
    fn the_refusal_survives_the_client_and_stays_legible() {
        // The tests above call the resolver directly, which proves the rule and
        // not the wiring. This goes through the agent `ingest_url` uses, so it
        // fails only if the resolver is actually installed on it — and it needs no
        // network, because the refusal happens before a socket is opened.
        let refused = fetch_agent().get("http://127.0.0.1:9/photo.jpg").call();
        let message = match refused {
            Ok(_) => panic!("connected to loopback"),
            Err(e) => fetch_error(e).to_string(),
        };
        assert!(message.contains("not a public address"), "{message:?}");
    }

    #[test]
    fn one_private_answer_among_public_ones_is_still_a_way_in() {
        // The case that makes the rule "every address" rather than "any": a
        // hostile name answers with a real public address *and* a private one,
        // and ureq is free to try either.
        let mixed: Vec<SocketAddr> = ["93.184.216.34:443", "10.0.0.1:443"]
            .iter()
            .map(|a| a.parse().unwrap())
            .collect();
        assert_eq!(
            first_unroutable(&mixed),
            Some("10.0.0.1".parse::<IpAddr>().unwrap())
        );

        let public: Vec<SocketAddr> = ["93.184.216.34:443", "1.1.1.1:443"]
            .iter()
            .map(|a| a.parse().unwrap())
            .collect();
        assert_eq!(first_unroutable(&public), None);
    }

    #[test]
    fn sees_through_an_ipv4_address_wearing_an_ipv6_hat() {
        assert!(!is_routable("::ffff:127.0.0.1".parse().unwrap()));
        assert!(!is_routable("::ffff:192.168.0.5".parse().unwrap()));
        assert!(is_routable("::ffff:93.184.216.34".parse().unwrap()));
    }

    #[test]
    fn does_not_sweep_a_temporary_another_thread_is_still_writing() {
        let (_dir, store) = store();
        let meta = store.ingest_bytes(&png(7, 7), None).unwrap();
        let temp = store.dir_for(&meta.sha256).join(format!(
            "{}.part{}-999",
            meta.sha256,
            std::process::id()
        ));
        fs::write(&temp, b"half a photograph").unwrap();

        store.gc(&HashSet::new()).unwrap();
        // An ingest running concurrently with collection must not have its
        // working file deleted out from under it.
        assert!(temp.is_file());
    }

    #[test]
    fn exports_a_byte_identical_original() {
        let (dir, store) = store();
        let bytes = png(20, 10);
        let meta = store.ingest_bytes(&bytes, None).unwrap();
        let dest = dir.path().join("out").join("photo.png");
        store.export(&meta.sha256, &dest).unwrap();
        assert_eq!(fs::read(dest).unwrap(), bytes);
    }

    #[test]
    fn variant_defaults_to_display_for_anything_it_does_not_recognise() {
        assert_eq!(Variant::parse(Some("thumb")), Variant::Thumb);
        assert_eq!(Variant::parse(Some("original")), Variant::Original);
        assert_eq!(Variant::parse(Some("nonsense")), Variant::Display);
        assert_eq!(Variant::parse(None), Variant::Display);
    }
}
