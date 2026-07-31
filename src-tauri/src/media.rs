//! How long a film or a cassette runs, read out of the container.
//!
//! > | Video | VHS cassette | Title and **runtime** on the spine |
//! > | Audio | Compact cassette | Title and **duration** on the J-card |
//! > — D-46 section 1
//!
//! Both of those labels are written before anybody presses play, and on a peer
//! that may never hold the bytes at all: a 400 MB interview arrives as an item
//! long before it arrives as a file (T-265), and the cassette on the wall has to
//! say something in the meantime. So the number is read **once, at ingest, by
//! the machine that has the file**, and travels in the asset record with the
//! hash and the size — not asked of a `<video>` element later, which would mean
//! every peer downloading a film to find out how long it is.
//!
//! That is the whole of AC-688, and it is also why this is Rust's: a duration is
//! a fact about bytes, and ARCHITECTURE section 4.1 puts facts about bytes on
//! this side of the line. What a runtime *means* — whether it goes on a spine or
//! a J-card, how it is written, whether four seconds is worth showing at all —
//! stays the frontend's, exactly as `document` hands over runs and says nothing
//! about paragraphs.
//!
//! ## Why there is no crate under this
//!
//! Every container here is asked one question: how many samples, frames or ticks
//! are in this file, and how many of them are a second. The libraries that
//! answer it — `symphonia` and its relatives — answer it by being *decoders*,
//! and would put a stack of audio codecs in the binary to read a header field.
//! That is the same trade `Cargo.toml` refuses for the AVIF encoder and for
//! `pdfium`: this application does not decode a film, it puts one on a wall.
//!
//! The cost of that is this module, and the honest version of the cost is that
//! it parses six container families by hand. It is bounded work — none of it is
//! a codec, all of it is header fields — but it is somebody else's file format
//! in every case, so every walk here is bounded, every arithmetic is checked,
//! and anything that does not add up returns [`None`].
//!
//! ## No duration is a fact; zero is a claim
//!
//! [`probe_duration`] returns `Option<f64>`, and the difference matters more
//! than it looks (AC-689). A cassette whose J-card says nothing is a cassette
//! nobody has listened to yet. A cassette whose J-card says **0:00** is a
//! cassette that is empty, and the file it was made from is a 400 MB interview.
//! So a container this build cannot read, a field that is absent, a duration
//! that is zero, negative, infinite or `NaN` all come back the same way: no
//! answer. Nothing here ever rounds a failure down to a number.
//!
//! `NaN` is named there on purpose, because a Matroska duration is a float read
//! straight out of a header and is where one would come from. It falls out
//! through the same gate as everything else — see [`plausible`], which is the
//! single place any of these become a `None`.

/// Seconds. The unit the whole module speaks in, and the unit that crosses to
/// the frontend.
type Seconds = f64;

/// Above this, a duration is not a duration — it is a field that was read wrong.
///
/// A hundred hours is far past anything a board holds: the longest thing D-46
/// imagines is an interview, and the 512 MB asset ceiling (T-264) puts a hard
/// roof on it anyway. The bound exists because a bad `timescale` or a stray
/// exponent turns into a plausible-looking float rather than an error, and a
/// spine reading "9,300 hours" is worse than a spine reading nothing.
const MAX_PLAUSIBLE: Seconds = 100.0 * 60.0 * 60.0;

/// Boxes, chunks or elements one walk will step over before giving up.
///
/// Every container here is a list of length-prefixed records, and every one of
/// them can be made to claim a record of length zero. This is what stops that
/// being a hang rather than a `None`.
const MAX_RECORDS: usize = 8192;

/// How far back from the end of an Ogg stream the last page is looked for.
///
/// A page is at most 27 + 255 + 255×255 = 65,307 bytes, so a megabyte is a
/// generous fifteen of them — enough to step over a trailing tag or a partial
/// page, and far short of walking a whole file backwards.
const OGG_TAIL_BYTES: usize = 1024 * 1024;

/// How far into an MPEG audio file the first frame is looked for.
///
/// Past the ID3v2 tag there is usually a frame immediately. There is not always:
/// some taggers leave padding they did not declare, and some files begin with
/// junk. This bounds the hunt.
const MPEG_SCAN_BYTES: usize = 256 * 1024;

/// Frames one file will be counted over.
///
/// A frame is 26 ms at the commonest settings, so this is about seventy hours —
/// comfortably past [`MAX_PLAUSIBLE`], which is the point: the bound is a
/// backstop against a file engineered to loop the walk, not a limit anything
/// real will meet.
const MAX_MPEG_FRAMES: usize = 10_000_000;

/// How long this file runs, if it is a film or a cassette and this build can
/// tell.
///
/// `mime` is the store's sniff, not the caller's word for it — by the time
/// anything gets here [`crate::assets::sniff_mime`] has already read the magic
/// numbers, so this dispatches on evidence rather than on a file extension.
///
/// `bytes` is the whole file. It is in memory already: ingestion hashes it,
/// which means holding it, and MPEG audio without a VBR header needs the total
/// length to say anything at all.
pub fn probe_duration(bytes: &[u8], mime: &str) -> Option<Seconds> {
    let seconds = match mime {
        // One container, three faces. `.m4a` and `.mp4` differ in the `ftyp`
        // brand and nowhere the duration lives, so they read identically here.
        "video/mp4" | "audio/mp4" | "video/quicktime" => iso_duration(bytes),
        "video/x-matroska" | "video/webm" => ebml_duration(bytes),
        "audio/ogg" | "video/ogg" => ogg_duration(bytes),
        "audio/flac" => flac_duration(bytes),
        "audio/wav" => wav_duration(bytes),
        "video/x-msvideo" => avi_duration(bytes),
        "audio/mpeg" => mpeg_duration(bytes),
        _ => None,
    }?;
    plausible(seconds)
}

/// The one gate every reader below leaves through, and the reason none of them
/// has to be careful about arithmetic on a field it was lied to about.
///
/// A length divided by a rate of zero is `inf`, and `inf` fails the ceiling; a
/// duration read out of a header as `NaN` fails every comparison put to it,
/// including `> 0.0`. So the guards inside the readers — a zero byte rate, a
/// zero sample count — are for saying what the file did rather than for
/// correctness, and this is what actually makes all of it a `None`.
///
/// `is_finite` is therefore belt to those braces rather than the thing catching
/// `NaN`: it says the intent out loud, in the one place a later reader would
/// otherwise have to reason about float comparison semantics to be sure.
fn plausible(seconds: Seconds) -> Option<Seconds> {
    (seconds.is_finite() && seconds > 0.0 && seconds <= MAX_PLAUSIBLE).then_some(seconds)
}

// --- ISO base media: .mp4, .m4a, .mov ---------------------------------------

/// The movie header's timescale and duration, or the fragment duration when the
/// header has none.
///
/// A non-fragmented file says it in `moov/mvhd` and that is the end of it. A
/// fragmented one — which is what a browser recording, a DASH remux or anything
/// that was once a live stream is — writes `mvhd` with a duration of zero and
/// puts the real one in `moov/mvex/mehd`, if it writes it at all. Files that do
/// neither exist, and they get no answer rather than a zero: summing every
/// fragment's `tfdt` would mean walking the whole file for a label.
fn iso_duration(bytes: &[u8]) -> Option<Seconds> {
    let moov = find_box(bytes, b"moov")?;
    let (timescale, duration) = find_box(moov, b"mvhd").and_then(mvhd_fields)?;
    if timescale == 0 {
        return None;
    }
    let ticks = if duration > 0 {
        duration
    } else {
        find_box(moov, b"mvex")
            .and_then(|mvex| find_box(mvex, b"mehd"))
            .and_then(mehd_fragment_duration)?
    };
    Some(ticks as f64 / timescale as f64)
}

/// `(timescale, duration)` out of an `mvhd`, in whichever of its two versions
/// this file was written in.
///
/// `u32::MAX` is the version-0 way of saying *unknown*, and it comes back as
/// zero so the fragmented path is tried — the alternative is a spine claiming
/// forty-nine days.
fn mvhd_fields(payload: &[u8]) -> Option<(u32, u64)> {
    match *payload.first()? {
        // version, flags, creation(8), modification(8), timescale, duration(8)
        1 => Some((be32(payload, 20)?, be64(payload, 24)?)),
        // version, flags, creation(4), modification(4), timescale, duration(4)
        0 => {
            let duration = be32(payload, 16)? as u64;
            Some((be32(payload, 12)?, if duration == u32::MAX as u64 { 0 } else { duration }))
        }
        _ => None,
    }
}

/// The total duration a fragmented file declares up front, in movie ticks.
fn mehd_fragment_duration(payload: &[u8]) -> Option<u64> {
    match *payload.first()? {
        1 => be64(payload, 4),
        0 => be32(payload, 4).map(u64::from),
        _ => None,
    }
}

/// The payload of the first box of this type at this level.
///
/// Not recursive: `moov` is at the top and `mvhd` is directly inside it, and a
/// search that descended would find the `mvhd` of some other movie in a file
/// that carries one. Nesting is expressed by calling this on what it returned.
fn find_box<'a>(data: &'a [u8], want: &[u8; 4]) -> Option<&'a [u8]> {
    let mut pos = 0usize;
    for _ in 0..MAX_RECORDS {
        let header = data.get(pos..pos + 8)?;
        let kind: [u8; 4] = header[4..8].try_into().ok()?;
        // Two escapes from the 32-bit size field, and both are ordinary: 1 puts
        // a 64-bit size after the type — which every file above 4 GB uses — and
        // 0 means "to the end", which is how `mdat` is written when the muxer
        // did not know the length in advance.
        let (head, size) = match be32(data, pos)? {
            1 => (16usize, be64(data, pos + 8)?),
            0 => (8usize, (data.len() - pos) as u64),
            n => (8usize, n as u64),
        };
        let size = usize::try_from(size).ok()?;
        if size < head {
            return None;
        }
        if &kind == want {
            // Clamped, not refused: a truncated download whose last box claims
            // more than arrived should hand back what did arrive, and let the
            // field reads inside decide whether it was enough.
            return Some(&data[pos + head..(pos + size).min(data.len())]);
        }
        pos = pos.checked_add(size)?;
    }
    None
}

// --- EBML: .mkv, .webm ------------------------------------------------------

/// Matroska's `Segment/Info`, which holds a duration in ticks and the length of
/// a tick in nanoseconds.
///
/// The duration is a float, and it is the only one in this module — which is why
/// [`plausible`] refuses `NaN` explicitly. A muxer that wrote a duration it did
/// not know can and does leave one here.
fn ebml_duration(bytes: &[u8]) -> Option<Seconds> {
    let segment = ebml_child(bytes, 0x1853_8067)?;
    let info = ebml_child(segment, 0x1549_A966)?;
    // The default when the element is absent, and near enough universal: one
    // tick is a millisecond.
    let scale = ebml_child(info, 0x002A_D7B1)
        .and_then(ebml_uint)
        .unwrap_or(1_000_000);
    let ticks = ebml_child(info, 0x4489).and_then(ebml_float)?;
    Some(ticks * scale as f64 / 1_000_000_000.0)
}

/// The payload of the first child element with this id, at this level.
fn ebml_child(data: &[u8], want: u64) -> Option<&[u8]> {
    let mut pos = 0usize;
    for _ in 0..MAX_RECORDS {
        let (id, id_len) = ebml_vint(data, pos, true)?;
        let (size, size_len) = ebml_vint(data, pos + id_len, false)?;
        let body = pos + id_len + size_len;
        // An unknown-size element runs to the end of its parent. `Segment` is
        // routinely written this way — a muxer that is still recording does not
        // know how long the file will be — and a `Cluster` sometimes is. Either
        // way there is nothing after it at this level, so the walk stops.
        let end = match size {
            UNKNOWN_SIZE => data.len(),
            n => body.checked_add(usize::try_from(n).ok()?)?.min(data.len()),
        };
        if body > end {
            return None;
        }
        if id == want {
            return Some(&data[body..end]);
        }
        if size == UNKNOWN_SIZE {
            return None;
        }
        pos = end;
    }
    None
}

/// What an EBML size field reads as when the file does not know it: every data
/// bit set. The marker is stripped by then, so this is the same value at every
/// width.
const UNKNOWN_SIZE: u64 = u64::MAX;

/// One EBML variable-width integer, and how many bytes it took.
///
/// The leading zeros of the first byte say the width; the first set bit is a
/// marker. An id keeps its marker — that is what makes `0x4489` the same number
/// in the spec and in the file — and a size does not, because a size is a
/// length rather than a name.
fn ebml_vint(data: &[u8], pos: usize, keep_marker: bool) -> Option<(u64, usize)> {
    let first = *data.get(pos)?;
    if first == 0 {
        // Eight or more leading zeros: not a width this build reads, and in
        // practice not a Matroska file either.
        return None;
    }
    let len = first.leading_zeros() as usize + 1;
    // Widened before the shift on purpose: the eight-byte width — which is what
    // a muxer writing a size it will fill in later uses — asks for `0xFF >> 8`,
    // and shifting a `u8` by its own width is an overflow panic in debug rather
    // than a zero.
    let mask = (0xFFu16 >> len) as u8;
    let mut value = if keep_marker {
        u64::from(first)
    } else {
        u64::from(first & mask)
    };
    let mut all_ones = !keep_marker && (first & mask) == mask;
    for i in 1..len {
        let byte = *data.get(pos + i)?;
        value = (value << 8) | u64::from(byte);
        all_ones &= byte == 0xFF;
    }
    Some((if all_ones { UNKNOWN_SIZE } else { value }, len))
}

/// An EBML unsigned integer, which is big-endian and as wide as it needs to be.
fn ebml_uint(data: &[u8]) -> Option<u64> {
    if data.is_empty() || data.len() > 8 {
        return None;
    }
    Some(data.iter().fold(0u64, |acc, &b| (acc << 8) | u64::from(b)))
}

/// An EBML float, which is IEEE-754 in four bytes or eight and nothing else.
fn ebml_float(data: &[u8]) -> Option<f64> {
    match data.len() {
        4 => Some(f32::from_be_bytes(data.try_into().ok()?) as f64),
        8 => Some(f64::from_be_bytes(data.try_into().ok()?)),
        _ => None,
    }
}

// --- Ogg: .ogg, .oga, .opus -------------------------------------------------

/// Where the stream ends, in samples, over how many samples make a second.
///
/// Ogg has no duration field anywhere. What it has is a granule position on
/// every page — a running sample count — so the duration is the last page's
/// granule and the sample rate out of the first page's identification header.
/// That is why this is the one reader here that looks at both ends of the file.
///
/// Vorbis, Opus and FLAC-in-Ogg count granules in samples and are read. Theora
/// counts them in frames, in a packed keyframe-plus-offset field whose shift is
/// declared in the header, and gets no answer rather than a wrong one — a
/// `.ogv` is rare enough that half-reading it is the worse trade.
///
/// A *chained* stream — two files concatenated, each with its own serial —
/// reports the first chain, because that is the stream the identification
/// header describes. Under-reporting a rarity beats reading a granule against
/// the wrong sample rate.
fn ogg_duration(bytes: &[u8]) -> Option<Seconds> {
    let first = ogg_page(bytes, 0)?;
    let (rate, pre_skip) = ogg_codec(first.payload)?;
    if rate == 0 {
        return None;
    }
    let granule = ogg_last_granule(bytes, first.serial)?;
    // Opus counts from before the pre-skip, which is decoder warm-up rather than
    // sound. On a short file it is the difference between 80 ms and nothing.
    let samples = granule.checked_sub(u64::from(pre_skip))?;
    Some(samples as f64 / rate as f64)
}

struct OggPage<'a> {
    serial: u32,
    granule: u64,
    payload: &'a [u8],
}

/// One Ogg page read at a byte offset, if there is one there.
fn ogg_page(bytes: &[u8], pos: usize) -> Option<OggPage<'_>> {
    let header = bytes.get(pos..pos + 27)?;
    if &header[0..4] != b"OggS" {
        return None;
    }
    let granule = u64::from_le_bytes(header[6..14].try_into().ok()?);
    let serial = u32::from_le_bytes(header[14..18].try_into().ok()?);
    let segments = header[26] as usize;
    let table = bytes.get(pos + 27..pos + 27 + segments)?;
    let payload_len: usize = table.iter().map(|&n| n as usize).sum();
    let start = pos + 27 + segments;
    let payload = bytes.get(start..start + payload_len)?;
    Some(OggPage {
        serial,
        granule,
        payload,
    })
}

/// The sample rate this stream's granules are counted in, and how many of them
/// at the front are not sound.
fn ogg_codec(packet: &[u8]) -> Option<(u32, u16)> {
    if packet.starts_with(b"\x01vorbis") {
        // version(4), channels(1), then the rate.
        return Some((le32(packet, 12)?, 0));
    }
    if packet.starts_with(b"OpusHead") {
        // Opus granules are always at 48 kHz whatever the input rate the header
        // records — that field is a hint for a resampler, not a clock.
        let pre_skip = u16::from_le_bytes(packet.get(10..12)?.try_into().ok()?);
        return Some((48_000, pre_skip));
    }
    if packet.starts_with(b"\x7fFLAC") {
        // A whole native FLAC metadata block, wrapped: 9 bytes of Ogg mapping
        // header, then `fLaC`, then the STREAMINFO block header, then the block.
        let streaminfo = packet.get(17..17 + 34)?;
        return Some((flac_rate(streaminfo)?, 0));
    }
    None
}

/// The granule position of the last page belonging to this stream.
fn ogg_last_granule(bytes: &[u8], serial: u32) -> Option<u64> {
    let floor = bytes.len().saturating_sub(OGG_TAIL_BYTES);
    let mut pos = bytes.len().checked_sub(4)?;
    loop {
        if &bytes[pos..pos + 4] == b"OggS" {
            if let Some(page) = ogg_page(bytes, pos) {
                if page.serial == serial {
                    return Some(page.granule);
                }
            }
        }
        if pos == floor {
            return None;
        }
        pos -= 1;
    }
}

// --- FLAC -------------------------------------------------------------------

/// Native FLAC says it outright: total samples over sample rate, both in the
/// STREAMINFO block, which the format requires to be the first one.
fn flac_duration(bytes: &[u8]) -> Option<Seconds> {
    let blocks = bytes.strip_prefix(b"fLaC")?;
    // Block header: a last-block flag and seven bits of type, then a 24-bit
    // length. Type 0 is STREAMINFO and it is mandatory here.
    if blocks.first()? & 0x7F != 0 {
        return None;
    }
    let streaminfo = blocks.get(4..4 + 34)?;
    let rate = flac_rate(streaminfo)?;
    let samples = flac_total_samples(streaminfo)?;
    if samples == 0 {
        // A legal way of saying "unknown" — a stream that was encoded live.
        return None;
    }
    Some(samples as f64 / rate as f64)
}

/// STREAMINFO packs the two fields this module wants into one 64-bit run:
/// 20 bits of sample rate, 3 of channels, 5 of bits per sample, 36 of total
/// samples. Hence the shifts rather than a struct.
fn flac_rate(streaminfo: &[u8]) -> Option<u32> {
    let packed = be64(streaminfo, 10)?;
    match (packed >> 44) as u32 {
        0 => None,
        rate => Some(rate),
    }
}

fn flac_total_samples(streaminfo: &[u8]) -> Option<u64> {
    Some(be64(streaminfo, 10)? & 0xF_FFFF_FFFF)
}

// --- RIFF: .wav, .avi -------------------------------------------------------

/// Bytes of sound over bytes of sound per second.
///
/// Not samples over sample rate, deliberately: `byte_rate` is one field that is
/// already correct for a compressed `.wav` — ADPCM, µ-law — where multiplying
/// the sample rate by the channel count and the sample width is not.
fn wav_duration(bytes: &[u8]) -> Option<Seconds> {
    let body = riff_body(bytes, b"WAVE")?;
    let fmt = riff_chunk(body, b"fmt ")?;
    let byte_rate = le32(fmt, 8)?;
    if byte_rate == 0 {
        return None;
    }
    let data = riff_chunk(body, b"data")?;
    Some(data.len() as f64 / byte_rate as f64)
}

/// Frames times the length of a frame. AVI's main header states both, which
/// makes it the one video container here that needs no arithmetic on a clock.
fn avi_duration(bytes: &[u8]) -> Option<Seconds> {
    let body = riff_body(bytes, b"AVI ")?;
    let hdrl = riff_list(body, b"hdrl")?;
    let avih = riff_chunk(hdrl, b"avih")?;
    let micros_per_frame = le32(avih, 0)? as f64;
    let frames = le32(avih, 16)? as f64;
    Some(micros_per_frame * frames / 1_000_000.0)
}

/// Everything after `RIFF<size><form>`, once the form is the one expected.
fn riff_body<'a>(bytes: &'a [u8], form: &[u8; 4]) -> Option<&'a [u8]> {
    if !bytes.starts_with(b"RIFF") || bytes.get(8..12)? != form {
        return None;
    }
    bytes.get(12..)
}

/// The payload of the first chunk with this id, at this level.
fn riff_chunk<'a>(data: &'a [u8], want: &[u8; 4]) -> Option<&'a [u8]> {
    riff_find(data, want, false)
}

/// The contents of the first `LIST` of this type, past its four-byte type.
fn riff_list<'a>(data: &'a [u8], want: &[u8; 4]) -> Option<&'a [u8]> {
    riff_find(data, want, true)
}

fn riff_find<'a>(data: &'a [u8], want: &[u8; 4], list: bool) -> Option<&'a [u8]> {
    let mut pos = 0usize;
    for _ in 0..MAX_RECORDS {
        let id: [u8; 4] = data.get(pos..pos + 4)?.try_into().ok()?;
        let size = usize::try_from(le32(data, pos + 4)?).ok()?;
        let start = pos + 8;
        // Clamped for the reason a box is: a `data` chunk whose declared size
        // outruns the file is a truncated download, and what arrived is still
        // the length of what can be played.
        let end = start.checked_add(size)?.min(data.len());
        let matched = if list {
            &id == b"LIST" && data.get(start..start + 4) == Some(want)
        } else {
            &id == want
        };
        if matched {
            return Some(if list { data.get(start + 4..end)? } else { data.get(start..end)? });
        }
        // Chunks are padded to an even offset, and the pad byte is not counted
        // in the size. Missing this reads every chunk after an odd one as
        // garbage — which is most `.wav` files with a metadata chunk in them.
        pos = start.checked_add(size + (size & 1))?;
    }
    None
}

// --- MPEG audio: .mp3 -------------------------------------------------------

/// The encoder's own frame count if it wrote one, and otherwise every frame in
/// the file, counted.
///
/// **Not bytes over a bitrate.** That is the obvious route and it is wrong on a
/// large minority of real files: an MP3 is free to change bitrate every frame,
/// and one written by anything that muxed rather than encoded — `Lavf`, which
/// is to say ffmpeg, and every tool built on it — carries no VBR header at all.
/// Two files on the machine this was written on read as 103 seconds against a
/// true 199 and as 97 against 192, because their first frame happens to be 256
/// kbps and their average is 133. A J-card claiming half the length of the tape
/// is worse than one claiming nothing.
///
/// So the fallback walks. Each step is a header parse and an add, the bytes are
/// already in memory, and a 400 MB podcast is about a million of them — which is
/// milliseconds, once, at ingest.
fn mpeg_duration(bytes: &[u8]) -> Option<Seconds> {
    let start = id3v2_end(bytes);
    let offset = mpeg_first_frame(bytes, start)?;
    let frame = MpegFrame::parse(bytes, offset)?;

    if let Some(frames) = mpeg_frame_count(bytes, offset, &frame) {
        return Some(frames as f64 * frame.samples_per_frame as f64 / frame.sample_rate as f64);
    }

    // The tag at the *end* is not sound. It matters here for where the walk
    // stops rather than for arithmetic: `TAG` is not a frame header, so the
    // walk would stop there anyway — but it would first spend a resync hunt
    // finding that out, on every file that has one, which is most of them.
    let id3v1 = bytes.len() >= 128 && bytes[bytes.len() - 128..].starts_with(b"TAG");
    let end = bytes.len() - if id3v1 { 128 } else { 0 };
    mpeg_walk(bytes, offset, end)
}

/// Every frame from here to there, at whatever bitrate each one turns out to be.
///
/// A stray tag or a block of junk in the middle of the audio is ordinary — a
/// file that has been through three taggers and a joiner is a normal file — so a
/// header that does not parse is resynced past rather than treated as the end.
/// What is *not* ordinary is a resync that finds nothing within
/// [`MPEG_SCAN_BYTES`], and that ends the walk with what has been counted so
/// far, because the alternative is discarding a correct reading of the first
/// fifty-nine minutes over a corrupt last one.
fn mpeg_walk(bytes: &[u8], from: usize, end: usize) -> Option<Seconds> {
    let mut pos = from;
    let mut seconds = 0.0f64;
    let mut frames = 0usize;
    while pos < end {
        match MpegFrame::parse(bytes, pos) {
            Some(frame) => {
                seconds += f64::from(frame.samples_per_frame) / f64::from(frame.sample_rate);
                pos += frame.length;
                frames += 1;
                if frames > MAX_MPEG_FRAMES {
                    return None;
                }
            }
            None => match mpeg_first_frame(&bytes[..end], pos + 1) {
                Some(next) => pos = next,
                None => break,
            },
        }
    }
    (frames > 0).then_some(seconds)
}

/// Where the audio starts, given an ID3v2 tag may be sitting in front of it.
///
/// The size is *syncsafe*: seven bits per byte, so that a tag length can never
/// contain a run of bits a decoder would mistake for a frame sync. Reading it
/// as a plain big-endian integer overshoots by up to a ninth, which lands in the
/// middle of the audio.
fn id3v2_end(bytes: &[u8]) -> usize {
    let Some(header) = bytes.get(..10) else {
        return 0;
    };
    if &header[0..3] != b"ID3" {
        return 0;
    }
    let size = header[6..10]
        .iter()
        .fold(0usize, |acc, &b| (acc << 7) | (b & 0x7F) as usize);
    // A footer is optional, present when bit 4 of the flags is set, and another
    // ten bytes.
    let footer = if header[5] & 0x10 != 0 { 10 } else { 0 };
    (10 + size + footer).min(bytes.len())
}

/// The offset of the first byte of the first frame, hunting forwards from where
/// the tags ended.
///
/// Two frames are required to agree, not one. A single sync pattern occurs in
/// ordinary data about once every two thousand bytes, and the whole failure
/// mode here is locking onto one inside an album cover.
fn mpeg_first_frame(bytes: &[u8], from: usize) -> Option<usize> {
    let limit = (from + MPEG_SCAN_BYTES).min(bytes.len());
    for offset in from..limit {
        let Some(frame) = MpegFrame::parse(bytes, offset) else {
            continue;
        };
        let next = offset + frame.length;
        if next >= bytes.len() || MpegFrame::parse(bytes, next).is_some() {
            return Some(offset);
        }
    }
    None
}

/// One MPEG audio frame header, decoded into the four things a duration needs.
struct MpegFrame {
    sample_rate: u32,
    samples_per_frame: u32,
    /// Bytes to the next frame header, which is what makes the two-frame check
    /// in [`mpeg_first_frame`] possible.
    length: usize,
    /// Where a VBR header would sit, if the encoder wrote one: past the side
    /// information, whose length depends on the version and the channel mode.
    xing_offset: usize,
}

impl MpegFrame {
    fn parse(bytes: &[u8], pos: usize) -> Option<Self> {
        let head = bytes.get(pos..pos + 4)?;
        if head[0] != 0xFF || head[1] & 0xE0 != 0xE0 {
            return None;
        }
        // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5, 1 = reserved. The half-rate
        // versions matter: they halve the sample rate *and*, at layer 3, the
        // samples per frame.
        let version = (head[1] >> 3) & 0x03;
        let layer = (head[1] >> 1) & 0x03;
        if version == 1 || layer == 0 {
            return None;
        }
        let bitrate_index = (head[2] >> 4) as usize;
        let rate_index = ((head[2] >> 2) & 0x03) as usize;
        // `free` (0) and `bad` (15) are both refusals: no real encoder writes
        // either, and a free-format stream has no bitrate to divide by.
        if bitrate_index == 0 || bitrate_index == 15 || rate_index == 3 {
            return None;
        }
        let padding = ((head[2] >> 1) & 0x01) as usize;
        let mono = (head[3] >> 6) & 0x03 == 0x03;

        let mpeg1 = version == 3;
        let layer_index = match layer {
            3 => 0usize, // layer I
            2 => 1,      // layer II
            _ => 2,      // layer III
        };
        let bitrate = 1000
            * BITRATES[usize::from(!mpeg1)][layer_index]
                .get(bitrate_index)
                .copied()? as u32;
        let sample_rate = SAMPLE_RATES[match version {
            3 => 0,
            2 => 1,
            _ => 2,
        }][rate_index];
        let samples_per_frame = match (layer_index, mpeg1) {
            (0, _) => 384,
            (1, _) => 1152,
            (_, true) => 1152,
            (_, false) => 576,
        };
        // Layer I is measured in four-byte slots; the other two in bytes.
        let length = if layer_index == 0 {
            (12 * bitrate as usize / sample_rate as usize + padding) * 4
        } else {
            samples_per_frame as usize / 8 * bitrate as usize / sample_rate as usize + padding
        };
        if length < 4 {
            return None;
        }
        let side_info = match (mpeg1, mono) {
            (true, true) => 17,
            (true, false) => 32,
            (false, true) => 9,
            (false, false) => 17,
        };
        Some(MpegFrame {
            sample_rate,
            samples_per_frame,
            length,
            xing_offset: 4 + side_info,
        })
    }
}

/// Frames, out of whichever VBR header the encoder wrote.
///
/// `Xing` and `Info` are the same structure under two names — LAME writes
/// `Info` when it encoded at a constant bitrate — and `VBRI` is Fraunhofer's,
/// at a fixed offset of its own.
fn mpeg_frame_count(bytes: &[u8], offset: usize, frame: &MpegFrame) -> Option<u64> {
    let xing = offset + frame.xing_offset;
    if let Some(tag) = bytes.get(xing..xing + 4) {
        if tag == b"Xing" || tag == b"Info" {
            let flags = be32(bytes, xing + 4)?;
            // Bit 0 says a frame count follows. Without it the header is only a
            // seek table, and there is nothing here to read.
            if flags & 0x01 != 0 {
                return match be32(bytes, xing + 8)? {
                    0 => None,
                    frames => Some(u64::from(frames)),
                };
            }
        }
    }
    let vbri = offset + 4 + 32;
    if bytes.get(vbri..vbri + 4)? == b"VBRI" {
        return match be32(bytes, vbri + 14)? {
            0 => None,
            frames => Some(u64::from(frames)),
        };
    }
    None
}

/// `[MPEG-1, MPEG-2 and 2.5][layer I, II, III]`, in kbps, indexed by the header's
/// four-bit field — so index 0 is the `free` slot and is never read.
const BITRATES: [[[u16; 15]; 3]; 2] = [
    [
        [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
        [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
        [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    ],
    [
        [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
        [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
        [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    ],
];

/// `[MPEG-1, MPEG-2, MPEG-2.5][the header's two-bit field]`.
const SAMPLE_RATES: [[u32; 3]; 3] = [
    [44100, 48000, 32000],
    [22050, 24000, 16000],
    [11025, 12000, 8000],
];

// --- reading numbers out of somebody else's file ----------------------------

fn be32(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

fn be64(data: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(data.get(at..at + 8)?.try_into().ok()?))
}

fn le32(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Durations are floats out of integer fields, so every assertion is a
    /// tolerance. A tenth of a millisecond is far below anything a spine shows
    /// and far above the error in any division here.
    fn assert_seconds(got: Option<Seconds>, want: Seconds) {
        let got = got.expect("expected a duration");
        assert!((got - want).abs() < 1e-4, "expected {want} seconds, got {got}");
    }

    // --- ISO base media -----------------------------------------------------

    fn iso_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(payload);
        out
    }

    fn mvhd_v0(timescale: u32, duration: u32) -> Vec<u8> {
        let mut p = vec![0u8; 4];
        p.extend_from_slice(&0u32.to_be_bytes());
        p.extend_from_slice(&0u32.to_be_bytes());
        p.extend_from_slice(&timescale.to_be_bytes());
        p.extend_from_slice(&duration.to_be_bytes());
        p.extend_from_slice(&[0u8; 80]);
        p
    }

    fn mvhd_v1(timescale: u32, duration: u64) -> Vec<u8> {
        let mut p = vec![1u8, 0, 0, 0];
        p.extend_from_slice(&0u64.to_be_bytes());
        p.extend_from_slice(&0u64.to_be_bytes());
        p.extend_from_slice(&timescale.to_be_bytes());
        p.extend_from_slice(&duration.to_be_bytes());
        p.extend_from_slice(&[0u8; 80]);
        p
    }

    /// `moov` deliberately last, which is where a file that was not written for
    /// streaming puts it — and the case a reader that only looks at the front of
    /// the file gets wrong.
    fn mp4(moov: &[u8]) -> Vec<u8> {
        let mut out = iso_box(b"ftyp", b"isom\0\0\x02\0isomiso2");
        out.extend_from_slice(&iso_box(b"mdat", &[0u8; 64]));
        out.extend_from_slice(&iso_box(b"moov", moov));
        out
    }

    #[test]
    fn mp4_reports_its_movie_header() {
        let file = mp4(&iso_box(b"mvhd", &mvhd_v0(600, 6000)));
        assert_seconds(probe_duration(&file, "video/mp4"), 10.0);
    }

    #[test]
    fn a_64_bit_movie_header_is_read_as_one() {
        let file = mp4(&iso_box(b"mvhd", &mvhd_v1(90_000, 90_000 * 42)));
        assert_seconds(probe_duration(&file, "video/quicktime"), 42.0);
    }

    #[test]
    fn an_m4a_reads_through_the_same_path_as_a_film() {
        let file = mp4(&iso_box(b"mvhd", &mvhd_v0(44_100, 44_100 * 7)));
        assert_seconds(probe_duration(&file, "audio/mp4"), 7.0);
    }

    #[test]
    fn a_fragmented_file_falls_back_to_the_declared_fragment_duration() {
        // What a browser recording and every DASH remux looks like: a movie
        // header saying nothing, and the length in `mvex/mehd`.
        let mut moov = iso_box(b"mvhd", &mvhd_v0(1000, 0));
        let mut mehd = vec![0u8, 0, 0, 0];
        mehd.extend_from_slice(&30_000u32.to_be_bytes());
        moov.extend_from_slice(&iso_box(b"mvex", &iso_box(b"mehd", &mehd)));
        assert_seconds(probe_duration(&mp4(&moov), "video/mp4"), 30.0);
    }

    #[test]
    fn a_movie_header_saying_unknown_is_not_a_length() {
        // `u32::MAX` ticks is version 0's way of saying it does not know.
        //
        // The timescale is 90 kHz — the one broadcast video actually uses —
        // rather than a millisecond, and that is the whole point of the
        // fixture: at a millisecond tick the bad reading is 49 days and the
        // plausibility ceiling refuses it whether or not this case is handled
        // at all, so the test would pass over a version of this that had never
        // heard of `u32::MAX`. At 90 kHz it is thirteen hours, which is a
        // perfectly plausible number and separates the two readings.
        let file = mp4(&iso_box(b"mvhd", &mvhd_v0(90_000, u32::MAX)));
        assert_eq!(probe_duration(&file, "video/mp4"), None);
    }

    #[test]
    fn a_box_that_needs_64_bits_to_say_its_size_is_stepped_over() {
        // Every file above 4 GB writes `mdat` this way: a size field of 1, and
        // the real length in the eight bytes after the type. A walk that reads
        // the 1 as a length steps forward by nothing and never reaches the
        // movie header — which on a film long enough to need this is exactly
        // the film whose runtime somebody wants on the spine.
        let payload = [0u8; 64];
        let mut mdat = 1u32.to_be_bytes().to_vec();
        mdat.extend_from_slice(b"mdat");
        mdat.extend_from_slice(&((payload.len() + 16) as u64).to_be_bytes());
        mdat.extend_from_slice(&payload);

        let mut file = iso_box(b"ftyp", b"isom\0\0\x02\0isomiso2");
        file.extend_from_slice(&mdat);
        file.extend_from_slice(&iso_box(b"moov", &iso_box(b"mvhd", &mvhd_v0(600, 3600))));
        assert_seconds(probe_duration(&file, "video/mp4"), 6.0);
    }

    #[test]
    fn a_timescale_of_zero_is_refused_rather_than_divided_by() {
        let file = mp4(&iso_box(b"mvhd", &mvhd_v0(0, 6000)));
        assert_eq!(probe_duration(&file, "video/mp4"), None);
    }

    #[test]
    fn a_box_that_runs_to_the_end_does_not_stop_the_walk_dead() {
        // Size 0 is "to the end of the file", which is how a muxer writes `mdat`
        // when it does not yet know how long the film is. Nothing after it is
        // reachable, so the movie header has to come first — and this is the
        // arrangement that proves the walk terminates rather than loops.
        let mut file = iso_box(b"ftyp", b"isom\0\0\x02\0isomiso2");
        file.extend_from_slice(&iso_box(b"moov", &iso_box(b"mvhd", &mvhd_v0(600, 1200))));
        file.extend_from_slice(&0u32.to_be_bytes());
        file.extend_from_slice(b"mdat");
        file.extend_from_slice(&[0u8; 32]);
        assert_seconds(probe_duration(&file, "video/mp4"), 2.0);
    }

    #[test]
    fn a_truncated_film_says_nothing_rather_than_zero() {
        let file = mp4(&iso_box(b"mvhd", &mvhd_v0(600, 6000)));
        for cut in [1usize, 8, 20, 40, 60, 80, 120] {
            let truncated = &file[..file.len().saturating_sub(cut)];
            let got = probe_duration(truncated, "video/mp4");
            assert!(got.is_none() || got == Some(10.0), "cut {cut} gave {got:?}");
        }
    }

    // --- Matroska and WebM --------------------------------------------------

    fn ebml_elem(id: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut out = id.to_vec();
        // The eight-byte size width, which is what a muxer writing a length it
        // means to come back and fill in uses — and the width that asks a naive
        // mask for `0xFF >> 8`.
        out.push(0x01);
        out.extend_from_slice(&(payload.len() as u64).to_be_bytes()[1..]);
        out.extend_from_slice(payload);
        out
    }

    fn mkv_info(scale: Option<u64>, duration: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        if let Some(scale) = scale {
            out.extend_from_slice(&ebml_elem(&[0x2A, 0xD7, 0xB1], &scale.to_be_bytes()[5..]));
        }
        out.extend_from_slice(&ebml_elem(&[0x44, 0x89], duration));
        out
    }

    fn mkv(info: &[u8]) -> Vec<u8> {
        let mut out = ebml_elem(&[0x1A, 0x45, 0xDF, 0xA3], b"\x42\x86\x81\x01");
        // A seek head before the info and a cluster after it, so the sibling
        // walk has something to step over in both directions.
        let mut segment = ebml_elem(&[0x11, 0x4D, 0x9B, 0x74], &[0u8; 8]);
        segment.extend_from_slice(&ebml_elem(&[0x15, 0x49, 0xA9, 0x66], info));
        segment.extend_from_slice(&ebml_elem(&[0x1F, 0x43, 0xB6, 0x75], &[0u8; 64]));
        out.extend_from_slice(&ebml_elem(&[0x18, 0x53, 0x80, 0x67], &segment));
        out
    }

    #[test]
    fn matroska_multiplies_its_ticks_by_its_timecode_scale() {
        let file = mkv(&mkv_info(Some(1_000_000), &12_500.0f64.to_be_bytes()));
        assert_seconds(probe_duration(&file, "video/x-matroska"), 12.5);
    }

    #[test]
    fn a_four_byte_duration_is_a_float_too() {
        let file = mkv(&mkv_info(Some(1_000_000), &3000.0f32.to_be_bytes()));
        assert_seconds(probe_duration(&file, "video/webm"), 3.0);
    }

    #[test]
    fn a_missing_timecode_scale_is_a_millisecond() {
        // The spec's default, and the reason a file that omits the element is
        // not a file with no duration.
        let file = mkv(&mkv_info(None, &4000.0f64.to_be_bytes()));
        assert_seconds(probe_duration(&file, "video/x-matroska"), 4.0);
    }

    #[test]
    fn a_non_default_timecode_scale_is_actually_used() {
        // A microsecond tick rather than a millisecond one. Ignoring the element
        // and assuming the default reports this file a thousand times longer,
        // which is the reading this fixture exists to separate.
        let file = mkv(&mkv_info(Some(1000), &9000.0f64.to_be_bytes()));
        assert_seconds(probe_duration(&file, "video/x-matroska"), 0.009);
    }

    #[test]
    fn a_nan_duration_is_no_duration() {
        // The one float in this module, and the one value that passes a `> 0.0`
        // guard by failing every comparison put to it.
        let file = mkv(&mkv_info(Some(1_000_000), &f64::NAN.to_be_bytes()));
        assert_eq!(probe_duration(&file, "video/x-matroska"), None);
    }

    #[test]
    fn an_infinite_duration_is_no_duration() {
        let file = mkv(&mkv_info(Some(1_000_000), &f64::INFINITY.to_be_bytes()));
        assert_eq!(probe_duration(&file, "video/webm"), None);
    }

    #[test]
    fn a_duration_of_zero_is_no_duration() {
        // AC-689 at its plainest: zero is a claim about the film, and the file
        // is not making it.
        let file = mkv(&mkv_info(Some(1_000_000), &0.0f64.to_be_bytes()));
        assert_eq!(probe_duration(&file, "video/x-matroska"), None);
    }

    #[test]
    fn an_implausible_duration_is_no_duration() {
        let file = mkv(&mkv_info(Some(1_000_000), &1.0e12f64.to_be_bytes()));
        assert_eq!(probe_duration(&file, "video/x-matroska"), None);
    }

    #[test]
    fn a_segment_of_unknown_size_is_still_descended_into() {
        // How a file that was still recording when it was saved is written: the
        // segment's size is every data bit set, and its contents run to the end.
        let info = mkv_info(Some(1_000_000), &8000.0f64.to_be_bytes());
        let mut file = ebml_elem(&[0x1A, 0x45, 0xDF, 0xA3], b"\x42\x86\x81\x01");
        file.extend_from_slice(&[0x18, 0x53, 0x80, 0x67, 0xFF]);
        file.extend_from_slice(&ebml_elem(&[0x15, 0x49, 0xA9, 0x66], &info));
        assert_seconds(probe_duration(&file, "video/x-matroska"), 8.0);
    }

    // --- Ogg ----------------------------------------------------------------

    fn ogg_page_bytes(granule: u64, serial: u32, seq: u32, payload: &[u8]) -> Vec<u8> {
        let mut out = b"OggS".to_vec();
        out.push(0);
        out.push(if seq == 0 { 0x02 } else { 0x04 });
        out.extend_from_slice(&granule.to_le_bytes());
        out.extend_from_slice(&serial.to_le_bytes());
        out.extend_from_slice(&seq.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        let mut table = Vec::new();
        let mut left = payload.len();
        while left >= 255 {
            table.push(255u8);
            left -= 255;
        }
        table.push(left as u8);
        out.push(table.len() as u8);
        out.extend_from_slice(&table);
        out.extend_from_slice(payload);
        out
    }

    fn vorbis_id(rate: u32) -> Vec<u8> {
        let mut p = b"\x01vorbis".to_vec();
        p.extend_from_slice(&0u32.to_le_bytes());
        p.push(2);
        p.extend_from_slice(&rate.to_le_bytes());
        p.extend_from_slice(&[0u8; 16]);
        p
    }

    fn opus_head(pre_skip: u16) -> Vec<u8> {
        let mut p = b"OpusHead".to_vec();
        p.push(1);
        p.push(2);
        p.extend_from_slice(&pre_skip.to_le_bytes());
        // The input sample rate the encoder was fed, which is exactly the field
        // that must not be used as a clock.
        p.extend_from_slice(&16_000u32.to_le_bytes());
        p.extend_from_slice(&[0u8; 3]);
        p
    }

    fn streaminfo(rate: u32, samples: u64) -> Vec<u8> {
        let mut p = vec![0u8; 10];
        let packed =
            (u64::from(rate) << 44) | (1u64 << 41) | (15u64 << 36) | (samples & 0xF_FFFF_FFFF);
        p.extend_from_slice(&packed.to_be_bytes());
        p.extend_from_slice(&[0u8; 16]);
        p
    }

    fn ogg(identification: &[u8], granule: u64, serial: u32) -> Vec<u8> {
        let mut out = ogg_page_bytes(0, serial, 0, identification);
        out.extend_from_slice(&ogg_page_bytes(granule, serial, 1, &[0u8; 32]));
        out
    }

    #[test]
    fn vorbis_is_its_last_granule_over_its_sample_rate() {
        let file = ogg(&vorbis_id(44_100), 44_100 * 30, 7);
        assert_seconds(probe_duration(&file, "audio/ogg"), 30.0);
    }

    #[test]
    fn opus_counts_at_48k_whatever_its_input_rate_was() {
        // The header records the rate the encoder was fed; the granules do not
        // use it. Reading that field instead of knowing this is how ten seconds
        // of Opus from a 16 kHz source reads as thirty.
        let file = ogg(&opus_head(0), 48_000 * 10, 3);
        assert_seconds(probe_duration(&file, "audio/ogg"), 10.0);
    }

    #[test]
    fn opus_does_not_count_its_pre_skip_as_sound() {
        let file = ogg(&opus_head(3840), 48_000 * 5 + 3840, 3);
        assert_seconds(probe_duration(&file, "audio/ogg"), 5.0);
    }

    #[test]
    fn flac_inside_ogg_reads_its_wrapped_stream_info() {
        let mut identification = b"\x7fFLAC".to_vec();
        identification.extend_from_slice(&[1, 0]);
        identification.extend_from_slice(&1u16.to_be_bytes());
        identification.extend_from_slice(b"fLaC");
        identification.push(0x00);
        identification.extend_from_slice(&[0, 0, 34]);
        identification.extend_from_slice(&streaminfo(48_000, 0));
        let file = ogg(&identification, 48_000 * 12, 11);
        assert_seconds(probe_duration(&file, "audio/ogg"), 12.0);
    }

    #[test]
    fn a_page_from_another_stream_is_not_this_one_s_last_page() {
        // A multiplexed file — sound and pictures in one Ogg — ends on whichever
        // stream happened to be written last. Reading that granule against this
        // stream's sample rate is the bug this separates.
        let mut file = ogg(&vorbis_id(44_100), 44_100 * 20, 7);
        file.extend_from_slice(&ogg_page_bytes(9_999_999, 8, 2, &[0u8; 16]));
        assert_seconds(probe_duration(&file, "audio/ogg"), 20.0);
    }

    #[test]
    fn theora_gets_no_answer_rather_than_frames_read_as_samples() {
        let mut identification = b"\x80theora".to_vec();
        identification.extend_from_slice(&[0u8; 32]);
        let file = ogg(&identification, 5000, 2);
        assert_eq!(probe_duration(&file, "video/ogg"), None);
    }

    // --- FLAC ---------------------------------------------------------------

    fn flac(rate: u32, samples: u64) -> Vec<u8> {
        let mut out = b"fLaC".to_vec();
        out.push(0x80);
        out.extend_from_slice(&[0, 0, 34]);
        out.extend_from_slice(&streaminfo(rate, samples));
        out
    }

    #[test]
    fn flac_says_it_outright() {
        assert_seconds(probe_duration(&flac(44_100, 44_100 * 200), "audio/flac"), 200.0);
    }

    #[test]
    fn a_flac_that_does_not_know_its_own_length_says_nothing() {
        // Zero total samples is the legal way to write a stream that was
        // encoded live, and it is not a recording of zero length.
        assert_eq!(probe_duration(&flac(44_100, 0), "audio/flac"), None);
    }

    // --- RIFF ---------------------------------------------------------------

    fn wav(byte_rate: u32, data_len: usize, odd_chunk_first: bool) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(b"fmt ");
        body.extend_from_slice(&16u32.to_le_bytes());
        body.extend_from_slice(&1u16.to_le_bytes());
        body.extend_from_slice(&2u16.to_le_bytes());
        body.extend_from_slice(&44_100u32.to_le_bytes());
        body.extend_from_slice(&byte_rate.to_le_bytes());
        body.extend_from_slice(&4u16.to_le_bytes());
        body.extend_from_slice(&16u16.to_le_bytes());
        if odd_chunk_first {
            body.extend_from_slice(b"LIST");
            body.extend_from_slice(&5u32.to_le_bytes());
            body.extend_from_slice(b"INFOx");
            // The pad byte, which the declared size does not count.
            body.push(0);
        }
        body.extend_from_slice(b"data");
        body.extend_from_slice(&(data_len as u32).to_le_bytes());
        body.extend_from_slice(&vec![0u8; data_len]);
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn a_wav_is_its_sound_over_its_byte_rate() {
        assert_seconds(probe_duration(&wav(176_400, 176_400 * 3, false), "audio/wav"), 3.0);
    }

    #[test]
    fn an_odd_length_chunk_does_not_lose_the_one_after_it() {
        // RIFF pads chunks to an even offset and does not count the pad byte in
        // the size. A walk that misses this reads everything after a metadata
        // block as garbage — which is most `.wav` files that have been through a
        // tagger at all.
        assert_seconds(probe_duration(&wav(176_400, 88_200, true), "audio/wav"), 0.5);
    }

    #[test]
    fn a_wav_with_no_byte_rate_is_not_divided_by_zero() {
        assert_eq!(probe_duration(&wav(0, 1024, false), "audio/wav"), None);
    }

    #[test]
    fn a_truncated_wav_reports_what_arrived() {
        // The `data` chunk claims more than the file holds, which is what a
        // transfer that stopped looks like. What arrived is still the length of
        // what can be played, and it is not nothing.
        let mut file = wav(176_400, 176_400, false);
        file.truncate(file.len() - 88_200);
        assert_seconds(probe_duration(&file, "audio/wav"), 0.5);
    }

    fn avi(micros_per_frame: u32, frames: u32) -> Vec<u8> {
        let mut avih = Vec::new();
        avih.extend_from_slice(&micros_per_frame.to_le_bytes());
        avih.extend_from_slice(&[0u8; 12]);
        avih.extend_from_slice(&frames.to_le_bytes());
        avih.extend_from_slice(&[0u8; 36]);
        let mut hdrl = b"hdrl".to_vec();
        hdrl.extend_from_slice(b"avih");
        hdrl.extend_from_slice(&(avih.len() as u32).to_le_bytes());
        hdrl.extend_from_slice(&avih);
        let mut body = b"LIST".to_vec();
        body.extend_from_slice(&(hdrl.len() as u32).to_le_bytes());
        body.extend_from_slice(&hdrl);
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
        out.extend_from_slice(b"AVI ");
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn an_avi_is_frames_times_the_length_of_a_frame() {
        assert_seconds(probe_duration(&avi(40_000, 250), "video/x-msvideo"), 10.0);
    }

    #[test]
    fn an_avi_with_no_frames_says_nothing() {
        assert_eq!(probe_duration(&avi(40_000, 0), "video/x-msvideo"), None);
    }

    // --- MPEG audio ---------------------------------------------------------

    /// MPEG-1 layer III, 44.1 kHz, stereo, 128 kbps — 417 bytes to the frame.
    const MP3_FRAME: usize = 417;
    /// A hundred frames, counted.
    const MP3_WALKED_SECONDS: Seconds = 100.0 * 1152.0 / 44_100.0;
    /// The same hundred frames read as bytes over the first frame's bitrate —
    /// close on a file that really is constant, and the reading that has to lose
    /// on one that is not.
    const MP3_DIVIDED_SECONDS: Seconds = (100 * MP3_FRAME) as Seconds * 8.0 / 128_000.0;
    /// What the encoder's own header claims, for a file whose bytes say
    /// otherwise.
    const MP3_DECLARED_SECONDS: Seconds = 1000.0 * 1152.0 / 44_100.0;

    fn mp3(frames: usize, xing: Option<u32>) -> Vec<u8> {
        let mut out = Vec::new();
        for i in 0..frames {
            let mut frame = vec![0xFFu8, 0xFB, 0x90, 0x00];
            frame.resize(MP3_FRAME, 0);
            if i == 0 {
                if let Some(count) = xing {
                    frame[36..40].copy_from_slice(b"Xing");
                    frame[40..44].copy_from_slice(&1u32.to_be_bytes());
                    frame[44..48].copy_from_slice(&count.to_be_bytes());
                }
            }
            out.extend_from_slice(&frame);
        }
        out
    }

    fn id3(payload: &[u8]) -> Vec<u8> {
        let mut out = b"ID3".to_vec();
        out.extend_from_slice(&[3, 0, 0]);
        let size = payload.len();
        out.extend_from_slice(&[
            ((size >> 21) & 0x7F) as u8,
            ((size >> 14) & 0x7F) as u8,
            ((size >> 7) & 0x7F) as u8,
            (size & 0x7F) as u8,
        ]);
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn a_file_with_no_vbr_header_is_counted_frame_by_frame() {
        // Not bytes over a bitrate. The two readings differ by only a quarter
        // of a percent on this fixture — which is exactly why a file whose
        // bitrate really does vary is the case that matters, and why the real
        // files this was checked against found it and a synthetic one could
        // not.
        assert!((MP3_WALKED_SECONDS - MP3_DIVIDED_SECONDS).abs() > 1e-3);
        assert_seconds(probe_duration(&mp3(100, None), "audio/mpeg"), MP3_WALKED_SECONDS);
    }

    #[test]
    fn a_walk_steps_over_junk_in_the_middle_rather_than_stopping_at_it() {
        // A file that has been through a tagger and a joiner has a block in the
        // middle that is not a frame. Stopping there reports half a recording
        // with no sign that anything was missed.
        let mut file = mp3(50, None);
        file.extend_from_slice(&[0u8; 3000]);
        file.extend_from_slice(&mp3(50, None));
        assert_seconds(probe_duration(&file, "audio/mpeg"), MP3_WALKED_SECONDS);
    }

    #[test]
    fn the_encoder_s_own_frame_count_is_believed_over_the_bytes() {
        // A Xing header saying a thousand frames in a file holding a hundred.
        // That is what a seekable VBR file looks like when only its first
        // megabyte has arrived, and the header is the better answer.
        let file = mp3(100, Some(1000));
        assert!((MP3_DECLARED_SECONDS - MP3_WALKED_SECONDS).abs() > 1.0);
        assert_seconds(probe_duration(&file, "audio/mpeg"), MP3_DECLARED_SECONDS);
    }

    #[test]
    fn an_id3_tag_is_measured_seven_bits_to_the_byte() {
        // Syncsafe: a tag length can never contain a run of bits a decoder would
        // take for a frame sync. Read as an ordinary big-endian integer, a
        // thousand-byte tag measures 1896 and the read lands inside the audio.
        assert_eq!(id3v2_end(&id3(&vec![0u8; 1000])), 1010);
    }

    #[test]
    fn a_frame_sync_inside_a_tag_is_not_the_first_frame() {
        // Album art and lyrics are arbitrary bytes, and two consecutive
        // plausible frame headers inside one are not impossible — this tag opens
        // with a pair. The tag says how long it is; that is the answer, and not
        // the first sync pattern in the file.
        let mut tag = mp3(2, None);
        tag.resize(2000, 0);
        let mut file = id3(&tag);
        file.extend_from_slice(&mp3(100, Some(1000)));
        assert_seconds(probe_duration(&file, "audio/mpeg"), MP3_DECLARED_SECONDS);
    }

    #[test]
    fn one_sync_pattern_is_not_a_frame() {
        // A sync pattern turns up in ordinary bytes about once every two
        // thousand, and a file with junk in front of the audio — no tag, just
        // junk — is common enough that this is the ordinary case rather than
        // the hostile one. Locking onto the first one costs the Xing header
        // that is 104 bytes further on, and the file reads as 2.6 seconds
        // instead of 26.
        let mut junk = vec![0xFFu8, 0xFB, 0x90, 0x00];
        junk.resize(104, 0);
        let mut file = junk;
        file.extend_from_slice(&mp3(100, Some(1000)));
        assert_seconds(probe_duration(&file, "audio/mpeg"), MP3_DECLARED_SECONDS);
    }

    #[test]
    fn an_id3v1_tag_at_the_end_is_not_sound() {
        // The commonest thing in the world to find after the last frame, and
        // the walk must neither count it nor be derailed by it.
        let mut file = mp3(100, None);
        let mut tag = b"TAG".to_vec();
        tag.resize(128, 0);
        file.extend_from_slice(&tag);
        assert_seconds(probe_duration(&file, "audio/mpeg"), MP3_WALKED_SECONDS);
    }

    #[test]
    fn a_free_format_frame_has_no_bitrate_to_divide_by() {
        // Bitrate index 0 is `free` and 15 is `bad`. Both are refusals rather
        // than a lookup into the table's first slot, which holds a zero.
        let mut file = mp3(4, None);
        for frame in 0..4 {
            file[frame * MP3_FRAME + 2] = 0x00;
        }
        assert_eq!(probe_duration(&file, "audio/mpeg"), None);
    }

    // --- what is not a film -------------------------------------------------

    #[test]
    fn a_picture_has_no_duration() {
        assert_eq!(probe_duration(b"\x89PNG\r\n\x1a\nnot really", "image/png"), None);
        assert_eq!(probe_duration(b"%PDF-1.7\n", "application/pdf"), None);
        assert_eq!(probe_duration(&wav(176_400, 1024, false), "application/octet-stream"), None);
    }

    #[test]
    fn bytes_that_are_not_the_container_they_claim_say_nothing() {
        // Every reader here is handed somebody else's file. None of these
        // panics, none of them hangs, and none of them invents a zero.
        for mime in [
            "video/mp4",
            "video/x-matroska",
            "audio/ogg",
            "audio/flac",
            "audio/wav",
            "video/x-msvideo",
            "audio/mpeg",
        ] {
            for bytes in [
                b"".as_slice(),
                b"\x00".as_slice(),
                b"RIFF".as_slice(),
                b"OggS".as_slice(),
                b"\xff\xff\xff\xff\xff\xff\xff\xff".as_slice(),
                &[0x1A, 0x45, 0xDF, 0xA3, 0xFF, 0xFF],
                &[0u8; 128],
            ] {
                assert_eq!(probe_duration(bytes, mime), None, "{mime} on {bytes:02x?}");
            }
        }
    }
}

