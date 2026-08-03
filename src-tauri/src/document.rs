//! Reading a document — its pages, what each one turns out to be, and where the
//! text on it sits.
//!
//! > No page renderer, no facsimile, no invisible text layer: Rust extracts the
//! > text and the frontend sets it in the board's own hand, on the board's own
//! > stock. [...] The known cost is a scan, which has no text to set [...] the
//! > page image is lifted onto our paper. [...] The decision is **per page, not
//! > per document**. — D-46 section 4
//!
//! Everything in here is that paragraph. Rust says *pages, what is on them, and
//! where* — ARCHITECTURE section 4.1's bytes half — and says nothing at all
//! about what a page means, whether two runs are one paragraph, or which run is
//! a heading. That is the frontend's, and putting any of it here would be
//! putting the board's typography in the language that cannot see the board.
//!
//! ## What a page comes back as
//!
//! One of four things, decided per page:
//!
//! - **Text**, as [`TextRun`]s with their boxes. Not one string: the reading
//!   surface sets the runs onto our own paper, and a quote cites one. A text
//!   page also carries its [`Figure`]s — the charts, photographs and exhibits
//!   drawn among the lines (Q-203). Dropping those was the first shape of this
//!   module, and it handed the reader a caption over a blank space.
//! - **Image**, when the page is a scan — a page-sized image and no text. The
//!   bytes come out of here; hashing them into the store is T-299's, which is
//!   also where two hundred of them stop being free.
//! - **Empty**, when the page yields neither.
//! - **Unsupported**, when it yields an image this build cannot decode. That
//!   variant exists because collapsing it into `Empty` is precisely how AC-682
//!   — "a page that yields neither text nor an image is empty and *says so*" —
//!   becomes a lie. Court scanners emit bilevel fax, we have no decoder for it,
//!   and a filing reading as a stack of blank sheets is the worst possible way
//!   to find that out.
//!
//! ## Two things that are deliberately not lopdf's way of doing it
//!
//! **`Document::get_page_images` is not called.** It looked like AC-683 and is
//! not. It indexes `array[0]` on a `/ColorSpace` array without first checking
//! the array is non-empty, so a malformed colour space panics inside the crate
//! — and this binary is `panic = "abort"` in release, so no `catch_unwind` at
//! this boundary could save the window. The stronger reason is that it reports
//! an image's own pixel dimensions and nothing whatever about *where on the
//! page it is drawn*: a page whose only image is a letterhead logo would lift
//! as a scan and get laid across the whole sheet. So the XObjects are read from
//! the page's resources here, and placed.
//!
//! **Invisible text is not collected.** Text render modes 3 and 7 draw nothing,
//! which in practice means somebody else's OCR layer sitting under a scan.
//! Taking it would put words on our paper that are not on the page, and — worse
//! — would make the page report as text, so the scan the user actually needs to
//! see would never be lifted. D-46 section 6 refuses OCR; this is the same
//! refusal arriving through a file instead of through a model.
//!
//! ## The bounds
//!
//! Every limit in here exists because the file was written by someone else. The
//! page count, the decompressed size of a content stream, the sample count of
//! an image and the number of runs on a page are all capped, and a document
//! that exceeds one is refused rather than trimmed silently.

use std::collections::HashMap;
use std::path::Path;

use lopdf::content::Content;
use lopdf::{Dictionary, Document, Encoding, LoadOptions, Object, ObjectId, Stream};

/// Pages this build will read from one document.
///
/// D-46's own worked example is a two hundred page scan, so this is an order of
/// magnitude above the case the feature was designed around and exists only so
/// that a page tree claiming to be endless is refused before it is walked.
const MAX_PAGES: usize = 4096;

/// Decompressed content stream bytes allowed per page.
///
/// Handed to lopdf's bounded reader rather than its unbounded one — the whole
/// reason `get_page_content_with_limit` exists is a file somebody else wrote.
const MAX_PAGE_CONTENT_BYTES: usize = 16 * 1024 * 1024;

/// Decompressed bytes allowed while loading the file's own structure — object
/// streams and cross-reference streams, before a single page is looked at.
const MAX_STRUCTURE_BYTES: usize = 64 * 1024 * 1024;

/// Decompressed sample bytes allowed for one lifted page image.
///
/// A 300 dpi A4 page in 24-bit colour is about 26 MB of samples, so this is
/// roughly five such pages' worth for one image — enough for an oversized
/// exhibit scanned at 600 dpi, and far short of what a bomb wants.
const MAX_IMAGE_SAMPLE_BYTES: usize = 128 * 1024 * 1024;

/// Text runs allowed on one page. A dense legal page is a few hundred.
const MAX_RUNS_PER_PAGE: usize = 50_000;

/// Bytes of a `ToUnicode` CMap stream that will be decompressed to decode one
/// font's text.
const MAX_CMAP_BYTES: usize = 4 * 1024 * 1024;

/// Form XObjects this walk will descend through.
///
/// Real files nest one or two deep — a page whose whole content is one form is
/// ordinary. Anything deeper is either generated or hostile, and either way the
/// text below it is not worth an unbounded stack.
const MAX_FORM_DEPTH: u8 = 4;

/// How much of the page an image must cover to be read as *the page*, rather
/// than as something drawn on it.
///
/// This is the whole scan-versus-letterhead question, and it is a fraction
/// rather than a rule about counts because a scan is one image the size of the
/// sheet and a logo is not, whatever else is on the page.
const SCAN_COVERAGE: f32 = 0.5;

/// How much of the page an image must cover to be lifted as a *figure* on a
/// page that also has text — a chart, a photograph, an exhibit.
///
/// Q-203 settled that a text page carries its figures rather than dropping
/// them, and this is the line under that. Carrying every placed image would
/// lift the letterhead logo on all two hundred pages of a report: two hundred
/// re-encodes of a thing nobody wants to see twice, and T-299's whole subject
/// is what that costs. Two percent of a sheet of A4 is about 110 by 90 points
/// — comfortably above a logo or a rule, comfortably below anything a caption
/// would ask you to look at.
///
/// It is a judgement, and it is deliberately on this side of the line: what is
/// worth *storing* is a question about bytes. What a figure means is not, and
/// stays the frontend's.
const FIGURE_COVERAGE: f32 = 0.02;

/// Figures lifted from one page, ceiling.
const MAX_FIGURES_PER_PAGE: usize = 64;

/// A glyph width, per mille, for a font that declares none.
///
/// Fonts other than the standard fourteen are required to carry `/Widths`, and
/// most producers write them even for those, so this is the rare path. When it
/// is taken a run's box is the right shape in the wrong width, which costs a
/// rectangle selection at the edge of a line and nothing else.
const FALLBACK_WIDTH: f32 = 500.0;

/// A fixed-pitch font has exactly one width, so the one member of the standard
/// fourteen whose metrics can be honestly guessed is guessed.
const COURIER_WIDTH: f32 = 600.0;

/// Where the top and bottom of a run go when the font descriptor says nothing.
const FALLBACK_ASCENT: f32 = 800.0;
const FALLBACK_DESCENT: f32 = -200.0;

/// A document, as far as this side of the line can see it.
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    pub pages: Vec<Page>,
}

/// One page.
///
/// `width` and `height` are points, after `/Rotate` — that is, the shape the
/// page is meant to be looked at in, which is the only shape the reading
/// surface has any use for.
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    /// One-based, and the page's identity. A PDF has real page numbers, which
    /// is what makes it the easy half of T-298.
    pub index: u32,
    pub width: f32,
    pub height: f32,
    pub content: PageContent,
    /// When each cue on this page was said, for a page of a transcript — T-287,
    /// Q-301. Empty for every other kind of page, which is most of them.
    ///
    /// **Beside the content rather than inside it**, and that is a claim about
    /// what a transcript is. On paper it is plain text: the same hand, the same
    /// measure, the same grid, cut the same way — so a variant of its own would
    /// have every reader of a page asking a question none of them has any use
    /// for, and the ones that ask by comparison rather than by match would
    /// quietly stop recognising a transcript at all. What is *not* plain about
    /// it is where it came from, and where a page came from is already the kind
    /// of fact that lives out here beside `index`.
    ///
    /// Offsets are into this page's own text, not into the file: a page is what
    /// crossed, and an offset into something the far side never received is not
    /// a fact it can use.
    pub cues: Vec<crate::cues::Mark>,
    /// What each stretch of this page's text is, for a page of markdown —
    /// T-346. Empty for every other page, which is nearly all of them.
    ///
    /// Beside the content for `cues`' reason, and in this page's own offsets
    /// for the same one. Spans are **clipped** to the page: a heading or a
    /// block quote can straddle a page boundary, and half of one drawn as
    /// ordinary prose is worse than either whole answer.
    pub roles: Vec<crate::markdown::Span>,
}

/// What a page turned out to be. See the module header for why `Unsupported` is
/// not folded into `Empty`.
#[derive(Debug, Clone, PartialEq)]
pub enum PageContent {
    /// A page that is meant to be read: its text, and whatever is drawn on it
    /// that is big enough to be worth looking at (Q-203).
    Text {
        runs: Vec<TextRun>,
        figures: Vec<Figure>,
    },
    /// A page of a document that had no layout to report — one page's worth of
    /// a text file, cut where [`crate::text`] said to cut it.
    ///
    /// A separate variant rather than one `TextRun` covering the page, and the
    /// difference is the whole of ARCHITECTURE section 4.2. A run carries a box
    /// in points because a PDF *states* where its text sits; a text file states
    /// nothing, and manufacturing a box here would be this side of the line
    /// inventing a layout and then handing it over as if it had been measured.
    /// What is known is the characters and the order they come in, so that is
    /// what crosses.
    Plain(String),
    Image(PageImage),
    Empty,
    /// There is something on this page and this build cannot read it. Carries
    /// what it was, in words meant to reach a person: it ends up under a page
    /// the user can see is not blank.
    Unsupported(String),
}

/// One show-text operation's worth of text, and the box it occupies.
///
/// Coordinates are points from the **top left** of the page, y downwards, with
/// `/Rotate` already applied — not PDF's bottom-left, y-up user space. Doing
/// the flip here means the reading surface never does it, and more to the point
/// never does it twice.
#[derive(Debug, Clone, PartialEq)]
pub struct TextRun {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    /// The font size after every matrix on the way here, in points. The reading
    /// surface reads relative sizes off this to tell a heading from a footnote;
    /// it is not being asked to reproduce the point size.
    pub size: f32,
}

/// Something drawn on a page that is also text: a chart, a photograph, an
/// exhibit. Its box is in the same coordinates as a [`TextRun`]'s, so the
/// reading surface can set it where it belongs among the lines.
#[derive(Debug, Clone, PartialEq)]
pub struct Figure {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub content: FigureContent,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FigureContent {
    Image(PageImage),
    /// This build could not lift it. Reported with its box rather than
    /// dropped, for the reason `PageContent::Unsupported` exists: a blank
    /// space is worst on a page whose caption is telling you to look at it.
    Unsupported(String),
}

/// A scanned page, lifted.
///
/// Deliberately not `Serialize`, and the reason changed under it. It was once
/// that what crossed to the frontend would be a hash; Q-206 then settled that a
/// page image is derived local data which never reaches the store, so there is
/// no hash and there was never going to be one. The reason it stays un-derivable
/// is now the simpler one: half a megabyte of JPEG must not be able to end up
/// inside a JSON value. `reading.rs` sends it as bytes on a road of its own, and
/// sends this record's shape without its payload.
#[derive(Debug, Clone, PartialEq)]
pub struct PageImage {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
}

/// One page's characters, and nothing that is looked at.
///
/// The other half of a page — its figures, its lifted scan, its box in points —
/// is [`PageContent`]'s and is what the reading surface asks for. This is what
/// the derived local index of D-46 section 2 asks for, and the difference is
/// most of what makes an index affordable: see [`Reader::read_text`].
///
/// A typed page and a page of a text file are one arm, deliberately. They are
/// two very different things to *draw* and the same thing to *search*, and this
/// is the searching side.
#[derive(Debug, Clone, PartialEq)]
pub enum PageText {
    /// What the page says.
    Text(String),
    /// Nothing to read here, and which of the three reasons it is — because
    /// they are not the same sentence to somebody whose search just missed.
    None(NoText),
}

/// Why a page has no characters on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoText {
    /// A picture covering the page. There is no OCR (D-46 section 6), so a scan
    /// is permanently unsearchable and the search field is expected to say so
    /// rather than let a silent miss read as a board that failed to find
    /// something (T-286).
    Scan,
    /// Genuinely blank.
    Empty,
    /// There is something on it and this build cannot read it — the same 6% of
    /// real files D-47 measured, one page at a time.
    Unreadable,
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    /// lopdf could not make a document of it.
    Malformed(String),
    /// The file wants a password. Nothing here will guess at one.
    Encrypted,
    /// A bound in this module was exceeded. Carries which, because "too big" on
    /// its own is not something anyone can act on.
    TooLarge(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Malformed(why) => write!(f, "could not read the document: {why}"),
            Error::Encrypted => write!(f, "the document is password protected"),
            Error::TooLarge(what) => write!(f, "{what}"),
        }
    }
}

impl std::error::Error for Error {}

/// A document held open, so that one page can be read without reading the rest.
///
/// **This is the shape T-299 measured its way to and it is not a convenience.**
/// A real hundred-page scan on the machine this was written on takes 5,860 ms
/// to read every page and 57 ms to read page one; a two-hundred-page filing is
/// therefore about twelve seconds of work to open, and about sixty milliseconds
/// to read the first page of. Reading a document is not one slow operation, it
/// is a hundred operations of which the reader wants one.
///
/// The split falls where the cost does. Loading the file's structure — the
/// cross-reference table and the page tree — is roughly independent of page
/// count and cheap: 3 to 25 ms typically, 53 ms for that 51 MB scan, 221 ms for
/// the largest file on the machine. Per-page cost is what varies, from 0.2 ms
/// for plain text to 92 ms for a page carrying a figure, because lifting an
/// image means decoding and re-encoding it. So the expensive half is exactly
/// the half nobody has asked for yet, and holding the cheap half open is what
/// makes page-turning affordable.
pub struct Reader {
    inner: Inner,
    /// How many pages this reader has actually produced.
    ///
    /// Here because "a page is read without reading the rest" is a claim about
    /// *work done*, and work done is not otherwise observable: a reader that
    /// read all two hundred pages and handed back one would look identical from
    /// the outside — same answer, same allocation, just twelve seconds slower.
    /// Counting is the only way to assert it that is not a stopwatch.
    read: std::sync::atomic::AtomicUsize,
}

/// Which of the two kinds of document is open.
///
/// The fork is here and it is the only place it exists. Everything above —
/// [`Reader::page`], [`crate::pages::PageStore`], and whatever the reading
/// surface turns out to be — asks for a page by number and is told what is on
/// it. That is D-46 section 2's rule about the three objects applied one level
/// down: if reading a document needed a special case anywhere the reader can
/// see, the model would be wrong.
enum Inner {
    Pdf {
        /// Boxed because a loaded `Document` is two orders of magnitude larger
        /// than the other variant, and an enum is as big as its widest arm: a
        /// text file would otherwise carry a PDF-shaped hole around with it.
        doc: Box<Document>,
        /// Page numbers and their objects, in reading order. lopdf hands these
        /// back as a map; the order is the document's own pagination and is the
        /// identity a quote cites.
        ids: Vec<(u32, ObjectId)>,
    },
    /// A file that stated no pagination, and the one this build gave it. The
    /// ranges tile `text`, so a page is a place in the file (T-298).
    Plain {
        text: String,
        pages: Vec<std::ops::Range<usize>>,
        /// When each cue in `text` was said — empty unless this file turned out
        /// to be a transcript (T-287). Offsets are into `text`, which for a
        /// transcript is the *speech* and not the file: see [`Reader::of_text`].
        marks: Vec<crate::cues::Mark>,
        /// What each stretch of the read text *is*, for a markdown file — T-346,
        /// D-65. Empty for every other text file, which is nearly all of them.
        ///
        /// Beside the text rather than in it, on `Page::cues`' argument exactly:
        /// on paper a markdown file is plain text cut the same way on the same
        /// grid, and a variant of its own would have every reader of a page
        /// asking a question none of them has a use for.
        roles: Vec<crate::markdown::Span>,
    },
}

impl Reader {
    /// Open a document off the disk, whichever kind it turns out to be.
    ///
    /// The path is the store's, not the user's — by the time anything gets here
    /// the bytes have already been ingested and hashed, so this never sees a
    /// name a person typed. Which is also why the kind is decided by
    /// [`crate::assets::sniff_path`] rather than by an extension: there is no
    /// extension to read, and the store's answer is the one the ingest gate and
    /// the asset record already agree on.
    pub fn open(path: &Path, markdown: bool) -> Result<Reader> {
        if crate::assets::sniff_path(path).is_some_and(|mime| mime.starts_with("text/")) {
            let bytes = std::fs::read(path).map_err(|e| Error::Malformed(e.to_string()))?;
            let text = crate::text::decode(&bytes)
                .ok_or_else(|| Error::Malformed("the file is not text after all".into()))?;
            return Reader::of_text(text, markdown);
        }
        let options = LoadOptions::with_max_decompressed_size(MAX_STRUCTURE_BYTES);
        let doc = Document::load_with_options(path, options)
            .map_err(|e| Error::Malformed(e.to_string()))?;
        Reader::of(doc)
    }

    /// Open a PDF already in memory. The tests build their fixtures this way,
    /// and so does anything that has the bytes but no file.
    ///
    /// Deliberately not the dispatching door: its callers have already decided
    /// what they are holding — [`probe`] from the record's mime, the tests from
    /// the fixture they just built — and a second opinion here could only
    /// disagree with the first.
    pub fn open_bytes(bytes: &[u8]) -> Result<Reader> {
        let options = LoadOptions::with_max_decompressed_size(MAX_STRUCTURE_BYTES);
        let doc = Document::load_mem_with_options(bytes, options)
            .map_err(|e| Error::Malformed(e.to_string()))?;
        Reader::of(doc)
    }

    /// Open text already decoded. The in-memory door for the other kind.
    pub fn open_text(text: String, markdown: bool) -> Result<Reader> {
        Reader::of_text(text, markdown)
    }

    fn of_text(text: String, markdown: bool) -> Result<Reader> {
        // **A transcript is read as what was said, and never as the file** —
        // T-287, Q-301. A `.srt` beside a recording is stored as an ordinary
        // text asset, so without this the reading surface sets cue numbers and
        // arrow timestamps on paper in our own hand, and a rectangle dragged
        // over the words cuts a card carrying them.
        //
        // It goes *here*, in front of the pagination, because everything that
        // follows is defined over the text this line chooses: the tiling, the
        // page count on the asset record, the search index, and the passage a
        // quote is cut from. One substitution and none of them knows.
        let spoken = crate::cues::speech(&text);
        let (text, marks) = match spoken {
            Some(speech) => (speech.text, speech.marks),
            None => (text, Vec::new()),
        };
        // **And the second substitution, on the same line of reasoning and in
        // the same place** — T-346, D-65. A markdown file is read as its words
        // with the marks taken off, and what they were comes back as spans over
        // the result. Same bargain: everything below is defined over the text
        // these two lines chose, and none of it knows either format exists.
        //
        // `markdown` and not a question asked of the content, because there is
        // no honest question to ask — every text file is valid markdown, so the
        // recognition was settled at ingest from the name (Q-324, T-345) and
        // arrives here as a fact.
        //
        // After the cues rather than before, and the order is not arbitrary: a
        // `.srt` is not markdown and a `.md` is not a transcript, so at most one
        // of these ever fires. Cues first keeps the total test — which can say
        // "this is not a transcript" — ahead of the one that cannot refuse.
        let (text, roles) = if markdown {
            let read = crate::markdown::read(&text);
            (read.text, read.roles)
        } else {
            (text, Vec::new())
        };
        let pages = crate::text::paginate(&text);
        // The same bound as a PDF's, for the same reason and in the same words:
        // a page tree — or a log file — claiming to be endless is refused
        // before it is walked rather than trimmed to fit.
        if pages.len() > MAX_PAGES {
            return Err(Error::TooLarge(format!(
                "{} pages is more than this build will read",
                pages.len()
            )));
        }
        Ok(Reader {
            inner: Inner::Plain { text, pages, marks, roles },
            read: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    fn of(doc: Document) -> Result<Reader> {
        // `is_encrypted` is not "was this file encrypted" — lopdf strips
        // `/Encrypt` from the trailer the moment it successfully decrypts,
        // which it does for the empty user password. So this is true only when
        // the bytes are still ciphertext, which is the one case where reading
        // on would hand back a document made of noise.
        if doc.is_encrypted() {
            return Err(Error::Encrypted);
        }
        let ids: Vec<(u32, ObjectId)> = doc.get_pages().into_iter().collect();
        if ids.len() > MAX_PAGES {
            return Err(Error::TooLarge(format!(
                "{} pages is more than this build will read",
                ids.len()
            )));
        }
        Ok(Reader {
            inner: Inner::Pdf {
                doc: Box::new(doc),
                ids,
            },
            read: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    /// How many pages there are — known from the page tree, or from the rule
    /// that stood in for one, without reading a page either way.
    pub fn page_count(&self) -> usize {
        match &self.inner {
            Inner::Pdf { ids, .. } => ids.len(),
            Inner::Plain { pages, .. } => pages.len(),
        }
    }

    /// What the file says it is called, if it says anything.
    ///
    /// The document information dictionary's `/Title`, and nothing else. Not the
    /// first heading, not the largest run on page one, not XMP: those are all
    /// *readings* of the document, and a reading is a claim about the evidence
    /// that D-46 section 6 does not let this side of the line make. `/Title` is
    /// the file stating its own name, which is the same category of fact as a
    /// film's runtime.
    ///
    /// `None` covers three things that are all the same to a label — no `/Info`,
    /// no `/Title`, and a `/Title` that is blank or nothing but space. A folder
    /// with no title writes one line instead of two.
    ///
    /// A text file is a fourth, and permanently: it has no dictionary to state
    /// a name in. Taking the first line instead would be a *reading* of the
    /// document, which is the thing this comment already refuses.
    pub fn title(&self) -> Option<String> {
        let Inner::Pdf { doc, .. } = &self.inner else {
            return None;
        };
        let info = doc.trailer.get(b"Info").ok()?;
        let dict = match info {
            Object::Reference(id) => doc.get_object(*id).ok()?.as_dict().ok()?,
            other => other.as_dict().ok()?,
        };
        tidy(&text_string(dict.get(b"Title").ok()?.as_str().ok()?))
    }

    /// How many pages this reader has produced since it was opened. See the
    /// field for why it is counted at all.
    pub fn pages_read(&self) -> usize {
        self.read.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Read one page, by the number printed on it.
    ///
    /// `None` means there is no such page, which is a different thing from a
    /// page that turned out to be [`PageContent::Empty`].
    pub fn page(&self, index: u32) -> Option<Page> {
        match &self.inner {
            Inner::Pdf { doc, ids } => {
                let (index, page_id) = ids.iter().copied().find(|(n, _)| *n == index)?;
                Some(self.produce(doc, index, page_id))
            }
            Inner::Plain { text, pages, marks, roles } => {
                let at = usize::try_from(index).ok()?.checked_sub(1)?;
                Some(self.cut(text, marks, roles, pages.get(at)?.clone(), index))
            }
        }
    }

    /// Every page. The whole cost, taken deliberately — an export or a bundle
    /// wants this; somebody turning to page four does not.
    pub fn read_all(&self) -> Reading {
        let pages = match &self.inner {
            Inner::Pdf { doc, ids } => ids
                .iter()
                .map(|&(index, page_id)| self.produce(doc, index, page_id))
                .collect(),
            Inner::Plain { text, pages, marks, roles } => pages
                .iter()
                .enumerate()
                .map(|(at, range)| self.cut(text, marks, roles, range.clone(), at as u32 + 1))
                .collect(),
        };
        Reading { pages }
    }

    /// Every page's characters, and nothing that is looked at — the read the
    /// derived local index is made of (D-46 section 2).
    ///
    /// Deliberately **not** [`Reader::read_all`]. That produces a page the way
    /// the reading surface wants one, which means `decide` lifts a scan's image
    /// and every figure over `FIGURE_COVERAGE` — and not one byte of a lifted
    /// image is a character. This walks the same content stream through the
    /// same [`Walk`] and stops before the pictures.
    ///
    /// Measured cold on 40 real multi-page files off this machine (772 pages),
    /// each read twice on its own reader: **11.1 ms a page here against 18.5
    /// through `read_all`**. That 1.7x is the floor rather than the figure,
    /// because ten of those 772 pages were scans — what separates them on that
    /// corpus is figures being lifted off typed pages. On a filing that is
    /// scanned exhibits the gap is the whole of the lift, which T-299 measured
    /// at 57 to 92 ms a page against a walk of about eleven.
    ///
    /// Sharing the walk is the point rather than a saving. What the index calls
    /// a scan has to be what the reader draws as a scan, or the search field
    /// says a page is unsearchable while the page beside it shows text.
    pub fn read_text(&self) -> Vec<PageText> {
        match &self.inner {
            Inner::Pdf { doc, ids } => ids
                .iter()
                .map(|&(_, page_id)| {
                    self.read.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    read_page_text(doc, page_id)
                })
                .collect(),
            Inner::Plain { text, pages, .. } => pages
                .iter()
                .map(|range| PageText::Text(text[range.clone()].to_string()))
                .collect(),
        }
    }

    fn produce(&self, doc: &Document, index: u32, page_id: ObjectId) -> Page {
        self.read.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        read_page(doc, index, page_id)
    }

    /// One page of a text file.
    ///
    /// **`width` and `height` are zero, and that is the honest answer rather
    /// than a missing one.** They are points, and points are what a PDF states
    /// about the shape it is meant to be looked at in. A text file states
    /// nothing, so the sheet it goes on is the board's decision and not the
    /// file's — which is [`crate::text`]'s whole argument arriving here: the
    /// reading surface's page is sized to the grid, so a number invented on
    /// this side could only be one the other side then had to ignore.
    fn cut(
        &self,
        text: &str,
        marks: &[crate::cues::Mark],
        roles: &[crate::markdown::Span],
        range: std::ops::Range<usize>,
        index: u32,
    ) -> Page {
        self.read.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let shown = &text[range.clone()];
        // Rebased into the page, because the page is what crosses — see
        // [`Page::cues`]. A cue that opens exactly at the page's last byte is
        // the next page's first line, which is why the end is exclusive.
        //
        // **And counted in UTF-16 code units, not bytes.** The only thing that
        // ever compares one of these against a position is a DOM caret, and a
        // DOM offset is an index into a JavaScript string. The two agree for as
        // long as the transcript is ASCII and part company at the first accent
        // — so a quote from a French interview would be cited from whichever
        // line happened to be a few bytes back. Converted here, where the page
        // text is in hand, rather than trusted to a reader that has only the
        // number.
        let cues = marks
            .iter()
            .filter(|mark| mark.offset >= range.start && mark.offset < range.end)
            .map(|mark| crate::cues::Mark {
                offset: shown[..mark.offset - range.start].encode_utf16().count(),
                at: mark.at,
            })
            .collect();
        // And the roles, rebased the same way and for the same two reasons —
        // the page is what crosses, and the only thing that ever compares one of
        // these against a position is a DOM caret counting UTF-16 code units.
        //
        // **Clipped to the page rather than dropped at its edge**, which is the
        // one place this differs from a cue. A cue is a *point* and belongs to
        // whichever page it opens on; a role is a *stretch*, and a heading or a
        // quoted block can be cut in half by a page boundary. Dropping it would
        // leave the second half of a block quote drawn as ordinary prose, so
        // what crosses is the part of the span that is on this page.
        let roles = roles
            .iter()
            .filter(|span| span.start < range.end && span.end > range.start)
            .map(|span| {
                let start = span.start.max(range.start) - range.start;
                let end = span.end.min(range.end) - range.start;
                crate::markdown::Span {
                    start: shown[..start].encode_utf16().count(),
                    end: shown[..end].encode_utf16().count(),
                    role: span.role,
                }
            })
            .collect();
        Page {
            index,
            width: 0.0,
            height: 0.0,
            content: PageContent::Plain(text[range].to_owned()),
            cues,
            roles,
        }
    }
}

/// Read every page of a PDF off the disk.
pub fn read_pdf(path: &Path) -> Result<Reading> {
    // `false`, and settled rather than deferred: this door is named for what
    // comes through it. An export and a bundle read a PDF here, and a PDF has
    // no marks to take off — `Reader::open` still dispatches on the sniffed
    // mime, so a text file handed to it is read plainly, which is the reading
    // every caller of this one wants (T-347).
    Ok(Reader::open(path, false)?.read_all())
}

/// Read every page of a PDF already in memory.
pub fn read_pdf_bytes(bytes: &[u8]) -> Result<Reading> {
    Ok(Reader::open_bytes(bytes)?.read_all())
}

// ---------------------------------------------------------------------------
// What a document says about itself, at ingest
// ---------------------------------------------------------------------------

/// Characters of `/Title` that reach the document.
///
/// A tab on a folder, not a field. Anything past this is a sentence somebody put
/// in the wrong box, and the record is what crosses the wire — a peer who will
/// never hold the file should not be sent a paragraph to describe it with.
const MAX_TITLE_CHARS: usize = 120;

/// The two facts a folder's tab needs, read once by the machine holding the file.
///
/// The same bargain [`crate::media::probe_duration`] makes, and for the same
/// stated reason: the asset record reaches a peer long before the bytes do, so a
/// number that can only be got from the bytes has to be taken at ingest or it is
/// never available to anyone else at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    pub pages: u32,
    pub title: Option<String>,
}

/// Read a document's page count and declared title, or `None` if this is not a
/// document, or is one this build cannot open.
///
/// It costs a structure load — 3 to 53 ms on the corpus T-299 measured, and 221
/// ms for the largest file on that machine — against an ingest that has already
/// hashed the whole file. No page is read: `page_count` comes off the page tree
/// and `/Title` off the trailer, which is why a two hundred page scan costs the
/// same here as a two page memo.
///
/// A malformed or encrypted file yields `None` rather than an error, because the
/// caller is a paste and nothing about this is worth refusing bytes over: a PDF
/// this build cannot parse is still a PDF, and it becomes a folder with nothing
/// written under its filename.
pub fn probe(bytes: &[u8], mime: &str, markdown: bool) -> Option<Probe> {
    match mime {
        "application/pdf" => Some(of(&Reader::open_bytes(bytes).ok()?)),
        // The other kind of document, and it comes through the same door on
        // purpose: "how many pages has this got" has one answer per file and
        // should have one place that gives it. What differs is only where the
        // number comes from — a PDF states its pagination and a text file is
        // given ours ([`crate::text`]).
        //
        // A title is `None` and always will be. A PDF has an information
        // dictionary in which the file states its own name; a text file has
        // nothing but its filename, which is already typed on the tab.
        mime if mime.starts_with("text/") => {
            let text = crate::text::decode(bytes)?;
            // Counted over the speech when the file is a transcript, for the
            // same reason `Reader::of_text` paginates the speech: these two
            // numbers are the same number. The record's count is what the open
            // sheet's header prints and what the folder's thickness is drawn
            // from, so a count taken over the markup would put "1 of 5" at the
            // head of a two page transcript.
            let spoken = crate::cues::speech(&text);
            let read = spoken.as_ref().map_or(&text, |s| &s.text);
            // And over the *read* markdown when it is markdown, which is this
            // count's whole job: `Reader::of_text` paginates the words with the
            // marks taken off, so counting the source here would put "1 of 5" at
            // the head of a three page file and draw a folder too thick for what
            // is in it. One substitution, applied in both places or in neither.
            let stripped = markdown.then(|| crate::markdown::read(read).text);
            let pages = crate::text::page_count(stripped.as_deref().unwrap_or(read));
            // Refused rather than trimmed, and by the same bound for the same
            // reason: a folder claiming more pages than this build will read is
            // a folder nobody can open, and one with no thickness is honest
            // about that where one with a wrong thickness is not.
            (pages <= MAX_PAGES).then_some(Probe {
                pages: pages as u32,
                title: None,
            })
        }
        _ => None,
    }
}

/// The same two facts, off a file this machine already holds.
///
/// The route the *title* takes, because Q-211 settled that a title is derived
/// locally and never enters the document: a machine learns what a folder is
/// called by reading the file, and a machine without the file does not learn it
/// at all. Asked once per document the board actually shows, rather than at
/// ingest, so that the one code path serves a paste, a transfer that has just
/// committed, a board reopened tomorrow and a bundle somebody sent — none of
/// which are ingests, and three of which would otherwise need their own answer.
pub fn probe_path(path: &Path) -> Option<Probe> {
    // `false`, and it costs nothing: both callers take `.title` and throw the
    // page count away — `asset_title` asks what a document calls itself, which
    // is a PDF's information dictionary and which a text file has no answer to
    // whichever way it is read. The count that reaches a record comes from
    // `probe` at ingest, which *is* told (T-347).
    Some(of(&Reader::open(path, false).ok()?))
}

fn of(reader: &Reader) -> Probe {
    Probe {
        pages: reader.page_count() as u32,
        title: reader.title(),
    }
}

/// Collapse, trim and cap — or `None` if there is nothing left.
///
/// Producers write titles with newlines in them, with runs of tabs where a
/// template had a field, and with nothing but spaces where a template had none.
/// All three are the same thing to a label, and doing this once here means the
/// frontend never has to wonder whether a title it was given is really a title.
///
/// Shared with [`crate::media::probe_title`], which reads the same kind of field
/// out of a different kind of container. One cap, because there is one label:
/// a tape whose name was cut at a different length from a folder's would be a
/// difference the board cannot explain.
pub(crate) fn tidy(text: &str) -> Option<String> {
    let mut out = String::new();
    for word in text.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
        if out.chars().count() >= MAX_TITLE_CHARS {
            break;
        }
    }
    // By characters, because the cap is about how much label there is, and
    // because cutting a UTF-8 string by bytes can cut a character in half.
    let capped: String = out.chars().take(MAX_TITLE_CHARS).collect();
    if capped.is_empty() {
        None
    } else {
        Some(capped)
    }
}

/// Decode a PDF *text string* — PDF 32000-1 section 7.9.2.2.
///
/// Three encodings share one syntax and are told apart by what the string starts
/// with: a UTF-16BE byte order mark, a UTF-8 one (PDF 2.0), or neither, which
/// means PDFDocEncoding. Guessing wrong is not a subtle failure — a UTF-16 title
/// read as bytes is every other character a NUL.
///
/// Lossy on purpose at both ends. A lone surrogate or an odd trailing byte is a
/// producer bug, and a replacement character in a folder's title is a better
/// outcome than a title that is `None` because one byte was wrong.
fn text_string(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    bytes.iter().map(|&b| pdf_doc_char(b)).collect()
}

/// One byte of PDFDocEncoding as a character.
///
/// Latin-1 in the two ranges where the two agree, and a table in the two where
/// they do not: PDFDocEncoding puts accents in `0x18`–`0x1F` where Latin-1 has
/// control codes, and typography in `0x80`–`0x9F` where Latin-1 has more of
/// them. `0x9F` and `0xAD` are undefined and become the replacement character,
/// which is what an undefined code point is.
///
/// The table is PDF 32000-1 Annex D.2's and **not** Windows-1252's, which
/// disagrees with it about nearly every byte in `0x80`–`0x9F` — a right single
/// quote is `0x90` here and `0x92` there. It matters less than it looks: a
/// producer with a character to write that is not ASCII writes UTF-16 with a
/// mark, so in practice this path decodes ASCII and the two tables agree.
fn pdf_doc_char(byte: u8) -> char {
    const ACCENTS: [char; 8] = [
        '\u{2D8}', '\u{2C7}', '\u{2C6}', '\u{2D9}', '\u{2DD}', '\u{2DB}', '\u{2DA}', '\u{2DC}',
    ];
    const TYPOGRAPHY: [char; 32] = [
        '\u{2022}', '\u{2020}', '\u{2021}', '\u{2026}', '\u{2014}', '\u{2013}', '\u{192}',
        '\u{2044}', '\u{2039}', '\u{203A}', '\u{2212}', '\u{2030}', '\u{201E}', '\u{201C}',
        '\u{201D}', '\u{2018}', '\u{2019}', '\u{201A}', '\u{2122}', '\u{FB01}', '\u{FB02}',
        '\u{141}', '\u{152}', '\u{160}', '\u{178}', '\u{17D}', '\u{131}', '\u{142}', '\u{153}',
        '\u{161}', '\u{17E}', '\u{FFFD}',
    ];
    match byte {
        0x18..=0x1F => ACCENTS[(byte - 0x18) as usize],
        0x80..=0x9F => TYPOGRAPHY[(byte - 0x80) as usize],
        0xA0 => '\u{20AC}',
        0xAD => '\u{FFFD}',
        other => other as char,
    }
}

// ---------------------------------------------------------------------------
// One page
// ---------------------------------------------------------------------------

fn read_page(doc: &Document, index: u32, page_id: ObjectId) -> Page {
    let frame = PageFrame::of(doc, page_id);
    let (width, height) = frame.size();
    let content = match walk_page(doc, frame, page_id) {
        Ok(walked) => decide(doc, walked.runs, walked.images, width * height, walked.undecodable),
        // A page whose content will not decompress within the bound is not a
        // page we can say anything about. It is not blank, so it does not get
        // to read as blank.
        Err(why) => PageContent::Unsupported(why),
    };
    Page {
        index,
        width,
        height,
        content,
        // A PDF has no cues. It could carry them one day — a film's chapters,
        // a scan of a numbered transcript — and the empty vec is what says this
        // page was asked and had none, rather than that nobody asked.
        cues: Vec::new(),
        // And no roles, for a reason that will not change: a PDF states its own
        // layout, so what a run *is* has always been readable off its size and
        // its box. These exist because a text file states nothing at all.
        roles: Vec::new(),
    }
}

fn read_page_text(doc: &Document, page_id: ObjectId) -> PageText {
    let frame = PageFrame::of(doc, page_id);
    let (width, height) = frame.size();
    match walk_page(doc, frame, page_id) {
        Ok(walked) => decide_text(walked, width * height),
        Err(_) => PageText::None(NoText::Unreadable),
    }
}

/// A page's content stream, walked — what was set on it and what was drawn on
/// it, before anything has decided which of the two the page *is*.
///
/// The split is here so that the reading surface and the index share one walk
/// and part company only at the decision. Two walks would be two answers to
/// "does this page have text on it", and the pair have to agree: what the index
/// calls a scan is what the reader draws as a scan.
struct Walked<'a> {
    runs: Vec<TextRun>,
    images: Vec<Placement<'a>>,
    undecodable: bool,
}

fn walk_page(
    doc: &Document,
    frame: PageFrame,
    page_id: ObjectId,
) -> std::result::Result<Walked<'_>, String> {
    let resources = page_resources(doc, page_id);
    let content = doc
        .get_page_content_with_limit(page_id, MAX_PAGE_CONTENT_BYTES)
        .map_err(|e| format!("the page could not be read: {e}"))?;

    let mut walk = Walk {
        doc,
        frame,
        runs: Vec::new(),
        images: Vec::new(),
        undecodable: false,
    };
    walk.run(&content, &resources, Matrix::IDENTITY, 0);
    let Walk {
        runs,
        images,
        undecodable,
        ..
    } = walk;
    Ok(Walked {
        runs,
        images,
        undecodable,
    })
}

/// The same decision [`decide`] makes, stopping one step short of the picture.
///
/// It has to be the same decision and in the same order, which is why it is
/// written beside it rather than folded into it: `decide` cannot answer this
/// question without lifting, and lifting is the entire cost this exists to
/// avoid. The tests assert the two agree page for page.
///
/// A scan that turns out to be an inline image, or one whose bytes will not
/// lift, is [`NoText::Scan`] here where `decide` says `Unsupported`. That is not
/// a disagreement about the page: all three are a picture with no characters on
/// it, and the difference between them is about what can be *shown*, which this
/// side of the fork is not asking.
fn decide_text(walked: Walked<'_>, page_area: f32) -> PageText {
    let Walked {
        runs,
        images,
        undecodable,
    } = walked;
    if runs.iter().any(|run| !run.text.trim().is_empty()) {
        return PageText::Text(joined(&runs));
    }
    let biggest = images.iter().max_by(|a, b| a.area().total_cmp(&b.area()));
    match biggest {
        Some(candidate) if page_area > 0.0 && candidate.area() / page_area >= SCAN_COVERAGE => {
            PageText::None(NoText::Scan)
        }
        _ => PageText::None(if undecodable {
            NoText::Unreadable
        } else {
            NoText::Empty
        }),
    }
}

/// Runs, joined into the characters a needle is tested against.
///
/// **This is not `linesOfRuns` and must not become a port of it.** That function
/// (`render/items/dom.ts`) decides where the *lines* were, off the run boxes,
/// because Q-198 re-sets the text on our own paper and a line break is part of
/// setting it. This decides only where the *gaps* were — which is the whole of
/// what a needle can tell apart, because every separator either function inserts
/// is whitespace, and a search normalises whitespace before it matches.
///
/// So the two are held to a promise they can actually keep: **the same
/// non-space characters in the same order**, asserted on this side and on the
/// other. "The same string" is a promise a line-breaking heuristic and a gap
/// rule could only keep by being one function, and one function would have to
/// live on one side — which would either put layout in Rust or a PDF parser in
/// the browser, and D-46 refuses both.
///
/// The rule itself is `linesOfRuns`'s own, in its own words: a run that
/// continues a line still needs a gap unless one end already has one. A PDF
/// splits a line at every font and kerning change, so joining bare runs the
/// words together — and a board that cannot find "witness statement" because
/// the file set it in two runs is a search that has failed at the only thing it
/// is for.
fn joined(runs: &[TextRun]) -> String {
    let mut text = String::new();
    for run in runs {
        if !text.is_empty()
            && !text.ends_with(char::is_whitespace)
            && !run.text.starts_with(char::is_whitespace)
        {
            text.push(' ');
        }
        text.push_str(&run.text);
    }
    text
}

/// The per-page decision, which is AC-684 and is the whole of it.
///
/// Text wins over an image, because D-46 section 4 re-typesets what it can and
/// only shows the original where there is nothing to set. A page with both — a
/// typed page carrying a figure — is a text page, and the decision the design
/// asked for is which of the two a page *is*.
///
/// It is not a merge, and it is not a drop either: Q-203 settled that the figure
/// comes too, carried beside the runs with its box. The reading surface re-flows
/// it among the re-set lines (T-329, Q-289).
fn decide(
    doc: &Document,
    runs: Vec<TextRun>,
    images: Vec<Placement<'_>>,
    page_area: f32,
    undecodable: bool,
) -> PageContent {
    if runs.iter().any(|run| !run.text.trim().is_empty()) {
        // Q-203: the figures come too. Before this, a report's chart was
        // dropped and the reader got the caption and a blank space.
        let figures = images
            .iter()
            .filter(|placed| page_area > 0.0 && placed.area() / page_area >= FIGURE_COVERAGE)
            .take(MAX_FIGURES_PER_PAGE)
            .map(|placed| Figure {
                x: placed.x,
                y: placed.y,
                width: placed.width,
                height: placed.height,
                content: match &placed.source {
                    Source::Inline => FigureContent::Unsupported(
                        "the figure is written inline in the page's content stream, which this build does not lift"
                            .into(),
                    ),
                    Source::XObject(stream) => match lift(doc, stream, "the figure") {
                        Ok(image) => FigureContent::Image(image),
                        Err(why) => FigureContent::Unsupported(why),
                    },
                },
            })
            .collect();
        return PageContent::Text { runs, figures };
    }

    /// What a page with nothing readable on it is, which depends on whether
    /// there was nothing or whether we simply could not read it.
    fn nothing(undecodable: bool) -> PageContent {
        if undecodable {
            PageContent::Unsupported(
                "the page's text is in a font that does not say which characters its codes stand for"
                    .into(),
            )
        } else {
            PageContent::Empty
        }
    }

    // The largest thing drawn on the page, which is the only candidate for
    // being the page.
    let biggest = images
        .into_iter()
        .max_by(|a, b| a.area().total_cmp(&b.area()));

    let Some(candidate) = biggest else {
        return nothing(undecodable);
    };
    if page_area <= 0.0 || candidate.area() / page_area < SCAN_COVERAGE {
        // Something is drawn here, but it is not the page — a logo, a rule, a
        // signature block. There is no readable text either, so the page is
        // blank in every sense that matters to a reader.
        return nothing(undecodable);
    }

    match candidate.source {
        Source::Inline => PageContent::Unsupported(
            "the page is an image written inline in its content stream, which this build does not lift"
                .into(),
        ),
        Source::XObject(stream) => match lift(doc, stream, "the page") {
            Ok(image) => PageContent::Image(image),
            Err(why) => PageContent::Unsupported(why),
        },
    }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/// A PDF transformation matrix, `[a b c d e f]`, applied to a row vector:
/// `(x, y) -> (a·x + c·y + e, b·x + d·y + f)`.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Matrix([f32; 6]);

impl Matrix {
    const IDENTITY: Matrix = Matrix([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    fn translate(tx: f32, ty: f32) -> Matrix {
        Matrix([1.0, 0.0, 0.0, 1.0, tx, ty])
    }

    /// `self` first, then `other` — the order every `cm`, `Td` and `Tm` in the
    /// spec is written in.
    fn mul(self, other: Matrix) -> Matrix {
        let [a1, b1, c1, d1, e1, f1] = self.0;
        let [a2, b2, c2, d2, e2, f2] = other.0;
        Matrix([
            a1 * a2 + b1 * c2,
            a1 * b2 + b1 * d2,
            c1 * a2 + d1 * c2,
            c1 * b2 + d1 * d2,
            e1 * a2 + f1 * c2 + e2,
            e1 * b2 + f1 * d2 + f2,
        ])
    }

    fn apply(self, x: f32, y: f32) -> (f32, f32) {
        let [a, b, c, d, e, f] = self.0;
        (a * x + c * y + e, b * x + d * y + f)
    }
}

/// The page's own box and how it is meant to be turned up the right way.
#[derive(Debug, Clone, Copy)]
struct PageFrame {
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    /// Clockwise, one of 0, 90, 180, 270.
    rotate: i32,
}

impl PageFrame {
    fn of(doc: &Document, page_id: ObjectId) -> PageFrame {
        // `/CropBox` is what the page is meant to show; `/MediaBox` is the
        // sheet it was imposed on, and the two differ on anything that has been
        // through a printer's workflow. Both are inheritable, so both are
        // looked up through the page tree.
        let box_ = inherited(doc, page_id, b"CropBox")
            .and_then(|o| rect(doc, o))
            .or_else(|| inherited(doc, page_id, b"MediaBox").and_then(|o| rect(doc, o)))
            // US Letter, which is what a PDF with no boxes at all is defined to
            // mean in practice; the alternative is a page of size zero, and
            // every coverage test below would then divide by it.
            .unwrap_or((0.0, 0.0, 612.0, 792.0));

        let rotate = inherited(doc, page_id, b"Rotate")
            .and_then(|o| o.as_i64().ok())
            .map(|r| {
                let r = ((r % 360) + 360) % 360;
                // A `/Rotate` that is not a multiple of 90 is illegal; treating
                // it as none is the only reading that does not tilt the page.
                if r % 90 == 0 {
                    r as i32
                } else {
                    0
                }
            })
            .unwrap_or(0);

        PageFrame {
            x0: box_.0.min(box_.2),
            y0: box_.1.min(box_.3),
            x1: box_.0.max(box_.2),
            y1: box_.1.max(box_.3),
            rotate,
        }
    }

    /// The page as it is looked at: rotation applied, so a landscape scan of a
    /// portrait page reports portrait.
    fn size(&self) -> (f32, f32) {
        let (w, h) = (self.x1 - self.x0, self.y1 - self.y0);
        if self.rotate == 90 || self.rotate == 270 {
            (h, w)
        } else {
            (w, h)
        }
    }

    /// PDF user space to points from the top left of the page as displayed.
    fn to_page(&self, x: f32, y: f32) -> (f32, f32) {
        let (w, h) = (self.x1 - self.x0, self.y1 - self.y0);
        // Into the unrotated sheet, y downwards.
        let dx = x - self.x0;
        let dy = h - (y - self.y0);
        match self.rotate {
            90 => (h - dy, dx),
            180 => (w - dx, h - dy),
            270 => (dy, w - dx),
            _ => (dx, dy),
        }
    }

    /// The axis-aligned box, in page coordinates, of a rectangle given in user
    /// space. Rotation here is always a multiple of a right angle, so an
    /// axis-aligned box stays one; the corners are transformed anyway because
    /// the *text* matrix is under no such constraint.
    fn box_of(&self, corners: [(f32, f32); 4]) -> (f32, f32, f32, f32) {
        let mapped = corners.map(|(x, y)| self.to_page(x, y));
        let xs = mapped.map(|p| p.0);
        let ys = mapped.map(|p| p.1);
        let min_x = xs.iter().copied().fold(f32::INFINITY, f32::min);
        let max_x = xs.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        let min_y = ys.iter().copied().fold(f32::INFINITY, f32::min);
        let max_y = ys.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        (min_x, min_y, max_x - min_x, max_y - min_y)
    }
}

/// Walk up the page tree for one of the attributes a page may inherit.
fn inherited<'a>(doc: &'a Document, page_id: ObjectId, key: &[u8]) -> Option<&'a Object> {
    let mut id = page_id;
    // The page tree is a tree, but the file says so rather than proving it, so
    // the climb is bounded.
    for _ in 0..32 {
        let dict = doc.get_dictionary(id).ok()?;
        if let Ok(value) = dict.get_deref(key, doc) {
            return Some(value);
        }
        id = dict.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

fn rect(doc: &Document, object: &Object) -> Option<(f32, f32, f32, f32)> {
    let array = object.as_array().ok()?;
    if array.len() != 4 {
        return None;
    }
    let mut out = [0.0f32; 4];
    for (slot, value) in out.iter_mut().zip(array) {
        // A box's components are routinely indirect references in files that
        // have been merged.
        let value = match value {
            Object::Reference(id) => doc.get_object(*id).ok()?,
            other => other,
        };
        *slot = value.as_float().ok()?;
    }
    Some((out[0], out[1], out[2], out[3]))
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/// The resource dictionaries in scope, most specific first. A form XObject's
/// own resources shadow the page's, and a page's shadow its ancestors'.
#[derive(Debug, Clone, Default)]
struct Resources<'a> {
    dicts: Vec<&'a Dictionary>,
}

impl<'a> Resources<'a> {
    /// Look a name up in one category — `/Font`, `/XObject` — through the whole
    /// scope chain.
    fn find(&self, doc: &'a Document, category: &[u8], name: &[u8]) -> Option<&'a Object> {
        for dict in &self.dicts {
            let Ok(sub) = dict.get_deref(category, doc).and_then(Object::as_dict) else {
                continue;
            };
            if let Ok(object) = sub.get_deref(name, doc) {
                return Some(object);
            }
        }
        None
    }

    /// The scope a form XObject's content runs in: its own resources in front
    /// of the ones it was drawn from. A form with no `/Resources` of its own
    /// inherits the caller's, which is what the spec has said since 1.2.
    fn inside(&self, own: Option<&'a Dictionary>) -> Resources<'a> {
        let mut dicts = Vec::with_capacity(self.dicts.len() + 1);
        dicts.extend(own);
        dicts.extend(self.dicts.iter().copied());
        Resources { dicts }
    }
}

fn page_resources<'a>(doc: &'a Document, page_id: ObjectId) -> Resources<'a> {
    let mut dicts: Vec<&Dictionary> = Vec::new();
    if let Ok((inline, ids)) = doc.get_page_resources(page_id) {
        dicts.extend(inline);
        for id in ids {
            if let Ok(dict) = doc.get_dictionary(id) {
                dicts.push(dict);
            }
        }
    }
    Resources { dicts }
}

// ---------------------------------------------------------------------------
// Fonts — only the two things a box needs
// ---------------------------------------------------------------------------

/// What this module wants from a font: how to turn its codes into characters,
/// and how wide each code is. Nothing about shape, because nothing here draws.
struct FontMetrics<'a> {
    encoding: Option<Encoding<'a>>,
    /// Per code, in glyph space — thousandths of the font size.
    widths: HashMap<u32, f32>,
    default_width: f32,
    /// A composite font's codes are read two bytes at a time. Simple fonts are
    /// one byte per code, always.
    two_byte: bool,
    ascent: f32,
    descent: f32,
}

impl<'a> FontMetrics<'a> {
    fn of(doc: &'a Document, font: &'a Dictionary) -> FontMetrics<'a> {
        let composite = font
            .get_deref(b"Subtype", doc)
            .and_then(Object::as_name)
            .map(|name| name == b"Type0")
            .unwrap_or(false);

        // A composite font's codes are two bytes and stand for whatever its
        // CMap says. lopdf can only tell us that for `Identity-H`/`Identity-V`
        // *with* a `/ToUnicode`; without one it does not fail, it falls back to
        // a one-byte standard table — and two-byte codes read through a
        // one-byte table are not text, they are noise.
        //
        // Noise is worse than nothing here, and this is the second door into
        // the same room as the OCR layer above: garbage is non-empty, so the
        // page would report as text, so a scan under it would never be lifted
        // and the user would be shown a paraphrase made of nothing.
        let undecodable_composite = composite
            && font
                .get_deref(b"ToUnicode", doc)
                .and_then(Object::as_stream)
                .is_err();
        let encoding = if undecodable_composite {
            None
        } else {
            font.get_font_encoding_with_limit(doc, MAX_CMAP_BYTES).ok()
        };

        if composite {
            FontMetrics::composite(doc, font, encoding)
        } else {
            FontMetrics::simple(doc, font, encoding)
        }
    }

    fn simple(
        doc: &'a Document,
        font: &'a Dictionary,
        encoding: Option<Encoding<'a>>,
    ) -> FontMetrics<'a> {
        let mut widths = HashMap::new();
        let first = font
            .get_deref(b"FirstChar", doc)
            .and_then(Object::as_i64)
            .unwrap_or(0);
        if let Ok(array) = font.get_deref(b"Widths", doc).and_then(Object::as_array) {
            for (offset, value) in array.iter().enumerate() {
                if let Some(width) = number(doc, value) {
                    widths.insert((first + offset as i64).max(0) as u32, width);
                }
            }
        }

        let descriptor = font
            .get_deref(b"FontDescriptor", doc)
            .and_then(Object::as_dict)
            .ok();
        let base = font
            .get_deref(b"BaseFont", doc)
            .and_then(Object::as_name)
            .unwrap_or(b"");

        let default_width = descriptor
            .and_then(|d| d.get_deref(b"MissingWidth", doc).ok())
            .and_then(|o| number(doc, o))
            // A fixed-pitch font has one width by definition, so the one member
            // of the standard fourteen whose metrics can be guessed honestly is
            // guessed. The rest fall back and say so in this constant's name.
            .unwrap_or(if contains(base, b"Courier") {
                COURIER_WIDTH
            } else {
                FALLBACK_WIDTH
            });

        let (ascent, descent) = vertical(doc, descriptor);
        FontMetrics {
            encoding,
            widths,
            default_width,
            two_byte: false,
            ascent,
            descent,
        }
    }

    /// A Type0 font, whose widths live one level down in its descendant.
    ///
    /// Codes are taken to be CIDs, which is exactly true for `Identity-H` and
    /// `Identity-V` — between them the overwhelming majority of composite fonts
    /// any producer has emitted this decade. Under a predefined CMap the
    /// mapping is not the identity and the widths come out wrong; the text does
    /// not, because that goes through the font's own `ToUnicode`.
    fn composite(
        doc: &'a Document,
        font: &'a Dictionary,
        encoding: Option<Encoding<'a>>,
    ) -> FontMetrics<'a> {
        let descendant = font
            .get_deref(b"DescendantFonts", doc)
            .and_then(Object::as_array)
            .ok()
            .and_then(|array| array.first())
            .and_then(|object| match object {
                Object::Reference(id) => doc.get_object(*id).ok(),
                other => Some(other),
            })
            .and_then(|object| object.as_dict().ok());

        let mut widths = HashMap::new();
        let mut default_width = 1000.0;
        let mut descriptor = None;

        if let Some(cid_font) = descendant {
            if let Some(dw) = cid_font
                .get_deref(b"DW", doc)
                .ok()
                .and_then(|o| number(doc, o))
            {
                default_width = dw;
            }
            if let Ok(array) = cid_font.get_deref(b"W", doc).and_then(Object::as_array) {
                read_cid_widths(doc, array, &mut widths);
            }
            descriptor = cid_font
                .get_deref(b"FontDescriptor", doc)
                .and_then(Object::as_dict)
                .ok();
        }

        let (ascent, descent) = vertical(doc, descriptor);
        FontMetrics {
            encoding,
            widths,
            default_width,
            two_byte: true,
            ascent,
            descent,
        }
    }

    fn width(&self, code: u32) -> f32 {
        self.widths
            .get(&code)
            .copied()
            .unwrap_or(self.default_width)
    }

    fn decode(&self, bytes: &[u8]) -> String {
        match &self.encoding {
            Some(encoding) => encoding.bytes_to_string(bytes).unwrap_or_default(),
            // No encoding means no honest reading of these bytes. An empty run
            // still advances the matrix, so the next run's box is right.
            None => String::new(),
        }
    }
}

/// A CID font's `/W`, which is written in two alternating shapes:
/// `c [w1 w2 …]` gives consecutive CIDs from `c`, and `c_first c_last w` gives
/// one width to a range.
fn read_cid_widths(doc: &Document, array: &[Object], widths: &mut HashMap<u32, f32>) {
    let mut i = 0;
    while i < array.len() {
        let Some(first) = number(doc, &array[i]) else {
            break;
        };
        let first = first.max(0.0) as u32;
        let Some(next) = array.get(i + 1) else { break };
        let next = deref(doc, next);

        if let Ok(list) = next.as_array() {
            for (offset, value) in list.iter().enumerate() {
                if let Some(width) = number(doc, value) {
                    widths.insert(first + offset as u32, width);
                }
            }
            i += 2;
        } else {
            let (Some(last), Some(value)) = (
                number(doc, next),
                array.get(i + 2).and_then(|o| number(doc, o)),
            ) else {
                break;
            };
            let last = last.max(0.0) as u32;
            // A range the file claims is enormous is not expanded — a `/W` is
            // not a place to allocate from.
            for cid in first..=last.min(first.saturating_add(65_535)) {
                widths.insert(cid, value);
            }
            i += 3;
        }
    }
}

fn vertical(doc: &Document, descriptor: Option<&Dictionary>) -> (f32, f32) {
    let ascent = descriptor
        .and_then(|d| d.get_deref(b"Ascent", doc).ok())
        .and_then(|o| number(doc, o))
        .filter(|a| *a > 0.0)
        .unwrap_or(FALLBACK_ASCENT);
    let descent = descriptor
        .and_then(|d| d.get_deref(b"Descent", doc).ok())
        .and_then(|o| number(doc, o))
        .filter(|d| *d < 0.0)
        .unwrap_or(FALLBACK_DESCENT);
    (ascent, descent)
}

fn deref<'a>(doc: &'a Document, object: &'a Object) -> &'a Object {
    match object {
        Object::Reference(id) => doc.get_object(*id).unwrap_or(object),
        other => other,
    }
}

fn number(doc: &Document, object: &Object) -> Option<f32> {
    deref(doc, object).as_float().ok()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/// Where an image is drawn, and what it is. One walk produces these and the
/// text runs together, because the text needs the text matrix and the image
/// needs the CTM, and there is only one stack of those.
struct Placement<'a> {
    source: Source<'a>,
    /// Where on the page it lands, in the same coordinates a run's box is in.
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

impl Placement<'_> {
    /// The area of the page, in square points, this covers.
    fn area(&self) -> f32 {
        self.width * self.height
    }
}

enum Source<'a> {
    XObject(&'a Stream),
    /// An image written into the content stream itself. Recorded so a page
    /// covered by one does not read as empty; not lifted.
    Inline,
}

/// Everything `q` saves and `Q` restores that this module cares about. The text
/// state is part of it, which is why `Tf` outlives a `BT`/`ET` pair.
#[derive(Debug, Clone)]
struct GState {
    ctm: Matrix,
    font: Option<Vec<u8>>,
    size: f32,
    char_spacing: f32,
    word_spacing: f32,
    /// `Tz` as a fraction, not a percentage.
    horizontal: f32,
    leading: f32,
    rise: f32,
    render_mode: i64,
}

impl GState {
    fn new(ctm: Matrix) -> GState {
        GState {
            ctm,
            font: None,
            size: 0.0,
            char_spacing: 0.0,
            word_spacing: 0.0,
            horizontal: 1.0,
            leading: 0.0,
            rise: 0.0,
            render_mode: 0,
        }
    }
}

struct Walk<'a> {
    doc: &'a Document,
    frame: PageFrame,
    runs: Vec<TextRun>,
    images: Vec<Placement<'a>>,
    /// Something was shown and nothing came back out of it. See
    /// [`FontMetrics::of`] — a page this happened on is not blank, whatever
    /// else it turns out not to be.
    undecodable: bool,
}

impl<'a> Walk<'a> {
    fn run(&mut self, content: &[u8], resources: &Resources<'a>, ctm: Matrix, depth: u8) {
        let doc = self.doc;
        let Ok(content) = Content::decode(content) else {
            return;
        };

        let mut fonts: HashMap<Vec<u8>, FontMetrics<'a>> = HashMap::new();
        let mut state = GState::new(ctm);
        let mut stack: Vec<GState> = Vec::new();
        // The text matrix and the line matrix, which exist only between `BT`
        // and `ET` and are not saved by `q`.
        let mut tm = Matrix::IDENTITY;
        let mut tlm = Matrix::IDENTITY;

        for operation in &content.operations {
            let operands = &operation.operands;
            match operation.operator.as_str() {
                "q" => stack.push(state.clone()),
                "Q" => {
                    if let Some(previous) = stack.pop() {
                        state = previous;
                    }
                }
                "cm" => {
                    if let Some(m) = matrix(doc, operands) {
                        state.ctm = m.mul(state.ctm);
                    }
                }

                "BT" => {
                    tm = Matrix::IDENTITY;
                    tlm = Matrix::IDENTITY;
                }

                "Tf" => {
                    state.font = operands
                        .first()
                        .and_then(|o| o.as_name().ok())
                        .map(<[u8]>::to_vec);
                    state.size = operands.get(1).and_then(|o| number(doc, o)).unwrap_or(0.0);
                }
                "Tc" => {
                    state.char_spacing =
                        operands.first().and_then(|o| number(doc, o)).unwrap_or(0.0)
                }
                "Tw" => {
                    state.word_spacing =
                        operands.first().and_then(|o| number(doc, o)).unwrap_or(0.0)
                }
                "Tz" => {
                    state.horizontal = operands
                        .first()
                        .and_then(|o| number(doc, o))
                        .unwrap_or(100.0)
                        / 100.0
                }
                "TL" => {
                    state.leading = operands.first().and_then(|o| number(doc, o)).unwrap_or(0.0)
                }
                "Ts" => state.rise = operands.first().and_then(|o| number(doc, o)).unwrap_or(0.0),
                "Tr" => {
                    state.render_mode = operands.first().and_then(|o| o.as_i64().ok()).unwrap_or(0)
                }

                "Td" => {
                    let tx = operands.first().and_then(|o| number(doc, o)).unwrap_or(0.0);
                    let ty = operands.get(1).and_then(|o| number(doc, o)).unwrap_or(0.0);
                    tlm = Matrix::translate(tx, ty).mul(tlm);
                    tm = tlm;
                }
                "TD" => {
                    let tx = operands.first().and_then(|o| number(doc, o)).unwrap_or(0.0);
                    let ty = operands.get(1).and_then(|o| number(doc, o)).unwrap_or(0.0);
                    state.leading = -ty;
                    tlm = Matrix::translate(tx, ty).mul(tlm);
                    tm = tlm;
                }
                "Tm" => {
                    if let Some(m) = matrix(doc, operands) {
                        tlm = m;
                        tm = m;
                    }
                }
                "T*" => {
                    tlm = Matrix::translate(0.0, -state.leading).mul(tlm);
                    tm = tlm;
                }

                "Tj" => {
                    if let Some(bytes) = operands.first().and_then(|o| o.as_str().ok()) {
                        self.show(
                            &mut fonts,
                            resources,
                            &state,
                            &mut tm,
                            &[Piece::Text(bytes)],
                        );
                    }
                }
                "TJ" => {
                    if let Ok(array) = operands.first().map(|o| o.as_array()).unwrap_or(Err(
                        lopdf::Error::ObjectType {
                            expected: "Array",
                            found: "none",
                        },
                    )) {
                        let pieces: Vec<Piece> = array
                            .iter()
                            .filter_map(|item| match item {
                                Object::String(bytes, _) => Some(Piece::Text(bytes)),
                                Object::Integer(_) | Object::Real(_) => {
                                    item.as_float().ok().map(Piece::Kern)
                                }
                                _ => None,
                            })
                            .collect();
                        self.show(&mut fonts, resources, &state, &mut tm, &pieces);
                    }
                }
                // PDF 32000-1 section 9.4.3 — `'` is `T*` then `Tj`, and `"`
                // sets the two spacings before doing the same.
                "'" | "\"" => {
                    let quoted = operation.operator == "\"";
                    if quoted {
                        state.word_spacing =
                            operands.first().and_then(|o| number(doc, o)).unwrap_or(0.0);
                        state.char_spacing =
                            operands.get(1).and_then(|o| number(doc, o)).unwrap_or(0.0);
                    }
                    tlm = Matrix::translate(0.0, -state.leading).mul(tlm);
                    tm = tlm;
                    let slot = if quoted { 2 } else { 0 };
                    if let Some(bytes) = operands.get(slot).and_then(|o| o.as_str().ok()) {
                        self.show(
                            &mut fonts,
                            resources,
                            &state,
                            &mut tm,
                            &[Piece::Text(bytes)],
                        );
                    }
                }

                "Do" => {
                    if let Some(name) = operands.first().and_then(|o| o.as_name().ok()) {
                        self.draw(resources, &state, name, depth);
                    }
                }
                "BI" => {
                    let placement = self.placed(Source::Inline, state.ctm);
                    self.images.push(placement);
                }

                _ => {}
            }
        }
    }

    /// A `Do`: either an image to be placed, or a form whose content is walked
    /// in the caller's coordinate system.
    fn draw(&mut self, resources: &Resources<'a>, state: &GState, name: &[u8], depth: u8) {
        let doc = self.doc;
        let Some(object) = resources.find(doc, b"XObject", name) else {
            return;
        };
        let Ok(stream) = object.as_stream() else {
            return;
        };
        let subtype = stream
            .dict
            .get(b"Subtype")
            .and_then(Object::as_name)
            .unwrap_or(b"");

        if subtype == b"Image" {
            let placement = self.placed(Source::XObject(stream), state.ctm);
            self.images.push(placement);
            return;
        }
        if subtype != b"Form" || depth >= MAX_FORM_DEPTH {
            return;
        }

        // A form carries its own matrix, applied before the CTM it is drawn
        // under. Files that place a whole page's content in one form use it.
        let ctm = stream
            .dict
            .get(b"Matrix")
            .and_then(Object::as_array)
            .ok()
            .and_then(|array| matrix(doc, array))
            .unwrap_or(Matrix::IDENTITY)
            .mul(state.ctm);

        let own = stream
            .dict
            .get_deref(b"Resources", doc)
            .and_then(Object::as_dict)
            .ok();
        let inner = resources.inside(own);
        if let Ok(content) = stream.decompressed_content_with_limit(MAX_PAGE_CONTENT_BYTES) {
            self.run(&content, &inner, ctm, depth + 1);
        }
    }

    /// Where the unit square under this matrix lands on the page, which is
    /// where every image goes: PDF draws an image into `(0,0)`–`(1,1)` and lets
    /// the CTM say how big that is and where.
    fn placed<'b>(&self, source: Source<'b>, ctm: Matrix) -> Placement<'b> {
        let (x, y, width, height) = self.frame.box_of([
            ctm.apply(0.0, 0.0),
            ctm.apply(1.0, 0.0),
            ctm.apply(1.0, 1.0),
            ctm.apply(0.0, 1.0),
        ]);
        Placement {
            source,
            x,
            y,
            width,
            height,
        }
    }

    /// One show-text operation. Produces at most one run, and always advances
    /// the text matrix — an undecodable string still moves the pen, and the
    /// next run's box depends on it having done so.
    fn show(
        &mut self,
        fonts: &mut HashMap<Vec<u8>, FontMetrics<'a>>,
        resources: &Resources<'a>,
        state: &GState,
        tm: &mut Matrix,
        pieces: &[Piece<'_>],
    ) {
        let doc = self.doc;
        let showed = pieces
            .iter()
            .any(|piece| matches!(piece, Piece::Text(bytes) if !bytes.is_empty()));

        let Some(name) = state.font.clone() else {
            self.undecodable |= showed;
            return;
        };
        let metrics = match fonts.entry(name) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                let font = resources
                    .find(doc, b"Font", entry.key())
                    .and_then(|object| object.as_dict().ok());
                let Some(font) = font else {
                    // Without the font there is no width either, so the matrix
                    // cannot honestly be advanced. The page still says so.
                    self.undecodable |= showed;
                    return;
                };
                entry.insert(FontMetrics::of(doc, font))
            }
        };

        let mut text = String::new();
        let mut advance = 0.0f32;
        for piece in pieces {
            match piece {
                Piece::Kern(amount) => {
                    advance -= amount / 1000.0 * state.size * state.horizontal;
                }
                Piece::Text(bytes) => {
                    text.push_str(&metrics.decode(bytes));
                    advance += run_advance(metrics, state, bytes);
                }
            }
        }

        let start = *tm;
        *tm = Matrix::translate(advance, 0.0).mul(*tm);

        // Bytes in and no characters out. A string of spaces decodes to a
        // string of spaces, so this is a decoding failure and not a blank line.
        self.undecodable |= showed && text.is_empty();

        // Modes 3 and 7 paint nothing. See the module header: this is where
        // somebody else's OCR layer stops.
        if state.render_mode == 3 || state.render_mode == 7 {
            return;
        }
        if text.trim().is_empty() || self.runs.len() >= MAX_RUNS_PER_PAGE {
            return;
        }

        // The run's rectangle in text space, before `Tm`: from the pen to where
        // the pen ended up, and from the font's descender to its ascender.
        let bottom = state.rise + metrics.descent / 1000.0 * state.size;
        let top = state.rise + metrics.ascent / 1000.0 * state.size;
        let trm = start.mul(state.ctm);
        let (x, y, width, height) = self.frame.box_of([
            trm.apply(0.0, bottom),
            trm.apply(advance, bottom),
            trm.apply(advance, top),
            trm.apply(0.0, top),
        ]);

        // The size after every matrix on the way here — what a reader would
        // measure off the page, not what the `Tf` said.
        let (_, unit_y) = state.ctm.apply(0.0, state.size);
        let (_, origin_y) = state.ctm.apply(0.0, 0.0);
        let size = (unit_y - origin_y).abs().max(0.0);

        self.runs.push(TextRun {
            text,
            x,
            y,
            width,
            height,
            size,
        });
    }
}

/// The two things a show operation is made of.
enum Piece<'a> {
    Text(&'a [u8]),
    /// A `TJ` adjustment, in thousandths of the font size, subtracted from the
    /// advance.
    Kern(f32),
}

/// PDF 32000-1 section 9.4.4: `tx = ((w0 − Tj/1000)·Tfs + Tc + Tw)·Th`, with
/// the `Tj` term handled by the caller because it arrives between strings.
fn run_advance(metrics: &FontMetrics<'_>, state: &GState, bytes: &[u8]) -> f32 {
    let mut advance = 0.0f32;
    let mut codes = bytes.iter().copied();
    loop {
        let code = if metrics.two_byte {
            let (Some(high), Some(low)) = (codes.next(), codes.next()) else {
                break;
            };
            u32::from(high) << 8 | u32::from(low)
        } else {
            let Some(byte) = codes.next() else { break };
            u32::from(byte)
        };

        let mut glyph = metrics.width(code) / 1000.0 * state.size + state.char_spacing;
        // Word spacing applies to the single-byte code 32 and to nothing else —
        // notably not to a two-byte code that happens to be 32, which is the
        // corner the spec calls out by name.
        if !metrics.two_byte && code == 32 {
            glyph += state.word_spacing;
        }
        advance += glyph * state.horizontal;
    }
    advance
}

fn matrix(doc: &Document, operands: &[Object]) -> Option<Matrix> {
    if operands.len() < 6 {
        return None;
    }
    let mut out = [0.0f32; 6];
    for (slot, value) in out.iter_mut().zip(operands) {
        *slot = number(doc, value)?;
    }
    Some(Matrix(out))
}

// ---------------------------------------------------------------------------
// Lifting a scanned page
// ---------------------------------------------------------------------------

/// Turn an image XObject into bytes something can display.
///
/// The error is a sentence rather than a code because it ends up in front of a
/// person looking at a page they can see is not blank.
///
/// `subject` is what that sentence calls the thing it could not read — "the
/// page" for a scan, "the figure" for a picture on a typed page. Threaded
/// rather than fixed because the two are not the same statement to whoever is
/// reading: "the page is a JPEG 2000 image" printed in a box halfway down a
/// page of perfectly legible text is a sentence that contradicts what is
/// around it, and it is the one this build shipped until T-329 looked at it.
fn lift(doc: &Document, stream: &Stream, subject: &str) -> std::result::Result<PageImage, String> {
    let dict = &stream.dict;
    let width = dict
        .get_deref(b"Width", doc)
        .and_then(Object::as_i64)
        .map_err(|_| "the image does not say how wide it is".to_string())?;
    let height = dict
        .get_deref(b"Height", doc)
        .and_then(Object::as_i64)
        .map_err(|_| "the image does not say how tall it is".to_string())?;
    if width <= 0 || height <= 0 || width > i64::from(u16::MAX) || height > i64::from(u16::MAX) {
        return Err(format!("the image claims to be {width} by {height} pixels"));
    }
    let (width, height) = (width as u32, height as u32);

    let filters: Vec<Vec<u8>> = stream
        .filters()
        .map(|names| names.into_iter().map(<[u8]>::to_vec).collect())
        .unwrap_or_default();

    // A DCT stream's content already *is* a JPEG file, which is the common case
    // for a colour scan and the one place this whole feature costs nothing: the
    // bytes go to the store unmodified.
    if filters.iter().any(|f| f == b"DCTDecode") {
        if filters.len() != 1 {
            return Err(format!(
                "the scan is a JPEG behind {} other filters, which this build does not unwrap",
                filters.len() - 1
            ));
        }
        return Ok(PageImage {
            bytes: stream.content.clone(),
            mime: "image/jpeg",
            width,
            height,
        });
    }

    for filter in &filters {
        if let Some(why) = unreadable(filter, subject) {
            return Err(why);
        }
    }

    let samples = stream
        .decompressed_content_with_limit(MAX_IMAGE_SAMPLE_BYTES)
        .map_err(|e| format!("the scan could not be decompressed: {e}"))?;

    let bits = dict
        .get_deref(b"BitsPerComponent", doc)
        .and_then(Object::as_i64)
        .unwrap_or(8);
    let mask = dict
        .get_deref(b"ImageMask", doc)
        .and_then(Object::as_bool)
        .unwrap_or(false);
    let space = colour_space(doc, dict);

    encode(
        &samples,
        width,
        height,
        bits,
        if mask { Space::Gray } else { space },
        subject,
    )
}

/// The image filters this build has no decoder for, each named in words.
///
/// Fax is not an exotic case for this audience — it is what a court scanner
/// emits — and the point of naming it is that a page it is on reports
/// `Unsupported` rather than blank.
fn unreadable(filter: &[u8], subject: &str) -> Option<String> {
    let what = match filter {
        b"CCITTFaxDecode" => "a fax-encoded bilevel scan",
        b"JBIG2Decode" => "a JBIG2 bilevel scan",
        b"JPXDecode" => "a JPEG 2000 image",
        _ => return None,
    };
    Some(format!(
        "{subject} is {what}, which this build cannot decode"
    ))
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Space {
    Gray,
    Rgb,
    Other,
}

fn colour_space(doc: &Document, dict: &Dictionary) -> Space {
    let Ok(object) = dict.get_deref(b"ColorSpace", doc) else {
        return Space::Gray;
    };
    let name = match object {
        Object::Name(name) => name.clone(),
        // `[/ICCBased <stream>]` and friends. The component count on the
        // stream is the only part of an ICC profile that changes how the
        // samples are laid out, and it is the only part read.
        Object::Array(array) => {
            let head = array.first().and_then(|o| o.as_name().ok()).unwrap_or(b"");
            if head == b"ICCBased" {
                let components = array
                    .get(1)
                    .map(|o| deref(doc, o))
                    .and_then(|o| o.as_stream().ok())
                    .and_then(|s| s.dict.get_deref(b"N", doc).and_then(Object::as_i64).ok())
                    .unwrap_or(0);
                return match components {
                    1 => Space::Gray,
                    3 => Space::Rgb,
                    _ => Space::Other,
                };
            }
            head.to_vec()
        }
        _ => return Space::Other,
    };
    match name.as_slice() {
        b"DeviceGray" | b"CalGray" | b"G" => Space::Gray,
        b"DeviceRGB" | b"CalRGB" | b"RGB" => Space::Rgb,
        _ => Space::Other,
    }
}

/// Raw samples to a PNG.
///
/// Three layouts are handled, and they are the three a scanner produces: eight
/// bits of grey, eight bits each of red, green and blue, and one bit of black
/// or white. Anything else — indexed palettes, CMYK, sixteen-bit — is named and
/// refused, because half-decoding a page of evidence is worse than saying it
/// could not be read.
fn encode(
    samples: &[u8],
    width: u32,
    height: u32,
    bits: i64,
    space: Space,
    subject: &str,
) -> std::result::Result<PageImage, String> {
    use image::{GrayImage, ImageFormat, RgbImage};

    let mut out = Vec::new();
    match (bits, space) {
        (8, Space::Gray) => {
            let needed = width as usize * height as usize;
            if samples.len() < needed {
                return Err(short(samples.len(), needed));
            }
            let image = GrayImage::from_raw(width, height, samples[..needed].to_vec())
                .ok_or_else(|| "the scan's samples do not fill its page".to_string())?;
            image
                .write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)
                .map_err(|e| format!("the scan could not be re-encoded: {e}"))?;
        }
        (8, Space::Rgb) => {
            let needed = width as usize * height as usize * 3;
            if samples.len() < needed {
                return Err(short(samples.len(), needed));
            }
            let image = RgbImage::from_raw(width, height, samples[..needed].to_vec())
                .ok_or_else(|| "the scan's samples do not fill its page".to_string())?;
            image
                .write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)
                .map_err(|e| format!("the scan could not be re-encoded: {e}"))?;
        }
        (1, Space::Gray) => {
            // One bit per pixel, rows padded to a byte boundary. Zero is black
            // in `DeviceGray`, which is also the way a stencil mask reads
            // without a `/Decode` telling it otherwise.
            let stride = (width as usize + 7) / 8;
            let needed = stride * height as usize;
            if samples.len() < needed {
                return Err(short(samples.len(), needed));
            }
            let mut pixels = Vec::with_capacity(width as usize * height as usize);
            for row in 0..height as usize {
                for column in 0..width as usize {
                    let byte = samples[row * stride + column / 8];
                    let bit = (byte >> (7 - (column % 8))) & 1;
                    pixels.push(if bit == 1 { 255 } else { 0 });
                }
            }
            let image = GrayImage::from_raw(width, height, pixels)
                .ok_or_else(|| "the scan's samples do not fill its page".to_string())?;
            image
                .write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)
                .map_err(|e| format!("the scan could not be re-encoded: {e}"))?;
        }
        (bits, space) => {
            let what = match space {
                Space::Gray => "greyscale",
                Space::Rgb => "colour",
                Space::Other => "an indexed or CMYK colour space",
            };
            return Err(format!(
                "{subject} is a scan in {what} at {bits} bits per component, which this build cannot decode"
            ));
        }
    }

    Ok(PageImage {
        bytes: out,
        mime: "image/png",
        width,
        height,
    })
}

fn short(got: usize, needed: usize) -> String {
    format!("the scan is {got} bytes where its own dimensions need {needed}")
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::content::{Content, Operation};
    use lopdf::{dictionary, Stream};

    /// Every fixture in this file is written here with lopdf's own writer
    /// rather than checked in as bytes. A checked-in PDF is a fixture nobody
    /// can read the diff of, and half of what is being asserted below is
    /// *arithmetic* — where a run's box lands — which is only worth asserting
    /// against a page whose geometry is visible three lines up.
    struct Builder {
        doc: Document,
        pages_id: ObjectId,
        kids: Vec<Object>,
    }

    impl Builder {
        fn new() -> Builder {
            let mut doc = Document::with_version("1.5");
            let pages_id = doc.new_object_id();
            Builder {
                doc,
                pages_id,
                kids: Vec::new(),
            }
        }

        fn stream(&mut self, dict: Dictionary, content: Vec<u8>) -> ObjectId {
            self.doc.add_object(Stream::new(dict, content))
        }

        /// Courier, with its widths written out. A fixed-pitch font is the only
        /// one whose box arithmetic can be checked by hand in a comment.
        fn courier(&mut self) -> ObjectId {
            let widths: Vec<Object> = (32..=126).map(|_| Object::Integer(600)).collect();
            let descriptor = self.doc.add_object(dictionary! {
                "Type" => "FontDescriptor",
                "FontName" => "Courier",
                "Ascent" => 629,
                "Descent" => -157,
                "MissingWidth" => 600,
            });
            self.doc.add_object(dictionary! {
                "Type" => "Font",
                "Subtype" => "Type1",
                "BaseFont" => "Courier",
                "FirstChar" => 32,
                "LastChar" => 126,
                "Widths" => widths,
                "Encoding" => "WinAnsiEncoding",
                "FontDescriptor" => descriptor,
            })
        }

        fn page(&mut self, mut page: Dictionary) {
            page.set("Type", "Page");
            page.set("Parent", self.pages_id);
            let id = self.doc.add_object(page);
            self.kids.push(id.into());
        }

        fn finish(mut self) -> Vec<u8> {
            let count = self.kids.len() as i64;
            let kids = std::mem::take(&mut self.kids);
            // `/MediaBox` sits on the page tree node, not on the pages, so
            // every fixture also exercises the inheritance climb.
            self.doc.objects.insert(
                self.pages_id,
                Object::Dictionary(dictionary! {
                    "Type" => "Pages",
                    "Kids" => kids,
                    "Count" => count,
                    "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
                }),
            );
            let catalog = self.doc.add_object(dictionary! {
                "Type" => "Catalog",
                "Pages" => self.pages_id,
            });
            self.doc.trailer.set("Root", catalog);
            let mut out = Vec::new();
            self.doc.save_to(&mut out).expect("fixture should write");
            out
        }
    }

    fn ops(operations: Vec<Operation>) -> Vec<u8> {
        Content { operations }
            .encode()
            .expect("content should encode")
    }

    fn tj(text: &str) -> Operation {
        Operation::new("Tj", vec![Object::string_literal(text)])
    }

    /// The simplest page there is: one line of Courier, one `Tj`.
    fn one_line(mode: Option<i64>) -> Vec<u8> {
        let mut builder = Builder::new();
        let font = builder.courier();
        let mut operations = vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["F1".into(), 12.into()]),
            Operation::new("Td", vec![72.into(), 720.into()]),
        ];
        if let Some(mode) = mode {
            operations.insert(1, Operation::new("Tr", vec![mode.into()]));
        }
        operations.push(tj("Hello"));
        operations.push(Operation::new("ET", vec![]));
        let content = builder.stream(Dictionary::new(), ops(operations));
        builder.page(dictionary! {
            "Contents" => content,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        });
        builder.finish()
    }

    fn runs(bytes: &[u8]) -> Vec<TextRun> {
        let reading = read_pdf_bytes(bytes).expect("fixture should read");
        assert_eq!(reading.pages.len(), 1);
        match &reading.pages[0].content {
            PageContent::Text { runs, .. } => runs.clone(),
            other => panic!("expected text, got {other:?}"),
        }
    }

    fn near(got: f32, want: f32) {
        assert!(
            (got - want).abs() < 0.01,
            "expected {want}, got {got} (off by {})",
            got - want
        );
    }

    // -- AC-687: runs, with their boxes ------------------------------------

    #[test]
    fn a_run_carries_its_text_and_its_box() {
        let runs = runs(&one_line(None));
        assert_eq!(runs.len(), 1);
        let run = &runs[0];
        assert_eq!(run.text, "Hello");

        // Five Courier glyphs at 600/1000 of 12 points.
        near(run.width, 5.0 * 0.6 * 12.0);
        // The descriptor's 629 and -157 per mille, over 12 points.
        near(run.height, 12.0 * (0.629 + 0.157));
        near(run.size, 12.0);

        // The pen is at 72 from the left, and 720 from the *bottom* in the
        // file — so 792 − 720 − 7.548 of ascender from the top.
        near(run.x, 72.0);
        near(run.y, 792.0 - 720.0 - 12.0 * 0.629);
    }

    #[test]
    fn a_second_line_is_further_down_the_page_not_further_up() {
        let mut builder = Builder::new();
        let font = builder.courier();
        let content = builder.stream(
            Dictionary::new(),
            ops(vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("TL", vec![14.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                tj("first"),
                Operation::new("T*", vec![]),
                tj("second"),
                Operation::new("ET", vec![]),
            ]),
        );
        builder.page(dictionary! {
            "Contents" => content,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        });

        let runs = runs(&builder.finish());
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].text, "first");
        assert_eq!(runs[1].text, "second");
        // `T*` moves down the page, and down the page is *plus* y once the
        // flip in `to_page` has happened. Getting this backwards is the whole
        // reason the conversion lives on this side of the line.
        near(runs[1].y - runs[0].y, 14.0);
        near(runs[1].x, runs[0].x);
    }

    #[test]
    fn a_tj_arrays_kerning_is_part_of_the_run_it_is_inside() {
        let mut builder = Builder::new();
        let font = builder.courier();
        let content = builder.stream(
            Dictionary::new(),
            ops(vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                Operation::new(
                    "TJ",
                    vec![Object::Array(vec![
                        Object::string_literal("Hello"),
                        Object::Integer(-500),
                        Object::string_literal("World"),
                    ])],
                ),
                Operation::new("ET", vec![]),
            ]),
        );
        builder.page(dictionary! {
            "Contents" => content,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        });

        let runs = runs(&builder.finish());
        assert_eq!(runs.len(), 1, "one show operation is one run");
        assert_eq!(runs[0].text, "HelloWorld");
        // Ten glyphs, plus the half-em the negative adjustment opens up.
        near(runs[0].width, 10.0 * 0.6 * 12.0 + 0.5 * 12.0);
    }

    #[test]
    fn horizontal_scaling_narrows_the_box_and_nothing_else() {
        let mut builder = Builder::new();
        let font = builder.courier();
        let content = builder.stream(
            Dictionary::new(),
            ops(vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Tz", vec![50.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                tj("Hello"),
                Operation::new("ET", vec![]),
            ]),
        );
        builder.page(dictionary! {
            "Contents" => content,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        });

        let runs = runs(&builder.finish());
        near(runs[0].width, 5.0 * 0.6 * 12.0 * 0.5);
        near(runs[0].height, 12.0 * (0.629 + 0.157));
    }

    #[test]
    fn word_spacing_reaches_the_space_and_char_spacing_reaches_everything() {
        let mut builder = Builder::new();
        let font = builder.courier();
        let content = builder.stream(
            Dictionary::new(),
            ops(vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Tc", vec![1.into()]),
                Operation::new("Tw", vec![5.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                tj("a b"),
                Operation::new("ET", vec![]),
            ]),
        );
        builder.page(dictionary! {
            "Contents" => content,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        });

        let runs = runs(&builder.finish());
        // Three glyphs, three lots of character spacing, one lot of word
        // spacing on the single space.
        near(runs[0].width, 3.0 * 0.6 * 12.0 + 3.0 * 1.0 + 5.0);
    }

    #[test]
    fn the_ctm_scales_the_text_that_is_drawn_under_it() {
        let mut builder = Builder::new();
        let font = builder.courier();
        let content = builder.stream(
            Dictionary::new(),
            ops(vec![
                Operation::new("q", vec![]),
                Operation::new(
                    "cm",
                    vec![2.into(), 0.into(), 0.into(), 2.into(), 0.into(), 0.into()],
                ),
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![36.into(), 360.into()]),
                tj("Hello"),
                Operation::new("ET", vec![]),
                Operation::new("Q", vec![]),
            ]),
        );
        builder.page(dictionary! {
            "Contents" => content,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        });

        let runs = runs(&builder.finish());
        // The same line as `a_run_carries_its_text_and_its_box`, drawn at
        // double scale from half the coordinates — so it lands in the same
        // place at twice the size.
        near(runs[0].x, 72.0);
        near(runs[0].width, 2.0 * 5.0 * 0.6 * 12.0);
        near(runs[0].size, 24.0);
        near(runs[0].y, 792.0 - 720.0 - 24.0 * 0.629);
    }

    #[test]
    fn text_inside_a_form_xobject_is_found_and_placed_by_the_forms_matrix() {
        let mut builder = Builder::new();
        let font = builder.courier();
        let inner = ops(vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["F1".into(), 12.into()]),
            Operation::new("Td", vec![0.into(), 600.into()]),
            tj("Hello"),
            Operation::new("ET", vec![]),
        ]);
        let form = builder.stream(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
                "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
            },
            inner,
        );
        let content = builder.stream(
            Dictionary::new(),
            ops(vec![
                Operation::new("q", vec![]),
                Operation::new(
                    "cm",
                    vec![
                        1.into(),
                        0.into(),
                        0.into(),
                        1.into(),
                        72.into(),
                        120.into(),
                    ],
                ),
                Operation::new("Do", vec![Object::Name(b"Fm0".to_vec())]),
                Operation::new("Q", vec![]),
            ]),
        );
        builder.page(dictionary! {
            "Contents" => content,
            "Resources" => dictionary! { "XObject" => dictionary! { "Fm0" => form } },
        });

        let runs = runs(&builder.finish());
        assert_eq!(
            runs.len(),
            1,
            "a page whose content is one form still has text on it"
        );
        near(runs[0].x, 72.0);
        near(runs[0].y, 792.0 - 720.0 - 12.0 * 0.629);
    }

    // -- the page's own frame ----------------------------------------------

    #[test]
    fn a_rotated_page_reports_the_shape_it_is_read_in() {
        let mut builder = Builder::new();
        let font = builder.courier();
        let content = builder.stream(
            Dictionary::new(),
            ops(vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                tj("Hello"),
                Operation::new("ET", vec![]),
            ]),
        );
        builder.page(dictionary! {
            "Contents" => content,
            "Rotate" => 90,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        });

        let reading = read_pdf_bytes(&builder.finish()).expect("fixture should read");
        let page = &reading.pages[0];
        near(page.width, 792.0);
        near(page.height, 612.0);

        let PageContent::Text { runs, .. } = &page.content else {
            panic!("expected text");
        };
        // A quarter turn clockwise turns a wide run into a tall one, and puts
        // what was near the top of a portrait page near its right-hand edge.
        near(runs[0].width, 12.0 * (0.629 + 0.157));
        near(runs[0].height, 5.0 * 0.6 * 12.0);
        near(runs[0].y, 72.0);
        // A quarter turn clockwise makes the page's new x axis its old y axis,
        // so the run's left edge is the descender's height *above the bottom*
        // of the file's page — which is nearly the full 792, because near the
        // top of a portrait page is near the right of a landscape one.
        near(runs[0].x, 720.0 - 12.0 * 0.157);
    }

    #[test]
    fn a_crop_box_is_the_origin_the_frontend_is_given() {
        let mut builder = Builder::new();
        let font = builder.courier();
        let content = builder.stream(
            Dictionary::new(),
            ops(vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![100.into(), 400.into()]),
                tj("Hello"),
                Operation::new("ET", vec![]),
            ]),
        );
        builder.page(dictionary! {
            "Contents" => content,
            "CropBox" => vec![72.into(), 72.into(), 540.into(), 720.into()],
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        });

        let reading = read_pdf_bytes(&builder.finish()).expect("fixture should read");
        let page = &reading.pages[0];
        near(page.width, 468.0);
        near(page.height, 648.0);

        let PageContent::Text { runs, .. } = &page.content else {
            panic!("expected text");
        };
        near(runs[0].x, 100.0 - 72.0);
        near(runs[0].y, 648.0 - (400.0 - 72.0) - 12.0 * 0.629);
    }

    // -- AC-683 and AC-684: what a page is ---------------------------------

    /// A page covered edge to edge by one image, which is what a scan is.
    fn scanned_page(builder: &mut Builder, image: ObjectId, extra: Vec<Operation>) -> Dictionary {
        let mut operations = vec![
            Operation::new("q", vec![]),
            Operation::new(
                "cm",
                vec![
                    612.into(),
                    0.into(),
                    0.into(),
                    792.into(),
                    0.into(),
                    0.into(),
                ],
            ),
            Operation::new("Do", vec![Object::Name(b"Im0".to_vec())]),
            Operation::new("Q", vec![]),
        ];
        operations.extend(extra);
        let content = builder.stream(Dictionary::new(), ops(operations));
        dictionary! {
            "Contents" => content,
            "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image } },
        }
    }

    fn jpeg_bytes() -> Vec<u8> {
        let mut out = Vec::new();
        image::RgbImage::from_fn(8, 8, |x, y| image::Rgb([x as u8 * 30, y as u8 * 30, 40]))
            .write_to(
                &mut std::io::Cursor::new(&mut out),
                image::ImageFormat::Jpeg,
            )
            .expect("jpeg should encode");
        out
    }

    fn dct_image(builder: &mut Builder, bytes: Vec<u8>) -> ObjectId {
        builder.stream(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 8,
                "Height" => 8,
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
                "Filter" => "DCTDecode",
            },
            bytes,
        )
    }

    #[test]
    fn a_jpeg_scan_reaches_the_store_as_the_bytes_that_were_already_in_the_file() {
        let mut builder = Builder::new();
        let jpeg = jpeg_bytes();
        let image = dct_image(&mut builder, jpeg.clone());
        let page = scanned_page(&mut builder, image, vec![]);
        builder.page(page);

        let reading = read_pdf_bytes(&builder.finish()).expect("fixture should read");
        let PageContent::Image(lifted) = &reading.pages[0].content else {
            panic!("expected an image, got {:?}", reading.pages[0].content);
        };
        // Byte-identical: the common colour scan costs no re-encode, which is
        // the whole reason the DCT case is checked before anything is
        // decompressed.
        assert_eq!(lifted.bytes, jpeg);
        assert_eq!(lifted.mime, "image/jpeg");
        assert_eq!((lifted.width, lifted.height), (8, 8));
    }

    #[test]
    fn a_greyscale_scan_is_re_encoded_with_its_pixels_intact() {
        let mut builder = Builder::new();
        // A ramp, so a row/column transposition or an off-by-one stride shows
        // up as a wrong pixel rather than as a uniform grey that matches
        // whatever it is compared against.
        let samples: Vec<u8> = (0..16u8).map(|i| i * 16).collect();
        let mut stream = Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 4,
                "Height" => 4,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 8,
            },
            samples.clone(),
        );
        stream.compress().expect("stream should compress");
        let image = builder.doc.add_object(stream);
        let page = scanned_page(&mut builder, image, vec![]);
        builder.page(page);

        let reading = read_pdf_bytes(&builder.finish()).expect("fixture should read");
        let PageContent::Image(lifted) = &reading.pages[0].content else {
            panic!("expected an image, got {:?}", reading.pages[0].content);
        };
        assert_eq!(lifted.mime, "image/png");
        let decoded = image::load_from_memory(&lifted.bytes)
            .expect("the lifted page should decode")
            .to_luma8();
        assert_eq!(decoded.dimensions(), (4, 4));
        assert_eq!(decoded.into_raw(), samples);
    }

    #[test]
    fn a_bilevel_scan_is_one_bit_a_pixel_and_stays_the_right_way_round() {
        let mut builder = Builder::new();
        // Four rows of four pixels, one bit each, padded to a byte per row:
        // black, white, alternating, alternating the other way.
        let samples = vec![0b0000_0000, 0b1111_0000, 0b1010_0000, 0b0101_0000];
        let image = builder.stream(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 4,
                "Height" => 4,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 1,
            },
            samples,
        );
        let page = scanned_page(&mut builder, image, vec![]);
        builder.page(page);

        let reading = read_pdf_bytes(&builder.finish()).expect("fixture should read");
        let PageContent::Image(lifted) = &reading.pages[0].content else {
            panic!("expected an image, got {:?}", reading.pages[0].content);
        };
        let decoded = image::load_from_memory(&lifted.bytes)
            .expect("the lifted page should decode")
            .to_luma8();
        assert_eq!(
            decoded.into_raw(),
            vec![
                0, 0, 0, 0, //
                255, 255, 255, 255, //
                255, 0, 255, 0, //
                0, 255, 0, 255,
            ]
        );
    }

    #[test]
    fn a_fax_encoded_page_says_so_rather_than_reading_as_blank() {
        let mut builder = Builder::new();
        let image = builder.stream(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 8,
                "Height" => 8,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 1,
                "Filter" => "CCITTFaxDecode",
            },
            vec![0u8; 8],
        );
        let page = scanned_page(&mut builder, image, vec![]);
        builder.page(page);

        let reading = read_pdf_bytes(&builder.finish()).expect("fixture should read");
        match &reading.pages[0].content {
            // AC-682's whole point. A court scanner emits this and we have no
            // decoder; calling it `Empty` would tell a journalist their filing
            // is a stack of blank sheets.
            PageContent::Unsupported(why) => assert!(
                why.contains("fax"),
                "the reason should name the format: {why}"
            ),
            other => panic!("a fax scan must not read as {other:?}"),
        }
    }

    #[test]
    fn a_page_with_nothing_on_it_is_empty() {
        let mut builder = Builder::new();
        let content = builder.stream(Dictionary::new(), Vec::new());
        builder.page(dictionary! { "Contents" => content });

        let reading = read_pdf_bytes(&builder.finish()).expect("fixture should read");
        assert_eq!(reading.pages[0].content, PageContent::Empty);
    }

    #[test]
    fn a_letterhead_logo_does_not_make_the_page_a_scan() {
        let mut builder = Builder::new();
        let image = dct_image(&mut builder, jpeg_bytes());
        let content = builder.stream(
            Dictionary::new(),
            ops(vec![
                Operation::new("q", vec![]),
                Operation::new(
                    "cm",
                    vec![
                        40.into(),
                        0.into(),
                        0.into(),
                        40.into(),
                        36.into(),
                        720.into(),
                    ],
                ),
                Operation::new("Do", vec![Object::Name(b"Im0".to_vec())]),
                Operation::new("Q", vec![]),
            ]),
        );
        builder.page(dictionary! {
            "Contents" => content,
            "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image } },
        });

        let reading = read_pdf_bytes(&builder.finish()).expect("fixture should read");
        // Forty points square on a 612 by 792 page. Lifting this would lay a
        // logo across the whole sheet and call it the evidence.
        assert_eq!(reading.pages[0].content, PageContent::Empty);
    }

    #[test]
    fn somebody_elses_ocr_layer_does_not_hide_the_scan_underneath_it() {
        let mut builder = Builder::new();
        let font = builder.courier();
        let image = dct_image(&mut builder, jpeg_bytes());
        let invisible = vec![
            Operation::new("BT", vec![]),
            // Render mode 3 paints nothing. This is what a scanner's OCR
            // layer looks like in the file.
            Operation::new("Tr", vec![3.into()]),
            Operation::new("Tf", vec!["F1".into(), 12.into()]),
            Operation::new("Td", vec![72.into(), 720.into()]),
            tj("IN THE MATTER OF"),
            Operation::new("ET", vec![]),
        ];
        let mut page = scanned_page(&mut builder, image, invisible);
        // The helper writes only the XObject; this page needs the font too.
        page.set(
            "Resources",
            dictionary! {
                "XObject" => dictionary! { "Im0" => image },
                "Font" => dictionary! { "F1" => font },
            },
        );
        builder.page(page);

        let reading = read_pdf_bytes(&builder.finish()).expect("fixture should read");
        match &reading.pages[0].content {
            PageContent::Image(_) => {}
            other => panic!("an invisible OCR layer must not turn a scan into text: {other:?}"),
        }
    }

    #[test]
    fn the_same_page_with_the_text_actually_visible_is_a_text_page() {
        // The other half of the test above. Without it, `Image` could be the
        // answer because the walker never finds the text at all, and the
        // render-mode rule would be passing vacuously.
        let mut builder = Builder::new();
        let font = builder.courier();
        let image = dct_image(&mut builder, jpeg_bytes());
        let visible = vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["F1".into(), 12.into()]),
            Operation::new("Td", vec![72.into(), 720.into()]),
            tj("IN THE MATTER OF"),
            Operation::new("ET", vec![]),
        ];
        let mut page = scanned_page(&mut builder, image, visible);
        page.set(
            "Resources",
            dictionary! {
                "XObject" => dictionary! { "Im0" => image },
                "Font" => dictionary! { "F1" => font },
            },
        );
        builder.page(page);

        let reading = read_pdf_bytes(&builder.finish()).expect("fixture should read");
        match &reading.pages[0].content {
            PageContent::Text { runs, .. } => assert_eq!(runs[0].text, "IN THE MATTER OF"),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn a_filing_is_typed_pages_with_scanned_exhibits_behind_them() {
        // AC-681, and the reason the decision is per page: one document, three
        // pages, three different answers.
        let mut builder = Builder::new();
        let font = builder.courier();
        let image = dct_image(&mut builder, jpeg_bytes());

        let typed = builder.stream(
            Dictionary::new(),
            ops(vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                tj("page one"),
                Operation::new("ET", vec![]),
            ]),
        );
        builder.page(dictionary! {
            "Contents" => typed,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        });

        let scan = scanned_page(&mut builder, image, vec![]);
        builder.page(scan);

        let blank = builder.stream(Dictionary::new(), Vec::new());
        builder.page(dictionary! { "Contents" => blank });

        let reading = read_pdf_bytes(&builder.finish()).expect("fixture should read");
        assert_eq!(reading.pages.len(), 3);
        assert_eq!(
            reading.pages.iter().map(|p| p.index).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert!(matches!(reading.pages[0].content, PageContent::Text { .. }));
        assert!(matches!(reading.pages[1].content, PageContent::Image(_)));
        assert_eq!(reading.pages[2].content, PageContent::Empty);
    }

    // -- Q-203: a text page keeps what is drawn on it ----------------------

    /// A page of text with one image drawn on it at the given size and place.
    fn illustrated(mut builder: Builder, image: ObjectId, scale: f32, at: (f32, f32)) -> Vec<u8> {
        let font = builder.courier();
        let content = builder.stream(
            Dictionary::new(),
            ops(vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                tj("see figure 1"),
                Operation::new("ET", vec![]),
                Operation::new("q", vec![]),
                Operation::new(
                    "cm",
                    vec![
                        Object::Real(scale),
                        0.into(),
                        0.into(),
                        Object::Real(scale),
                        Object::Real(at.0),
                        Object::Real(at.1),
                    ],
                ),
                Operation::new("Do", vec![Object::Name(b"Im0".to_vec())]),
                Operation::new("Q", vec![]),
            ]),
        );
        builder.page(dictionary! {
            "Contents" => content,
            "Resources" => dictionary! {
                "Font" => dictionary! { "F1" => font },
                "XObject" => dictionary! { "Im0" => image },
            },
        });
        builder.finish()
    }

    fn page_of(bytes: &[u8]) -> PageContent {
        let reading = read_pdf_bytes(bytes).expect("fixture should read");
        reading.pages[0].content.clone()
    }

    #[test]
    fn a_report_keeps_its_figure_and_says_where_on_the_page_it_sits() {
        let mut builder = Builder::new();
        let jpeg = jpeg_bytes();
        let image = dct_image(&mut builder, jpeg.clone());
        // 300 points square, low on the page.
        let content = page_of(&illustrated(builder, image, 300.0, (100.0, 200.0)));

        let PageContent::Text { runs, figures } = content else {
            panic!("expected a text page, got {content:?}");
        };
        assert_eq!(runs[0].text, "see figure 1");
        assert_eq!(figures.len(), 1, "the caption is pointing at something");

        let figure = &figures[0];
        near(figure.x, 100.0);
        near(figure.width, 300.0);
        near(figure.height, 300.0);
        // Top-left origin, same as a run's: 792 less the top of the figure.
        near(figure.y, 792.0 - (200.0 + 300.0));
        match &figure.content {
            FigureContent::Image(lifted) => assert_eq!(lifted.bytes, jpeg),
            other => panic!("this one lifts: {other:?}"),
        }
    }

    #[test]
    fn a_figure_under_a_skewed_matrix_is_boxed_by_all_four_of_its_corners() {
        // `Do` draws into the unit square and the CTM says where that lands,
        // and a CTM is any matrix at all — nothing requires it to be a
        // rectangle. Every fixture above places images square, and for a
        // rectangle each extreme is shared by two corners, so a box built from
        // only three of them comes out identical and the corner walk is never
        // actually tested. This matrix puts the minimum x on one corner alone.
        let mut builder = Builder::new();
        let font = builder.courier();
        let image = dct_image(&mut builder, jpeg_bytes());
        let content = builder.stream(
            Dictionary::new(),
            ops(vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                tj("see figure 1"),
                Operation::new("ET", vec![]),
                Operation::new("q", vec![]),
                Operation::new(
                    "cm",
                    vec![
                        300.into(),
                        0.into(),
                        (-200).into(),
                        400.into(),
                        250.into(),
                        50.into(),
                    ],
                ),
                Operation::new("Do", vec![Object::Name(b"Im0".to_vec())]),
                Operation::new("Q", vec![]),
            ]),
        );
        builder.page(dictionary! {
            "Contents" => content,
            "Resources" => dictionary! {
                "Font" => dictionary! { "F1" => font },
                "XObject" => dictionary! { "Im0" => image },
            },
        });

        let PageContent::Text { figures, .. } = page_of(&builder.finish()) else {
            panic!("expected a text page");
        };
        // The four corners land at (250,50), (550,50), (350,450) and
        // (50,450). Only the last of those is at x = 50.
        near(figures[0].x, 50.0);
        near(figures[0].width, 500.0);
        near(figures[0].y, 792.0 - 450.0);
        near(figures[0].height, 400.0);
    }

    #[test]
    fn a_letterhead_logo_is_not_a_figure_either() {
        // The same rule as the page-level one, one threshold down. Lifting
        // this would re-encode the same logo once per page of a report.
        let mut builder = Builder::new();
        let image = dct_image(&mut builder, jpeg_bytes());
        let content = page_of(&illustrated(builder, image, 40.0, (36.0, 720.0)));

        let PageContent::Text { figures, .. } = content else {
            panic!("expected a text page");
        };
        assert!(
            figures.is_empty(),
            "forty points square is a logo: {figures:?}"
        );
    }

    #[test]
    fn a_figure_that_cannot_be_lifted_still_says_where_it_was() {
        let mut builder = Builder::new();
        let image = builder.stream(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 8,
                "Height" => 8,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 1,
                "Filter" => "JBIG2Decode",
            },
            vec![0u8; 8],
        );
        let content = page_of(&illustrated(builder, image, 300.0, (100.0, 200.0)));

        let PageContent::Text { figures, .. } = content else {
            panic!("expected a text page");
        };
        assert_eq!(
            figures.len(),
            1,
            "a blank space is the failure, not the fix"
        );
        near(figures[0].width, 300.0);
        match &figures[0].content {
            FigureContent::Unsupported(why) => {
                assert!(why.contains("JBIG2"), "the reason should name it: {why}");
                // And it calls itself the figure. The reading surface prints
                // this sentence in a box halfway down a page of legible text
                // (T-329), so "the page is a JBIG2 bilevel scan" would be a
                // statement contradicted by everything around it.
                assert!(
                    why.starts_with("the figure is"),
                    "a figure's sentence must not claim to be the page's: {why}"
                );
            }
            other => panic!("this one cannot lift: {other:?}"),
        }
    }

    #[test]
    fn a_scan_with_a_stamp_across_it_is_a_text_page_that_still_has_the_scan() {
        // The page-sized image is well over the figure threshold, so the
        // clerk's stamped text no longer costs the reader the evidence.
        let mut builder = Builder::new();
        let jpeg = jpeg_bytes();
        let image = dct_image(&mut builder, jpeg.clone());
        let content = page_of(&illustrated(builder, image, 612.0, (0.0, 90.0)));

        let PageContent::Text { runs, figures } = content else {
            panic!("expected a text page");
        };
        assert_eq!(runs.len(), 1);
        assert_eq!(figures.len(), 1);
        match &figures[0].content {
            FigureContent::Image(lifted) => assert_eq!(lifted.bytes, jpeg),
            other => panic!("expected the scan: {other:?}"),
        }
    }

    // -- composite fonts, which is most of what a modern producer emits ----

    /// A `Type0`/`Identity-H` font: two-byte codes, widths in the descendant's
    /// `/W`, and characters only where a `/ToUnicode` says so. CID 65 is `Z`
    /// and CID 66 is `Y`, at 500 and 750 thousandths.
    ///
    /// Those numbers are chosen, not arbitrary. Read correctly — two bytes at
    /// a time, through the CMap — `<0041><0042>` is `ZY`. Read the way lopdf
    /// falls back to when there is no `/ToUnicode`, one byte at a time through
    /// a standard table, the same bytes come out as `AB`: wrong, and *not
    /// empty*, which is the whole danger. A fixture whose CIDs were 1 and 2
    /// would decode to nothing under either reading and would quietly test
    /// neither.
    fn identity_h(builder: &mut Builder, with_to_unicode: bool) -> ObjectId {
        let descriptor = builder.doc.add_object(dictionary! {
            "Type" => "FontDescriptor",
            "FontName" => "AAAAAA+Test",
            "Ascent" => 750,
            "Descent" => -250,
        });
        let cid_font = builder.doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "CIDFontType2",
            "BaseFont" => "AAAAAA+Test",
            "CIDSystemInfo" => dictionary! {
                "Registry" => Object::string_literal("Adobe"),
                "Ordering" => Object::string_literal("Identity"),
                "Supplement" => 0,
            },
            "DW" => 1000,
            "W" => vec![
                Object::Integer(0x41),
                Object::Array(vec![Object::Integer(500), Object::Integer(750)]),
            ],
            "FontDescriptor" => descriptor,
        });

        let mut font = dictionary! {
            "Type" => "Font",
            "Subtype" => "Type0",
            "BaseFont" => "AAAAAA+Test",
            "Encoding" => "Identity-H",
            "DescendantFonts" => vec![cid_font.into()],
        };
        if with_to_unicode {
            // Joined rather than written as one literal so the fixture cannot
            // pick up this function's indentation. The metadata block is not
            // decoration: lopdf's CMap parser requires at least one entry
            // between `begincmap` and the codespace range.
            let cmap = [
                "/CIDInit /ProcSet findresource begin",
                "12 dict begin",
                "begincmap",
                "/CIDSystemInfo",
                "<< /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
                "/CMapName /Adobe-Identity-UCS def",
                "/CMapType 2 def",
                "1 begincodespacerange",
                "<0000> <FFFF>",
                "endcodespacerange",
                "2 beginbfchar",
                "<0041> <005A>",
                "<0042> <0059>",
                "endbfchar",
                "endcmap",
                "CMapName currentdict /CMap defineresource pop",
                "end",
                "end",
            ]
            .join("\n");
            let stream = builder.stream(Dictionary::new(), cmap.into_bytes());
            font.set("ToUnicode", stream);
        }
        builder.doc.add_object(font)
    }

    /// `ZY` in `Identity-H`: two bytes a glyph, and the glyphs are CIDs. Read
    /// one byte at a time these same bytes say `AB`.
    fn zy() -> Operation {
        Operation::new(
            "Tj",
            vec![Object::String(
                vec![0x00, 0x41, 0x00, 0x42],
                lopdf::StringFormat::Hexadecimal,
            )],
        )
    }

    #[test]
    fn a_composite_font_is_read_two_bytes_at_a_time_and_measured_from_its_descendant() {
        let mut builder = Builder::new();
        let font = identity_h(&mut builder, true);
        let content = builder.stream(
            Dictionary::new(),
            ops(vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                zy(),
                Operation::new("ET", vec![]),
            ]),
        );
        builder.page(dictionary! {
            "Contents" => content,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        });

        let runs = runs(&builder.finish());
        assert_eq!(runs.len(), 1);
        // Four bytes, two glyphs, and the glyphs are not their own bytes.
        // Read one byte at a time this would be `AB`.
        assert_eq!(runs[0].text, "ZY");
        // The two widths out of `/W`, not the `/DW` default and not the
        // fallback — either of which would come out as 12 or 24 points.
        near(runs[0].width, (0.5 + 0.75) * 12.0);
        near(runs[0].height, 12.0 * (0.75 + 0.25));
    }

    #[test]
    fn a_font_that_will_not_say_what_its_codes_mean_does_not_bury_the_scan() {
        // The second door into the same room as the OCR layer. lopdf answers
        // an `Identity-H` with no `/ToUnicode` by falling back to a one-byte
        // table rather than by failing, so the temptation is to take what it
        // gives — and what it gives is noise, which is non-empty, which would
        // make this page report as text.
        let mut builder = Builder::new();
        let font = identity_h(&mut builder, false);
        let image = dct_image(&mut builder, jpeg_bytes());
        let mut page = scanned_page(
            &mut builder,
            image,
            vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                zy(),
                Operation::new("ET", vec![]),
            ],
        );
        page.set(
            "Resources",
            dictionary! {
                "XObject" => dictionary! { "Im0" => image },
                "Font" => dictionary! { "F1" => font },
            },
        );
        builder.page(page);

        let reading = read_pdf_bytes(&builder.finish()).expect("fixture should read");
        match &reading.pages[0].content {
            PageContent::Image(_) => {}
            other => panic!("the scan is what is on this page, not {other:?}"),
        }
    }

    #[test]
    fn a_page_of_unreadable_text_and_nothing_else_says_so_rather_than_reading_as_blank() {
        let mut builder = Builder::new();
        let font = identity_h(&mut builder, false);
        let content = builder.stream(
            Dictionary::new(),
            ops(vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                zy(),
                Operation::new("ET", vec![]),
            ]),
        );
        builder.page(dictionary! {
            "Contents" => content,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        });

        let reading = read_pdf_bytes(&builder.finish()).expect("fixture should read");
        match &reading.pages[0].content {
            PageContent::Unsupported(why) => {
                assert!(why.contains("font"), "the reason should name it: {why}")
            }
            other => panic!("a page with writing on it is not {other:?}"),
        }
    }

    #[test]
    fn something_that_is_not_a_pdf_is_refused_rather_than_read_as_empty() {
        let error =
            read_pdf_bytes(b"this is not a document at all").expect_err("a text file is not a PDF");
        assert!(matches!(error, Error::Malformed(_)), "got {error:?}");
    }

    // --- what the folder's tab is written from (T-267) ---------------------

    /// A document of `count` blank pages, with `title` in its `/Info` if given
    /// as raw bytes — raw, because half of what is under test is *which*
    /// encoding those bytes are in.
    fn titled(count: usize, title: Option<&[u8]>) -> Vec<u8> {
        let mut builder = Builder::new();
        for _ in 0..count {
            builder.page(dictionary! {});
        }
        if let Some(title) = title {
            let info = builder.doc.add_object(dictionary! {
                "Title" => Object::String(title.to_vec(), lopdf::StringFormat::Literal),
            });
            builder.doc.trailer.set("Info", info);
        }
        builder.finish()
    }

    #[test]
    fn a_probe_counts_the_pages_without_reading_one() {
        let bytes = titled(7, None);
        // Through the `Reader` rather than through `probe`, because the claim is
        // about work done and only the reader can be asked (T-299).
        let reader = Reader::open_bytes(&bytes).expect("fixture should open");
        assert_eq!(reader.page_count(), 7);
        assert_eq!(reader.pages_read(), 0, "a page count is not a page read");

        let probe = probe(&bytes, "application/pdf", false).expect("a PDF probes");
        assert_eq!(probe.pages, 7);
    }

    #[test]
    fn the_mime_decides_which_kind_of_document_this_is() {
        // The bytes really are a document; the mime is what decides, because it
        // is the store's answer after sniffing and the one thing that has looked
        // at the file (T-260). It was two kinds of answer before T-298 and is
        // three now — the middle one being that there is more than one sort of
        // document, and they are counted differently and labelled the same.
        let bytes = titled(1, None);
        assert_eq!(probe(&bytes, "video/mp4", false), None);
        assert_eq!(probe(&bytes, "application/pdf", false).map(|p| p.pages), Some(1));
        assert_eq!(probe(b"a memo\n", "text/plain", false).map(|p| p.pages), Some(1));
    }

    #[test]
    fn a_document_this_build_cannot_open_probes_as_nothing_rather_than_failing() {
        // 6% of the files D-47 swept. A paste is not refused over it — the
        // folder simply has no page count on it.
        assert_eq!(
            probe(b"%PDF-1.7 and then nonsense", "application/pdf", false),
            None
        );
    }

    #[test]
    fn a_title_is_read_in_each_of_the_three_encodings_a_pdf_may_write_it_in() {
        let latin = titled(1, Some(b"Findings"));
        assert_eq!(
            probe(&latin, "application/pdf", false)
                .and_then(|p| p.title)
                .as_deref(),
            Some("Findings")
        );

        // UTF-16BE with a byte order mark, which is what every producer that
        // has ever seen a non-ASCII character writes. Read as bytes it is every
        // other character a NUL, which is why the mark is checked first.
        let mut utf16 = vec![0xFE, 0xFF];
        for unit in "Rapport financier".encode_utf16() {
            utf16.extend_from_slice(&unit.to_be_bytes());
        }
        assert_eq!(
            probe(&titled(1, Some(&utf16)), "application/pdf", false)
                .and_then(|p| p.title)
                .as_deref(),
            Some("Rapport financier")
        );

        // PDFDocEncoding, which is Latin-1 except in the two ranges where it is
        // not: 0x90 is a right single quote and 0x84 an em dash. Those are the
        // *spec's* code points and not Windows-1252's, where the same two bytes
        // are a private-use control and a low double quote — the two encodings
        // disagree about almost the whole of `0x80`–`0x9F`, and this is the one
        // that PDF 32000-1 section 7.9.2.2 says a text string is written in.
        let quoted = probe(
            &titled(1, Some(b"O\x90Brien \x84 statement")),
            "application/pdf",
            false,
        )
        .and_then(|p| p.title);
        assert_eq!(quoted.as_deref(), Some("O\u{2019}Brien \u{2014} statement"));
    }

    #[test]
    fn a_title_that_says_nothing_is_no_title_at_all() {
        // Three ways to be absent, and a tab cannot tell them apart: no `/Info`
        // dictionary, an `/Info` with no `/Title`, and a `/Title` of whitespace.
        assert_eq!(
            probe(&titled(1, None), "application/pdf", false).and_then(|p| p.title),
            None
        );
        assert_eq!(
            probe(&titled(1, Some(b"   \r\n\t ")), "application/pdf", false).and_then(|p| p.title),
            None
        );
    }

    #[test]
    fn a_title_is_collapsed_and_capped_because_it_is_going_on_a_label() {
        let ragged = titled(1, Some(b"  Interim\n\treport   2019  "));
        assert_eq!(
            probe(&ragged, "application/pdf", false)
                .and_then(|p| p.title)
                .as_deref(),
            Some("Interim report 2019")
        );

        let long = "x".repeat(400);
        let capped = probe(&titled(1, Some(long.as_bytes())), "application/pdf", false)
            .and_then(|p| p.title)
            .expect("a long title is still a title");
        assert_eq!(capped.chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn the_cap_counts_characters_rather_than_bytes() {
        // Four bytes each in UTF-8. Cutting by bytes would end the string in the
        // middle of one, which is not a string at all.
        let long: String = std::iter::repeat_n('\u{1F600}', 200).collect();
        let mut utf16 = vec![0xFE, 0xFF];
        for unit in long.encode_utf16() {
            utf16.extend_from_slice(&unit.to_be_bytes());
        }
        let capped = probe(&titled(1, Some(&utf16)), "application/pdf", false)
            .and_then(|p| p.title)
            .expect("emoji are a title too");
        assert_eq!(capped.chars().count(), MAX_TITLE_CHARS);
        assert!(capped.chars().all(|c| c == '\u{1F600}'));
    }

    // --- the other kind of document (T-298) ---------------------------------

    /// Two pages' worth of text and a little over, so the count is a rule being
    /// applied rather than a file that happens to be short.
    fn statement() -> String {
        (0..crate::text::ROWS * 2 + 3)
            .map(|n| format!("line {n} of the statement"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_text_file_is_probed_for_pages_and_never_for_a_title() {
        let text = statement();
        let probe = probe(text.as_bytes(), "text/plain", false).expect("text is a document");
        assert_eq!(probe.pages, 3);
        // Permanently. A text file has no dictionary to state a name in, and
        // taking its first line instead would be a reading of the evidence.
        assert_eq!(probe.title, None);
        // And the record agrees with the reader, which is the whole point of
        // one door: the thickness a peer draws is the page a reader turns to.
        let reader = Reader::open_text(text, false).expect("open");
        assert_eq!(reader.page_count(), 3);
        assert_eq!(reader.title(), None);
    }

    #[test]
    fn a_probe_still_refuses_anything_that_is_not_a_document() {
        assert_eq!(probe(b"hello", "image/png", false), None);
        assert_eq!(probe(b"hello", "audio/mpeg", false), None);
        // Called with a mime the bytes contradict, which is the one way this
        // can be reached: the caller passes the record's mime, not a guess.
        assert_eq!(probe(&[0xff, 0xd8, 0xff], "text/plain", false), None);
    }

    #[test]
    fn the_pages_of_a_text_file_are_the_file() {
        // AC-779 and the property a citation rests on. Reading every page back
        // in order reproduces the document exactly, so a page is a place in the
        // file rather than a place in a rendering of it.
        let text = statement();
        let reading = Reader::open_text(text.clone(), false).expect("open").read_all();
        assert_eq!(reading.pages.len(), 3);
        let rebuilt: String = reading
            .pages
            .iter()
            .map(|page| match &page.content {
                PageContent::Plain(text) => text.as_str(),
                other => panic!("a text file's page is not {other:?}"),
            })
            .collect();
        assert_eq!(rebuilt, text);
        // One-based and in order, like a PDF's, so a reference does not have to
        // know which kind of document it came from.
        assert_eq!(
            reading.pages.iter().map(|p| p.index).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
    }

    // --- T-346: a markdown file read as what it says -------------------------

    /// The reader's own view of a markdown file, since `markdown.rs` tests the
    /// parser and this tests the substitution being *in the pipeline*.
    #[test]
    fn reads_markdown_as_its_words_and_says_which_were_a_heading() {
        let source = "## The statement\n\nHe came on the **Tuesday** train.\n";
        let plain = Reader::open_text(source.into(), false).expect("open");
        let read = Reader::open_text(source.into(), true).expect("open");

        // The same file, read two ways, and the flag is the only difference.
        let PageContent::Plain(as_written) = plain.page(1).unwrap().content else {
            panic!("a text file is a plain page");
        };
        assert!(as_written.contains("##"), "unflagged, the marks stay");

        let page = read.page(1).unwrap();
        let PageContent::Plain(as_read) = &page.content else {
            panic!("a markdown file is still a plain page — D-65");
        };
        assert!(!as_read.contains('#') && !as_read.contains('*'));
        assert_eq!(page.roles.first().map(|s| s.role), Some(crate::markdown::Role::Heading(2)));
    }

    #[test]
    fn counts_a_markdown_files_pages_over_the_words_it_will_show() {
        // The record's count and the reader's pagination are the same number,
        // and this is where they could come apart: `probe` runs at ingest over
        // the bytes and the reader runs later over the read text. A file whose
        // marks alone push it past a page boundary would otherwise draw a
        // folder a page too thick and print "1 of 3" on a two page document.
        let mut source = String::new();
        for i in 0..crate::text::ROWS {
            // Every line marked up, so the marks are a real share of the bytes.
            source.push_str(&format!("- **item {i}** see [a page](https://example.com/a/very/long/address)\n"));
        }
        let bytes = source.as_bytes();

        let as_written = probe(bytes, "text/plain", false).expect("probes").pages;
        let as_read = probe(bytes, "text/plain", true).expect("probes").pages;
        assert!(as_read < as_written, "taking the marks off must shorten it");

        let reader = Reader::open_text(source.clone(), true).expect("open");
        assert_eq!(reader.page_count() as u32, as_read, "the record and the reader disagree");
    }

    #[test]
    fn a_markdown_files_pages_still_tile_the_text_they_were_cut_from() {
        // `text.rs`'s invariant, which every page reference on this board rests
        // on: concatenating the pages reproduces the document. Markdown does not
        // get to be the exception — it substitutes the text *before* the tiling,
        // exactly as a transcript does, rather than cutting differently.
        let mut source = String::new();
        for i in 0..crate::text::ROWS * 2 {
            source.push_str(&format!("## Heading {i}\n\nSome *words* here.\n\n"));
        }
        let reader = Reader::open_text(source, true).expect("open");
        let mut whole = String::new();
        for index in 1..=reader.page_count() as u32 {
            let PageContent::Plain(text) = reader.page(index).unwrap().content else {
                panic!("plain");
            };
            whole.push_str(&text);
        }
        let Inner::Plain { text, .. } = &reader.inner else {
            panic!("plain");
        };
        assert_eq!(&whole, text, "the pages do not tile the read text");
    }

    #[test]
    fn clips_a_role_that_straddles_a_page_rather_than_dropping_it() {
        // A cue is a point and belongs to the page it opens on. A role is a
        // stretch, and a block quote long enough to cross a page boundary would
        // otherwise have its second half drawn as ordinary prose — the reader
        // silently losing the one thing this feature is for.
        //
        // Blank quoted lines between them, and that is the fixture doing what
        // the module says rather than a flourish: consecutive `>` lines are one
        // *paragraph* and reflow onto one line, so the first version of this
        // fixture was fifty-one lines that came back as a single page.
        let mut source = String::new();
        for i in 0..crate::text::ROWS + 5 {
            source.push_str(&format!("> quoted line {i}\n>\n"));
        }
        let reader = Reader::open_text(source, true).expect("open");
        assert!(reader.page_count() > 1, "the fixture must cross a page");
        for index in 1..=reader.page_count() as u32 {
            let page = reader.page(index).unwrap();
            let PageContent::Plain(text) = &page.content else {
                panic!("plain");
            };
            let quoted = page
                .roles
                .iter()
                .find(|s| s.role == crate::markdown::Role::Quote)
                .unwrap_or_else(|| panic!("page {index} lost the quote"));
            // In this page's own offsets, and inside it — the same rebasing
            // `cues` gets, in UTF-16 for the same DOM caret.
            assert!(quoted.end <= text.encode_utf16().count());
        }
    }

    #[test]
    fn a_plain_page_declares_no_shape_because_the_sheet_is_the_boards() {
        let page = Reader::open_text("a memo\n".into(), false)
            .expect("open")
            .page(1)
            .expect("page one");
        assert_eq!((page.width, page.height), (0.0, 0.0));
    }

    #[test]
    fn a_text_page_is_asked_for_by_number_and_only_the_ones_that_exist_answer() {
        let reader = Reader::open_text(statement(), false).expect("open");
        assert_eq!(reader.page(0), None, "there is no page zero");
        assert!(reader.page(1).is_some());
        assert!(reader.page(3).is_some());
        assert_eq!(reader.page(4), None);
        assert_eq!(reader.pages_read(), 2, "only the pages asked for were cut");
    }

    #[test]
    fn opening_a_file_reads_it_as_whatever_its_own_bytes_say_it_is() {
        let dir = tempfile::tempdir().expect("tempdir");

        // Both under a name that says nothing, because a name is not the
        // evidence: the store holds originals under their hash.
        let text_path = dir.path().join("aa");
        std::fs::write(&text_path, statement()).expect("write");
        let reader = Reader::open(&text_path, false).expect("text opens");
        assert_eq!(reader.page_count(), 3);
        assert!(matches!(
            reader.page(1).map(|p| p.content),
            Some(PageContent::Plain(_))
        ));

        let pdf_path = dir.path().join("bb");
        std::fs::write(&pdf_path, titled(2, None)).expect("write");
        let reader = Reader::open(&pdf_path, false).expect("a pdf still opens");
        assert_eq!(reader.page_count(), 2);
        assert!(!matches!(
            reader.page(1).map(|p| p.content),
            Some(PageContent::Plain(_))
        ));

        // And bytes that are neither are an error rather than an empty document.
        let junk = dir.path().join("cc");
        std::fs::write(&junk, [0xff, 0xd8, 0xff, 0x00]).expect("write");
        assert!(Reader::open(&junk, false).is_err());
    }

    #[test]
    fn a_text_file_with_more_pages_than_this_build_will_read_is_refused() {
        // The same bound as a page tree's, refused rather than trimmed: a
        // folder claiming pages nobody can turn to is worse than one with no
        // thickness written on it at all.
        let huge = "\n".repeat(crate::text::ROWS * (MAX_PAGES + 1));
        assert!(matches!(
            Reader::open_text(huge.clone(), false),
            Err(Error::TooLarge(_))
        ));
        assert_eq!(probe(huge.as_bytes(), "text/plain", false), None);
    }

    // -- T-280: the text a search is matched against -----------------------

    /// A document with one of each page a reader can meet, in the order the
    /// assertions below read them.
    fn four_kinds() -> Vec<u8> {
        let mut builder = Builder::new();
        let font = builder.courier();

        // 1: typed.
        let typed = builder.stream(
            Dictionary::new(),
            ops(vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                tj("Witness statement"),
                Operation::new("ET", vec![]),
            ]),
        );
        builder.page(dictionary! {
            "Contents" => typed,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        });

        // 2: a scan.
        let image = dct_image(&mut builder, jpeg_bytes());
        let scan = scanned_page(&mut builder, image, vec![]);
        builder.page(scan);

        // 3: blank.
        let blank = builder.stream(Dictionary::new(), ops(vec![]));
        builder.page(dictionary! { "Contents" => blank });

        // 4: a scan this build cannot lift — CMYK, which `lift` names and
        //    refuses rather than half-decoding.
        let cmyk = builder.stream(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 8,
                "Height" => 8,
                "ColorSpace" => "DeviceCMYK",
                "BitsPerComponent" => 8,
            },
            vec![0u8; 8 * 8 * 4],
        );
        let page = scanned_page(&mut builder, cmyk, vec![]);
        builder.page(page);

        builder.finish()
    }

    #[test]
    fn the_index_and_the_reading_surface_agree_page_for_page_about_what_says_something() {
        let bytes = four_kinds();
        let reader = Reader::open_bytes(&bytes).expect("fixture should read");
        let drawn = reader.read_all();
        let said = reader.read_text();
        assert_eq!(drawn.pages.len(), 4);
        assert_eq!(said.len(), 4);

        // The pairing is the claim. A page the reader draws as text is a page
        // the index has characters for, and a page the reader draws as a
        // picture is one the index calls a scan — so the search field can never
        // say a page is unsearchable while the page beside it shows words.
        for (page, text) in drawn.pages.iter().zip(&said) {
            match (&page.content, text) {
                (PageContent::Text { .. }, PageText::Text(_)) => {}
                (PageContent::Image(_), PageText::None(NoText::Scan)) => {}
                (PageContent::Empty, PageText::None(NoText::Empty)) => {}
                // Page 4: the reader has to say it cannot show the scan, and
                // the index only has to say there are no words on it. Both are
                // "a picture with nothing to read", which is the one thing a
                // search is asking.
                (PageContent::Unsupported(_), PageText::None(NoText::Scan)) => {}
                (drawn, said) => panic!("page {}: {drawn:?} against {said:?}", page.index),
            }
        }

        let PageText::Text(first) = &said[0] else {
            panic!("page 1 should say something");
        };
        assert_eq!(first, "Witness statement");
    }

    #[test]
    fn naming_a_scan_costs_no_lift() {
        // Page 4 of the fixture is a scan whose bytes `lift` refuses. The
        // reading surface can only report that; the index names it a scan
        // anyway, which it could not do if it had gone through `lift` to find
        // out. This is the whole of why `read_text` is affordable on a filing
        // that is two hundred scanned exhibits.
        let bytes = four_kinds();
        let reader = Reader::open_bytes(&bytes).expect("fixture should read");
        assert!(matches!(
            reader.read_all().pages[3].content,
            PageContent::Unsupported(_)
        ));
        assert_eq!(reader.read_text()[3], PageText::None(NoText::Scan));
    }

    /// T-287, Q-301. The reader is where the substitution has to hold: a
    /// transcript that paginated as its markup would put cue numbers and arrow
    /// timestamps on the sheet, into the search index, and onto a quote card.
    #[test]
    fn a_transcript_is_read_as_its_speech_and_carries_when_each_line_was_said() {
        let srt = "1
00:00:00,000 --> 00:00:03,200
He came up from Wexford.

                   2
00:00:03,200 --> 00:00:07,400
I asked him twice.
";
        let reader = Reader::open_text(srt.to_owned(), false).expect("a transcript should read");

        let page = reader.page(1).expect("page one");
        let PageContent::Plain(shown) = &page.content else {
            panic!("a transcript is plain text on paper");
        };
        assert_eq!(shown, "He came up from Wexford.
I asked him twice.");
        assert!(!shown.contains("-->"), "the packaging is not the speech");

        // And the moment each line was said crosses beside it, rebased into
        // the page — which is what a citation is built from.
        assert_eq!(page.cues.len(), 2);
        assert_eq!(page.cues[0].offset, 0);
        assert_eq!(page.cues[0].at, 0.0);
        assert_eq!(&shown[page.cues[1].offset..][..7], "I asked");
        assert_eq!(page.cues[1].at, 3.2);

        // The index reads the same words, so searching a recording cannot
        // match on a timestamp nobody said.
        assert_eq!(
            reader.read_text()[0],
            PageText::Text("He came up from Wexford.
I asked him twice.".into())
        );
    }

    /// The units the offset is in, which is the one thing a byte count and a
    /// DOM caret disagree about the moment a transcript stops being ASCII.
    #[test]
    fn a_cue_offset_is_counted_the_way_the_caret_that_reads_it_counts() {
        // Four accented characters ahead of the second cue: two bytes each in
        // UTF-8 and one code unit each in a JavaScript string.
        let srt = "1\n00:00:01,000 --> 00:00:02,000\nr\u{e9}pondit-il tr\u{e8}s t\u{f4}t \u{e0}\n\n\
                   2\n00:00:05,000 --> 00:00:06,000\nand then in English\n";
        let reader = Reader::open_text(srt.to_owned(), false).expect("a transcript should read");
        let page = reader.page(1).expect("page one");
        let PageContent::Plain(shown) = &page.content else {
            panic!("a transcript is plain text on paper");
        };

        let second = page.cues[1].offset;
        let utf16: Vec<u16> = shown.encode_utf16().collect();
        let from_there = String::from_utf16(&utf16[second..]).expect("valid");
        assert!(
            from_there.starts_with("and then"),
            "cited from {from_there:?}"
        );
        // And the byte offset would not have been, which is what makes the
        // conversion load-bearing rather than tidy.
        assert_ne!(second, shown.find("and then").expect("present"));
    }

    /// The other half of the same rule, and the one that protects everything
    /// else: an ordinary text file must not lose a line to the cue parser.
    #[test]
    fn a_text_file_that_merely_mentions_an_arrow_is_read_whole() {
        let notes = "the flow is A --> B
and back again
";
        let reader = Reader::open_text(notes.to_owned(), false).expect("a text file should read");
        let page = reader.page(1).expect("page one");
        let PageContent::Plain(shown) = &page.content else {
            panic!("a text file is plain text");
        };
        assert_eq!(shown, notes);
        assert!(page.cues.is_empty());
    }

    #[test]
    fn a_page_whose_font_will_not_say_what_its_codes_mean_is_unreadable_rather_than_blank() {
        // The same page `decide` calls `Unsupported`: bytes are shown and no
        // characters come back. It must not read as an empty page, because an
        // empty page is a page there is nothing on and this is a page nobody
        // can search.
        let bytes = one_line(None);
        let reader = Reader::open_bytes(&bytes).expect("fixture should read");
        assert!(matches!(reader.read_text()[0], PageText::Text(_)));

        let mut builder = Builder::new();
        let font = identity_h(&mut builder, false);
        let content = builder.stream(
            Dictionary::new(),
            ops(vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                zy(),
                Operation::new("ET", vec![]),
            ]),
        );
        builder.page(dictionary! {
            "Contents" => content,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
        });
        let reader = Reader::open_bytes(&builder.finish()).expect("fixture should read");
        assert_eq!(reader.read_text()[0], PageText::None(NoText::Unreadable));
    }

    #[test]
    fn a_text_files_pages_say_exactly_what_the_reading_surface_sets_on_them() {
        // One writer for the pagination (T-298/D-60) means the index cannot cut
        // a text file anywhere the reader does not, so a page reference taken
        // from a search is a page reference the reader can turn to.
        let text = (1..=300)
            .map(|n| format!("line {n} of the statement"))
            .collect::<Vec<_>>()
            .join("\n");
        let reader = Reader::open_text(text, false).expect("text should read");
        let drawn = reader.read_all();
        let said = reader.read_text();
        assert!(drawn.pages.len() > 1, "the fixture should run to two pages");
        assert_eq!(said.len(), drawn.pages.len());
        for (page, text) in drawn.pages.iter().zip(&said) {
            let PageContent::Plain(shown) = &page.content else {
                panic!("a text file's page is plain, got {:?}", page.content);
            };
            assert_eq!(text, &PageText::Text(shown.clone()));
        }
    }

    #[test]
    fn read_text_reads_every_page_and_read_all_is_not_what_it_calls() {
        let bytes = four_kinds();
        let reader = Reader::open_bytes(&bytes).expect("fixture should read");
        assert_eq!(reader.pages_read(), 0);
        let _ = reader.read_text();
        assert_eq!(reader.pages_read(), 4);
    }

    // -- the gap rule ------------------------------------------------------

    fn run(text: &str) -> TextRun {
        TextRun {
            text: text.into(),
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
            size: 12.0,
        }
    }

    #[test]
    fn two_runs_get_one_gap_between_them_and_never_two() {
        // A PDF splits a line at every font and kerning change. Joining bare
        // would make "witness statement" unfindable in a file that set the two
        // words in two runs, and joining blindly would make it unfindable in
        // one that already put the space in.
        assert_eq!(joined(&[run("witness"), run("statement")]), "witness statement");
        assert_eq!(joined(&[run("witness "), run("statement")]), "witness statement");
        assert_eq!(joined(&[run("witness"), run(" statement")]), "witness statement");
        // And a gap is never invented in front of the first run.
        assert_eq!(joined(&[run("witness")]), "witness");
        assert_eq!(joined(&[]), "");
    }

    /// The cases both sides of the boundary are held to.
    ///
    /// `render/items/dom.ts`'s `linesOfRuns` reads the same file and asserts the
    /// same tokens, which is the promise the two implementations can keep: the
    /// same non-space characters in the same order. See [`joined`] for why it is
    /// not "the same string".
    #[test]
    fn the_gap_rule_agrees_with_the_reading_surfaces_line_rule() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("run-joining.json");
        let raw = std::fs::read_to_string(&path).expect("the shared fixture should be readable");
        let cases: serde_json::Value = serde_json::from_str(&raw).expect("valid json");
        let cases = cases.as_array().expect("an array of cases");
        assert!(!cases.is_empty());
        for case in cases {
            let runs: Vec<TextRun> = case["runs"]
                .as_array()
                .expect("runs")
                .iter()
                .map(|r| TextRun {
                    text: r["text"].as_str().expect("text").to_string(),
                    x: r["x"].as_f64().unwrap_or(0.0) as f32,
                    y: r["y"].as_f64().unwrap_or(0.0) as f32,
                    width: r["width"].as_f64().unwrap_or(0.0) as f32,
                    height: r["height"].as_f64().unwrap_or(12.0) as f32,
                    size: 12.0,
                })
                .collect();
            let want: Vec<String> = case["tokens"]
                .as_array()
                .expect("tokens")
                .iter()
                .map(|t| t.as_str().expect("token").to_string())
                .collect();
            let got: Vec<String> = joined(&runs)
                .split_whitespace()
                .map(str::to_string)
                .collect();
            assert_eq!(got, want, "case {}", case["name"]);
        }
    }
}

