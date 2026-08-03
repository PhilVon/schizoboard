//! The reading surface's side of the boundary — a page, as JSON, and a lifted
//! image as bytes.
//!
//! `document.rs` reads a page and `pages.rs` decides what it costs to keep one.
//! Neither of them can be *called*: until this module existed, `PageStore` was
//! never managed state and `Reader` was reachable only through `probe_path`
//! inside `asset_title`, so the whole of T-297 and T-299 was a reader nothing
//! could ask. This is the ask.
//!
//! ## Two roads, because a page is two very different sizes
//!
//! A page's *structure* is small — a few hundred runs with their boxes, or a
//! couple of thousand characters of plain text — and it is JSON. A scanned
//! page's *image* is around half a megabyte of JPEG and must never be JSON:
//! base64 in a string is a third bigger again, and the whole point of
//! `asset_chunk`'s raw response (ARCHITECTURE section 4.4) is that bytes cross
//! as bytes. So [`document_page`] answers what a page *is* and
//! [`document_page_image`] answers what it *looks like*, and the second is only
//! asked when the first says there is something to ask for.
//!
//! That split is why the wire types here are not `document.rs`'s types with
//! `Serialize` on them. [`WireImage`] carries a lifted image's mime, its pixel
//! box and its byte length and **not its bytes**, so there is no shape in which
//! half a megabyte of scan can accidentally end up inside a JSON value.
//!
//! `document.rs` says of `PageImage` that "what crosses to the frontend is a
//! hash". That sentence was written before Q-206, which settled that a page
//! image is derived local data that never reaches the store — so there is no
//! hash, and there was never going to be one. What crosses is bytes, on their
//! own road, and the comment there now says so.
//!
//! ## What holds the file open, and what lets it go
//!
//! [`PageStore`] holds one document open at a time, because a 51 MB scan costs
//! about 51 MB of working set to hold (`pages.rs`). That makes shutting a case
//! file a thing the frontend has to *say* — [`document_close`] — rather than
//! something Rust can infer. Nothing breaks if it is never said: the next
//! document opened evicts this one. What it costs is one file's worth of memory
//! held for as long as the board is up, which is the whole reason the call
//! exists.
//!
//! Every command here is a hash and never a path. The frontend has no business
//! knowing where the store keeps its files, and a path chosen by the renderer is
//! a path chosen by anything that reached the renderer — the argument
//! `asset_export` and both bundle commands already take.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::assets::AssetStore;
use crate::document::{FigureContent, NoText, Page, PageContent, PageImage, PageText, Reader};
use crate::pages::PageStore;

/// One page, as the reading surface sees it.
///
/// `width` and `height` are **points**, with `/Rotate` already applied, and are
/// both zero for a page of a text file — which is the honest answer rather than
/// a missing one. A text file states no page shape, so the sheet it goes on is
/// the board's decision; `text.rs`'s grid is what sizes it, and a number
/// invented on this side could only be one the reading surface then had to
/// ignore.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WirePage {
    index: u32,
    width: f32,
    height: f32,
    content: WireContent,
    /// When each cue on this page was said — see [`Page::cues`]. Empty for
    /// every page that is not a page of a transcript, which is most of them.
    cues: Vec<WireCue>,
    /// What each stretch of this page is, for a page of markdown — T-348.
    /// Empty for every other page, which is most of them.
    roles: Vec<WireRole>,
}

/// One stretch of a page, and what it is.
///
/// `start` and `end` are offsets into the page's own text in **UTF-16 code
/// units**, for `WireCue`'s reason: the only thing that ever compares one of
/// these against a position is a DOM range, and a DOM offset is an index into a
/// JavaScript string.
///
/// `role` is a word and `level` a number, rather than one tagged union, because
/// the two things that vary are independent and only two roles use the second —
/// a heading's depth and a list item's nesting. A union would give every arm a
/// payload to say it has none.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireRole {
    start: usize,
    end: usize,
    role: &'static str,
    /// One-based for a heading, zero-based for a list item, and `0` for
    /// everything else — which has no depth rather than a depth of zero.
    level: u8,
}

/// One cue's place on a page, and the moment it names in the recording.
///
/// `offset` is a byte offset into the page's own text and `at` is seconds. Two
/// numbers rather than a formatted string, because what a citation *reads* like
/// is `lib/objects.ts`'s to decide and it already decides it for the other two
/// kinds — this side states the fact and never the sentence.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireCue {
    offset: usize,
    at: f32,
}

/// What is on a page — the same five answers `PageContent` gives, tagged so the
/// frontend gets a discriminated union rather than a shape it has to guess at.
///
/// The tag is `kind` and the payload is inline, which is the shape every other
/// union crossing this boundary already takes.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WireContent {
    /// Typed text, with the boxes it was set in, and any figure big enough to
    /// have been worth lifting.
    Text {
        runs: Vec<WireRun>,
        figures: Vec<WireFigure>,
    },
    /// A page of a text file, which has runs nowhere and boxes nowhere.
    Plain { text: String },
    /// A scan: one image covering the page.
    Image { image: WireImage },
    /// Nothing on it at all.
    Empty,
    /// Something on it this build cannot read, naming what. A page that says so
    /// is the whole of AC-682 — the alternative is a blank sheet that reads as a
    /// blank page.
    Unsupported { reason: String },
}

/// A run of text and the box it was set in — points from the top left, `y`
/// downwards.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireRun {
    text: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    size: f32,
}

/// A lifted image and where on the page it sits.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFigure {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    content: WireFigureContent,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WireFigureContent {
    Image {
        image: WireImage,
    },
    /// Reported with its box rather than dropped: a blank space is worst on a
    /// page whose caption is telling you to look at it.
    Unsupported {
        reason: String,
    },
}

/// What the frontend is told about a lifted image, which is everything except
/// the image.
///
/// `bytes` is a length and not a payload. It is here so the surface can decide
/// whether to ask for something before it asks — and so a test can assert that
/// the JSON road carries a number where the byte road carries that many bytes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireImage {
    mime: &'static str,
    width: u32,
    height: u32,
    bytes: usize,
}

impl WireImage {
    fn of(image: &PageImage) -> WireImage {
        WireImage {
            mime: image.mime,
            width: image.width,
            height: image.height,
            bytes: image.bytes.len(),
        }
    }
}

/// What one page says, for the index — the other, much smaller thing a page can
/// be asked for.
///
/// Two arms against [`WireContent`]'s five, and the shortfall is the point: a
/// typed page and a page of a text file are the same answer to "what does it
/// say", and a scan, a blank page and a page this build cannot read are three
/// different answers to "why does it say nothing". The reading surface needs
/// the first distinction and not the second; a search field needs the second
/// and not the first, because "its scans are not searchable" is a sentence
/// somebody can act on and "no match" is not (T-286, D-46 section 4).
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WirePageText {
    Text { text: String },
    None { why: &'static str },
}

impl WirePageText {
    fn of(text: &PageText) -> WirePageText {
        match text {
            PageText::Text(text) => WirePageText::Text { text: text.clone() },
            PageText::None(why) => WirePageText::None {
                why: match why {
                    NoText::Scan => "scan",
                    NoText::Empty => "empty",
                    NoText::Unreadable => "unreadable",
                },
            },
        }
    }
}

impl WireRole {
    fn of(span: &crate::markdown::Span) -> WireRole {
        use crate::markdown::Role;
        let (role, level) = match span.role {
            Role::Heading(level) => ("heading", level),
            Role::Item(depth) => ("item", depth),
            Role::Quote => ("quote", 0),
            Role::Code => ("code", 0),
            Role::Emphasis => ("emphasis", 0),
            Role::Strong => ("strong", 0),
        };
        WireRole {
            start: span.start,
            end: span.end,
            role,
            level,
        }
    }
}

impl WirePage {
    fn of(page: &Page) -> WirePage {
        WirePage {
            index: page.index,
            width: page.width,
            height: page.height,
            content: WireContent::of(&page.content),
            cues: page
                .cues
                .iter()
                .map(|mark| WireCue {
                    offset: mark.offset,
                    at: mark.at,
                })
                .collect(),
            roles: page.roles.iter().map(WireRole::of).collect(),
        }
    }
}

impl WireContent {
    fn of(content: &PageContent) -> WireContent {
        match content {
            PageContent::Text { runs, figures } => WireContent::Text {
                runs: runs
                    .iter()
                    .map(|run| WireRun {
                        text: run.text.clone(),
                        x: run.x,
                        y: run.y,
                        width: run.width,
                        height: run.height,
                        size: run.size,
                    })
                    .collect(),
                figures: figures
                    .iter()
                    .map(|figure| WireFigure {
                        x: figure.x,
                        y: figure.y,
                        width: figure.width,
                        height: figure.height,
                        content: match &figure.content {
                            FigureContent::Image(image) => WireFigureContent::Image {
                                image: WireImage::of(image),
                            },
                            FigureContent::Unsupported(why) => WireFigureContent::Unsupported {
                                reason: why.clone(),
                            },
                        },
                    })
                    .collect(),
            },
            PageContent::Plain(text) => WireContent::Plain { text: text.clone() },
            PageContent::Image(image) => WireContent::Image {
                image: WireImage::of(image),
            },
            PageContent::Empty => WireContent::Empty,
            PageContent::Unsupported(why) => WireContent::Unsupported {
                reason: why.clone(),
            },
        }
    }
}

/// The lifted image a `(page, figure)` pair names, or `None` when that pair
/// names something that is not an image.
///
/// `figure` is `None` for the page's own scan and `Some(n)` for the nth figure
/// on it, which is the same pair the JSON side hands out.
fn image_of(page: &Page, figure: Option<u32>) -> Option<&PageImage> {
    match (&page.content, figure) {
        (PageContent::Image(image), None) => Some(image),
        (PageContent::Text { figures, .. }, Some(at)) => {
            match &figures.get(usize::try_from(at).ok()?)?.content {
                FigureContent::Image(image) => Some(image),
                FigureContent::Unsupported(_) => None,
            }
        }
        _ => None,
    }
}

/// How many pages, without reading one.
///
/// A structure load and no page read — 3 to 53 ms on the corpus D-47 swept, 221
/// ms on the largest file that machine held. The asset record's `pages` answers
/// this without touching the disk at all and is what the folder's thickness is
/// drawn from; this is for the case that record cannot cover, which is a
/// document counted by a machine that could not count it — an older build, or
/// one that had never held the bytes.
#[tauri::command]
pub async fn document_page_count(
    app: AppHandle,
    sha256: String,
    markdown: bool,
) -> Result<u32, String> {
    crate::blocking(move || {
        let (store, pages) = stores(&app)?;
        count_pages(&store, &pages, &sha256, markdown)
    })
    .await
}

/// [`document_page_count`] without the app.
///
/// The three functions below carry the whole of what this module decides, and
/// they are separate from their commands for one reason: a `#[tauri::command]`
/// can only be called with an `AppHandle`, so a body left inside one is a body
/// no test can reach. What T-318 claims is that a page is *reachable* and that
/// reaching one costs one page — and both of those are claims about these
/// functions, asserted in the tests below against a real store on a real
/// tempdir rather than against a double of my own making.
fn count_pages(
    store: &AssetStore,
    pages: &PageStore,
    sha256: &str,
    markdown: bool,
) -> crate::document::Result<u32> {
    let count = pages.page_count(sha256, &store.original_path(sha256), markdown)?;
    Ok(u32::try_from(count).unwrap_or(u32::MAX))
}

/// One page, by the number printed on it, one-based.
///
/// `None` means there is no such page. That is a different answer from a page
/// which turned out to be [`WireContent::Empty`], and the two must not be
/// collapsed: one is a reader asking for page 300 of a 200-page filing, and the
/// other is page 47 of it being blank.
///
/// **Costs one page, not a document.** A 200-page scan is about twelve seconds
/// of work to read through and about sixty milliseconds to read the first page
/// of, which is why this is per page and why `PageStore` holds the structure
/// open between calls.
#[tauri::command]
pub async fn document_page(
    app: AppHandle,
    sha256: String,
    index: u32,
    markdown: bool,
) -> Result<Option<WirePage>, String> {
    crate::blocking(move || {
        let (store, pages) = stores(&app)?;
        read_page(&store, &pages, &sha256, index, markdown)
    })
    .await
}

/// [`document_page`] without the app.
fn read_page(
    store: &AssetStore,
    pages: &PageStore,
    sha256: &str,
    index: u32,
    markdown: bool,
) -> crate::document::Result<Option<WirePage>> {
    Ok(pages
        .page(sha256, &store.original_path(sha256), index, markdown)?
        .map(|page| WirePage::of(&page)))
}

/// A lifted image, as a **raw response** — the bytes, not a JSON array of them.
///
/// The frontend hands these to `Blob` and never reads one. Asked only when
/// [`document_page`] has already said there is an image at this `(page,
/// figure)`, and the page it comes off is by then in `PageStore`'s cache, so
/// this is a memory copy rather than a second decode.
///
/// An empty response means that pair names no image — no such page, a page with
/// no scan on it, a figure index past the end, or a figure this build could not
/// lift. All four are the same thing to a caller that has been told what is on
/// the page and asked for something else.
#[tauri::command]
pub async fn document_page_image(
    app: AppHandle,
    sha256: String,
    index: u32,
    figure: Option<u32>,
    markdown: bool,
) -> Result<tauri::ipc::Response, String> {
    let bytes = crate::blocking(move || {
        let (store, pages) = stores(&app)?;
        read_page_image(&store, &pages, &sha256, index, figure, markdown)
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// [`document_page_image`] without the app.
fn read_page_image(
    store: &AssetStore,
    pages: &PageStore,
    sha256: &str,
    index: u32,
    figure: Option<u32>,
    markdown: bool,
) -> crate::document::Result<Vec<u8>> {
    // The reading comes through even though a markdown page has no images to
    // lift, and that is not defensive: `PageStore` is keyed on it, so asking
    // here without it would open the document a second way and evict the
    // reading the sheet is using.
    let Some(page) = pages.page(sha256, &store.original_path(sha256), index, markdown)? else {
        return Ok(Vec::new());
    };
    Ok(image_of(&page, figure)
        .map(|image| image.bytes.clone())
        .unwrap_or_default())
}

/// Every page's characters, in one answer — what the derived local index of
/// D-46 section 2 is built out of.
///
/// ## Why the whole document and not a page at a time
///
/// Asking page by page would pay the structure load again per call — unless the
/// reader were held between them, which is exactly the 51 MB [`PageStore`]
/// holds one document at a time to avoid, and that slot belongs to whoever is
/// reading. One call reads a whole file on one reader and drops it.
///
/// Measured cold on 40 real multi-page files (772 pages): 8.5 ms to open one
/// and 11.1 ms a page to take the text off, so an average case file is about
/// 215 ms and the worst on that corpus — a 100-page permit — was 4.9 seconds.
///
/// What comes back is text and never runs, which is what makes one answer
/// affordable: a page is a couple of thousand characters, so a two-hundred-page
/// filing is a few hundred kilobytes and the largest document this build will
/// open at all is a few megabytes. The runs and their boxes would be an order
/// of magnitude more, every byte of it thrown away by the caller on arrival.
/// `document::joined` says what that costs and what it does not.
///
/// ## It does not touch `PageStore`, deliberately
///
/// That slot belongs to the person reading. An index that took it would make
/// the next page turn re-open a file the reader already had open, so this opens
/// its own [`Reader`] and drops it — which costs the document's structure twice
/// over for as long as the walk runs, and is the honest price of not
/// interrupting somebody mid-page.
#[tauri::command]
pub async fn document_text(
    app: AppHandle,
    sha256: String,
    markdown: bool,
) -> Result<Vec<WirePageText>, String> {
    crate::blocking(move || {
        let store = app.try_state::<AssetStore>().ok_or_else(|| {
            crate::document::Error::Malformed("the asset store failed to open".into())
        })?;
        read_text(&store, &sha256, markdown)
    })
    .await
}

/// [`document_text`] without the app.
fn read_text(
    store: &AssetStore,
    sha256: &str,
    markdown: bool,
) -> crate::document::Result<Vec<WirePageText>> {
    // The search index reads the same words the sheet shows, which is what
    // stops `Ctrl+F` matching on an asterisk nobody can see (T-347).
    let reader = Reader::open(&store.original_path(sha256), markdown)?;
    Ok(reader.read_text().iter().map(WirePageText::of).collect())
}

/// The folder has been shut. Let the file go.
///
/// The pages stay cached — they are bounded, small, and still true, so opening
/// the same folder again does not re-do the work. It is the document-sized
/// allocation this gives back, and on a 51 MB scan that is 51 MB.
///
/// Deliberately not an error when nothing is open, and deliberately a no-op when
/// the open document is a different one: the frontend says which folder it shut,
/// and a race where two folders were opened in quick succession must not have
/// the loser's close land on the winner's file.
#[tauri::command]
pub async fn document_close(app: AppHandle, sha256: String) -> Result<(), String> {
    let pages = app
        .try_state::<PageStore>()
        .ok_or_else(|| "the page store failed to open".to_string())?;
    pages.close(&sha256);
    Ok(())
}

/// The two pieces of state every command here needs.
///
/// Reported as a `Malformed` rather than as its own error kind because the
/// frontend does one thing with every failure on this road: the page does not
/// arrive and the surface says so. A state that failed to register is a bug in
/// this process, not a fact about the document, and it cannot happen after
/// `setup` has run.
fn stores(
    app: &AppHandle,
) -> crate::document::Result<(tauri::State<'_, AssetStore>, tauri::State<'_, PageStore>)> {
    let store = app.try_state::<AssetStore>().ok_or_else(|| {
        crate::document::Error::Malformed("the asset store failed to open".into())
    })?;
    let pages = app
        .try_state::<PageStore>()
        .ok_or_else(|| crate::document::Error::Malformed("the page store failed to open".into()))?;
    Ok((store, pages))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{Figure, TextRun};

    fn scan(bytes: &[u8]) -> PageImage {
        PageImage {
            bytes: bytes.to_vec(),
            mime: "image/jpeg",
            width: 1240,
            height: 1754,
        }
    }

    fn page(content: PageContent) -> Page {
        Page {
            index: 1,
            roles: Vec::new(),
            width: 595.0,
            height: 842.0,
            content,
            cues: Vec::new(),
        }
    }

    /// The guarantee the whole two-road split exists for. A scanned page is
    /// around half a megabyte, and the one way it could quietly become JSON is
    /// somebody deriving `Serialize` on `PageImage` — so this asserts the
    /// absence rather than trusting the derive list.
    #[test]
    fn a_lifted_image_crosses_as_a_length_and_never_as_bytes() {
        let page = page(PageContent::Image(scan(&[0xff, 0xd8, 0xff, 0xe0, 0x00])));
        let json = serde_json::to_string(&WirePage::of(&page)).expect("serialise");

        assert!(json.contains(r#""bytes":5"#), "{json}");
        // The five bytes above, in every encoding a serialiser could reach for.
        assert!(!json.contains("255"), "{json}");
        assert!(!json.contains("/9j/"), "{json}");
        assert!(!json.contains(r#""bytes":["#), "{json}");
    }

    /// The tag the frontend's discriminated union switches on. A rename here is
    /// a silent break there — the TypeScript would still compile and every page
    /// would fall through to the default arm.
    #[test]
    fn every_content_is_tagged_by_the_name_the_frontend_switches_on() {
        let kinds = [
            (
                PageContent::Text {
                    runs: Vec::new(),
                    figures: Vec::new(),
                },
                "text",
            ),
            (PageContent::Plain("memo".into()), "plain"),
            (PageContent::Image(scan(&[1])), "image"),
            (PageContent::Empty, "empty"),
            (PageContent::Unsupported("JBIG2".into()), "unsupported"),
        ];

        for (content, kind) in kinds {
            let json = serde_json::to_string(&WirePage::of(&page(content))).expect("serialise");
            assert!(json.contains(&format!(r#""kind":"{kind}""#)), "{json}");
        }
    }

    #[test]
    fn a_text_page_carries_its_runs_with_their_boxes() {
        let page = page(PageContent::Text {
            runs: vec![TextRun {
                text: "IN THE MATTER OF".into(),
                x: 72.0,
                y: 96.0,
                width: 180.5,
                height: 12.0,
                size: 11.0,
            }],
            figures: Vec::new(),
        });

        let json = serde_json::to_value(WirePage::of(&page)).expect("serialise");
        let run = &json["content"]["runs"][0];
        assert_eq!(run["text"], "IN THE MATTER OF");
        assert_eq!(run["x"], 72.0);
        assert_eq!(run["size"], 11.0);
        assert_eq!(json["width"], 595.0);
    }

    /// A text file states no page shape, so both are zero — and the reading
    /// surface has to be able to tell that apart from a PDF that does.
    #[test]
    fn a_page_of_a_text_file_carries_its_text_and_no_box() {
        let page = Page {
            index: 3,
            roles: Vec::new(),
            width: 0.0,
            height: 0.0,
            content: PageContent::Plain("the fourth witness\n".into()),
            cues: Vec::new(),
        };

        let json = serde_json::to_value(WirePage::of(&page)).expect("serialise");
        assert_eq!(json["content"]["text"], "the fourth witness\n");
        assert_eq!(json["index"], 3);
        assert_eq!(json["width"], 0.0);
        assert_eq!(json["height"], 0.0);
    }

    #[test]
    fn a_figure_that_could_not_be_lifted_reports_with_its_box() {
        let page = page(PageContent::Text {
            runs: Vec::new(),
            figures: vec![Figure {
                x: 100.0,
                y: 200.0,
                width: 300.0,
                height: 400.0,
                content: FigureContent::Unsupported("JPX".into()),
            }],
        });

        let json = serde_json::to_value(WirePage::of(&page)).expect("serialise");
        let figure = &json["content"]["figures"][0];
        assert_eq!(figure["content"]["kind"], "unsupported");
        assert_eq!(figure["content"]["reason"], "JPX");
        assert_eq!(figure["width"], 300.0);
    }

    #[test]
    fn the_pair_that_names_an_image_is_the_pair_the_json_handed_out() {
        let scanned = page(PageContent::Image(scan(&[7, 7, 7])));
        assert_eq!(image_of(&scanned, None).map(|i| i.bytes.len()), Some(3));
        // A scan is the page, so there is no figure zero on it to ask for.
        assert!(image_of(&scanned, Some(0)).is_none());

        let illustrated = page(PageContent::Text {
            runs: Vec::new(),
            figures: vec![
                Figure {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0,
                    content: FigureContent::Unsupported("CCITTFax".into()),
                },
                Figure {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0,
                    content: FigureContent::Image(scan(&[1, 2])),
                },
            ],
        });
        assert!(image_of(&illustrated, None).is_none());
        assert!(image_of(&illustrated, Some(0)).is_none());
        assert_eq!(
            image_of(&illustrated, Some(1)).map(|i| i.bytes.len()),
            Some(2)
        );
        assert!(image_of(&illustrated, Some(2)).is_none());
    }

    #[test]
    fn a_page_with_nothing_on_it_says_so_rather_than_carrying_an_empty_string() {
        // AC-682's whole subject. `Empty` and `Plain("")` would draw the same
        // blank sheet, and only one of them is allowed to.
        let json = serde_json::to_value(WirePage::of(&page(PageContent::Empty))).expect("json");
        assert_eq!(json["content"]["kind"], "empty");
        assert!(json["content"]["text"].is_null());
    }

    // --- the road from a hash to a page, on a real store ------------------
    //
    // Everything above this line tests a conversion. These test the claim the
    // task is actually about, which is that a page can be *reached* at all:
    // a document goes into a real `AssetStore` on a real tempdir and comes back
    // out a page at a time through the same functions the commands call.

    fn stores_on_disk() -> (tempfile::TempDir, AssetStore, PageStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = AssetStore::new(dir.path().join("assets")).expect("store");
        (dir, store, PageStore::default())
    }

    /// Long enough to be several pages of the 66x46 grid, and written so that
    /// which page a line landed on is visible in the assertion.
    fn filing() -> Vec<u8> {
        let mut text = String::new();
        for line in 0..200 {
            text.push_str(&format!(
                "line {line} of the witness statement
"
            ));
        }
        text.into_bytes()
    }

    fn files_under(dir: &std::path::Path) -> usize {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return 0;
        };
        entries
            .flatten()
            .map(|entry| {
                if entry.path().is_dir() {
                    files_under(&entry.path())
                } else {
                    1
                }
            })
            .sum()
    }

    #[test]
    fn a_page_is_reachable_from_the_hash_the_board_holds() {
        let (_dir, store, pages) = stores_on_disk();
        let meta = store.ingest_bytes(&filing(), None).expect("ingest");

        let page = read_page(&store, &pages, &meta.sha256, 1, false)
            .expect("read")
            .expect("a first page");

        assert_eq!(page.index, 1);
        match page.content {
            WireContent::Plain { text } => assert!(text.starts_with("line 0 of"), "{text}"),
            other => panic!("a text file is a plain page, not {other:?}"),
        }
    }

    /// AC-793, asserted at the boundary rather than inside `pages.rs`. A 200-page
    /// scan is about twelve seconds of work to read through and sixty
    /// milliseconds to read the first page of, so a command that quietly called
    /// `read_all` would be correct and unusable.
    #[test]
    fn reading_one_page_of_a_long_document_reads_one_page() {
        let (_dir, store, pages) = stores_on_disk();
        let meta = store.ingest_bytes(&filing(), None).expect("ingest");

        let count = count_pages(&store, &pages, &meta.sha256, false).expect("count");
        assert!(
            count > 2,
            "the fixture is meant to be several pages, got {count}"
        );
        // Counting comes off the structure and must not have read anything.
        assert_eq!(pages.pages_produced(), 0);

        read_page(&store, &pages, &meta.sha256, 1, false).expect("read");
        assert_eq!(pages.pages_produced(), 1);

        read_page(&store, &pages, &meta.sha256, 2, false).expect("read");
        assert_eq!(pages.pages_produced(), 2);

        // And a page already produced is not produced again.
        read_page(&store, &pages, &meta.sha256, 1, false).expect("read");
        assert_eq!(pages.pages_produced(), 2);
    }

    /// AC-794. The guarantee is `pages.rs`'s by construction — there is no code
    /// path from here to the store's writer — and this is the assertion that
    /// says so from outside, where a future command that decided to cache a
    /// lifted page as an asset would be caught.
    #[test]
    fn reading_every_page_leaves_the_store_holding_exactly_what_it_held() {
        let (dir, store, pages) = stores_on_disk();
        let meta = store.ingest_bytes(&filing(), None).expect("ingest");
        let root = dir.path().join("assets");
        let before = files_under(&root);

        let count = count_pages(&store, &pages, &meta.sha256, false).expect("count");
        for index in 1..=count {
            read_page(&store, &pages, &meta.sha256, index, false).expect("read");
        }

        assert_eq!(files_under(&root), before);
    }

    /// AC-795. What `close` gives back is the document-sized allocation and not
    /// the pages, and the two halves are asserted separately because collapsing
    /// them is the tempting simplification.
    #[test]
    fn shutting_a_case_file_lets_the_file_go_and_keeps_the_pages() {
        let (_dir, store, pages) = stores_on_disk();
        let meta = store.ingest_bytes(&filing(), None).expect("ingest");
        read_page(&store, &pages, &meta.sha256, 1, false).expect("read");

        let cached = pages.cached_bytes();
        assert!(cached > 0);

        pages.close(&meta.sha256);
        assert_eq!(pages.pages_produced(), 0, "the file is no longer open");
        assert_eq!(pages.cached_bytes(), cached, "the pages are still here");

        // And the page comes back without re-opening the document.
        read_page(&store, &pages, &meta.sha256, 1, false).expect("read");
        assert_eq!(pages.pages_produced(), 0, "a cache hit reopens nothing");
    }

    // --- T-280: the whole document's text, on the same real store ---------

    #[test]
    fn the_text_of_every_page_is_reachable_from_the_hash_the_board_holds() {
        let (_dir, store, _pages) = stores_on_disk();
        let meta = store.ingest_bytes(&filing(), None).expect("ingest");

        let text = read_text(&store, &meta.sha256, false).expect("text");
        assert!(text.len() > 2, "the fixture is several pages");

        // Index-aligned, and the alignment is the whole of what a citation
        // stands on: element 0 is page 1, which is the number `document_page`
        // takes and the number printed on the sheet.
        let joined: Vec<String> = text
            .iter()
            .map(|page| match page {
                WirePageText::Text { text } => text.clone(),
                WirePageText::None { why } => panic!("a text file has no {why} pages"),
            })
            .collect();
        assert!(joined[0].starts_with("line 0 of"), "{}", joined[0]);
        assert!(
            joined[1].starts_with("line 46 of"),
            "the second page picks up where the first stopped: {}",
            joined[1]
        );

        // Every line of the fixture is somewhere, so nothing was dropped
        // between the pages.
        let all = joined.concat();
        for line in 0..200 {
            assert!(
                all.contains(&format!("line {line} of the witness statement")),
                "line {line} went missing"
            );
        }
    }

    #[test]
    fn reading_a_documents_text_does_not_take_the_slot_the_reader_is_holding() {
        // The one thing this command must not do. `PageStore` holds one file
        // open and that slot belongs to whoever is turning pages; an index that
        // took it would make the next turn re-open a document the reader
        // already had.
        //
        // True by construction today — `read_text` is not given a `PageStore`
        // and so cannot reach one — and this is the assertion from outside that
        // says so, on the same footing as
        // `reading_every_page_leaves_the_store_holding_exactly_what_it_held`. It
        // does not discriminate against anything that exists; it catches the
        // future change that threads the store in for the convenience of one
        // cached page.
        let (_dir, store, pages) = stores_on_disk();
        let meta = store.ingest_bytes(&filing(), None).expect("ingest");

        read_page(&store, &pages, &meta.sha256, 1, false).expect("read");
        assert_eq!(pages.pages_produced(), 1);

        read_text(&store, &meta.sha256, false).expect("text");

        // Still open, still holding its page, and the next turn is a cache hit.
        assert_eq!(pages.pages_produced(), 1, "the index went nowhere near it");
        read_page(&store, &pages, &meta.sha256, 1, false).expect("read");
        assert_eq!(pages.pages_produced(), 1);
    }

    #[test]
    fn reading_a_documents_text_leaves_the_store_holding_exactly_what_it_held() {
        // The same claim `pages.rs` makes about a page and for the same reason:
        // there is no hash for an index entry, so nothing can reference it,
        // nothing can collect it, and no `WANT` can be sent for it.
        let (dir, store, _pages) = stores_on_disk();
        let meta = store.ingest_bytes(&filing(), None).expect("ingest");
        let root = dir.path().join("assets");
        let before = files_under(&root);

        read_text(&store, &meta.sha256, false).expect("text");

        assert_eq!(files_under(&root), before);
    }

    #[test]
    fn a_hash_the_store_does_not_hold_is_an_error_rather_than_an_empty_document() {
        let (_dir, store, _pages) = stores_on_disk();
        // Silence would read as a case file that says nothing, which is a
        // sentence about the document. This is a sentence about the machine.
        assert!(read_text(&store, &"f".repeat(64), false).is_err());
    }

    #[test]
    fn a_page_past_the_end_is_no_page_rather_than_an_empty_one() {
        let (_dir, store, pages) = stores_on_disk();
        let meta = store.ingest_bytes(&filing(), None).expect("ingest");

        assert!(read_page(&store, &pages, &meta.sha256, 9_999, false)
            .expect("read")
            .is_none());
        // Nor is a page zero: the reference is one-based, and off-by-one here
        // would be off-by-one in every citation.
        assert!(read_page(&store, &pages, &meta.sha256, 0, false)
            .expect("read")
            .is_none());
    }

    #[test]
    fn a_page_with_no_image_on_it_hands_back_nothing_rather_than_failing() {
        let (_dir, store, pages) = stores_on_disk();
        let meta = store.ingest_bytes(&filing(), None).expect("ingest");

        assert!(read_page_image(&store, &pages, &meta.sha256, 1, None, false)
            .expect("image")
            .is_empty());
        assert!(read_page_image(&store, &pages, &meta.sha256, 1, Some(0), false)
            .expect("image")
            .is_empty());
        assert!(read_page_image(&store, &pages, &meta.sha256, 9_999, None, false)
            .expect("image")
            .is_empty());
    }

    /// The count this hands out and the count the ingest gate wrote into the
    /// asset record have to be the same number, or the folder's thickness and
    /// its last page disagree.
    #[test]
    fn the_count_is_the_one_the_pagination_rule_gives() {
        let (_dir, store, pages) = stores_on_disk();
        let bytes = filing();
        let meta = store.ingest_bytes(&bytes, None).expect("ingest");

        let text = crate::text::decode(&bytes).expect("decodes");
        assert_eq!(
            count_pages(&store, &pages, &meta.sha256, false).expect("count") as usize,
            crate::text::page_count(&text)
        );
    }

    /// A one-page PDF, written with lopdf's own writer rather than checked in
    /// as bytes — document.rs's fixtures make the argument and it holds here:
    /// a checked-in PDF is a fixture nobody can read the diff of.
    fn one_page_pdf() -> Vec<u8> {
        use lopdf::content::{Content, Operation};
        use lopdf::{dictionary, Document, Object, Stream};

        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Courier",
        });
        let resources = doc.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                Operation::new("Tj", vec![Object::string_literal("EXHIBIT A")]),
                Operation::new("ET", vec![]),
            ],
        };
        let content_id = doc.add_object(Stream::new(
            dictionary! {},
            content.encode().expect("encode the content stream"),
        ));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "Resources" => resources,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);

        let mut out = Vec::new();
        doc.save_to(&mut out).expect("write the fixture");
        out
    }

    /// The other half of AC-792. Both kinds of document go in as bytes and come
    /// back as a page through the same call — which is the whole reason the
    /// frontend gets a tagged union rather than two commands: what a document is
    /// made of is a fact about the bytes, and the reading surface finds out by
    /// being told rather than by asking first.
    #[test]
    fn a_pdf_page_comes_back_through_the_same_call_a_text_page_does() {
        let (_dir, store, pages) = stores_on_disk();
        let meta = store.ingest_bytes(&one_page_pdf(), None).expect("ingest");
        assert_eq!(meta.mime, "application/pdf");

        assert_eq!(count_pages(&store, &pages, &meta.sha256, false).expect("count"), 1);

        let page = read_page(&store, &pages, &meta.sha256, 1, false)
            .expect("read")
            .expect("a first page");

        // The page states its own shape, where a text file states none.
        assert_eq!((page.width, page.height), (595.0, 842.0));
        match page.content {
            WireContent::Text { runs, .. } => {
                assert_eq!(runs.len(), 1);
                assert_eq!(runs[0].text, "EXHIBIT A");
                // Points from the TOP left, y downwards: the run was set at
                // y=720 from the bottom of an 842-point page, and 842 - 720 is
                // the baseline, less the ascent of 12-point Courier.
                assert_eq!(runs[0].x, 72.0);
                assert!(runs[0].y > 100.0 && runs[0].y < 125.0, "{}", runs[0].y);
                assert_eq!(runs[0].size, 12.0);
            }
            other => panic!("a typed page is text, not {other:?}"),
        }
    }
}
