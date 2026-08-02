//! The `asset://` URI scheme handler.
//!
//! > **Image bytes reach the webview through a custom URI scheme, never through
//! > IPC.** Register an asynchronous URI scheme handler so
//! > `<img src="asset://...">` streams from disk with browser caching and range
//! > requests, at zero JavaScript memory cost.
//! >
//! > Base64-ing a 12 MB photograph across the IPC boundary is the obvious first
//! > thing to try and roughly the worst available option: it inflates by a
//! > third, blocks on serialisation, and pins the whole image in JS heap.
//! > — docs/ARCHITECTURE.md section 4.3
//!
//! The load-bearing word is *never*. The bytes go filesystem → webview network
//! stack → decoder, and JavaScript is not on that path at any point: no
//! `ArrayBuffer`, no data URL, no `URL.createObjectURL`, nothing for the GC to
//! hold. A board with two hundred photographs open costs the JS heap two
//! hundred `<img>` elements.
//!
//! ## What it does *not* do is stream, and it cannot (T-263)
//!
//! Tauri 2.11's asynchronous scheme responder takes a `Response<Vec<u8>>`.
//! There is no body to write into and no handle to hand back — the whole answer
//! is materialised on the heap before the webview sees a byte of it. So the
//! word "streams" above describes the *shape* of the traffic, one span after
//! another, and not the implementation, and the only thing this handler can
//! control is how big one answer is allowed to be.
//!
//! It caps it, at [`MAX_BODY`]. A range wider than that is answered **short** —
//! a 206 whose `Content-Range` states exactly the span that was actually sent,
//! which is what a media server does and what a media element already expects,
//! because it is the same shape as a connection that ended early. This matters
//! for exactly one reason: `Range: bytes=0-` is the first thing a `<video>`
//! sends, and uncapped that is an allocation the size of the file. A 400 MB
//! interview asked to play used to be 400 MB of resident memory before the
//! first frame.
//!
//! **One case is still unbounded, deliberately.** A request carrying *no*
//! `Range` header at all gets the whole file, because 206 is only a legal
//! answer to a range request and a truncated 200 is a corrupt one. Nothing in
//! the application takes that path with a large file — a media element always
//! sends a range, and an `<img>` is served a bounded variant — so what is left
//! is a hand-written `fetch` of the original of something enormous, and the
//! ceiling that would make that impossible is T-264's, not this module's.
//!
//! ## Caching, which content addressing makes free
//!
//! The name of the thing *is* the hash of the thing, so a response can be
//! declared immutable with a straight face — no revalidation, ever, for the
//! life of the cache. That is worth more than the streaming: an item that
//! scrolls back into view does not touch the disk again, and the re-raster
//! after a zoom gesture (DESIGN section 6.6) does not either.
//!
//! ## The URL is not the same on every platform
//!
//! WebView2 cannot register a real custom scheme, so Tauri maps them onto
//! `http://<scheme>.localhost/<path>` on Windows and Android while macOS and
//! Linux get `asset://localhost/<path>`. The frontend never spells either out —
//! `platform/tauri.ts` asks Tauri's own `convertFileSrc` — and this handler
//! only ever looks at the path and the query, which are the same either way.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use tauri::http::{header, Request, Response, StatusCode};

use crate::assets::{AssetStore, Variant};

/// A year, which is as long as `max-age` is allowed to mean anything. Paired
/// with `immutable` so a conditional request is never even made.
const CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

/// The most bytes one answer will put on the heap (T-263).
///
/// Four mebibytes because the number has two jobs and they pull apart: too
/// small and a film costs a request every few frames, each one a thread hop and
/// a fresh `open`; too large and the cap has not done anything. Four is about a
/// second and a half of the 20 Mbit/s a phone records at, which is comfortably
/// more than a media element reads ahead, and it is a bound a machine does not
/// notice sixteen items holding at once.
const MAX_BODY: u64 = 4 * 1024 * 1024;

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .expect("static response")
}

/// The hash is the last non-empty path segment.
///
/// Both `/<hash>` and the `/sha256/<hash>` form the ADR writes are accepted,
/// because the second reads better in a document and the first is what
/// `convertFileSrc` produces without percent-encoding a slash.
fn hash_of(path: &str) -> &str {
    path.rsplit('/').find(|s| !s.is_empty()).unwrap_or("")
}

fn variant_tag(variant: Variant) -> &'static str {
    match variant {
        Variant::Thumb => "thumb",
        Variant::Display => "display",
        Variant::Original => "original",
    }
}

fn variant_of(query: Option<&str>) -> Variant {
    let value = query.and_then(|q| {
        q.split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(k, _)| *k == "v")
            .map(|(_, v)| v)
    });
    Variant::parse(value)
}

/// The span a `bytes=` header asks for, clamped to the file.
///
/// A multi-range request names several spans, and a conformant answer to one is
/// a `multipart/byteranges` body. This takes the **first** span and answers a
/// single 206 saying so — because the alternative it replaced was to fall
/// through to the whole file, which handed a client the one thing this module
/// is not allowed to do (T-263): an allocation it chooses the size of. Chromium
/// never sends a multi-range for media, and a client that did gets bytes it
/// asked for with a `Content-Range` that does not pretend otherwise.
fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    // No range of a zero-length file is satisfiable, and every arm below
    // computes `len - 1` — which panics in a debug build, and in a release
    // build wraps to u64::MAX and only fails to be a bug by accident. Empty
    // assets are reachable: an empty file dropped in is stored, not refused.
    if len == 0 {
        return None;
    }
    let spec = value.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (from, to) = spec.split_once('-')?;
    let (start, end) = match (from.trim(), to.trim()) {
        // "bytes=-500" — the last 500 bytes.
        ("", suffix) => {
            let n: u64 = suffix.parse().ok()?;
            (len.saturating_sub(n.min(len)), len - 1)
        }
        (start, "") => (start.parse().ok()?, len - 1),
        (start, end) => (start.parse().ok()?, end.parse::<u64>().ok()?.min(len - 1)),
    };
    if start > end || start >= len {
        return None;
    }
    Some((start, end))
}

/// Answer one request. Pure but for the filesystem, so it can be driven
/// directly from a test with no Tauri application anywhere in sight.
pub fn respond(store: &AssetStore, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri();
    let sha256 = hash_of(uri.path());
    let variant = variant_of(uri.query());

    let Some(resolved) = store.resolve(sha256, variant) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let (path, mime) = (resolved.path, resolved.mime);

    // Immutable only when this is the file that was actually asked for. The
    // original standing in for a variant that has not finished building is a
    // temporary answer, and caching a temporary answer forever is how a board
    // ends up holding a 40-megapixel decode for every photograph on it for the
    // rest of the session.
    let cache_control = if resolved.exact {
        CACHE_CONTROL
    } else {
        "no-store"
    };

    // The variant is in the tag because the same asset is served at three
    // different sizes from three different URLs that differ only in a query
    // string, and a shared validator would let a cache answer one with another.
    //
    // Keyed on the *resolved* variant rather than the raw query, so two URLs
    // that mean the same thing — `?v=display`, no query at all, or one
    // carrying some unrelated parameter — share one cache entry instead of
    // downloading the same immutable bytes once each.
    let etag = format!("\"{sha256}.{}\"", variant_tag(variant));
    if resolved.exact
        && request
            .headers()
            .get(header::IF_NONE_MATCH)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v == etag)
    {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, &etag)
            .header(header::CACHE_CONTROL, CACHE_CONTROL)
            .body(Vec::new())
            .expect("static response");
    }

    let Ok(mut file) = File::open(&path) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(len) = file.metadata().map(|m| m.len()) else {
        return empty(StatusCode::INTERNAL_SERVER_ERROR);
    };

    let requested = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());

    let base = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, cache_control)
        .header(header::ETAG, &etag)
        .header(header::ACCEPT_RANGES, "bytes")
        // The webview treats this handler as a foreign origin, so without it an
        // item's photograph cannot be drawn into a canvas — which is exactly
        // what export (T-85) has to do.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");

    if let Some(spec) = requested {
        match parse_range(spec, len) {
            Some((start, requested_end)) => {
                // Short, when the span is wider than the cap, and every header
                // below describes what was *sent* rather than what was asked
                // for. A 206 shorter than the request is ordinary — it is the
                // same shape as a connection that ended early, and a media
                // element answers it by asking for the rest. An allocation the
                // client picked the size of is not ordinary.
                let end = requested_end.min(start.saturating_add(MAX_BODY - 1));
                let count = end - start + 1;
                let mut body = vec![0u8; count as usize];
                if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut body).is_err()
                {
                    return empty(StatusCode::INTERNAL_SERVER_ERROR);
                }
                return base
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                    .header(header::CONTENT_LENGTH, count)
                    .body(body)
                    .expect("range response");
            }
            // `!spec.contains(',')` used to be here, back when a multi-range
            // parsed as `None` and had to be kept out of the 416 that would
            // have been the wrong answer to it. It parses now.
            None if spec.starts_with("bytes=") => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                    .body(Vec::new())
                    .expect("static response");
            }
            None => {}
        }
    }

    let mut body = Vec::with_capacity(len as usize);
    if file.read_to_end(&mut body).is_err() {
        return empty(StatusCode::INTERNAL_SERVER_ERROR);
    }
    base.status(StatusCode::OK)
        .header(header::CONTENT_LENGTH, len)
        .body(body)
        .expect("asset response")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::AssetStore;
    use image::{DynamicImage, ImageFormat, RgbImage};

    fn fixture() -> (tempfile::TempDir, AssetStore, String) {
        let dir = tempfile::tempdir().unwrap();
        let store = AssetStore::new(dir.path().join("assets")).unwrap();
        let mut bytes = Vec::new();
        DynamicImage::ImageRgb8(RgbImage::from_pixel(24, 12, image::Rgb([10, 20, 30])))
            .write_to(&mut std::io::Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();
        let meta = store.ingest_bytes(&bytes, None).unwrap();
        (dir, store, meta.sha256)
    }

    fn get(uri: &str) -> Request<Vec<u8>> {
        Request::builder().uri(uri).body(Vec::new()).unwrap()
    }

    #[test]
    fn serves_an_asset_with_a_type_and_a_length() {
        let (_dir, store, sha) = fixture();
        let response = respond(&store, &get(&format!("asset://localhost/{sha}?v=display")));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            response.body().len().to_string()
        );
        assert!(!response.body().is_empty());
    }

    #[test]
    fn accepts_the_namespaced_path_the_adr_writes() {
        let (_dir, store, sha) = fixture();
        let response = respond(&store, &get(&format!("asset://localhost/sha256/{sha}")));
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn works_through_the_windows_http_localhost_mapping() {
        let (_dir, store, sha) = fixture();
        let response = respond(
            &store,
            &get(&format!("http://asset.localhost/{sha}?v=thumb")),
        );
        // No thumb built yet, so this is the original — the point is that the
        // handler never looked at the scheme.
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn declares_itself_immutable_because_the_name_is_the_content() {
        let (_dir, store, sha) = fixture();
        store.build_variants(&sha).unwrap();
        let response = respond(&store, &get(&format!("asset://localhost/{sha}?v=thumb")));
        assert_eq!(response.headers()[header::CACHE_CONTROL], CACHE_CONTROL);
        assert!(response.headers().contains_key(header::ETAG));
    }

    #[test]
    fn refuses_to_cache_the_original_standing_in_for_a_variant() {
        let (_dir, store, sha) = fixture();
        // Between ingest and asset:ready this is every asset on the board, and
        // the same URL is about to start answering with the downscale.
        let response = respond(&store, &get(&format!("asset://localhost/{sha}?v=display")));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }

    #[test]
    fn does_not_honour_a_validator_against_a_stand_in() {
        let (_dir, store, sha) = fixture();
        let first = respond(&store, &get(&format!("asset://localhost/{sha}?v=display")));
        let etag = first.headers()[header::ETAG].clone();

        let conditional = Request::builder()
            .uri(format!("asset://localhost/{sha}?v=display"))
            .header(header::IF_NONE_MATCH, etag)
            .body(Vec::new())
            .unwrap();
        // A 304 here would pin the full-size original in place of the variant
        // for as long as the window stays open.
        assert_eq!(respond(&store, &conditional).status(), StatusCode::OK);
    }

    #[test]
    fn answers_a_matching_validator_with_nothing_at_all() {
        let (_dir, store, sha) = fixture();
        store.build_variants(&sha).unwrap();
        let first = respond(&store, &get(&format!("asset://localhost/{sha}?v=thumb")));
        let etag = first.headers()[header::ETAG].clone();

        let conditional = Request::builder()
            .uri(format!("asset://localhost/{sha}?v=thumb"))
            .header(header::IF_NONE_MATCH, etag)
            .body(Vec::new())
            .unwrap();
        let response = respond(&store, &conditional);
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert!(response.body().is_empty());
    }

    #[test]
    fn does_not_let_one_variant_validate_another() {
        let (_dir, store, sha) = fixture();
        store.build_variants(&sha).unwrap();
        let thumb = respond(&store, &get(&format!("asset://localhost/{sha}?v=thumb")));
        let etag = thumb.headers()[header::ETAG].clone();

        let cross = Request::builder()
            .uri(format!("asset://localhost/{sha}?v=original"))
            .header(header::IF_NONE_MATCH, etag)
            .body(Vec::new())
            .unwrap();
        assert_eq!(respond(&store, &cross).status(), StatusCode::OK);
    }

    #[test]
    fn gives_two_spellings_of_the_same_request_one_cache_entry() {
        let (_dir, store, sha) = fixture();
        store.build_variants(&sha).unwrap();
        let bare = respond(&store, &get(&format!("asset://localhost/{sha}")));
        let spelled = respond(
            &store,
            &get(&format!("asset://localhost/{sha}?v=display&x=1")),
        );
        assert_eq!(
            bare.headers()[header::ETAG],
            spelled.headers()[header::ETAG]
        );
    }

    #[test]
    fn does_not_panic_on_a_range_of_an_empty_asset() {
        let dir = tempfile::tempdir().unwrap();
        let store = AssetStore::new(dir.path().join("assets")).unwrap();
        // An empty file is stored, not refused, so this is reachable.
        let sha = store.ingest_bytes(b"", None).unwrap().sha256;

        for spec in ["bytes=0-", "bytes=-5", "bytes=0-100"] {
            let request = Request::builder()
                .uri(format!("asset://localhost/{sha}?v=original"))
                .header(header::RANGE, spec)
                .body(Vec::new())
                .unwrap();
            assert_eq!(
                respond(&store, &request).status(),
                StatusCode::RANGE_NOT_SATISFIABLE,
                "{spec}"
            );
        }
    }

    #[test]
    fn serves_a_byte_range() {
        let (_dir, store, sha) = fixture();
        let whole = respond(&store, &get(&format!("asset://localhost/{sha}"))).into_body();

        let ranged = Request::builder()
            .uri(format!("asset://localhost/{sha}"))
            .header(header::RANGE, "bytes=4-11")
            .body(Vec::new())
            .unwrap();
        let response = respond(&store, &ranged);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            format!("bytes 4-11/{}", whole.len())
        );
        assert_eq!(response.body(), &whole[4..12]);
    }

    #[test]
    fn serves_a_suffix_range() {
        let (_dir, store, sha) = fixture();
        let whole = respond(&store, &get(&format!("asset://localhost/{sha}"))).into_body();

        let ranged = Request::builder()
            .uri(format!("asset://localhost/{sha}"))
            .header(header::RANGE, "bytes=-6")
            .body(Vec::new())
            .unwrap();
        let response = respond(&store, &ranged);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), &whole[whole.len() - 6..]);
    }

    #[test]
    fn refuses_a_range_that_starts_past_the_end() {
        let (_dir, store, sha) = fixture();
        let ranged = Request::builder()
            .uri(format!("asset://localhost/{sha}"))
            .header(header::RANGE, "bytes=999999-")
            .body(Vec::new())
            .unwrap();
        let response = respond(&store, &ranged);
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    }

    /// A film big enough that the cap is between its ends. Just over two
    /// `MAX_BODY`s, so a whole-file range is answered in three spans and the
    /// last one is a short remainder rather than another full chunk.
    fn long_film(store: &AssetStore) -> String {
        let mut bytes = vec![0, 0, 0, 0x18];
        bytes.extend_from_slice(b"ftypisom");
        bytes.resize(MAX_BODY as usize * 2 + 4096, 0);
        // Not zeros, or a truncated answer and a correct one look alike.
        for (i, b) in bytes.iter_mut().enumerate().skip(16) {
            *b = (i % 251) as u8;
        }
        store.ingest_bytes(&bytes, None).unwrap().sha256
    }

    #[test]
    fn caps_what_one_answer_puts_on_the_heap() {
        // AC-698, AC-699. `bytes=0-` is the first thing a <video> sends, and
        // uncapped it is an allocation the size of the file — 400 MB resident
        // before the first frame of an interview.
        let (_dir, store, _) = fixture();
        let sha = long_film(&store);
        let request = Request::builder()
            .uri(format!("asset://localhost/{sha}"))
            .header(header::RANGE, "bytes=0-")
            .body(Vec::new())
            .unwrap();
        let response = respond(&store, &request);

        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().len() as u64, MAX_BODY);
        // The headers describe what was sent, not what was asked for. A
        // Content-Range naming the whole file beside a body that is not it is
        // the one failure here that a player would report as a corrupt file.
        let total = MAX_BODY * 2 + 4096;
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            format!("bytes 0-{}/{total}", MAX_BODY - 1)
        );
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            MAX_BODY.to_string()
        );
    }

    #[test]
    fn a_capped_film_still_plays_through_to_the_end() {
        // The cap is only correct if the short answers join up. Asking for the
        // whole of what is left each time is what a player does after a
        // connection ends early, and it is the loop the cap has to survive.
        let (_dir, store, _) = fixture();
        let sha = long_film(&store);
        let total = MAX_BODY * 2 + 4096;

        let mut played: Vec<u8> = Vec::new();
        let mut answers = 0;
        while (played.len() as u64) < total {
            let request = Request::builder()
                .uri(format!("asset://localhost/{sha}"))
                .header(header::RANGE, format!("bytes={}-", played.len()))
                .body(Vec::new())
                .unwrap();
            let response = respond(&store, &request);
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert!(
                !response.body().is_empty(),
                "no progress at {}",
                played.len()
            );
            played.extend_from_slice(response.body());
            answers += 1;
            assert!(answers <= 8, "the cap is not advancing");
        }
        assert_eq!(answers, 3, "two full spans and a remainder");
        assert_eq!(played.len() as u64, total);

        // And it is the file, not three copies of the head of it.
        let mut expected = vec![0, 0, 0, 0x18];
        expected.extend_from_slice(b"ftypisom");
        expected.resize(total as usize, 0);
        for (i, b) in expected.iter_mut().enumerate().skip(16) {
            *b = (i % 251) as u8;
        }
        assert_eq!(played, expected);
    }

    #[test]
    fn a_short_range_is_answered_in_full() {
        // The cap is a ceiling, not a chunk size: a player asking for a
        // kilobyte gets a kilobyte, not four megabytes of read-ahead.
        let (_dir, store, _) = fixture();
        let sha = long_film(&store);
        let request = Request::builder()
            .uri(format!("asset://localhost/{sha}"))
            .header(header::RANGE, "bytes=1000-1999")
            .body(Vec::new())
            .unwrap();
        let response = respond(&store, &request);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().len(), 1000);
    }

    #[test]
    fn a_multi_range_takes_the_first_span_rather_than_the_whole_file() {
        // This used to fall through to a 200 carrying everything, which handed
        // a client the one thing this module must not do: an allocation it
        // chooses the size of. Two commas and a large file was the whole
        // exploit.
        let (_dir, store, _) = fixture();
        let sha = long_film(&store);
        let request = Request::builder()
            .uri(format!("asset://localhost/{sha}"))
            .header(header::RANGE, "bytes=100-199,5000-5999")
            .body(Vec::new())
            .unwrap();
        let response = respond(&store, &request);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().len(), 100);
        let total = MAX_BODY * 2 + 4096;
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            format!("bytes 100-199/{total}")
        );
    }

    /// A file that is a film as far as everything downstream is concerned: the
    /// `ftyp` box is what the sniffer reads and what a decoder reads first too.
    fn film(store: &AssetStore) -> String {
        let mut bytes = vec![0, 0, 0, 0x18];
        bytes.extend_from_slice(b"ftypisom");
        // Long enough that a range of it is a range of something.
        bytes.resize(4096, 0x11);
        store.ingest_bytes(&bytes, None).unwrap().sha256
    }

    #[test]
    fn answers_a_film_with_a_type_a_video_element_will_accept() {
        // T-262. `application/octet-stream` is not a type `<video>` declines
        // politely — it does not start, and says nothing about why.
        let (_dir, store, _) = fixture();
        let sha = film(&store);
        let response = respond(&store, &get(&format!("asset://localhost/{sha}")));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
    }

    #[test]
    fn plays_a_film_through_from_one_range_to_the_next() {
        // How a media element actually reads a file: a probe of the head, then
        // span after span to the end. What this asserts is that the spans join
        // up into the file — a handler that answered each of them with the
        // whole thing would also "work", and would send the file once per
        // request for the length of the sitting.
        let (_dir, store, _) = fixture();
        let sha = film(&store);
        let whole = respond(&store, &get(&format!("asset://localhost/{sha}"))).into_body();

        let mut played = Vec::new();
        while played.len() < whole.len() {
            let start = played.len();
            let end = (start + 1023).min(whole.len() - 1);
            let request = Request::builder()
                .uri(format!("asset://localhost/{sha}"))
                .header(header::RANGE, format!("bytes={start}-{end}"))
                .body(Vec::new())
                .unwrap();
            let response = respond(&store, &request);
            assert_eq!(
                response.status(),
                StatusCode::PARTIAL_CONTENT,
                "from {start}"
            );
            assert_eq!(response.headers()[header::CONTENT_TYPE], "video/mp4");
            played.extend_from_slice(response.body());
        }
        assert_eq!(played, whole);
    }

    #[test]
    fn lets_a_film_be_cached_because_no_variant_is_ever_coming() {
        // An image at `?v=display` is `no-store` until its downscale exists,
        // and rightly. Nothing downscales a film, so the same answer there
        // would make every range request of a 400 MB interview a fresh read.
        let (_dir, store, _) = fixture();
        let sha = film(&store);
        for variant in ["v=original", "v=display", "v=thumb"] {
            let response = respond(&store, &get(&format!("asset://localhost/{sha}?{variant}")));
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                CACHE_CONTROL,
                "{variant}"
            );
        }
    }

    #[test]
    fn is_a_plain_404_for_anything_it_does_not_hold() {
        let (_dir, store, _sha) = fixture();
        let missing = "b".repeat(64);
        let response = respond(&store, &get(&format!("asset://localhost/{missing}")));
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn refuses_a_path_pretending_to_be_a_hash() {
        let (_dir, store, _sha) = fixture();
        for hostile in ["..", "../../../etc/passwd", "", "%2e%2e"] {
            let response = respond(&store, &get(&format!("asset://localhost/{hostile}")));
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{hostile}");
            assert!(response.body().is_empty());
        }
    }
}
