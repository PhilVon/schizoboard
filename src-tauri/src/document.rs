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
//!   surface sets the runs onto our own paper, and a quote cites one.
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
}

/// What a page turned out to be. See the module header for why `Unsupported` is
/// not folded into `Empty`.
#[derive(Debug, Clone, PartialEq)]
pub enum PageContent {
    Text(Vec<TextRun>),
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

/// A scanned page, lifted.
///
/// Deliberately not `Serialize`: what crosses to the frontend is a hash, and
/// there is no hash until the store has the bytes. Which store, at what
/// refcount, and what two hundred of them do to the sweep and the wire is
/// T-299's subject, so this module hands over bytes and stops.
#[derive(Debug, Clone, PartialEq)]
pub struct PageImage {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
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

/// Read a PDF off the disk.
///
/// The path is the store's, not the user's — by the time anything gets here the
/// bytes have already been ingested and hashed, so this never sees a name a
/// person typed.
pub fn read_pdf(path: &Path) -> Result<Reading> {
    let options = LoadOptions::with_max_decompressed_size(MAX_STRUCTURE_BYTES);
    let doc = Document::load_with_options(path, options)
        .map_err(|e| Error::Malformed(e.to_string()))?;
    read_document(&doc)
}

/// Read a PDF already in memory. The tests build their fixtures this way, and
/// so does anything that has the bytes but no file.
pub fn read_pdf_bytes(bytes: &[u8]) -> Result<Reading> {
    let options = LoadOptions::with_max_decompressed_size(MAX_STRUCTURE_BYTES);
    let doc = Document::load_mem_with_options(bytes, options)
        .map_err(|e| Error::Malformed(e.to_string()))?;
    read_document(&doc)
}

fn read_document(doc: &Document) -> Result<Reading> {
    // `is_encrypted` is not "was this file encrypted" — lopdf strips `/Encrypt`
    // from the trailer the moment it successfully decrypts, which it does for
    // the empty user password. So this is true only when the bytes are still
    // ciphertext, which is the one case where reading on would hand back a
    // document made of noise.
    if doc.is_encrypted() {
        return Err(Error::Encrypted);
    }

    let ids = doc.get_pages();
    if ids.len() > MAX_PAGES {
        return Err(Error::TooLarge(format!(
            "{} pages is more than this build will read",
            ids.len()
        )));
    }

    let mut pages = Vec::with_capacity(ids.len());
    for (index, page_id) in ids {
        pages.push(read_page(doc, index, page_id));
    }
    Ok(Reading { pages })
}

// ---------------------------------------------------------------------------
// One page
// ---------------------------------------------------------------------------

fn read_page(doc: &Document, index: u32, page_id: ObjectId) -> Page {
    let frame = PageFrame::of(doc, page_id);
    let (width, height) = frame.size();

    let resources = page_resources(doc, page_id);
    let content = match doc.get_page_content_with_limit(page_id, MAX_PAGE_CONTENT_BYTES) {
        Ok(bytes) => bytes,
        // A page whose content will not decompress within the bound is not a
        // page we can say anything about. It is not blank, so it does not get
        // to read as blank.
        Err(e) => {
            return Page {
                index,
                width,
                height,
                content: PageContent::Unsupported(format!("the page could not be read: {e}")),
            };
        }
    };

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

    Page {
        index,
        width,
        height,
        content: decide(doc, runs, images, width * height, undecodable),
    }
}

/// The per-page decision, which is AC-684 and is the whole of it.
///
/// Text wins over an image, because D-46 section 4 re-typesets what it can and
/// only shows the original where there is nothing to set. A page with both — a
/// typed page carrying a figure — is a text page, and the figure is not lifted:
/// the decision the design asked for is which of the two a page *is*, not a
/// merge of the two.
fn decide(
    doc: &Document,
    runs: Vec<TextRun>,
    images: Vec<Placement<'_>>,
    page_area: f32,
    undecodable: bool,
) -> PageContent {
    if runs.iter().any(|run| !run.text.trim().is_empty()) {
        return PageContent::Text(runs);
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
        .max_by(|a, b| a.area.total_cmp(&b.area));

    let Some(candidate) = biggest else {
        return nothing(undecodable);
    };
    if page_area <= 0.0 || candidate.area / page_area < SCAN_COVERAGE {
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
        Source::XObject(stream) => match lift(doc, stream) {
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
                if r % 90 == 0 { r as i32 } else { 0 }
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
            if let Some(dw) = cid_font.get_deref(b"DW", doc).ok().and_then(|o| number(doc, o)) {
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
        self.widths.get(&code).copied().unwrap_or(self.default_width)
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
    /// The area of the page, in square points, the image covers.
    area: f32,
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
                    state.font = operands.first().and_then(|o| o.as_name().ok()).map(<[u8]>::to_vec);
                    state.size = operands.get(1).and_then(|o| number(doc, o)).unwrap_or(0.0);
                }
                "Tc" => state.char_spacing = operands.first().and_then(|o| number(doc, o)).unwrap_or(0.0),
                "Tw" => state.word_spacing = operands.first().and_then(|o| number(doc, o)).unwrap_or(0.0),
                "Tz" => {
                    state.horizontal =
                        operands.first().and_then(|o| number(doc, o)).unwrap_or(100.0) / 100.0
                }
                "TL" => state.leading = operands.first().and_then(|o| number(doc, o)).unwrap_or(0.0),
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
                        self.show(&mut fonts, resources, &state, &mut tm, &[Piece::Text(bytes)]);
                    }
                }
                "TJ" => {
                    if let Ok(array) = operands.first().map(|o| o.as_array()).unwrap_or(Err(
                        lopdf::Error::ObjectType { expected: "Array", found: "none" },
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
                        self.show(&mut fonts, resources, &state, &mut tm, &[Piece::Text(bytes)]);
                    }
                }

                "Do" => {
                    if let Some(name) = operands.first().and_then(|o| o.as_name().ok()) {
                        self.draw(resources, &state, name, depth);
                    }
                }
                "BI" => self.images.push(Placement {
                    source: Source::Inline,
                    area: self.covered(state.ctm),
                }),

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
        let Ok(stream) = object.as_stream() else { return };
        let subtype = stream.dict.get(b"Subtype").and_then(Object::as_name).unwrap_or(b"");

        if subtype == b"Image" {
            self.images.push(Placement {
                source: Source::XObject(stream),
                area: self.covered(state.ctm),
            });
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

        let own = stream.dict.get_deref(b"Resources", doc).and_then(Object::as_dict).ok();
        let inner = resources.inside(own);
        if let Ok(content) = stream.decompressed_content_with_limit(MAX_PAGE_CONTENT_BYTES) {
            self.run(&content, &inner, ctm, depth + 1);
        }
    }

    /// The area of the page covered by the unit square under this matrix, which
    /// is where every image goes: PDF draws an image into `(0,0)`–`(1,1)` and
    /// lets the CTM say how big that is.
    fn covered(&self, ctm: Matrix) -> f32 {
        let (_, _, w, h) = self.frame.box_of([
            ctm.apply(0.0, 0.0),
            ctm.apply(1.0, 0.0),
            ctm.apply(1.0, 1.0),
            ctm.apply(0.0, 1.0),
        ]);
        w * h
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

/// Turn a page-sized image XObject into bytes something can display.
///
/// The error is a sentence rather than a code because it ends up in front of a
/// person looking at a page they can see is not blank.
fn lift(doc: &Document, stream: &Stream) -> std::result::Result<PageImage, String> {
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
        if let Some(why) = unreadable(filter) {
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

    encode(&samples, width, height, bits, if mask { Space::Gray } else { space })
}

/// The image filters this build has no decoder for, each named in words.
///
/// Fax is not an exotic case for this audience — it is what a court scanner
/// emits — and the point of naming it is that a page it is on reports
/// `Unsupported` rather than blank.
fn unreadable(filter: &[u8]) -> Option<String> {
    let what = match filter {
        b"CCITTFaxDecode" => "a fax-encoded bilevel scan",
        b"JBIG2Decode" => "a JBIG2 bilevel scan",
        b"JPXDecode" => "a JPEG 2000 image",
        _ => return None,
    };
    Some(format!("the page is {what}, which this build cannot decode"))
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
                "the page is a scan in {what} at {bits} bits per component, which this build cannot decode"
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
        Content { operations }.encode().expect("content should encode")
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
            PageContent::Text(runs) => runs.clone(),
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
                    vec![1.into(), 0.into(), 0.into(), 1.into(), 72.into(), 120.into()],
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
        assert_eq!(runs.len(), 1, "a page whose content is one form still has text on it");
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

        let PageContent::Text(runs) = &page.content else {
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

        let PageContent::Text(runs) = &page.content else {
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
                vec![612.into(), 0.into(), 0.into(), 792.into(), 0.into(), 0.into()],
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
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg)
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
                    vec![40.into(), 0.into(), 0.into(), 40.into(), 36.into(), 720.into()],
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
            other => panic!(
                "an invisible OCR layer must not turn a scan into text: {other:?}"
            ),
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
            PageContent::Text(runs) => assert_eq!(runs[0].text, "IN THE MATTER OF"),
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
        assert!(matches!(reading.pages[0].content, PageContent::Text(_)));
        assert!(matches!(reading.pages[1].content, PageContent::Image(_)));
        assert_eq!(reading.pages[2].content, PageContent::Empty);
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
        let error = read_pdf_bytes(b"this is not a document at all")
            .expect_err("a text file is not a PDF");
        assert!(matches!(error, Error::Malformed(_)), "got {error:?}");
    }
}
