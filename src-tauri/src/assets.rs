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
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageReader, Limits};
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

use crate::document;
use crate::media;

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

/// The most memory one ingest is allowed to ask this machine for.
///
/// **This is the only number below that was chosen.** Both ceilings are what
/// the measurement says each road can carry inside it, so what is written down
/// is a budget and a measurement rather than a round number somebody liked.
///
/// A gigabyte because the smallest machine this is meant to run on has eight,
/// and one paste is not entitled to an eighth of it twice over.
const INGEST_MEMORY_BUDGET: u64 = 1024 * 1024 * 1024;

/// What the IPC road costs, per byte of file. Rounded up from 10.14×, because a
/// ceiling that rounds the other way is not a ceiling.
///
/// Measured at the ceiling, which is the only place it has to hold: a paste of
/// exactly [`MAX_PASTE_BYTES`] took the shell from 5.2 MiB of private bytes to
/// **943.8 MiB**, sampled at 20 ms in a fresh process. D-54 measured 10.29× at
/// a different size and the two agree.
///
/// Most of it is not ours: wry reads the raw body 1 KiB at a time into a `Vec`
/// with no capacity hint, and Tauri forces a clone of the finished buffer on
/// the way to the command. **This is why the paste road has the low ceiling** —
/// there is nothing on this side of the boundary to make it cheaper.
const IPC_INGEST_MULTIPLIER: u64 = 11;

/// How big a file may be to arrive **as a buffer handed across the IPC
/// boundary** — a paste on a platform with no native pasteboard reader, a data
/// URL, bytes the shell could not name a path for. About 93 MiB.
///
/// Far below [`MAX_ASSET_BYTES`] on purpose, and the reason the board tells a
/// person to drag a big file in rather than paste it (Q-229). At the ceiling
/// the *disk* road publishes, this road would ask for about 5 GiB.
///
/// **What the check does not do is save the whole peak.** By the time
/// [`AssetStore::ingest_ipc_bytes`] runs, wry has already built the body — the
/// refusal saves the clone, the write and the variant pass, but not the buffer
/// it is measuring. Refusing before the invoke is the only place the rest is
/// avoided, and that is the frontend's to do.
pub(crate) const MAX_PASTE_BYTES: u64 = INGEST_MEMORY_BUDGET / IPC_INGEST_MULTIPLIER;

/// What the disk road costs — **the file, and then a fixed amount that is not
/// the file.** It used to be a staircase (D-55), because
/// [`AssetStore::ingest_path`] read through a `Take<BufReader<File>>` that
/// `read_to_end` could not size-hint through, so the `Vec` doubled its way up
/// and every file on one stair cost the same. T-307 flattened it by sizing the
/// buffer from the metadata and holding the read to that number; D-56 has the
/// before-and-after at the same sizes on the same rig.
///
/// | file | peak, stair (D-55) | peak, flat (D-56) | what is left over |
/// |---|---|---|---|
/// | 260.0 MiB | 774.7 MiB | 265.7 MiB | 5.7 MiB |
/// | 448.0 MiB | 774.9 MiB | 454.1 MiB | 6.1 MiB |
/// | 512.0 MiB | 1544.2 MiB | 518.3 MiB | 6.3 MiB |
/// | 768.0 MiB | *would not arrive* | 774.8 MiB | 6.8 MiB |
///
/// The first two rows used to be equal to within 0.2 MiB and are now 188 MiB
/// apart: that is the run that shows the *shape* changed rather than one number
/// moving. The third is the size this constant published before anybody
/// measured it, which needed 1544 MiB and could not arrive on an 8 GB machine —
/// it now costs a third of that. The fourth is the new ceiling, and it lands on
/// the peak the old ceiling of 448 MiB already cost: the same memory, seventy
/// per cent more file.
///
/// [`OVERHEAD`] is the part that is not the file. It is dominated by the
/// process's own 5.1 MiB idle before the paste, sampled in the same run, and
/// what drifts on top of that across the four rows is commit granularity and
/// the sampler standing next to it rather than anything that scales with the
/// file. What matters for a bound is that it does not grow *with* the file, and
/// in particular that [`AssetStore::build_variants`]' `fs::read` of the file it
/// was just handed does **not** stack on top: `ingest_path`'s buffer is dropped
/// before it runs and the allocator hands the same pages straight back.
const fn disk_ingest_peak(size: u64) -> u64 {
    size + OVERHEAD
}

/// Read exactly the `promised` bytes, into a buffer that is already that size,
/// and refuse a source that has more to give.
///
/// **This is the whole of why [`disk_ingest_peak`] is flat**, and it is one
/// function rather than two copies because there are two roads that read a
/// whole file into memory against a promised length — [`AssetStore::ingest_path`]
/// off the file system's metadata, and `bundle::entry` off a zip's central
/// directory — and a rule that a peak is derived from is the last rule that
/// should be allowed to drift between them.
///
/// The two halves do different jobs and both are load-bearing:
///
///   - **sizing** the buffer means `read_to_end` never has to guess, which is
///     what removes the doubling that used to cost `next_power_of_two(n) * 1.5`;
///   - **stopping** at the promise means it cannot guess *anyway*. A hint on its
///     own is only a hint: a source that hands back more than it said would
///     reserve past it and double from there, so the worst case would still be
///     the staircase and the ceiling could not have moved at all.
///
/// The byte past the end is what makes the promise binding rather than merely
/// believed. A character device, a FIFO and most of `/proc` report a length of
/// zero and then stream; a file being appended to while it is pasted is the same
/// lie told smaller; a zip that overstates is an archive somebody else wrote.
/// All three are refused rather than accommodated.
pub(crate) fn read_promised(source: impl Read, promised: u64) -> Result<Vec<u8>> {
    let mut source = source.take(promised);
    let mut bytes = Vec::with_capacity(promised as usize);
    source.read_to_end(&mut bytes)?;

    source.set_limit(1);
    if source.read(&mut [0u8; 1])? != 0 {
        return Err(Error::SizeMismatch);
    }
    Ok(bytes)
}

/// The part of [`disk_ingest_peak`] that is not the file. Rounded up from the
/// 6.8 MiB measured at the ceiling — which is the only place a bound has to
/// hold, and the largest of the four runs — because a ceiling that rounds the
/// other way is not a ceiling.
///
/// Deliberately *not* fitted to the drift across the four rows. A line through
/// 5.7, 6.1, 6.3 and 6.8 would predict all four better and would be a worse thing to
/// write down: the drift is the measuring rig and the allocator's commit
/// granularity, and a slope fitted to noise reads to the next person as a cost
/// that scales with the file, which is exactly the mistake D-54 made.
const OVERHEAD: u64 = 8 * 1024 * 1024;

/// How big an asset may be **at all** — read in one go rather than streamed,
/// above which the caller is doing something other than putting a file on a
/// corkboard.
///
/// 768 MiB, and **the interesting thing about it is that it peaks where 448 MiB
/// used to.** T-307 flattened the read (see [`disk_ingest_peak`]), so the same
/// 775 MiB of memory the old ceiling cost now buys seventy per cent more file.
/// The number moved because the code did; nobody raised it by hand.
///
/// 248 MiB of the budget is left spare on purpose, and it is doing two jobs:
/// the 5.1 MiB idle in [`OVERHEAD`] is a *fresh* board's, and a process with a
/// four-hundred-page document already on it is not fresh; and the budget is
/// what **one** ingest may ask for, while nothing stops a person dropping two
/// files at once. It is asserted below rather than left as a comment, so that
/// raising the ceiling into it has to be done on purpose.
///
/// It holds the four-hundred-megabyte interview T-254 exists for with room to
/// spare, which is the constraint the number had to clear. This one bounds
/// every road that starts from a file already on a disk:
/// [`AssetStore::ingest_path`], a peer transfer landing in
/// [`AssetStore::commit_received`], a bundle entry.
///
/// **It cannot bound a photograph, and nothing byte-shaped can.** An 11 MiB
/// JPEG of 121 megapixels asked for 794 MiB (D-54, and 391 MiB now), because the cost of a
/// picture is its pixels rather than its bytes. A JPEG's compression ratio is a
/// property of the picture — sky against foliage — so no byte figure predicts
/// it. That is [`decode_peak`]'s job, and [`MAX_PICTURE_PEAK`] is the ceiling
/// it stands behind; this constant bounds only what is read off a disk.
///
/// `pub(crate)` for `bundle`, which has to bound a zip entry before it
/// decompresses it and must bound it at the same number — an asset this store
/// would refuse to ingest is not one a bundle should be allowed to expand.
pub(crate) const MAX_ASSET_BYTES: u64 = 768 * 1024 * 1024;

/// What one pixel costs in the buffer a downscale is filtered through: four
/// `f32` channels, whatever depth the picture itself is.
///
/// `imageops::resize` runs vertically into an `Rgba32FImage` and then
/// horizontally back out of it, so the middle of every downscale is sixteen
/// bytes a pixel even for a JPEG that is three. At 121 megapixels that was
/// 430 MiB against a decoded surface of 346 — **the largest single thing in a
/// picture ingest, and not the picture** — which is why [`downscale`] stops
/// using this filter past a 2× reduction (T-310).
///
/// It is still here because the mild reductions that keep `resize` still pay it.
/// They are bounded by construction: a picture that keeps this filter is inside
/// twice the variant's edge, so the term cannot exceed 5120 × 2560 × 16.
const RESAMPLE_BYTES_PER_PIXEL: u64 = 16;

/// What building an asset's variants asks the machine for — the other half of
/// the ingest road, and the half [`disk_ingest_peak`] cannot see.
///
/// **None of the terms is the file.** D-57 and D-58 measured ten pictures on the
/// rig D-55 and D-56 used — the real application, one fresh process per file,
/// private bytes at 20 ms — and this predicts every one of them from above:
///
/// | picture | depth | measured | this says | was, before T-310 |
/// |---|---|---|---|---|
/// | 4000 × 4000 | 8-bit | 226.6 MiB | 247.8 | 226.7 |
/// | 8000 × 8000 | 8-bit | 227.5 | 229.5 | 521.6 |
/// | 11000 × 11000 | 8-bit | 391.4 | 393.4 | 803.4 |
/// | 22000 × 5500 | 8-bit | 363.1 | 393.4 | 574.0 |
/// | 14142 × 14142 | 8-bit | 618.9 | 620.5 | *would not arrive* |
/// | 6000 × 6000 | 8-bit + alpha | 277.7 | 292.0 | 403.7 |
/// | 3000 × 3000 | 16-bit + alpha | 241.8 | 390.2 | 242.2 |
/// | 4500 × 4500 | 16-bit + alpha | 387.0 | 535.1 | 387.3 |
/// | 6000 × 6000 | 16-bit + alpha | 451.5 | 480.2 | 566.8 |
/// | 3000 × 3000 | 16-bit | 212.1 | 252.0 | 212.5 |
///
/// The rows that barely moved are the ones under 5120 on their long edge, which
/// is where `downscale` keeps the old filter on purpose. They are also the rows
/// this is most generous about, and it does not matter: a picture that small is
/// nowhere near the ceiling, so the slack cannot bind.
///
///   - **the surface** is `w × h ×` the decoder's own bytes per pixel, and the
///     depth in there is why a *megapixel* ceiling would not have held either:
///     36 megapixels at sixteen bits cost more than 121 at eight. The depth is
///     a property of the picture in exactly the way the compression ratio is.
///   - **the intermediate** is zero for anything big, which is what T-310
///     changed. It used to be the *short* edge times the variant's edge at
///     sixteen bytes a pixel — `resize` filters vertically into an
///     `Rgba32FImage` first — and it made the **shape** decide as much as the
///     count: 121 megapixels cost 803 MiB square and 574 at 4:1. Past a 2×
///     reduction `downscale` now takes a box average, which allocates nothing
///     but its result, and those two rows are 391.4 and 363.1 — the same
///     picture, and the difference is the variant rather than the source.
///   - **the variant**, twice: the downscale itself and the copy `to_rgb8` or
///     `to_rgba8` hands the encoder. The *square* variant, which is the largest
///     at any depth — a bound may be generous about a shape and may not be
///     short about one, which is the whole of the 4:1 row's 30 MiB.
///   - **[`PNG_ENCODE_PEAK`]**, on the alpha road only.
///
/// The thumb pass is not a term. It comes off the display variant rather than
/// off the original, so there is nothing left in it that scales with the source.
///
/// Saturating throughout, because two of the three terms are a product of
/// numbers a *file* chose. A bound that wraps to something small is worse than
/// no bound at all.
const fn decode_peak(file: u64, w: u64, h: u64, bytes_per_pixel: u64, alpha: bool) -> u64 {
    let surface = w.saturating_mul(h).saturating_mul(bytes_per_pixel);
    let long_edge = if w > h { w } else { h };
    let short_edge = if w < h { w } else { h };
    // Zero for anything big, which is the whole of T-310: past a 2× reduction
    // `downscale` takes the box average, and a box average allocates nothing but
    // its own result. What is left is the mild-reduction branch, and it is
    // bounded rather than merely small — a picture that keeps `resize` is by
    // definition inside twice the variant's edge, so this can never exceed
    // 5120 × 2560 × 16.
    let intermediate = if long_edge >= (DISPLAY_MAX_EDGE as u64) * (BOX_FILTER_FROM as u64) {
        0
    } else {
        short_edge
            .saturating_mul(DISPLAY_MAX_EDGE as u64)
            .saturating_mul(RESAMPLE_BYTES_PER_PIXEL)
    };
    // Twice: the variant, and the copy the encoder is handed — `to_rgb8` and
    // `to_rgba8` both allocate, including when the image is already in that
    // form. The square variant, which is the largest one at any given depth.
    let variant = (DISPLAY_MAX_EDGE as u64)
        .saturating_mul(DISPLAY_MAX_EDGE as u64)
        .saturating_mul(bytes_per_pixel)
        .saturating_mul(2);
    // A PNG chunk carries its own length, so the `png` crate cannot start
    // writing IDAT until it has compressed all of it — the filtered image and
    // the deflated image are both in memory, inside the crate, where nothing on
    // this side can stream them. Only the alpha road pays it, and the colour
    // type says at probe time whether this picture can take that road.
    let encode = if alpha { PNG_ENCODE_PEAK } else { 0 };
    file.saturating_add(surface)
        .saturating_add(intermediate)
        .saturating_add(variant)
        .saturating_add(encode)
        .saturating_add(OVERHEAD)
}

/// What the `png` crate holds while it encodes a variant, over and above the
/// variant itself and the copy handed to it.
///
/// Rounded up from 81 MiB, the largest of the two alpha runs in D-58, and it is
/// a constant rather than a multiple because it is the *variant* being encoded
/// and the variant is always 2560 square at most. It does not scale with the
/// picture: an eight-bit alpha variant of 25 MiB and a sixteen-bit one of 50
/// left 80 and 69 MiB unaccounted respectively.
const PNG_ENCODE_PEAK: u64 = 96 * 1024 * 1024;

/// How much of [`INGEST_MEMORY_BUDGET`] one picture may ask for.
///
/// **This stands where a ceiling would stand, and it is not a ceiling**, because
/// a picture's cost is more than one number. There is no megapixel figure to
/// write down here: the depth moves it as much as the count does, and 36
/// megapixels at sixteen bits used to cost more than 121 at eight. The *shape*
/// moved it too, until T-310 — 121 megapixels cost 803 MiB square and 574 at
/// 4:1 — which is the term this model lost and the one nobody would have
/// guessed was there.
///
/// **The whole budget, and deliberately not the four fifths [`MAX_ASSET_BYTES`]
/// holds itself to** (Q-234). The margin on the disk road is there because that
/// road's ceiling is one number that has to cover every file; this one is
/// computed per picture from the picture's own three, so there is nothing for a
/// margin to absorb that the model is not already looking at. It is the more
/// generous of the two answers and it was chosen knowing that.
///
/// What it admits, for a square picture and a small file:
///
/// | depth | admitted | before T-310 |
/// |---|---|---|
/// | 8-bit, no alpha — a photograph | about 342 megapixels | 170 |
/// | 8-bit with alpha | about 228 | 139 |
/// | 16-bit with alpha | about 107 | 81 |
///
/// **The numbers doubled and this constant did not move**, which is the same
/// thing D-56 said about [`MAX_ASSET_BYTES`]: `downscale` stopped filtering
/// through a buffer as wide as the source (T-310, Q-236) and the ceiling
/// followed the measurement. A 200-megapixel phone photograph — Samsung and
/// Xiaomi ship them — needed about 1148 MiB and did not arrive under any share
/// of this budget; it now costs 618 MiB and does.
///
/// **Every one of those three rows is past the 512 MiB `image` allows a decode
/// by default**, which is why [`decode_limits`] exists rather than being
/// tidiness: without it the crate would quietly refuse a picture this number
/// admits, after the file was stored and the item was on the board.
const MAX_PICTURE_PEAK: u64 = INGEST_MEMORY_BUDGET;

// Pinned where they are defined and not in a test, because these are
// comparisons between constants and the build is the right thing to fail: a
// test asserting one constant equals another has already compiled the wrong
// number into the binary before it runs.
//
// Each road inside the budget at its own ceiling. This is the whole claim the
// two numbers are making.
const _: () = assert!(MAX_PASTE_BYTES * IPC_INGEST_MULTIPLIER <= INGEST_MEMORY_BUDGET);
const _: () = assert!(disk_ingest_peak(MAX_ASSET_BYTES) <= INGEST_MEMORY_BUDGET);
// The second one now clears the budget by 248 MiB rather than by a whisker, and
// that slack is a choice rather than a rounding — so it is asserted separately,
// in the terms it was chosen in. Raise the ceiling until this fails and the next
// person has taken the margin without noticing it was there.
const _: () =
    assert!(INGEST_MEMORY_BUDGET - disk_ingest_peak(MAX_ASSET_BYTES) >= INGEST_MEMORY_BUDGET / 5);
// And the paste ceiling to the byte, because the 943.8 MiB above is not a
// figure derived at some other size and scaled — it was sampled at exactly this
// one. Move the multiplier and the measurement has to be taken again.
const _: () = assert!(MAX_PASTE_BYTES == 97_612_893);
// The ordering is the design rather than an accident. The road that costs five
// times more gets the lower ceiling, or "everything big comes in by path" is
// not true of anything.
const _: () = assert!(MAX_PASTE_BYTES < MAX_ASSET_BYTES);

/// How much of an original one chunk of a peer transfer is — ARCHITECTURE
/// section 5.2, and the same number as `CHUNK_BYTES` in `platform/types.ts`.
///
/// Both sides cut at the same offsets or the receiver assembles a file that
/// hashes to nothing. It is the third and last thing the two languages agree on
/// by hand, after the message type and the frame (D-28).
pub const CHUNK_BYTES: u64 = 256 * 1024;

/// Redirect hops [`AssetStore::ingest_url`] will follow, checking each one.
const MAX_REDIRECTS: u8 = 3;

/// What ingestion returns. Note what is *not* here: the bytes.
///
/// No `Eq`, since `duration` arrived: a float has no total ordering, and the
/// derive would be claiming one. Nothing compares two of these for equality
/// outside the tests, which want `PartialEq` and are satisfied by it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AssetMeta {
    pub sha256: String,
    pub w: u32,
    pub h: u32,
    pub mime: String,
    pub size: u64,
    /// Seconds, for a film or a cassette; `None` for everything else and for a
    /// container this build cannot read (T-300).
    ///
    /// It is here rather than in a later probe because a peer writes the spine
    /// of a cassette it may not hold a single byte of — the record travels
    /// ahead of the file, so the runtime has to be in it (AC-688).
    pub duration: Option<f64>,
    /// Pages, for a document; `None` for everything else and for a PDF this
    /// build cannot open. Here for exactly the reason `duration` is: a folder on
    /// a machine that will never hold the file still says how thick it is.
    ///
    /// Its sibling `/Title` is deliberately **not** here. Q-211 settled that a
    /// document's declared title is derived locally and never enters the
    /// document, so it is asked for by [`crate::document_title`] against a file
    /// this machine already holds, rather than carried out of ingest to be
    /// written down. The two facts come off the same structure load and go to
    /// different places, which is the whole distinction: a page count is what
    /// the object *is*, a title is what one machine can currently *read*.
    pub pages: Option<u32>,
}

/// What to put in front of the user when they export an asset.
///
/// A *name*, never a path — which is the whole distinction T-94 turns on. See
/// [`safe_stem`].
pub struct ExportName {
    /// Pre-fills the dialog's name field. The user is free to replace it.
    pub file_name: String,
    /// What the dialog filters on, without the dot.
    pub extension: &'static str,
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
    /// Too big for the road it came in on, and **not the same refusal** as
    /// [`Error::TooLarge`]: this board can hold the file, just not handed over
    /// as one buffer across the IPC boundary. Its own variant so the sentence
    /// can say the thing worth saying, which is what to do instead.
    TooLargeToPaste(u64),
    /// The source handed back more bytes than its own metadata promised — a
    /// file appended to while it was being pasted, or a pipe, a character
    /// device or something else that reports a length of zero and then streams.
    ///
    /// Its own variant rather than a [`Error::TooLarge`] because there is no
    /// honest number to put in one. [`AssetStore::ingest_path`] sizes its buffer
    /// from the promised length and stops the read there, so all this store ever
    /// learns is that there was more.
    SizeMismatch,
    /// A small file and an enormous photograph.
    ///
    /// **Not an [`Error::TooLarge`]**, and the distinction is the whole of
    /// T-308: that one is about the file, and an 11 MiB JPEG of 121 megapixels
    /// asked for 803 MiB. No byte figure predicts a picture, because what a
    /// picture costs is its pixels and their depth (D-54, D-57) — so what this
    /// carries is the picture's own numbers, and what it says is about the
    /// picture. Somebody told the file is too big when the file is 11 MiB will
    /// go and look at the file.
    PictureTooLarge { w: u32, h: u32 },
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
            Error::TooLargeToPaste(n) => {
                write!(f, "{n} bytes is too much to hand over in one piece — drag the file in instead")
            }
            Error::SizeMismatch => write!(f, "that file is not the size it said it was"),
            Error::PictureTooLarge { w, h } => write!(
                f,
                "{w} × {h} is more picture than this board can open — it is the pixels rather than the size of the file"
            ),
            Error::Undecodable(why) => write!(f, "could not decode: {why}"),
            Error::Fetch(why) => write!(f, "could not fetch: {why}"),
            Error::Unavailable(why) => write!(f, "{why}"),
        }
    }
}

impl Error {
    /// Whether the board will refuse this file **however it arrives**.
    ///
    /// The one thing the frontend cannot work out for itself and must not
    /// guess, because *nothing here can hold it* is a claim about the board:
    /// true of a four-hundred-megapixel scan, and a lie about a file that is
    /// merely too big to hand across the IPC boundary — that one has another
    /// road and the sentence has to offer it.
    fn holds_nowhere(&self) -> bool {
        matches!(
            self,
            Error::TooLarge(_)
                | Error::PictureTooLarge { .. }
                | Error::SizeMismatch
                | Error::Undecodable(_)
        )
    }

    /// The sentence for a person, which is deliberately **not** the same string
    /// as [`Display`]'s.
    ///
    /// That one goes in a log next to a hash and has to stand alone. This one
    /// goes on a corkboard after a file's name, so it is a verb phrase with the
    /// file as its subject — the same register the frontend's own refusals are
    /// already written in ("is not a picture, a film, a recording or a
    /// document"). Both live here because here is where the numbers are.
    fn sentence(&self) -> String {
        match self {
            Error::PictureTooLarge { w, h } => format!(
                "is {w} × {h}, which is more picture than this board can open — the pixels rather than the size of the file"
            ),
            Error::TooLargeToPaste(_) => {
                "is too big to hand over in one piece — drag it in from a window instead".into()
            }
            Error::TooLarge(_) => "is bigger than this board will take".into(),
            Error::SizeMismatch => "is not the size it said it was".into(),
            Error::Undecodable(_) => "says it is a picture and will not open as one".into(),
            // A path that went stale, a fetch that failed, a store that never
            // opened. The person is told the attempt failed and nothing about
            // the board, because nothing about the board has been established.
            _ => "could not be read".into(),
        }
    }
}

/// An ingest that did not happen, in a shape the webview can act on.
///
/// The three `asset_ingest_*` commands reject with this rather than with a
/// string, and deliberately alone in that: this is the only boundary where the
/// failure is a sentence somebody reads rather than a line in a log, so it is
/// the only one that has to carry it as data. Matching on the prose of a message
/// would have been the alternative, and prose is not a contract (T-309).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    /// Whether to say that nothing here can hold it. See [`Error::holds_nowhere`].
    pub holds_nowhere: bool,
    /// A verb phrase with the file as its subject.
    pub say: String,
}

impl Refusal {
    /// Something that went wrong on this side of the store — the blocking job
    /// panicked, the store never opened, the body arrived in the wrong shape.
    /// Never a claim about the board: nothing about the file was established.
    pub fn failed(why: String) -> Self {
        eprintln!("assets: an ingest failed before it began: {why}");
        Self {
            holds_nowhere: false,
            say: "could not be read".into(),
        }
    }
}

impl From<Error> for Refusal {
    fn from(error: Error) -> Self {
        Self {
            holds_nowhere: error.holds_nowhere(),
            say: error.sentence(),
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
///
/// `pub(crate)` for `bundle`, and deliberately not re-implemented there: a
/// second definition of "is this a hash" is a second thing to keep in step, and
/// the one that drifts is always the one guarding the newer door.
pub(crate) fn valid_hash(sha256: &str) -> bool {
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

/// How much of a file the sniffer below can want to look at.
///
/// Twelve bytes covered the four image formats and nothing else: a Matroska
/// file says whether it is `webm` in a DocType element a few dozen bytes in,
/// and an Ogg stream names its codec at offset 28. Both of those distinctions
/// are the difference between `video/` and `audio/`, which is the whole reason
/// this function exists.
pub const SNIFF_BYTES: usize = 64;

/// Magic numbers, not the caller's word for it. A browser's idea of a
/// clipboard item's type is a hint; the first bytes are evidence.
///
/// ## Why a media type has to be sniffed at all
///
/// Serving these as `application/octet-stream` is not merely untidy — no
/// `<video>` or `<audio>` element will touch one. The element looks at the
/// `Content-Type` before it looks at the bytes, so a correct file behind a
/// wrong type fails to play with no error worth reading. That is the whole of
/// T-262, and it is why this list grew past pictures.
///
/// The order is not arbitrary. Everything with a container signature is asked
/// first and the bare MPEG frame header is asked last, because it is the only
/// entry here that is a *pattern* rather than a string — eleven set bits and
/// four fields that have to be plausible — and it would otherwise claim the odd
/// file that merely begins with the right byte.
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
    // One container, three payloads. `.webp` was already one of them, which is
    // why this reads as an existing arm learning two more rather than as two
    // new formats being appended to the list.
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") {
        return match &bytes[8..12] {
            b"WEBP" => Some("image/webp"),
            b"WAVE" => Some("audio/wav"),
            b"AVI " => Some("video/x-msvideo"),
            _ => None,
        };
    }
    if bytes.starts_with(b"%PDF-") {
        return Some("application/pdf");
    }
    // ISO base media: the `ftyp` box is second, not first, and the brand that
    // follows it is what says whether the identical container is a film or a
    // song. An `.m4a` and an `.mp4` differ in those four bytes and nowhere
    // else that is cheap to reach.
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return match &bytes[8..12] {
            b"M4A " | b"M4B " | b"M4P " | b"F4A " => Some("audio/mp4"),
            b"qt  " => Some("video/quicktime"),
            _ => Some("video/mp4"),
        };
    }
    // EBML, which is Matroska and WebM both. The DocType string is an element
    // in the header rather than at a fixed offset, so it is searched for
    // instead of indexed — and Matroska is the fallback because a `.mkv` is a
    // film either way and only the codec support differs.
    //
    // Searched over the sniff window and not over the slice, which at ingest
    // is the *whole file*: a two-gigabyte `.mkv` with the four bytes `webm`
    // anywhere in its payload would otherwise be renamed by its own contents.
    if bytes.starts_with(b"\x1a\x45\xdf\xa3") {
        let header = &bytes[..bytes.len().min(SNIFF_BYTES)];
        return if find(header, b"webm").is_some() {
            Some("video/webm")
        } else {
            Some("video/x-matroska")
        };
    }
    // Ogg names its codec in the first packet, at a fixed offset. Theora is
    // the only one of the three that makes this a video, and guessing audio
    // for an unrecognised codec is the safer way round: a soundtrack playing
    // out of a cassette is a smaller lie than a silent tape.
    if bytes.starts_with(b"OggS") {
        let codec = bytes.get(28..).unwrap_or_default();
        return if codec.starts_with(b"\x80theora") {
            Some("video/ogg")
        } else {
            Some("audio/ogg")
        };
    }
    if bytes.starts_with(b"fLaC") {
        return Some("audio/flac");
    }
    if bytes.starts_with(b"ID3") || is_mpeg_frame(bytes) {
        return Some("audio/mpeg");
    }
    // **Last, and it could not be anywhere else.** Every other arm here matches
    // a signature; text has none, so the only honest form the question can take
    // is *what is left*. Q-255 chose this over recognising a document by its
    // extension, which keeps the rule the whole ingest story is built on: an
    // extension is what somebody typed, and this is the one place the board
    // decides what it is holding.
    //
    // Asked of the sniff window and not of the slice, for the reason the EBML
    // DocType above is: at ingest this function is handed the *whole file*, and
    // the answer must not depend on which of the two the caller had.
    //
    // Two consequences worth stating rather than discovering. An empty file is
    // not text — there is no evidence about it at all — so it stays refused at
    // the gate the way it is today. And a file whose head reads as text while
    // the rest does not becomes a folder that `text::decode` then declines to
    // count: a document with nothing written where its thickness goes, which is
    // the outcome the 6% of real PDFs D-47 measured already have.
    if crate::text::reads_as_text(&bytes[..bytes.len().min(SNIFF_BYTES)]) {
        return Some("text/plain");
    }
    None
}

/// The first index at which `needle` appears in `haystack`.
///
/// Only the EBML DocType wants this, and only over the sniff window, so the
/// naive scan is the right one — a substring search that pays for an index
/// would be pricing a 64-byte haystack like a document.
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// A plausible MPEG audio frame header, which is all an `.mp3` without an ID3
/// tag has to identify it.
///
/// Eleven sync bits alone would claim roughly one file in two thousand at
/// random, so the three fields behind them are checked for their reserved
/// values as well. It is still the weakest signature in [`sniff_mime`], which
/// is why it is asked last and why a bitrate of `free` is refused along with
/// the reserved one — a real encoder writes neither.
fn is_mpeg_frame(bytes: &[u8]) -> bool {
    let (Some(&a), Some(&b), Some(&c)) = (bytes.first(), bytes.get(1), bytes.get(2)) else {
        return false;
    };
    a == 0xff
        && b & 0xe0 == 0xe0
        && (b >> 3) & 0x03 != 0x01 // version: 01 is reserved
        && (b >> 1) & 0x03 != 0x00 // layer: 00 is reserved
        && !matches!(c >> 4, 0x00 | 0x0f) // bitrate: free, and bad
        && (c >> 2) & 0x03 != 0x03 // sampling rate: 11 is reserved
}

/// The file extension a mime type should be written out under, without the dot.
///
/// Only exists for export. Inside the store nothing needs it — an original is
/// stored under its hash and nothing else, because a content-addressed name has
/// no room for one — which is exactly why leaving the store means inventing one.
fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "application/pdf" => "pdf",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "video/x-matroska" => "mkv",
        "video/x-msvideo" => "avi",
        "video/ogg" => "ogv",
        "audio/mpeg" => "mp3",
        "audio/mp4" => "m4a",
        "audio/wav" => "wav",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        // One extension for every kind of text, because the sniffer has one
        // mime for them: a `.md`, a `.csv` and a `.log` are told apart by their
        // names, and a name is the evidence this store does not keep.
        "text/plain" => "txt",
        // Reachable now in a way it was not: ingestion no longer decodes
        // everything it commits, so a format the sniffer does not know still
        // gets stored and can still be exported. A store directory is a
        // directory on someone's disk, and offering a name with no extension
        // at all is worse than offering a dull one.
        _ => "bin",
    }
}

/// Windows treats these as devices whatever directory they appear in, and with
/// any extension: `CON.jpg` is not a file.
const DEVICE_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// How much of a suggested name to keep. Long enough to recognise a photograph
/// by, short enough that the whole thing fits in a dialog's name field.
const MAX_STEM_CHARS: usize = 64;

/// Reduce a suggested filename to something that can only *be* a filename.
///
/// The suggestion is the asset's `origName`, and it comes from the document —
/// so it came from whoever ingested the asset. That is a URL segment off a page
/// nobody here wrote, or a peer's string arriving over sync. It is the one
/// caller-supplied string anywhere near this command, and this is where it stops
/// being one.
///
/// Reducing a *name* is tractable in the way validating a *destination path* is
/// not, and the difference is the whole reason `asset_export` takes a name and
/// not a path. A path has no wrong answers to recognise — every directory on the
/// disk is somewhere a user might legitimately save a photograph. A name has
/// plenty: no separator may appear in one at all, a colon is an alternate data
/// stream rather than punctuation, a trailing dot or space is silently something
/// else on Windows, and the extension is not the suggester's to pick because the
/// bytes on disk already decided it.
///
/// So `..\..\Startup\holiday.exe` comes out as `holiday`, gets `.jpg` from what
/// is actually in the file, and lands in whichever directory the user was
/// already looking at. `None` means nothing survived and the caller should fall
/// back to a name of its own.
pub(crate) fn safe_stem(hint: &str) -> Option<String> {
    // A separator is never part of a name, so only the last component could be
    // one. Both spellings, because a name can arrive from either platform.
    let last = hint.rsplit(['/', '\\']).next().unwrap_or_default();
    // Dropped, not kept and re-suffixed: `holiday.exe.jpg` is a safe file with
    // `.exe` sitting in the middle of a name someone is about to skim past.
    let stem = last.rsplit_once('.').map_or(last, |(before, _)| before);

    let cleaned: String = stem
        .chars()
        // A deny list rather than an allow list of ASCII, so a name in Japanese
        // survives being suggested instead of arriving as a row of dashes.
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '-'
            } else {
                c
            }
        })
        .take(MAX_STEM_CHARS)
        .collect();

    // Leading dots hide a file; trailing dots and spaces are dropped by Windows,
    // which makes `holiday .` a different file from the one the dialog showed.
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c == '-' || c.is_whitespace());
    if trimmed.is_empty() || DEVICE_NAMES.contains(&trimmed.to_ascii_uppercase().as_str()) {
        return None;
    }
    Some(trimmed.to_string())
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

/// Below this reduction a box average is the wrong filter, and above it the
/// only one worth paying for.
///
/// Two, because at two each output pixel covers a whole two-by-two block and the
/// average is exact. Below it the block is fractional, the box degenerates
/// towards nearest-neighbour, and it aliases: measured on sixty photographs
/// against CatmullRom, a 1.2× reduction moves the picture by 4.48 levels out of
/// 255 with a worst channel of 228, where 2× moves it by 1.30 and 4.3× by 2.24
/// (D-58).
///
/// The split costs nothing, which is the good part: `resize`'s intermediate is
/// as wide as the *source*, so the mild reductions this keeps it for are exactly
/// the ones where the source is small enough for it not to matter.
const BOX_FILTER_FROM: u32 = 2;

/// Downscale, by whichever filter suits the reduction.
///
/// `thumbnail` is an exact area average and allocates nothing but its result.
/// `resize` filters vertically into an `Rgba32FImage` as wide as the source and
/// as tall as the output, at [`RESAMPLE_BYTES_PER_PIXEL`] — 430 MiB for a
/// 121-megapixel photograph, which was the largest single thing in an ingest and
/// the reason a picture's *shape* changed what it cost.
///
/// The box average is not a compromise for the reductions it is used at. Over
/// sixty real photographs at the 4.3× a display variant actually does, it came
/// out **4.2 per cent sharper** than CatmullRom rather than softer — the filter
/// in use spreads its window wide when it reduces this far — and moved the
/// picture by a mean of 1.96 levels out of 255 (D-58, Q-236).
fn downscale(image: &DynamicImage, edge: u32) -> DynamicImage {
    if image.width().max(image.height()) >= edge.saturating_mul(BOX_FILTER_FROM) {
        image.thumbnail(edge, edge)
    } else {
        image.resize(edge, edge, FilterType::CatmullRom)
    }
}

fn apply_orientation(image: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        // The `drop` is not tidiness. Chained, `rotate90().fliph()` holds three
        // whole surfaces at once — the argument, the turn and the flip — where
        // every other arm here holds two. Measured on the same rig as the rest
        // of D-57: a 121-megapixel picture marked orientation 5 peaked at
        // **1047.5 MiB, over the whole ingest budget**, against 803.3 for the
        // identical picture marked 1. Letting the original go between the two
        // passes costs nothing and takes it to 803.3 as well — which is what
        // lets [`decode_peak`] be one expression rather than a maximum over
        // where in the road the picture happens to be.
        5 => {
            let turned = image.rotate90();
            drop(image);
            turned.fliph()
        }
        6 => image.rotate90(),
        7 => {
            let turned = image.rotate270();
            drop(image);
            turned.fliph()
        }
        8 => image.rotate270(),
        _ => image,
    }
}

/// What a header says a picture is: the shape it will be stored at, and what
/// one pixel of it costs the moment it is decoded.
struct Probed {
    w: u32,
    h: u32,
    /// What the decoder says it will produce, per pixel — three for a JPEG,
    /// four for a PNG with an alpha channel, eight for a sixteen-bit one.
    ///
    /// **This is why a megapixel ceiling would not have held.** Depth is a
    /// property of the picture in exactly the way a JPEG's compression ratio is
    /// a property of the picture, and it moves the cost by nearly three times at
    /// the same pixel count (D-57).
    bytes_per_pixel: u64,
    /// Whether the decoded surface has an alpha channel at all, which decides
    /// whether this picture's variant *can* take the PNG road — the expensive
    /// one. Whether it actually does is `uses_alpha`'s answer and is not known
    /// until the pixels are read, so a bound has to assume it will.
    alpha: bool,
}

/// Dimensions and depth without decoding. Every format here carries both in a
/// header a few dozen bytes long.
///
/// Building the decoder and asking it, rather than asking for dimensions, costs
/// nothing: `into_dimensions` builds one, reads two numbers off it and throws
/// it away. It is the only way to be told the colour type before the pixels
/// arrive, and the colour type is half of what [`decode_peak`] needs.
///
/// It does not reserve anything, which is what makes it safe to call on a
/// picture this store is about to refuse: `ImageReader::decode` is where the
/// crate checks its own allocation limit, and that is on the far side of the
/// gate in [`AssetStore::ingest_bytes`].
fn probe_picture(bytes: &[u8]) -> Result<Probed> {
    let decoder = ImageReader::new(io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(Error::Io)?
        .into_decoder()
        .map_err(|e| Error::Undecodable(e.to_string()))?;
    let (w, h) = decoder.dimensions();
    let colour = decoder.color_type();
    let bytes_per_pixel = u64::from(colour.bytes_per_pixel());
    let (w, h) = if swaps_axes(exif_orientation(bytes)) {
        (h, w)
    } else {
        (w, h)
    };
    Ok(Probed {
        w,
        h,
        bytes_per_pixel,
        alpha: colour.has_alpha(),
    })
}

/// The allocation ceiling handed to every decode, so that the crate's rule and
/// this store's rule are the same rule.
///
/// `image` ships a default of 512 MiB and this codebase never wrote it down —
/// which is why a 256-megapixel scan was *already* refused before T-308, with
/// "Memory limit exceeded" on stderr, after the file had been stored and the
/// item was on the board. Two rules about the same memory, one of them
/// invisible and neither of them ours.
///
/// Setting it to [`MAX_PICTURE_PEAK`] makes it a backstop rather than a second
/// opinion: nothing [`AssetStore::ingest_bytes`] admitted can be refused here,
/// because every term in [`decode_peak`] is at least as big as this one, and
/// anything that reached a decode without passing that gate still cannot take
/// the process past the budget.
fn decode_limits() -> Limits {
    let mut limits = Limits::no_limits();
    limits.max_alloc = Some(MAX_PICTURE_PEAK);
    limits
}

fn hex(digest: &[u8]) -> String {
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// What these bytes are called, in the only naming scheme this store has.
///
/// `pub(crate)` for `bundle`, which needs to know a zip entry's true name
/// *before* handing it to [`AssetStore::ingest_bytes`] — an entry called
/// `assets/<x>` holding bytes that hash to `<y>` is a bundle lying about its
/// own contents, and ingesting first would mean writing `<y>` into the store on
/// the way to finding out.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
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

    // --- transfer -----------------------------------------------------------
    //
    // The store half of the peer exchange (ARCHITECTURE section 5.2). The
    // frontend decides what to ask for and who to ask; everything below is the
    // part it is deliberately not allowed to do — cut the original into chunks,
    // put the arriving ones somewhere, and refuse to commit any of it until the
    // hash says it is what was asked for.

    /// The original's size, or `None` for an asset this machine does not hold.
    pub fn size(&self, sha256: &str) -> Option<u64> {
        if !valid_hash(sha256) {
            return None;
        }
        fs::metadata(self.original_path(sha256)).ok().map(|m| m.len())
    }

    /// Every hash there are bytes for here, for the `HAVE` announcement.
    ///
    /// The originals only. A machine holding a display variant and not the
    /// original cannot serve the asset — the variants are a local cache, not a
    /// thing to hand to a peer who asked for a photograph.
    pub fn hashes(&self) -> Result<Vec<String>> {
        let trash = self.trash_dir();
        let mut out = Vec::new();
        for entry in walk_files(&self.root)? {
            if entry.starts_with(&trash) {
                continue;
            }
            let Some(name) = entry.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            // Exactly the hash and nothing after it: `<sha>.display.jpg` and a
            // half-received `<sha>.part-recv` both start with one.
            if valid_hash(name) {
                out.push(name.to_string());
            }
        }
        Ok(out)
    }

    /// One chunk of an original, to put on the wire.
    ///
    /// Empty for an asset that is not here, or an index past the end. Not an
    /// error: an asset collected between the `WANT` and this call is an ordinary
    /// race, and the peer waiting is served better by a stream that stops than
    /// by a failure it has no way to act on.
    pub fn chunk(&self, sha256: &str, index: u64) -> Result<Vec<u8>> {
        if !valid_hash(sha256) {
            return Err(Error::BadHash);
        }
        let Some(at) = index.checked_mul(CHUNK_BYTES) else {
            return Ok(Vec::new());
        };
        let Ok(mut file) = File::open(self.original_path(sha256)) else {
            return Ok(Vec::new());
        };
        if file.seek(SeekFrom::Start(at)).is_err() {
            return Ok(Vec::new());
        }
        let mut buffer = vec![0u8; CHUNK_BYTES as usize];
        let mut filled = 0usize;
        // `read` is allowed to return less than asked for without being at the
        // end, and a short chunk in the middle of a transfer would be a hole in
        // the file at the other end that only the hash check would ever notice.
        while filled < buffer.len() {
            match file.read(&mut buffer[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(ref e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(Error::Io(e)),
            }
        }
        buffer.truncate(filled);
        Ok(buffer)
    }

    /// Where a transfer accumulates. `.part` in the name, so `gc` sweeps an
    /// abandoned one the same way it sweeps an interrupted write.
    fn partial_path(&self, sha256: &str) -> PathBuf {
        self.original_path(sha256).with_extension("part-recv")
    }

    /// How many bytes of this asset are already on the disk, from a transfer
    /// that was interrupted rather than finished.
    ///
    /// **A length, not a count of chunks, and the difference is the whole
    /// reason resuming needs no bookkeeping** (T-265). `receive_chunk` writes at
    /// offsets, so a file with a hole in it is longer than the bytes it holds
    /// and this number would be a lie. It is not a lie because of a property
    /// held on the *other* side of the wire: `serve` sends chunk zero upwards in
    /// order, and the exchange only ever resumes from a contiguous point, so
    /// what accumulates here is always dense. Under that, the length is exactly
    /// the prefix that can be kept.
    ///
    /// The store does not enforce that and must not: `receive_chunk` accepts any
    /// order on purpose, and the hash at commit is what actually decides whether
    /// a transfer was any good. This is a hint that makes a resume cheap, and
    /// the failure mode when the hint is wrong is a commit that does not verify
    /// — the same one a dropped chunk already has.
    ///
    /// Zero for no such file, which is also the right answer for a transfer
    /// whose partial the hour-long `gc` sweep has already taken.
    pub fn partial_len(&self, sha256: &str) -> u64 {
        if !valid_hash(sha256) {
            return 0;
        }
        fs::metadata(self.partial_path(sha256))
            .map(|meta| meta.len())
            .unwrap_or(0)
    }

    /// File one arriving chunk. Nothing here is trusted yet.
    ///
    /// Written at its own offset rather than appended, so the order chunks
    /// arrive in does not matter and a repeat costs nothing. A gap left by a
    /// chunk that never came reads back as zeroes, which is a file that does
    /// not hash to its name — so the missing-chunk case needs no bookkeeping of
    /// its own, and cannot be got wrong separately from the corruption case.
    pub fn receive_chunk(&self, sha256: &str, index: u64, total: u64, bytes: &[u8]) -> Result<()> {
        if !valid_hash(sha256) {
            return Err(Error::BadHash);
        }
        // Everything a peer sends is a claim about how big a file it is about to
        // make us create, and `seek` past the end of a file is how a sparse one
        // of any size at all gets made.
        if index >= total || bytes.len() as u64 > CHUNK_BYTES {
            return Err(Error::BadHash);
        }
        let Some(at) = index.checked_mul(CHUNK_BYTES) else {
            return Err(Error::TooLarge(u64::MAX));
        };
        let end = at.saturating_add(bytes.len() as u64);
        if end > MAX_ASSET_BYTES {
            return Err(Error::TooLarge(end));
        }

        fs::create_dir_all(self.dir_for(sha256))?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.partial_path(sha256))?;
        file.seek(SeekFrom::Start(at))?;
        file.write_all(bytes)?;
        Ok(())
    }

    /// Hash what arrived, and commit it only if it is what was asked for.
    ///
    /// **This is the only place the bytes from another machine become an
    /// asset**, and the hash is checked before they are anywhere they could be
    /// served or rendered from. `false` is "that was not the asset" — a
    /// collision on the `HAVE` prefix, a truncated transfer, a peer with a
    /// corrupted store — and it is not a failure, so the caller retries
    /// somebody else rather than reporting anything.
    ///
    /// The digest is taken here and then again inside `ingest_bytes`. Thirty
    /// milliseconds on a twelve megabyte photograph, in exchange for a received
    /// asset landing by exactly the same path as a pasted one: the trash
    /// restore, the mime sniff, the dimensions and the atomic rename are all
    /// written once, and a transfer cannot drift away from them.
    pub fn commit_received(&self, sha256: &str) -> Result<bool> {
        if !valid_hash(sha256) {
            return Err(Error::BadHash);
        }
        let partial = self.partial_path(sha256);
        let size = fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);
        if size == 0 || size > MAX_ASSET_BYTES {
            let _ = fs::remove_file(&partial);
            return Ok(false);
        }

        let bytes = fs::read(&partial)?;
        let _ = fs::remove_file(&partial);
        if hex(&Sha256::digest(&bytes)) != sha256 {
            return Ok(false);
        }
        self.ingest_bytes(&bytes, None)?;
        Ok(true)
    }

    /// Throw away a partial transfer. Absent is success — the caller aborts on
    /// a socket closing, and there may never have been a file.
    pub fn abort_received(&self, sha256: &str) -> Result<()> {
        if !valid_hash(sha256) {
            return Err(Error::BadHash);
        }
        match fs::remove_file(self.partial_path(sha256)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Error::Io(e)),
        }
    }

    // --- ingestion ----------------------------------------------------------

    /// [`ingest_bytes`](Self::ingest_bytes), for bytes that crossed the IPC
    /// boundary as one buffer — which is the expensive road, and the only one
    /// bounded by [`MAX_PASTE_BYTES`] rather than by [`MAX_ASSET_BYTES`].
    ///
    /// A separate entry rather than a flag on the shared one because the other
    /// callers of `ingest_bytes` are a bundle expanding an entry, a peer
    /// transfer committing, and this store's own path road — they all start
    /// from a file on a disk, they all pay the cheap cost, and none of them
    /// should be refused at a ceiling sized for wry's read loop. A
    /// four-hundred-megabyte interview is *supposed* to reach the store; it
    /// just is not supposed to come this way.
    pub fn ingest_ipc_bytes(&self, bytes: &[u8], mime_hint: Option<&str>) -> Result<AssetMeta> {
        let size = bytes.len() as u64;
        if size > MAX_PASTE_BYTES {
            return Err(Error::TooLargeToPaste(size));
        }
        self.ingest_bytes(bytes, mime_hint)
    }

    /// Hash, probe, store. **Returns as soon as the hash and the dimensions are
    /// known** (AC-46); the caller is expected to kick off [`build_variants`]
    /// afterwards and emit `asset:ready` when it finishes.
    ///
    /// `mime_hint` is only consulted when the magic numbers say nothing.
    ///
    /// The ceiling here is [`MAX_ASSET_BYTES`] — how big an asset may be at all
    /// — because every road funnels through this function and only one of them
    /// is the expensive one. That road checks itself first, in
    /// [`ingest_ipc_bytes`](Self::ingest_ipc_bytes).
    ///
    /// **And the second bound, which is not about bytes at all**, is here for
    /// the same reason the first one is: a picture costs its pixels and their
    /// depth, both are in the header, and every road that can put a picture on
    /// this board comes through this function — a paste, a drop, a peer
    /// transfer committing, a bundle expanding an entry. One gate, before the
    /// write, and long before the decode that would pay for it.
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
        let (w, h) = match probe_picture(bytes) {
            Ok(picture) => {
                // The one refusal on this road that is about the picture rather
                // than about the file, and it has to be here rather than in
                // `build_variants` where the memory is actually spent. By then
                // the bytes are on the disk, the item is on the board, and the
                // failure is a line on stderr — which is what a 256-megapixel
                // scan did before T-308, leaving the webview to decode it.
                let asked = decode_peak(
                    size,
                    u64::from(picture.w),
                    u64::from(picture.h),
                    picture.bytes_per_pixel,
                    picture.alpha,
                );
                if asked > MAX_PICTURE_PEAK {
                    return Err(Error::PictureTooLarge {
                        w: picture.w,
                        h: picture.h,
                    });
                }
                (picture.w, picture.h)
            }
            // Not a picture, or not one this build can read. Both are stored:
            // the second is a photograph the board shows a tear for rather than
            // one it throws away.
            Err(_) => (0, 0),
        };
        // Read here, from the whole file, once — and *before* the write, so a
        // received asset gets the number by the same path a pasted one does.
        // `commit_received` routes through this function for exactly that
        // reason, and a duration probed anywhere else would be the one field
        // that could differ between the machine that pasted the film and the
        // machine that was sent it.
        let duration = media::probe_duration(bytes, &mime);
        // And the page count, on the same argument and in the same place: one
        // structure load, no page read, and `commit_received` comes through here
        // too so a folder that arrived over the wire counts its pages by the
        // same code as one that was pasted.
        let pages = document::probe(bytes, &mime).map(|d| d.pages);

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
            duration,
            pages,
        })
    }

    /// Ingest a file already on disk. Read once into memory, which is what the
    /// [`MAX_ASSET_BYTES`] ceiling is for: hashing in a stream and then
    /// re-reading to probe would touch the disk twice to save a buffer that a
    /// background thread is about to allocate anyway.
    ///
    /// The read below is the one [`disk_ingest_peak`] models, and **the whole of
    /// that function's flatness rests on the two lines here that look like
    /// belt-and-braces.** The buffer is sized from the metadata so `read_to_end`
    /// never has to guess, and the read is held to that same number so it can
    /// never grow past it — a hint on its own is only a hint, and a source that
    /// hands back more than it promised would double its way up exactly as
    /// before. The ceiling is derived from the worst case, not the usual one.
    pub fn ingest_path(&self, path: &Path) -> Result<AssetMeta> {
        let file = File::open(path)?;
        let size = file.metadata()?.len();
        if size > MAX_ASSET_BYTES {
            return Err(Error::TooLarge(size));
        }
        // No `BufReader` around it: that exists to make small reads cheap, and
        // there are no small reads left here. `read_to_end` fills the spare
        // capacity in whatever chunks the file system gives it, and an 8 KiB
        // way-station in front of that is one memcpy of the whole file for
        // nothing.
        let bytes = read_promised(file, size)?;
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
    /// Idempotent, and a no-op for an asset the sniffer places as something
    /// other than a picture — it produces nothing, says so with `Ok`, and the
    /// original is served instead.
    pub fn build_variants(&self, sha256: &str) -> Result<()> {
        if !valid_hash(sha256) {
            return Err(Error::BadHash);
        }
        let original = self.original_path(sha256);
        let bytes = fs::read(&original).map_err(|_| Error::NotFound)?;

        // This function's own comment claimed a film was safe to pass here and
        // "simply produces nothing" long before it was: the decode failed, the
        // error came back, and `schedule_variants` printed "assets: no
        // variants for <hash>" for every video and every PDF on the board — a
        // failure line for the one outcome that is not a failure.
        //
        // Only a *known* non-picture returns early. Bytes the sniffer cannot
        // place still go to the decoder, because `with_guessed_format` knows
        // formats this function does not and a real failure there is worth
        // hearing about.
        if sniff_mime(&bytes).is_some_and(|mime| !mime.starts_with("image/")) {
            return Ok(());
        }

        let orientation = exif_orientation(&bytes);
        let mut reader = ImageReader::new(io::Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(Error::Io)?;
        reader.limits(decode_limits());
        let decoded = reader
            .decode()
            .map_err(|e| Error::Undecodable(e.to_string()))?;
        let image = apply_orientation(decoded, orientation);

        // No variant when the original is already small enough and already the
        // right way up: the handler falls back to it, and a byte-identical
        // second copy on disk is the one thing a content-addressed store is
        // supposed to make impossible.
        let oversized = image.width() > DISPLAY_MAX_EDGE || image.height() > DISPLAY_MAX_EDGE;
        // Borrowed when the only reason for a variant is the rotation — cloning
        // a decoded 40-megapixel image to hand it straight to an encoder is
        // 160 MB of memcpy for nothing.
        let display: Cow<'_, DynamicImage> = if oversized {
            Cow::Owned(downscale(&image, DISPLAY_MAX_EDGE))
        } else {
            Cow::Borrowed(&image)
        };
        if oversized || orientation != 1 {
            self.write_variant(sha256, Variant::Display, &display, JPEG_QUALITY_DISPLAY)?;
        }

        // **Off the display variant, not off the original.** Ten times smaller
        // again from something already filtered is what a mip chain is, and it
        // is indistinguishable at 256 pixels — while going back to the original
        // meant a second pass whose cost scaled with the *source*, which is the
        // one property this whole road was just rid of. When there is no display
        // variant the original is already inside 2560 and bounded anyway.
        let thumb = downscale(&display, THUMB_MAX_EDGE);
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
        let alpha = uses_alpha(image);
        let ext = if alpha { ".png" } else { ".jpg" };
        // The other extension may be left over from a previous build with a
        // different alpha verdict, and two variants would make `resolve`'s
        // answer depend on probe order.
        let stale = self.path_for(sha256, variant, if alpha { ".jpg" } else { ".png" });
        let _ = fs::remove_file(stale);

        // **Encoded into the file rather than into a buffer.** There was a
        // `Vec` here that the whole variant was built in and then written from,
        // and with the resize intermediate gone (T-310) it was what the peak of
        // the alpha road had become: a 2560-square variant of 25 MiB was costing
        // 144. A `Vec` that nobody sized doubles, and the allocator keeps every
        // outgrown half — the same shape T-307 took out of `ingest_path`, and
        // the reason *sizing* it was the wrong answer there is the reason
        // removing it is the right one here. An encoder is a `Write`; a file is
        // a `Write`. There was never anything for the buffer to do.
        write_atomic_with(&self.path_for(sha256, variant, ext), |file| {
            if alpha {
                // **Eight bits a channel whatever the original was.** A variant
                // exists to be shown, a webview shows eight, and the original is
                // still on disk untouched for anything that wants the rest.
                // Encoding a 2560-square variant *at sixteen* cost a fixed
                // 337 MiB (D-57).
                let rgba = image.to_rgba8();
                image::codecs::png::PngEncoder::new(file)
                    .write_image(
                        rgba.as_raw(),
                        rgba.width(),
                        rgba.height(),
                        image::ExtendedColorType::Rgba8,
                    )
                    .map_err(|e| Error::Undecodable(e.to_string()))
            } else {
                image::codecs::jpeg::JpegEncoder::new_with_quality(file, quality)
                    .encode_image(&image.to_rgb8())
                    .map_err(|e| Error::Undecodable(e.to_string()))
            }
        })
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
        let mime = sniff_path(&original).unwrap_or("application/octet-stream");
        Some(Resolved {
            path: original,
            // The original standing in for a variant is only a *temporary*
            // answer when a variant is coming. Nothing downscales a film, so
            // for anything that is not a picture this is the final answer at
            // every variant, and saying so is what lets it be cached.
            //
            // That is not tidiness. A `<video>` plays by asking for one range
            // after another for the length of the file, and `no-store` means
            // the webview may re-ask for spans it already has — on a 400 MB
            // interview, off a disk, for the whole sitting.
            exact: variant == Variant::Original || !mime.starts_with("image/"),
            mime: mime.to_string(),
        })
    }

    /// What to offer this asset as in a save dialog.
    ///
    /// Answered before the dialog opens rather than after, so a hash that is
    /// malformed or unknown fails immediately instead of after the user has
    /// picked somewhere to put nothing.
    ///
    /// `hint` is the asset's `origName` — the last URL or path segment paste kept
    /// on the way in, and the only provenance a content-addressed store has room
    /// for. It is a suggestion in both directions: [`safe_stem`] decides how much
    /// of it survives, and the user can replace whatever does. The extension is
    /// not part of the suggestion; it comes from the bytes.
    ///
    /// With nothing usable to suggest the name is the hash's first eight
    /// characters, which is unlovely but unique — `image.jpg` would collide with
    /// itself the second time anyone exported.
    pub fn export_name(&self, sha256: &str, hint: Option<&str>) -> Result<ExportName> {
        if !valid_hash(sha256) {
            return Err(Error::BadHash);
        }
        let original = self.original_path(sha256);
        if !original.is_file() {
            return Err(Error::NotFound);
        }
        // Sniffed, like everywhere else the store needs to know what something
        // is: the mime was never written down (`resolve` re-derives it too).
        let extension = extension_for(
            read_head(&original, 12)
                .ok()
                .and_then(|head| sniff_mime(&head))
                .unwrap_or_default(),
        );
        // Slicing bytes off the hash is safe: `valid_hash` has established 64 of
        // them, all ASCII.
        let stem = hint
            .and_then(safe_stem)
            .unwrap_or_else(|| format!("schizoboard-{}", &sha256[..8]));
        Ok(ExportName {
            file_name: format!("{stem}.{extension}"),
            extension,
        })
    }

    /// Copy an original out to a path *someone else* chose.
    ///
    /// Deliberately takes a path and validates nothing about it, because there
    /// is nothing useful to validate — see the note in `lib.rs` above
    /// `asset_export`. Both callers get their path from outside this module and
    /// neither gets it from the webview: the command gets one from a native save
    /// dialog, and bundle export (T-84) will pass one the application picked.
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
/// [`write_atomic`], for a producer that would rather write than be read from.
///
/// The same temp-then-rename, with `fill` handed the file instead of the bytes
/// handed to us — so an encoder that is already a `Write` never has to build its
/// answer in memory first. Buffered, because an encoder writes in small pieces
/// and a syscall each is the thing `write_atomic`'s single `write_all` was
/// getting for free.
fn write_atomic_with(
    path: &Path,
    fill: impl FnOnce(&mut dyn Write) -> Result<()>,
) -> Result<()> {
    let temp = temp_beside(path);
    let outcome = (|| {
        let mut file = io::BufWriter::new(File::create(&temp)?);
        fill(&mut file)?;
        let file = file.into_inner().map_err(|e| Error::Io(e.into_error()))?;
        file.sync_all()?;
        Ok(())
    })();
    if outcome.is_err() {
        let _ = fs::remove_file(&temp);
        return outcome;
    }
    finish_atomic(&temp, path)
}

/// A name beside `path` that nothing else in this process or any other will
/// choose.
fn temp_beside(path: &Path) -> PathBuf {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    path.with_extension(format!(
        "part{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Put the finished temp file where it belongs.
fn finish_atomic(temp: &Path, path: &Path) -> Result<()> {
    match fs::rename(temp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(temp);
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

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = temp_beside(path);
    {
        let mut file = File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    finish_atomic(&temp, path)
}

/// What the bytes at this path say they are, off their first [`SNIFF_BYTES`].
///
/// The same evidence [`sniff_mime`] is given at ingest, asked of a file the
/// store already holds — so a caller that has a hash and needs to know what to
/// do with it dispatches on the file rather than on a record some other machine
/// wrote. `None` for a file that is not there, and for one whose head matches
/// nothing this build knows.
pub(crate) fn sniff_path(path: &Path) -> Option<&'static str> {
    read_head(path, SNIFF_BYTES)
        .ok()
        .and_then(|head| sniff_mime(&head))
}

fn read_head(path: &Path, n: usize) -> io::Result<Vec<u8>> {
    let mut buffer = vec![0u8; n];
    let mut file = File::open(path)?;
    let read = file.read(&mut buffer)?;
    buffer.truncate(read);
    Ok(buffer)
}

/// `pub(crate)` for `pages`, whose whole argument is that reading a document
/// writes nothing here — a claim that is only worth making if something counts
/// the files and proves it (AC-692).
pub(crate) fn walk_files(root: &Path) -> io::Result<Vec<PathBuf>> {
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

    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let mut out = Vec::new();
        DynamicImage::ImageRgb8(RgbImage::from_pixel(w, h, image::Rgb([200, 40, 40])))
            .write_to(&mut io::Cursor::new(&mut out), ImageFormat::Jpeg)
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

    /// An ISO base media header: a box length, `ftyp`, and the brand that says
    /// which of the family this is. Nothing past byte 12 is looked at.
    fn ftyp(brand: &[u8; 4]) -> Vec<u8> {
        let mut out = vec![0, 0, 0, 0x18];
        out.extend_from_slice(b"ftyp");
        out.extend_from_slice(brand);
        out
    }

    /// An Ogg page whose first packet begins at byte 28 — four bytes of
    /// capture pattern, then the 23 that carry version, granule, serial,
    /// sequence, checksum and the one-entry segment table.
    fn ogg(codec: &[u8]) -> Vec<u8> {
        let mut out = b"OggS".to_vec();
        out.resize(28, 0);
        out.extend_from_slice(codec);
        out
    }

    /// An EBML header with a DocType somewhere inside it.
    fn ebml(doc_type: &[u8]) -> Vec<u8> {
        let mut out = vec![0x1a, 0x45, 0xdf, 0xa3];
        out.extend_from_slice(b"\x42\x82");
        out.extend_from_slice(doc_type);
        out
    }

    #[test]
    fn names_a_type_no_media_element_would_decode_without_one() {
        // The failure this prevents is silent: `<video>` reads the header
        // before it reads a byte of the file, and refuses an octet-stream
        // without saying why.
        for (name, bytes, expected) in [
            ("pdf", b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec(), "application/pdf"),
            ("mp4", ftyp(b"isom"), "video/mp4"),
            ("mp4 from a phone", ftyp(b"mp42"), "video/mp4"),
            ("m4a", ftyp(b"M4A "), "audio/mp4"),
            ("mov", ftyp(b"qt  "), "video/quicktime"),
            ("webm", ebml(b"webm"), "video/webm"),
            ("mkv", ebml(b"matroska"), "video/x-matroska"),
            ("opus in ogg", ogg(b"OpusHead"), "audio/ogg"),
            ("vorbis in ogg", ogg(b"\x01vorbis"), "audio/ogg"),
            ("theora in ogg", ogg(b"\x80theora"), "video/ogg"),
            ("wav", b"RIFF\x24\x00\x00\x00WAVEfmt ".to_vec(), "audio/wav"),
            ("avi", b"RIFF\x24\x00\x00\x00AVI LIST".to_vec(), "video/x-msvideo"),
            ("flac", b"fLaC\x00\x00\x00\x22".to_vec(), "audio/flac"),
            ("mp3 with a tag", b"ID3\x04\x00\x00\x00\x00\x00\x00".to_vec(), "audio/mpeg"),
            ("mp3 with none", vec![0xff, 0xfb, 0x90, 0x00], "audio/mpeg"),
        ] {
            assert_eq!(sniff_mime(&bytes), Some(expected), "{name}");

            // A real file is not its header. `resolve` sniffs a served asset
            // from the first `SNIFF_BYTES` and nothing else, so every
            // signature above has to be decidable inside that window — which
            // is only tested if the fixture is longer than it.
            let mut padded = bytes.clone();
            padded.resize(SNIFF_BYTES * 4, 0);
            assert!(padded.len() > SNIFF_BYTES);
            assert_eq!(sniff_mime(&padded[..SNIFF_BYTES]), Some(expected), "{name} head");

            // And the answer must not change once the rest of the file is
            // there: at ingest `sniff_mime` is handed every byte, so anything
            // that *searches* has to be bounded or the payload votes.
            assert_eq!(sniff_mime(&padded), Some(expected), "{name} whole");
        }
    }

    #[test]
    fn text_is_what_is_left_once_every_signature_has_said_no() {
        assert_eq!(sniff_mime(b"To: the editor\n\nI enclose the transcript.\n"), Some("text/plain"));
        assert_eq!(sniff_mime("a page\ttabbed\r\nand fed\x0con".as_bytes()), Some("text/plain"));
        assert_eq!(sniff_mime("naïve, café, £4\n".as_bytes()), Some("text/plain"));
        assert_eq!(extension_for("text/plain"), "txt");

        // However short. There is no floor under this and there should not be:
        // a signature is a fixed number of bytes and *this* arm is a property
        // of all of them, so "too small to be sure" would be a rule about
        // confidence rather than about evidence.
        assert_eq!(sniff_mime(b"a"), Some("text/plain"));
        assert_eq!(sniff_mime(b"no."), Some("text/plain"));

        // And it is asked last. Every one of these reads perfectly well as text
        // and is something else, so a text arm anywhere above would take them.
        assert_eq!(sniff_mime(b"%PDF-1.7\ntrailer\n"), Some("application/pdf"));
        assert_eq!(sniff_mime(b"RIFF\x24\x00\x00\x00WAVEfmt "), Some("audio/wav"));
        assert_eq!(sniff_mime(b"ID3\x04and then some words"), Some("audio/mpeg"));
    }

    #[test]
    fn bytes_that_would_read_as_gibberish_on_a_page_are_not_text() {
        assert_eq!(sniff_mime(b""), None, "an empty file is not evidence");
        assert_eq!(sniff_mime(b"before\0after"), None, "a NUL");
        assert_eq!(sniff_mime(b"\x1b[31mred\x1b[0m"), None, "terminal escapes");
        assert_eq!(sniff_mime(b"\x07\x07\x07"), None, "C0 controls");
        assert_eq!(sniff_mime(&[0xc3, 0x28]), None, "not UTF-8");
    }

    #[test]
    fn a_character_the_sniff_window_cut_in_half_is_not_evidence() {
        // One ASCII character and then two-byte ones, so a character starts at
        // the last byte of the window and is cut in half by it. That is the
        // window's doing and not the file's, and accented prose is not binary.
        // (The odd offset is load-bearing: SNIFF_BYTES is even, so a file of
        // nothing but two-byte characters would divide it exactly and this test
        // would assert nothing.)
        let accented = format!("x{}", "é".repeat(SNIFF_BYTES));
        assert_eq!(accented.as_bytes()[SNIFF_BYTES - 1], 0xc3, "the window cuts one");
        assert_eq!(sniff_mime(accented.as_bytes()), Some("text/plain"));
        assert_eq!(sniff_mime(&accented.as_bytes()[..SNIFF_BYTES]), Some("text/plain"));

        // But a broken sequence *within* the window still refuses the file:
        // tolerating the tail must not become tolerating everything.
        let mut broken = vec![0xc3, 0x28];
        broken.extend_from_slice(&accented.as_bytes()[..SNIFF_BYTES]);
        assert_eq!(sniff_mime(&broken), None);
    }

    #[test]
    fn a_text_file_reads_the_same_from_its_head_and_from_all_of_it() {
        // The property the table above asserts for every signature, made
        // separately because that fixture pads with NUL — which is one of the
        // three things text is refused for.
        let mut file = b"THE STATEMENT OF A WITNESS\n\n".to_vec();
        file.extend(std::iter::repeat_n(b'x', SNIFF_BYTES * 8));
        assert!(file.len() > SNIFF_BYTES);
        assert_eq!(sniff_mime(&file[..SNIFF_BYTES]), Some("text/plain"), "head");
        assert_eq!(sniff_mime(&file), Some("text/plain"), "whole");

        // A file whose head reads as text and whose tail does not is still
        // called text here — the window is the whole evidence, deliberately —
        // and it is `text::decode` that then declines to count its pages.
        let mut tailed = file.clone();
        tailed.push(0);
        assert_eq!(sniff_mime(&tailed), Some("text/plain"));
        assert_eq!(crate::text::decode(&tailed), None);
        assert_eq!(crate::document::probe(&tailed, "text/plain"), None);
    }

    #[test]
    fn does_not_let_a_matroska_payload_rename_the_file() {
        // The DocType is an element in the header. `webm` appearing later is a
        // coincidence in two gigabytes of video, not a declaration — and at
        // ingest this function is handed the whole file.
        let mut mkv = ebml(b"matroska");
        mkv.resize(SNIFF_BYTES * 2, 0);
        mkv.extend_from_slice(b"webm");
        assert_eq!(sniff_mime(&mkv), Some("video/x-matroska"));
    }

    #[test]
    fn does_not_hear_an_mp3_in_bytes_that_are_not_one() {
        // Eleven sync bits on their own are common enough in arbitrary data to
        // matter, and this is the one signature with no string in it.
        for junk in [
            vec![0xff, 0xff, 0xff, 0xff],       // layer and version both reserved
            vec![0xff, 0xfb, 0xf0, 0x00],       // bitrate index 1111 — "bad"
            vec![0xff, 0xfb, 0x0c, 0x00],       // bitrate index 0000 — "free"
            vec![0xff, 0xfb, 0x9c, 0x00],       // sampling rate 11 — reserved
            vec![0xff, 0xe9, 0x90, 0x00],       // version 01 — reserved
            vec![0xff],                          // nothing to check
        ] {
            assert_eq!(sniff_mime(&junk), None, "{junk:02x?}");
        }
    }

    #[test]
    fn still_reads_the_four_pictures_it_always_could() {
        assert_eq!(sniff_mime(&png(2, 2)), Some("image/png"));
        assert_eq!(sniff_mime(&jpeg(2, 2)), Some("image/jpeg"));
        assert_eq!(sniff_mime(b"GIF89a\x01\x00"), Some("image/gif"));
        assert_eq!(sniff_mime(b"RIFF\x24\x00\x00\x00WEBPVP8 "), Some("image/webp"));
    }

    #[test]
    fn serves_a_film_under_its_own_type_and_lets_it_be_cached() {
        let (_dir, store) = store();
        let meta = store.ingest_bytes(&ftyp(b"isom"), None).unwrap();
        assert_eq!(meta.mime, "video/mp4");
        // Zero, because there is no pixel box — which is `readAsset`'s problem
        // (T-261), not this one's.
        assert_eq!((meta.w, meta.h), (0, 0));

        // Every variant, because the frontend is free to ask for any of them
        // and a film answers all three with the same file. `exact` is what the
        // handler turns into `immutable`, and a video plays by asking for one
        // range after another for the length of the file — the wrong answer
        // here is re-reading a 400 MB interview off the disk all afternoon.
        for variant in [Variant::Original, Variant::Display, Variant::Thumb] {
            let resolved = store.resolve(&meta.sha256, variant).unwrap();
            assert_eq!(resolved.mime, "video/mp4");
            assert!(resolved.exact, "{variant:?}");
        }
    }

    /// A `.wav` of a known length, which is the cheapest real container to
    /// build: a format chunk saying how many bytes a second is, and that many.
    fn wav(seconds: u32) -> Vec<u8> {
        const BYTE_RATE: u32 = 176_400;
        let mut body = b"fmt ".to_vec();
        body.extend_from_slice(&16u32.to_le_bytes());
        body.extend_from_slice(&1u16.to_le_bytes());
        body.extend_from_slice(&2u16.to_le_bytes());
        body.extend_from_slice(&44_100u32.to_le_bytes());
        body.extend_from_slice(&BYTE_RATE.to_le_bytes());
        body.extend_from_slice(&4u16.to_le_bytes());
        body.extend_from_slice(&16u16.to_le_bytes());
        body.extend_from_slice(b"data");
        body.extend_from_slice(&(BYTE_RATE * seconds).to_le_bytes());
        body.extend_from_slice(&vec![0u8; (BYTE_RATE * seconds) as usize]);
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn a_cassette_knows_how_long_it_is_the_moment_it_is_ingested() {
        // AC-688. The number is in the meta ingestion *returns* — not in a
        // later probe and not in a variant — because that meta is what the
        // frontend writes into the document, and the document reaches a peer
        // long before the file does.
        let (_dir, store) = store();
        let meta = store.ingest_bytes(&wav(3), None).unwrap();
        assert_eq!(meta.mime, "audio/wav");
        assert_eq!(meta.duration, Some(3.0));
    }

    #[test]
    fn a_photograph_has_no_duration_and_neither_does_a_file_nobody_can_read() {
        // AC-689. Three different reasons to say nothing, and all three say the
        // same nothing rather than a zero: it is not a recording, it is a
        // container this build does not read, and it is not a file at all.
        let (_dir, store) = store();
        for bytes in [png(4, 4), ogg(b"\x80theora"), b"not a file".to_vec()] {
            assert_eq!(store.ingest_bytes(&bytes, None).unwrap().duration, None);
        }
    }

    #[test]
    fn what_crosses_to_the_frontend_is_a_number_or_a_null() {
        // The one thing about this field the unit tests above cannot see: it
        // has to survive `serde` as `duration: 3` and `duration: null`, because
        // that is the shape `platform/types.ts` declares and the shape the
        // frontend distinguishes on. An `Option` serialised as an absent key
        // would type-check on both sides and read as `undefined` at run time.
        let (_dir, store) = store();
        let film = store.ingest_bytes(&wav(3), None).unwrap();
        let picture = store.ingest_bytes(&png(4, 4), None).unwrap();
        assert_eq!(
            serde_json::to_value(&film).unwrap()["duration"],
            serde_json::json!(3.0)
        );
        assert_eq!(
            serde_json::to_value(&picture).unwrap()["duration"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn what_a_cassette_is_called_does_not_cross_with_it() {
        // AC-696, and the reason it is a test rather than a note: `AssetMeta` is
        // what the frontend writes into the document, so a `title` field added
        // here later — for the best of reasons, beside `duration`, which came
        // off the same file at the same moment — would put a name on the wire
        // and undo Q-211 without anything else in the build noticing.
        //
        // Both halves are asserted together on purpose. That the record has no
        // title is worth nothing on its own: a fixture that simply has no title
        // in it would pass that and prove nothing. So the same bytes are read
        // the other way, through the path a label really uses, and do have one.
        let (_dir, store) = store();
        let mut titled = wav(1);
        let mut info = b"INFO".to_vec();
        info.extend_from_slice(b"INAM");
        info.extend_from_slice(&12u32.to_le_bytes());
        info.extend_from_slice(b"Interview\0\0\0");
        let mut list = b"LIST".to_vec();
        list.extend_from_slice(&(info.len() as u32).to_le_bytes());
        list.extend_from_slice(&info);
        titled.extend_from_slice(&list);
        let riff = (titled.len() - 8) as u32;
        titled[4..8].copy_from_slice(&riff.to_le_bytes());

        let meta = store.ingest_bytes(&titled, None).unwrap();
        let crossed = serde_json::to_value(&meta).unwrap();
        let keys: Vec<&String> = crossed.as_object().unwrap().keys().collect();
        assert!(
            !keys.iter().any(|key| key.contains("title") || key.contains("name")),
            "a title reached the record: {keys:?}"
        );

        let read = crate::media::probe_title(&mut std::io::Cursor::new(titled), "audio/wav");
        assert_eq!(read, Some("Interview".to_string()));
    }

    /// A document of `count` blank pages, written with lopdf so the fixture is
    /// a real file rather than a byte string nobody can read the diff of.
    fn pdf(count: usize) -> Vec<u8> {
        use lopdf::{dictionary, Document, Object};
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let kids: Vec<Object> = (0..count)
            .map(|_| {
                doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id })
                    .into()
            })
            .collect();
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => count as i64,
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            }),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        let mut out = Vec::new();
        doc.save_to(&mut out).expect("fixture should write");
        out
    }

    #[test]
    fn a_folder_knows_how_thick_it_is_the_moment_it_is_ingested() {
        // AC-668's half of the plumbing, and the same argument the duration
        // above makes: the page count is in the meta ingestion *returns*,
        // because that is what the frontend writes into the document and the
        // document reaches a peer long before the file does.
        let (_dir, store) = store();
        let meta = store.ingest_bytes(&pdf(12), None).unwrap();
        assert_eq!(meta.mime, "application/pdf");
        assert_eq!(meta.pages, Some(12));
        // And nothing else grew one. A picture is not a document with no pages,
        // it is a thing that pages are not a fact about.
        assert_eq!(store.ingest_bytes(&png(4, 4), None).unwrap().pages, None);
        assert_eq!(store.ingest_bytes(&wav(1), None).unwrap().pages, None);
    }

    #[test]
    fn a_document_that_will_not_open_is_stored_anyway_and_counts_no_pages() {
        // 6% of the files D-47 swept will not parse. Refusing the bytes over it
        // would be refusing a paste the user cannot do anything about, so the
        // asset lands and the folder has nothing written under its filename.
        let (_dir, store) = store();
        let meta = store
            .ingest_bytes(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\nand then nonsense", None)
            .unwrap();
        assert_eq!(meta.mime, "application/pdf");
        assert_eq!(meta.pages, None);
        assert!(store.original_path(&meta.sha256).is_file());
    }

    #[test]
    fn a_page_count_crosses_to_the_frontend_as_a_number_or_a_null() {
        // The same thing `duration` needs and for the same reason: an `Option`
        // serialised as an absent key type-checks on both sides and reads as
        // `undefined` at run time.
        let (_dir, store) = store();
        let folder = store.ingest_bytes(&pdf(3), None).unwrap();
        let picture = store.ingest_bytes(&png(4, 4), None).unwrap();
        assert_eq!(serde_json::to_value(&folder).unwrap()["pages"], serde_json::json!(3));
        assert_eq!(
            serde_json::to_value(&picture).unwrap()["pages"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn a_document_that_arrived_over_the_wire_can_still_be_asked_what_it_is_called() {
        // The title is derived locally (Q-211), so the *receiving* machine has
        // to be able to read it off the file — there is nothing in the record
        // to fall back on. That is only true if what landed is the file.
        let (_from, sender) = store();
        let (_to, receiver) = store();
        let meta = sender.ingest_bytes(&pdf(5), None).unwrap();
        assert!(transfer(&sender, &receiver, &meta.sha256));
        let probe = document::probe_path(&receiver.original_path(&meta.sha256))
            .expect("the received bytes are still a document");
        assert_eq!(probe.pages, 5);
    }

    #[test]
    fn the_duration_is_known_before_a_single_variant_is_built() {
        // The other half of AC-688. `ingest_bytes` returns the moment the hash
        // and the box are known and leaves the variants to a background thread
        // (AC-46) — so a duration read during variant generation would arrive
        // after the item was already on the board and already replicated. At
        // the point this assertion is made there is exactly one file on disk:
        // the original.
        let (_dir, store) = store();
        let meta = store.ingest_bytes(&wav(2), None).unwrap();
        assert_eq!(meta.duration, Some(2.0));
        assert_eq!(walk_files(store.root.as_path()).unwrap().len(), 1);
    }

    #[test]
    fn does_not_report_a_failure_for_a_film_it_was_never_going_to_downscale() {
        let (_dir, store) = store();
        let meta = store.ingest_bytes(&ftyp(b"isom"), None).unwrap();
        // The comment on `build_variants` claimed this for a long time while
        // the code returned `Undecodable`, so `schedule_variants` printed a
        // failure line for every film on the board.
        assert!(store.build_variants(&meta.sha256).is_ok());
        assert_eq!(walk_files(store.root.as_path()).unwrap().len(), 1);

        // A picture is still downscaled, and bytes nobody can place are still
        // offered to the decoder — this is a rule about *known* non-pictures.
        let picture = store.ingest_bytes(&png(4096, 8), None).unwrap();
        store.build_variants(&picture.sha256).unwrap();
        assert!(store
            .resolve(&picture.sha256, Variant::Thumb)
            .unwrap()
            .exact);
    }

    #[test]
    fn stores_bytes_it_cannot_decode_rather_than_refusing_them() {
        let (_dir, store) = store();
        // Nothing blocks thinking: a paste the user cannot fix must not fail.
        //
        // The fixture is binary rather than the sentence it used to be, because
        // a sentence is a document now (Q-255) and would be testing the arm
        // above this one. What is wanted here is bytes that place *nowhere*:
        // no signature matches them and the NUL keeps them out of text.
        let meta = store.ingest_bytes(&[0x00, 0x01, 0x02, 0x03], None).unwrap();
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
    fn offers_an_export_name_carrying_the_type_it_actually_stored() {
        let (_dir, store) = store();
        let shot = store.ingest_bytes(&png(6, 6), None).unwrap();
        let offered = store
            .export_name(&shot.sha256, Some("holiday.png"))
            .unwrap();

        assert_eq!(offered.extension, "png");
        assert_eq!(offered.file_name, "holiday.png");

        // Sniffed from the bytes, not taken from the hint, and not remembered:
        // the store never wrote the mime down, and the original on disk is named
        // after its hash alone. A JPEG called `.png` exports as a JPEG.
        let photo = store.ingest_bytes(&jpeg(6, 6), None).unwrap();
        let offered = store
            .export_name(&photo.sha256, Some("holiday.png"))
            .unwrap();
        assert_eq!(offered.file_name, "holiday.jpg");
        assert_eq!(offered.extension, "jpg");
    }

    #[test]
    fn falls_back_to_the_hash_when_there_is_nothing_worth_suggesting() {
        let (_dir, store) = store();
        let shot = store.ingest_bytes(&png(6, 6), None).unwrap();
        let expected = format!("schizoboard-{}.png", &shot.sha256[..8]);

        // No hint at all — a paste of raw clipboard bytes has no provenance.
        assert_eq!(
            store.export_name(&shot.sha256, None).unwrap().file_name,
            expected
        );
        // A hint nothing survives of. Unlovely but unique, which `image.png` is
        // not the second time anyone exports.
        assert_eq!(
            store
                .export_name(&shot.sha256, Some("../.."))
                .unwrap()
                .file_name,
            expected
        );
    }

    #[test]
    fn will_not_name_an_asset_it_does_not_have() {
        let (_dir, store) = store();
        // Neither of these reaches a save dialog: one could never be a hash, the
        // other is a well-formed hash for nothing.
        assert!(matches!(
            store.export_name("../../../etc/passwd", None),
            Err(Error::BadHash)
        ));
        assert!(matches!(
            store.export_name(&"a".repeat(64), None),
            Err(Error::NotFound)
        ));
    }

    #[test]
    fn reduces_a_suggested_name_to_something_that_can_only_be_a_name() {
        // The suggestion is `origName`, which came from a URL on a page nobody
        // here wrote or from a peer over sync. A path in it is not a path.
        assert_eq!(
            safe_stem("../../Startup/holiday.exe").as_deref(),
            Some("holiday")
        );
        assert_eq!(
            safe_stem(r"..\..\Startup\holiday.exe").as_deref(),
            Some("holiday")
        );
        // A colon opens an alternate data stream rather than punctuating.
        assert_eq!(
            safe_stem("holiday:evil.jpg").as_deref(),
            Some("holiday-evil")
        );
        assert_eq!(safe_stem("hol\u{7}iday").as_deref(), Some("hol-iday"));
        // Windows drops a trailing dot or space, so a name ending in one is not
        // the name the dialog showed.
        assert_eq!(safe_stem("holiday .").as_deref(), Some("holiday"));
        assert_eq!(safe_stem(".hidden.jpg").as_deref(), Some("hidden"));

        // Nothing left to suggest.
        assert_eq!(safe_stem(""), None);
        assert_eq!(safe_stem("../.."), None);
        assert_eq!(safe_stem("/"), None);
        // A device whatever directory it turns up in, and whatever it is called
        // after the dot.
        assert_eq!(safe_stem("NUL.jpg"), None);
        assert_eq!(safe_stem("com1"), None);

        // Kept, because the point is to suggest something a human recognises.
        assert_eq!(
            safe_stem("holiday (2) - beach_1.jpg").as_deref(),
            Some("holiday (2) - beach_1")
        );
        assert_eq!(safe_stem("休暇.jpg").as_deref(), Some("休暇"));
        assert_eq!(
            safe_stem("a".repeat(200).as_str()).unwrap().chars().count(),
            64
        );
    }

    #[test]
    fn every_format_a_board_can_hold_exports_under_an_extension() {
        assert_eq!(extension_for("image/jpeg"), "jpg");
        assert_eq!(extension_for("image/png"), "png");
        assert_eq!(extension_for("image/gif"), "gif");
        assert_eq!(extension_for("image/webp"), "webp");
        // Unreachable through ingestion, but a save dialog still needs something
        // to filter on.
        assert_eq!(extension_for("application/octet-stream"), "bin");
    }

    #[test]
    fn variant_defaults_to_display_for_anything_it_does_not_recognise() {
        assert_eq!(Variant::parse(Some("thumb")), Variant::Thumb);
        assert_eq!(Variant::parse(Some("original")), Variant::Original);
        assert_eq!(Variant::parse(Some("nonsense")), Variant::Display);
        assert_eq!(Variant::parse(None), Variant::Display);
    }

    // --- transfer -----------------------------------------------------------

    /// Send an asset from one store to another the way the exchange would.
    /// Returns what `commit_received` said.
    fn transfer(from: &AssetStore, to: &AssetStore, sha256: &str) -> bool {
        let size = from.size(sha256).expect("the sender should hold it");
        let total = size.div_ceil(CHUNK_BYTES).max(1);
        for index in 0..total {
            let chunk = from.chunk(sha256, index).unwrap();
            to.receive_chunk(sha256, index, total, &chunk).unwrap();
        }
        to.commit_received(sha256).unwrap()
    }

    /// Bigger than one chunk, so the loop above is a loop. A gradient rather
    /// than a flat colour, because a quarter of a megabyte of one colour
    /// compresses to nothing and the test would silently become a single-chunk
    /// one.
    fn big_png() -> Vec<u8> {
        let mut image = RgbImage::new(700, 700);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x * y) % 256) as u8]);
        }
        let mut out = Vec::new();
        DynamicImage::ImageRgb8(image)
            .write_to(&mut io::Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn a_photograph_crosses_between_two_stores() {
        let (_a, sender) = store();
        let (_b, receiver) = store();
        let bytes = big_png();
        let meta = sender.ingest_bytes(&bytes, None).unwrap();
        assert!(meta.size > CHUNK_BYTES, "should take more than one chunk");

        assert!(transfer(&sender, &receiver, &meta.sha256));
        assert!(receiver.has(&meta.sha256));
        assert_eq!(fs::read(receiver.original_path(&meta.sha256)).unwrap(), bytes);
        // Through the ingest path, so the dimensions came out too.
        assert_eq!(receiver.size(&meta.sha256), Some(meta.size));
    }

    #[test]
    fn chunks_may_arrive_in_any_order() {
        let (_a, sender) = store();
        let (_b, receiver) = store();
        let meta = sender.ingest_bytes(&big_png(), None).unwrap();
        let total = meta.size.div_ceil(CHUNK_BYTES);
        assert!(total >= 3, "wanted a few chunks, got {total}");

        for index in (0..total).rev() {
            let chunk = sender.chunk(&meta.sha256, index).unwrap();
            receiver
                .receive_chunk(&meta.sha256, index, total, &chunk)
                .unwrap();
        }
        assert!(receiver.commit_received(&meta.sha256).unwrap());
    }

    #[test]
    fn a_missing_chunk_commits_nothing() {
        // The case with no bookkeeping behind it: the gap reads back as zeroes,
        // and zeroes do not hash to the name the file is waiting under.
        let (_a, sender) = store();
        let (_b, receiver) = store();
        let meta = sender.ingest_bytes(&big_png(), None).unwrap();
        let total = meta.size.div_ceil(CHUNK_BYTES);

        for index in 1..total {
            let chunk = sender.chunk(&meta.sha256, index).unwrap();
            receiver
                .receive_chunk(&meta.sha256, index, total, &chunk)
                .unwrap();
        }
        assert!(!receiver.commit_received(&meta.sha256).unwrap());
        assert!(!receiver.has(&meta.sha256));
    }

    #[test]
    fn bytes_that_are_not_the_asset_are_refused() {
        // A peer answering a `HAVE` prefix collision with a different
        // photograph, or one whose store has rotted. Nothing may be committed,
        // and in particular it must not be committed under its *own* hash — the
        // receiver asked for one asset, not for whatever this turned out to be.
        let (_a, receiver) = store();
        let wanted = "0".repeat(64);
        let impostor = png(4, 4);

        receiver.receive_chunk(&wanted, 0, 1, &impostor).unwrap();
        assert!(!receiver.commit_received(&wanted).unwrap());
        assert!(!receiver.has(&wanted));
        assert_eq!(receiver.hashes().unwrap(), Vec::<String>::new());
    }

    #[test]
    fn a_transfer_leaves_nothing_behind_when_it_fails() {
        let (dir, receiver) = store();
        let wanted = "1".repeat(64);
        receiver.receive_chunk(&wanted, 0, 1, b"not a photograph").unwrap();
        assert!(!receiver.commit_received(&wanted).unwrap());

        let leftovers = walk_files(&dir.path().join("assets")).unwrap();
        assert!(leftovers.is_empty(), "left {leftovers:?}");
    }

    #[test]
    fn an_abandoned_transfer_can_be_thrown_away() {
        let (_dir, receiver) = store();
        let wanted = "2".repeat(64);
        receiver.receive_chunk(&wanted, 0, 2, b"half of it").unwrap();

        receiver.abort_received(&wanted).unwrap();
        assert!(!receiver.partial_path(&wanted).is_file());
        // Absent is success: the socket can close before a byte ever arrives.
        assert!(receiver.abort_received(&wanted).is_ok());
    }

    #[test]
    fn an_interrupted_transfer_says_how_much_of_it_arrived() {
        // T-265. The number the exchange resumes from, and it is a length
        // because `receive_chunk` writes at offsets — there is no chunk count
        // anywhere in this store to ask for instead.
        let (_dir, receiver) = store();
        let wanted = "4".repeat(64);
        assert_eq!(receiver.partial_len(&wanted), 0);

        receiver
            .receive_chunk(&wanted, 0, 3, &vec![7u8; CHUNK_BYTES as usize])
            .unwrap();
        assert_eq!(receiver.partial_len(&wanted), CHUNK_BYTES);

        receiver
            .receive_chunk(&wanted, 1, 3, &vec![7u8; CHUNK_BYTES as usize])
            .unwrap();
        assert_eq!(receiver.partial_len(&wanted), CHUNK_BYTES * 2);

        // And nothing of a hash that is not one. The name reaches here off the
        // wire, and `dir_for` slices it at 2 and at 4 to build the path — so a
        // short one is a panic rather than a miss, and one with `..` in it is a
        // path outside the store. Both of those are what the guard is for, and
        // both are what these two lines would do without it.
        assert_eq!(receiver.partial_len(""), 0);
        assert_eq!(receiver.partial_len("ab"), 0);
        assert_eq!(receiver.partial_len("../../../etc/passwd"), 0);
        assert_eq!(receiver.partial_len(&"z".repeat(64)), 0);
    }

    #[test]
    fn what_arrived_survives_until_it_is_committed_or_thrown_away() {
        // The property the whole of T-265 rests on: the store keeps a partial
        // until it is told otherwise, so the exchange abandoning a transfer
        // costs its place in the queue and not its bytes. Only `commit_received`
        // and `abort_received` remove one.
        let (_dir, receiver) = store();
        let wanted = "5".repeat(64);
        receiver
            .receive_chunk(&wanted, 0, 4, &vec![3u8; CHUNK_BYTES as usize])
            .unwrap();

        // Everything an interruption does to this store, which is nothing.
        assert_eq!(receiver.partial_len(&wanted), CHUNK_BYTES);
        assert!(receiver.partial_path(&wanted).is_file());

        // A later chunk lands at its own offset in the same file, so resuming
        // adds to what is there rather than starting a second one.
        receiver.receive_chunk(&wanted, 1, 4, b"the rest").unwrap();
        assert_eq!(receiver.partial_len(&wanted), CHUNK_BYTES + 8);
    }

    #[test]
    fn a_hole_makes_the_length_longer_than_what_is_held() {
        // Why `partial_len` is documented as a hint rather than a fact. The
        // exchange promises to resume from a contiguous point, so this shape
        // does not arise from it — but the store must not pretend it cannot,
        // because `receive_chunk` accepts any order on purpose and the hash at
        // commit is what actually decides.
        let (_dir, receiver) = store();
        let wanted = "6".repeat(64);
        receiver.receive_chunk(&wanted, 2, 4, b"third").unwrap();

        assert_eq!(receiver.partial_len(&wanted), CHUNK_BYTES * 2 + 5);
        // Which is a file of mostly zeroes, and a commit refuses it.
        assert!(!receiver.commit_received(&wanted).unwrap());
    }

    #[test]
    fn a_peer_cannot_make_us_write_an_enormous_sparse_file() {
        // `seek` past the end creates a file as big as the offset. The index is
        // a number off the network, so this is the one arithmetic in the
        // transfer path that an attacker chooses.
        let (_dir, receiver) = store();
        let wanted = "3".repeat(64);
        let far = MAX_ASSET_BYTES / CHUNK_BYTES + 1;

        assert!(receiver.receive_chunk(&wanted, far, far + 1, b"x").is_err());
        assert!(receiver.receive_chunk(&wanted, u64::MAX, u64::MAX, b"x").is_err());
        // And an index outside the total it claims for itself.
        assert!(receiver.receive_chunk(&wanted, 5, 2, b"x").is_err());
        assert!(!receiver.partial_path(&wanted).is_file());
    }

    #[test]
    fn the_flat_cost_predicts_the_three_sizes_it_was_measured_at() {
        // The model behind `MAX_ASSET_BYTES`, checked against the runs it came
        // from — real application, one fresh process per file, private bytes
        // sampled at 20 ms (D-56, same rig as D-55). Never under, because a
        // bound that under-predicts is not one; and within 2%, because slack
        // nobody can account for is slack that grows.
        let mib = |n: u64| n * 1024 * 1024;
        // Peaks in tenths of a MiB, so the numbers read as they were reported.
        for (size, tenths) in [
            (272_629_760u64, 2657u64), // 260.0 MiB of file -> 265.7 MiB
            (469_762_048, 4541),       // 448.0 MiB         -> 454.1 MiB
            (536_870_912, 5183),       // 512.0 MiB         -> 518.3 MiB
            (805_306_368, 7748),       // 768.0 MiB         -> 774.8 MiB
        ] {
            let measured = tenths * 1024 * 1024 / 10;
            let predicted = disk_ingest_peak(size);
            assert!(
                predicted >= measured,
                "{size} bytes: predicted {predicted} under the measured {measured}"
            );
            assert!(
                predicted - measured <= measured / 50,
                "{size} bytes: predicted {predicted} is more than 2% over {measured}"
            );
        }

        // The property that makes it flat rather than a staircase, and the whole
        // of what T-307 changed: two files far apart in size no longer cost the
        // same, and the step that used to double is gone. Both of these were
        // *equalities* against the old model.
        assert_ne!(disk_ingest_peak(mib(260)), disk_ingest_peak(mib(448)));
        assert!(disk_ingest_peak(mib(512)) < 2 * disk_ingest_peak(mib(448)));
        // Stated as the difference rather than only as `!=`, so a model that
        // went flat-but-wrong — a constant, say — still fails here.
        assert_eq!(
            disk_ingest_peak(mib(448)) - disk_ingest_peak(mib(260)),
            mib(188)
        );

        // Which is why the ceiling could move: the old 448 MiB peaked at 775 MiB
        // and so does the new 768 MiB.
        assert!(disk_ingest_peak(MAX_ASSET_BYTES) <= INGEST_MEMORY_BUDGET);
        // And the 512 MiB this constant held before anybody measured it — the
        // row that cost 1544.2 MiB and could not arrive on an 8 GB machine at
        // all — is now in the loop above at 518.3 measured. Stated here against
        // the old *measurement* rather than against the budget, because that is
        // the comparison that says what changed.
        assert!(disk_ingest_peak(mib(512)) * 2 < 15442 * mib(1) / 10);
        // And the margin, in the terms it was chosen in rather than as a number
        // copied down from the constant.
        assert!(INGEST_MEMORY_BUDGET - disk_ingest_peak(MAX_ASSET_BYTES) >= mib(248));
    }

    #[test]
    fn a_read_against_an_honest_promise_does_not_grow_its_buffer() {
        // `disk_ingest_peak` is flat only because `read_promised` cannot reserve
        // past the capacity it starts with. That is a property of `read_to_end`
        // and `Take` rather than of anything written here, which makes it exactly
        // the kind of assumption a constant should not rest on silently: if a
        // future std grows the buffer to probe for EOF, the peak doubles,
        // nothing fails to compile, and the ceiling becomes a lie in the unsafe
        // direction with no test to say so.
        //
        // 64 KiB and not a handful of bytes, because a `Vec` under a page can be
        // rounded up by the allocator and read as growth that did not happen.
        let n = 64 * 1024;
        let bytes = read_promised(io::Cursor::new(vec![3u8; n]), n as u64).unwrap();
        assert_eq!(bytes.len(), n);
        assert_eq!(
            bytes.capacity(),
            n,
            "the read grew a buffer that was already the right size"
        );
    }

    #[test]
    fn a_source_that_hands_back_more_than_it_promised_is_refused() {
        // The other half of the flatness, and the half that is this codebase's
        // own decision rather than std's: a source that will not keep to its
        // length is one whose buffer cannot be sized, and the old code
        // accommodated it by doubling — which is the staircase coming back for
        // precisely the input that is trying to cause it.
        //
        // Driven by understating the promise rather than by racing a writer
        // against a real file: a test that has to win a race to fail is a test
        // that passes for the wrong reason.
        match read_promised(io::Cursor::new(b"twelve bytes".to_vec()), 4) {
            Err(Error::SizeMismatch) => {}
            other => panic!("a source that overran its promise was taken: {other:?}"),
        }

        // Exactly at the promise is fine. A rule nobody may satisfy is a
        // different rule from the one written down.
        let exact = read_promised(io::Cursor::new(b"twelve bytes".to_vec()), 12).unwrap();
        assert_eq!(exact.len(), 12);

        // And under it is fine too — a file that *shrank* is short, not lying,
        // and what was read hashes to what it is. Only more is refused.
        let short = read_promised(io::Cursor::new(b"four".to_vec()), 9).unwrap();
        assert_eq!(short, b"four");

        // The sentence names the file rather than a number: there is no honest
        // number to report, which is the whole reason this is not `TooLarge`.
        let said = Error::SizeMismatch.to_string();
        assert!(said.contains("not the size it said it was"), "{said}");
        assert!(!said.contains("too large"), "{said}");
    }

    /// The same picture with its header rewritten to claim a size it does not
    /// have.
    ///
    /// Not a trick, and not a hostile file: it is what *every* large photograph
    /// looks like to a probe. A PNG carries its shape in the first chunk, so the
    /// two numbers the bound turns on are known thirty-three bytes in, and the
    /// pixels are still on the far side of a decode nobody has paid for. That is
    /// the whole reason this can be refused before the write.
    fn claiming(mut bytes: Vec<u8>, w: u32, h: u32) -> Vec<u8> {
        bytes[16..20].copy_from_slice(&w.to_be_bytes());
        bytes[20..24].copy_from_slice(&h.to_be_bytes());
        // The `png` crate checks chunk CRCs, so the header has to be honest
        // about being dishonest.
        let mut crc = 0xffff_ffffu32;
        for byte in &bytes[12..29] {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    0xedb8_8320 ^ (crc >> 1)
                } else {
                    crc >> 1
                };
            }
        }
        bytes[29..33].copy_from_slice(&(!crc).to_be_bytes());
        bytes
    }

    /// Sixteen bits a channel and an alpha channel that is doing something —
    /// eight bytes a pixel, the most expensive thing this build can be handed.
    fn png16(w: u32, h: u32) -> Vec<u8> {
        let mut out = Vec::new();
        DynamicImage::ImageRgba16(image::ImageBuffer::from_pixel(
            w,
            h,
            image::Rgba([9u16, 8, 7, 6]),
        ))
        .write_to(&mut io::Cursor::new(&mut out), ImageFormat::Png)
        .unwrap();
        out
    }

    #[test]
    fn the_decode_model_predicts_the_ten_pictures_it_was_measured_at() {
        // D-57, on the rig D-55 and D-56 used: the real application, one fresh
        // process per file, private bytes sampled at 20 ms. Never under, because
        // a bound that under-predicts is not one.
        //
        // Width, height, the decoder's bytes per pixel, whether it has an alpha
        // channel, the file, and the peak in tenths of a MiB so the numbers read
        // as they were reported.
        for (w, h, bpp, alpha, file, tenths) in [
            (4_000u64, 4_000u64, 3u64, false, 258_753u64, 2266u64),
            (8_000, 8_000, 3, false, 957_885, 2275),
            (11_000, 11_000, 3, false, 1_776_149, 3914),
            (22_000, 5_500, 3, false, 1_775_499, 3631),
            (14_142, 14_142, 3, false, 2_951_980, 6189),
            (6_000, 6_000, 4, true, 730_296, 2777),
            (3_000, 3_000, 8, true, 395_056, 2418),
            (4_500, 4_500, 8, true, 880_452, 3870),
            (6_000, 6_000, 8, true, 1_559_138, 4515),
            (3_000, 3_000, 6, false, 303_419, 2121),
        ] {
            let measured = tenths * 1024 * 1024 / 10;
            let predicted = decode_peak(file, w, h, bpp, alpha);
            assert!(
                predicted >= measured,
                "{w}x{h} at {bpp}: predicted {predicted} under the measured {measured}"
            );
            // Tight only where tightness matters. A picture inside 5120 keeps
            // `resize`, so the model carries an intermediate its peak never
            // reached and is generous by as much as 60% — which cannot bind,
            // because a picture that small is nowhere near the ceiling. The
            // rows that decide the ceiling are the big ones, and those are
            // within 8%.
            let slack = if w.max(h) >= u64::from(DISPLAY_MAX_EDGE * BOX_FILTER_FROM) {
                measured / 10
            } else {
                measured
            };
            assert!(
                predicted - measured <= slack,
                "{w}x{h} at {bpp}: predicted {predicted} is too far over {measured}"
            );
        }

        // **The shape has stopped deciding.** These two were 803.4 and 574.0 MiB
        // of the same 121 megapixels, and the 229 MiB between them was the one
        // term in here nobody would have guessed. What is left is the variant,
        // which the square picture has more of.
        let square = decode_peak(0, 11_000, 11_000, 3, false);
        let wide = decode_peak(0, 22_000, 5_500, 3, false);
        assert_eq!(square, wide, "the shape is back in the model");

        // The depth has not, and cannot: it is in the surface.
        assert!(decode_peak(0, 6_000, 6_000, 8, true) > decode_peak(0, 6_000, 6_000, 3, false));

        // And the 200-megapixel photograph T-310 exists for. It needed about
        // 1148 MiB and did not fit under any share of this budget.
        assert!(decode_peak(3_000_000, 14_142, 14_142, 3, false) <= MAX_PICTURE_PEAK);
    }

    #[test]
    fn the_box_average_takes_over_exactly_where_it_starts_being_the_right_filter() {
        // Below a 2x reduction a box block is fractional, the average degenerates
        // towards nearest-neighbour and it aliases — measured against CatmullRom
        // on sixty photographs, a 1.2x reduction moves the picture by 4.48 levels
        // out of 255 against 1.30 at 2x (D-58). So the split is stated here as
        // the exact edge it happens at rather than left as a comment on a
        // constant.
        let strip = |w: u32| DynamicImage::ImageRgb8(RgbImage::from_pixel(w, 4, image::Rgb([9, 8, 7])));
        let edge = DISPLAY_MAX_EDGE;

        let box_side = strip(edge * BOX_FILTER_FROM);
        assert_eq!(
            downscale(&box_side, edge).to_rgb8(),
            box_side.thumbnail(edge, edge).to_rgb8(),
            "at exactly the threshold this is no longer the box average"
        );

        let mild = strip(edge * BOX_FILTER_FROM - 1);
        assert_eq!(
            downscale(&mild, edge).to_rgb8(),
            mild.resize(edge, edge, FilterType::CatmullRom).to_rgb8(),
            "one pixel under the threshold this is no longer the filter it was"
        );
    }

    #[test]
    fn a_picture_is_refused_on_its_pixels_and_never_on_its_bytes() {
        let (_dir, store) = store();
        // Under a kilobyte of file, four hundred megapixels of picture. The byte
        // ceiling is 768 MiB and nothing here comes within a thousandth of it.
        let enormous = claiming(png(8, 8), 20_000, 20_000);
        assert!((enormous.len() as u64) < MAX_ASSET_BYTES / 1000);

        match store.ingest_bytes(&enormous, None) {
            Err(Error::PictureTooLarge { w, h }) => assert_eq!((w, h), (20_000, 20_000)),
            other => panic!("four hundred megapixels was not refused: {other:?}"),
        }
        // And nothing was written on the way to saying no — the refusal is
        // before the write, not a tidy-up after it.
        assert!(walk_files(store.root.as_path()).unwrap().is_empty());

        // The sentence is about the picture. Somebody told their 700-byte file
        // is too large will go and look at the file.
        let said = Error::PictureTooLarge {
            w: 20_000,
            h: 20_000,
        }
        .to_string();
        assert!(said.contains("20000 × 20000"), "{said}");
        assert!(said.contains("pixels"), "{said}");
        assert!(!said.contains("bytes"), "{said}");
    }

    #[test]
    fn the_depth_decides_as_much_as_the_count_and_the_shape_no_longer_does() {
        let (_dir, store) = store();
        // One count, one shape, two verdicts — on depth alone. Eight bytes a
        // pixel against three is the same picture costing two and a half times
        // as much, and it is sitting in the header exactly as the count is.
        // Nothing shaped like a megapixel ceiling can say this.
        assert!(
            store
                .ingest_bytes(&claiming(png(8, 8), 11_000, 11_000), None)
                .is_ok()
        );
        assert!(matches!(
            store.ingest_bytes(&claiming(png16(2, 2), 11_000, 11_000), None),
            Err(Error::PictureTooLarge { .. })
        ));

        // And the shape, which used to: 121 megapixels square cost 803 MiB where
        // the same count at 4:1 cost 574, so a *squarer* picture was refused at
        // fewer pixels than a wide one was admitted at. T-310 took that term
        // out, and these two now agree because there is nothing left to
        // disagree about (D-58).
        for (w, h) in [(19_000u32, 19_000u32), (38_000, 9_500)] {
            assert!(
                matches!(
                    store.ingest_bytes(&claiming(png(8, 8), w, h), None),
                    Err(Error::PictureTooLarge { .. })
                ),
                "{w} x {h}"
            );
        }
        for (w, h) in [(13_200u32, 13_200u32), (26_400, 6_600)] {
            assert!(
                store.ingest_bytes(&claiming(png(8, 8), w, h), None).is_ok(),
                "{w} x {h}"
            );
        }
    }

    #[test]
    fn nothing_a_header_can_claim_wraps_the_model_round() {
        // Two of the three terms are a product of numbers a *file* chose, and a
        // bound that overflows into something small is worse than no bound at
        // all — it is a bound that reports success.
        let widest = u64::from(u32::MAX);
        assert!(decode_peak(0, widest, widest, 8, true) > MAX_PICTURE_PEAK);
        assert!(decode_peak(MAX_ASSET_BYTES, widest, 1, 8, false) > MAX_PICTURE_PEAK);
        assert_eq!(decode_peak(u64::MAX, 1, 1, 1, true), u64::MAX);
    }

    #[test]
    fn the_crates_own_limit_cannot_overrule_this_one() {
        // `image` refuses an allocation over 512 MiB by default, and this
        // codebase never wrote that down. Before T-308 it was what actually
        // refused a 256-megapixel scan — from inside `build_variants`, after the
        // file had been stored and the item was on the board, with the reason on
        // stderr.
        //
        // The budget Q-234 chose admits pictures whose surface is past that
        // default, so leaving it in place would have meant the crate quietly
        // overruling the answer — and only on the alpha and sixteen-bit roads,
        // which is the worst way for a limit to disagree with another one.
        let default = Limits::default().max_alloc.unwrap();
        let (edge, bpp) = (11_700u64, 4u64);
        assert!(decode_peak(0, edge, edge, bpp, true) <= MAX_PICTURE_PEAK);
        assert!(
            edge * edge * bpp > default,
            "the two rules no longer disagree, so this test is no longer about anything"
        );
        assert_eq!(decode_limits().max_alloc, Some(MAX_PICTURE_PEAK));
    }

    #[test]
    fn a_variant_is_eight_bits_a_channel_whatever_the_original_was() {
        // A variant exists to be shown and a webview shows eight. Encoding one
        // at sixteen cost a fixed 337 MiB — the one place in the decode road
        // where the peak was not the resize — and the original is still on disk
        // for anything that wants the rest of the depth.
        let (_dir, store) = store();
        let meta = store.ingest_bytes(&png16(320, 240), None).unwrap();
        store.build_variants(&meta.sha256).unwrap();

        let thumb = store.resolve(&meta.sha256, Variant::Thumb).unwrap();
        let bytes = fs::read(&thumb.path).unwrap();
        let decoder = ImageReader::new(io::Cursor::new(&bytes))
            .with_guessed_format()
            .unwrap()
            .into_decoder()
            .unwrap();
        assert_eq!(
            decoder.color_type().bytes_per_pixel(),
            4,
            "a sixteen-bit original produced a sixteen-bit variant"
        );
    }

    #[test]
    fn every_exif_orientation_puts_the_pixels_where_the_tag_says() {
        // Only orientation 6 was covered here, and T-308 restructured 5 and 7 —
        // the two arms nothing was watching — to stop them holding a third whole
        // surface while they worked. Written as the mapping the Exif tag defines
        // rather than as "the same as it was", so it tests the specification and
        // not the code that is supposed to implement it.
        let (w, h) = (3u32, 2u32);
        let mut pixels = RgbImage::new(w, h);
        for (x, y, pixel) in pixels.enumerate_pixels_mut() {
            *pixel = image::Rgb([x as u8, y as u8, 0]);
        }
        let source = DynamicImage::ImageRgb8(pixels);

        for orientation in 1..=8u32 {
            let out = apply_orientation(source.clone(), orientation).to_rgb8();
            let (ow, oh) = if swaps_axes(orientation) {
                (h, w)
            } else {
                (w, h)
            };
            assert_eq!((out.width(), out.height()), (ow, oh), "{orientation}");

            for v in 0..oh {
                for u in 0..ow {
                    let want = match orientation {
                        1 => (u, v),
                        2 => (w - 1 - u, v),
                        3 => (w - 1 - u, h - 1 - v),
                        4 => (u, h - 1 - v),
                        5 => (v, u),
                        6 => (v, h - 1 - u),
                        7 => (w - 1 - v, h - 1 - u),
                        _ => (w - 1 - v, u),
                    };
                    let got = out.get_pixel(u, v);
                    assert_eq!(
                        (u32::from(got.0[0]), u32::from(got.0[1])),
                        want,
                        "orientation {orientation} at ({u}, {v})"
                    );
                }
            }
        }
    }

    #[test]
    fn the_refusal_from_the_paste_road_names_the_other_road() {
        // The numbers themselves are pinned beside the constants, where they
        // fail the build rather than a test. What is left to check at runtime is
        // the only reason this refusal is a variant of its own: a person told a
        // number and not what to do with it has been told nothing.
        let refused = Error::TooLargeToPaste(9).to_string();
        assert!(refused.contains("drag the file in"), "{refused}");
        assert!(!Error::TooLarge(9).to_string().contains("drag the file in"));
    }

    #[test]
    fn a_refusal_crosses_the_boundary_as_two_facts_and_not_as_prose() {
        // T-309. What the frontend could not work out for itself: whether the
        // board will refuse this file *however it arrives*. Everything else it
        // can do — it has the file's name and it writes the frame — but this one
        // is a claim about the board, and the only alternative to carrying it was
        // matching on the wording of a message.
        let nowhere = Refusal::from(Error::PictureTooLarge {
            w: 16_000,
            h: 16_000,
        });
        assert!(nowhere.holds_nowhere);
        // A verb phrase with the file as its subject, so it reads after a name.
        assert!(nowhere.say.starts_with("is 16000 × 16000"), "{}", nowhere.say);
        assert!(nowhere.say.contains("pixels"), "{}", nowhere.say);

        // And the one that is *not* a claim about the board. A four-hundred
        // megabyte interview refused by the paste road is one drag from working,
        // so being told nothing here can hold it would be false in the direction
        // that stops somebody trying (Q-229 put it on the other road on purpose).
        let elsewhere = Refusal::from(Error::TooLargeToPaste(9));
        assert!(!elsewhere.holds_nowhere);
        assert!(elsewhere.say.contains("drag it in"), "{}", elsewhere.say);

        // A read that broke establishes nothing about the board and says nothing
        // about it. This is the arm a stale clipboard entry takes.
        let broke = Refusal::from(Error::Io(io::Error::other("gone")));
        assert!(!broke.holds_nowhere);
        assert_eq!(broke.say, "could not be read");

        // The sentence for a person is not `Display`'s, on purpose: that one
        // goes in a log beside a hash and has to stand up alone.
        let picture = Error::PictureTooLarge {
            w: 16_000,
            h: 16_000,
        };
        assert_ne!(picture.sentence(), picture.to_string());
        assert!(picture.to_string().starts_with("16000 × 16000"));
    }

    #[test]
    fn a_file_too_big_to_paste_still_arrives_by_path() {
        // The shape of Q-229's answer, end to end: one low ceiling on the road
        // that costs ten times the file, and the four-hundred-megabyte
        // interview comes in the other way.
        let (dir, store) = store();
        // Ninety-three megabytes is not free, so it is allocated once and both
        // sides of the boundary are read out of the same buffer.
        let big = vec![7u8; (MAX_PASTE_BYTES + 1) as usize];

        // Exactly at the ceiling is in. A ceiling nobody may reach is a
        // different number from the one written down.
        let at = &big[..MAX_PASTE_BYTES as usize];
        assert!(store.ingest_ipc_bytes(at, None).is_ok());
        match store.ingest_ipc_bytes(&big, None) {
            Err(Error::TooLargeToPaste(n)) => assert_eq!(n, MAX_PASTE_BYTES + 1),
            other => panic!("the IPC road took a file over its ceiling: {other:?}"),
        }

        // The same bytes off a disk, which is the road this size is meant to
        // travel and is bounded nearly five times higher.
        let path = dir.path().join("interview.wav");
        fs::write(&path, &big).unwrap();
        drop(big);
        assert_eq!(store.ingest_path(&path).unwrap().size, MAX_PASTE_BYTES + 1);
    }

    #[test]
    fn nothing_reaches_the_store_over_the_ceiling_it_publishes() {
        let (dir, store) = store();

        // Sized rather than written: `ingest_path` reads the metadata before it
        // reads a byte, and half a gigabyte of real content to prove one
        // comparison is a test nobody would run twice.
        let path = dir.path().join("enormous.bin");
        File::create(&path).unwrap().set_len(MAX_ASSET_BYTES + 1).unwrap();
        match store.ingest_path(&path) {
            Err(Error::TooLarge(n)) => assert_eq!(n, MAX_ASSET_BYTES + 1),
            other => panic!("the path road took a file over the ceiling: {other:?}"),
        }

        // And a transfer that assembles to one byte over it. `commit_received`
        // is not an error path — a peer offering something this store will not
        // hold is the same "that was not the asset" as a truncated one — so the
        // tell is the `false` and the wreckage being cleared up.
        let wanted = "4".repeat(64);
        fs::create_dir_all(store.dir_for(&wanted)).unwrap();
        let partial = store.partial_path(&wanted);
        File::create(&partial).unwrap().set_len(MAX_ASSET_BYTES + 1).unwrap();
        assert!(!store.commit_received(&wanted).unwrap());
        assert!(!partial.is_file());
    }

    #[test]
    fn a_hash_that_is_not_a_hash_gets_nowhere() {
        let (_dir, store) = store();
        for bad in ["../../etc/passwd", "", &"z".repeat(64)] {
            assert!(store.chunk(bad, 0).is_err());
            assert!(store.receive_chunk(bad, 0, 1, b"x").is_err());
            assert!(store.commit_received(bad).is_err());
            assert!(store.abort_received(bad).is_err());
            assert_eq!(store.size(bad), None);
        }
    }

    #[test]
    fn asking_for_an_asset_we_do_not_have_is_empty_rather_than_an_error() {
        let (_dir, store) = store();
        let absent = "4".repeat(64);
        assert_eq!(store.chunk(&absent, 0).unwrap(), Vec::<u8>::new());
        assert_eq!(store.size(&absent), None);
    }

    #[test]
    fn reading_past_the_end_of_an_asset_is_empty() {
        let (_dir, store) = store();
        let meta = store.ingest_bytes(&png(8, 8), None).unwrap();
        assert!(!store.chunk(&meta.sha256, 0).unwrap().is_empty());
        assert!(store.chunk(&meta.sha256, 1).unwrap().is_empty());
    }

    #[test]
    fn the_summary_names_originals_and_not_variants_or_partials() {
        let (_dir, store) = store();
        let meta = store.ingest_bytes(&png(80, 60), None).unwrap();
        store.build_variants(&meta.sha256).unwrap();
        store.receive_chunk(&"5".repeat(64), 0, 2, b"partial").unwrap();

        // A machine holding a display variant cannot serve the photograph, and
        // one holding half of a transfer certainly cannot.
        assert_eq!(store.hashes().unwrap(), vec![meta.sha256]);
    }
}
