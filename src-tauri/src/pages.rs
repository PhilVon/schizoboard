//! Pages, produced on demand from the file they came from and kept nowhere that
//! outlives the window.
//!
//! > Page text, transcripts and any other extracted content are a **derived
//! > local index** and never enter the document. — D-46 section 2
//!
//! Q-206 settled that a scanned page's *image* is the same kind of thing as its
//! text: derived, local, and rebuildable from the one authoritative artefact,
//! which is the file. So a two-hundred-page scan is not two hundred assets. It
//! is one asset and two hundred things this module can make again whenever it
//! is asked.
//!
//! ## What that buys, and it is most of the task
//!
//! Nothing here reaches the asset store. There is no hash to put in the
//! document, so `referencedAssets` cannot miss it, the boot sweep cannot collect
//! it, a bundle cannot silently omit it, and no `WANT` is ever sent for it —
//! **by construction, rather than because four places were taught a new rule.**
//! That is AC-692, and the reason it reads as a short module rather than a long
//! one. The test that pins it counts the files in a store before and after
//! reading every page of a document in it.
//!
//! The other half is AC-694. Everything in here can be thrown away at any
//! moment — evicted, closed, or lost to the process ending — and the cost is
//! time. There is no state to migrate, no state to repair, and no state that can
//! be *wrong*: a page is derived from content-addressed bytes, so a page cached
//! against a hash stays true for as long as that hash exists.
//!
//! ## Why one open document and not several
//!
//! Measured, because it is the one cost here that is not obvious. Holding a
//! document open costs approximately **the size of the file**: a 51 MB scan adds
//! 53 MB of working set, a 77 MB file adds 77 MB. With the asset ceiling at 512
//! MB, two open documents is potentially a gigabyte of resident memory for a
//! feature whose visible output is a page of text.
//!
//! So one is held, and the reading surface says when it is finished with it
//! ([`PageStore::close`]). Turning between two open folders costs a reload each
//! way — 3 to 53 ms on the files measured, against the 57 to 92 ms a page of a
//! scan costs to produce anyway. That is the trade taken: page-turning inside
//! one document is fast, and comparing two is not free but is not slow either.
//!
//! The *pages* outlive the open document deliberately. They are small, bounded,
//! and still true after the file is closed, so shutting a folder and opening it
//! again does not re-do the work.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::document::{FigureContent, Page, PageContent, Reader, Result};

/// Derived page bytes held at once.
///
/// A page of a 300 dpi scan re-encodes to something like half a megabyte, so
/// this is a hundred-odd pages — more than anybody reads in one sitting, and
/// small beside the document that produced them. It is a ceiling on *derived*
/// data: exceeding it costs a re-read, never a loss.
const MAX_CACHED_BYTES: usize = 64 * 1024 * 1024;

/// One document held open, and the pages it has been asked for.
pub struct PageStore {
    inner: Mutex<Inner>,
    max_bytes: usize,
}

struct Inner {
    /// The hash of the file currently open, and the reader over it. One, for
    /// the memory reason in the module header.
    open: Option<(String, Reader)>,
    /// Pages produced so far, oldest use first. A `VecDeque` rather than a map
    /// plus a list because the whole structure is a hundred entries at its
    /// ceiling — a linear scan of that is cheaper than the bookkeeping that
    /// would replace it, and it is not on any frame's path.
    cached: VecDeque<(Key, Arc<Page>)>,
    bytes: usize,
}

type Key = (String, u32);

impl Default for PageStore {
    fn default() -> Self {
        PageStore::with_capacity(MAX_CACHED_BYTES)
    }
}

impl PageStore {
    pub fn with_capacity(max_bytes: usize) -> PageStore {
        PageStore {
            inner: Mutex::new(Inner {
                open: None,
                cached: VecDeque::new(),
                bytes: 0,
            }),
            max_bytes,
        }
    }

    /// How many pages this document has, without reading one.
    ///
    /// It comes out of the page tree, which is part of the structure load — so
    /// this is the 3-to-53 ms half of the cost and none of the per-page half.
    /// The reading surface needs it to say "1 of 200" before it has read any.
    pub fn page_count(&self, hash: &str, path: &Path) -> Result<usize> {
        let mut inner = self.inner.lock().expect("page store");
        inner.ensure_open(hash, path)?;
        Ok(inner
            .open
            .as_ref()
            .map(|(_, reader)| reader.page_count())
            .unwrap_or(0))
    }

    /// One page, by the number printed on it.
    ///
    /// `None` is "there is no such page", which is not the same answer as a page
    /// that turned out to be [`PageContent::Empty`].
    pub fn page(&self, hash: &str, path: &Path, index: u32) -> Result<Option<Arc<Page>>> {
        let key = (hash.to_string(), index);
        let mut inner = self.inner.lock().expect("page store");
        if let Some(hit) = inner.take_cached(&key) {
            inner.cached.push_back((key, Arc::clone(&hit)));
            return Ok(Some(hit));
        }

        inner.ensure_open(hash, path)?;
        let Some(page) = inner
            .open
            .as_ref()
            .and_then(|(_, reader)| reader.page(index))
        else {
            return Ok(None);
        };

        let page = Arc::new(page);
        inner.bytes += weight(&page);
        inner.cached.push_back((key, Arc::clone(&page)));
        inner.evict_to(self.max_bytes);
        Ok(Some(page))
    }

    /// The folder has been shut. Let go of the file.
    ///
    /// The pages stay: they are bounded, they are small, and they are still true
    /// — so opening the same folder again does not re-do the work. It is the
    /// document-sized allocation that had to be given back.
    pub fn close(&self, hash: &str) {
        let mut inner = self.inner.lock().expect("page store");
        if inner.open.as_ref().is_some_and(|(open, _)| open == hash) {
            inner.open = None;
        }
    }

    /// The file itself is gone. Nothing derived from it is worth keeping.
    pub fn forget(&self, hash: &str) {
        let mut inner = self.inner.lock().expect("page store");
        if inner.open.as_ref().is_some_and(|(open, _)| open == hash) {
            inner.open = None;
        }
        let mut kept = VecDeque::with_capacity(inner.cached.len());
        let mut bytes = 0;
        while let Some((key, page)) = inner.cached.pop_front() {
            if key.0 != hash {
                bytes += weight(&page);
                kept.push_back((key, page));
            }
        }
        inner.cached = kept;
        inner.bytes = bytes;
    }

    /// Derived bytes currently held. For the tests, and for anything that wants
    /// to say what this is costing.
    pub fn cached_bytes(&self) -> usize {
        self.inner.lock().expect("page store").bytes
    }

    /// Pages the currently open document has actually produced. Zero when
    /// nothing is open. See [`Reader::pages_read`] for why this is counted.
    pub fn pages_produced(&self) -> usize {
        self.inner
            .lock()
            .expect("page store")
            .open
            .as_ref()
            .map(|(_, reader)| reader.pages_read())
            .unwrap_or(0)
    }
}

impl Inner {
    fn ensure_open(&mut self, hash: &str, path: &Path) -> Result<()> {
        if self.open.as_ref().is_some_and(|(open, _)| open == hash) {
            return Ok(());
        }
        // These two lines are not one line, and the difference is the whole
        // point of holding one document. `self.open = Some(Reader::open(..)?)`
        // evaluates the load *first* and drops the old reader afterwards, so
        // for the length of that load both documents are resident — which on
        // two large filings is exactly the gigabyte this design exists to
        // avoid. Dropping first costs a reload nobody can measure and bounds
        // the peak.
        //
        // No test covers this: peak memory during a call is not observable
        // from the outside, and a mutation that collapses these two into one
        // passes everything below. It is written down here because that makes
        // it a decision rather than a line somebody tidies away.
        self.open = None;
        self.open = Some((hash.to_string(), Reader::open(path)?));
        Ok(())
    }

    fn take_cached(&mut self, key: &Key) -> Option<Arc<Page>> {
        let at = self.cached.iter().position(|(k, _)| k == key)?;
        self.cached.remove(at).map(|(_, page)| page)
    }

    fn evict_to(&mut self, max_bytes: usize) {
        // Never evicts the page just inserted, even if that page alone is over
        // the ceiling: a reader who asked for an enormous page gets it, and the
        // ceiling reasserts itself on the next one. The alternative is a page
        // that cannot be read at all on a document made of them.
        while self.bytes > max_bytes && self.cached.len() > 1 {
            if let Some((_, page)) = self.cached.pop_front() {
                self.bytes = self.bytes.saturating_sub(weight(&page));
            }
        }
    }
}

/// What one page costs to keep.
///
/// Images dominate by three orders of magnitude, which is why the text is
/// counted at all rather than assumed free: a page of dense text with no figure
/// is the case where the image count is zero and something still has to be.
fn weight(page: &Page) -> usize {
    match &page.content {
        PageContent::Image(image) => image.bytes.len(),
        PageContent::Text { runs, figures } => {
            let text: usize = runs.iter().map(|run| run.text.len()).sum();
            let lifted: usize = figures
                .iter()
                .map(|figure| match &figure.content {
                    FigureContent::Image(image) => image.bytes.len(),
                    FigureContent::Unsupported(why) => why.len(),
                })
                .sum();
            text + lifted
        }
        // The whole page, because that is what it is: a page of a text file is
        // its characters and there is nothing else on it to dominate them.
        PageContent::Plain(text) => text.len(),
        PageContent::Empty => 0,
        PageContent::Unsupported(why) => why.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::Write;

    use lopdf::content::{Content, Operation};
    use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};

    /// A document of `count` pages, each one a scan: a single image covering the
    /// whole sheet.
    ///
    /// Every page carries a *different* image, which is the point. A fixture
    /// whose pages shared one object would let a per-page reader and a
    /// whole-document reader produce the same allocation, and the eviction
    /// tests below would prove nothing.
    fn scan(count: u32, edge: u32) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut kids: Vec<Object> = Vec::new();

        for page in 0..count {
            let image = dct_image(&mut doc, jpeg_bytes(edge, page), edge);
            let content = doc.add_object(Stream::new(
                Dictionary::new(),
                Content {
                    operations: vec![
                        Operation::new("q", vec![]),
                        Operation::new(
                            "cm",
                            vec![612.into(), 0.into(), 0.into(), 792.into(), 0.into(), 0.into()],
                        ),
                        Operation::new("Do", vec![Object::Name(b"Im0".to_vec())]),
                        Operation::new("Q", vec![]),
                    ],
                }
                .encode()
                .expect("content should encode"),
            ));
            let id = doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content,
                "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image } },
            });
            kids.push(id.into());
        }

        let total = kids.len() as i64;
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => total,
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            }),
        );
        let catalog = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog);
        let mut out = Vec::new();
        doc.save_to(&mut out).expect("fixture should write");
        out
    }

    fn jpeg_bytes(edge: u32, seed: u32) -> Vec<u8> {
        let mut out = Vec::new();
        image::RgbImage::from_fn(edge, edge, |x, y| {
            image::Rgb([
                x.wrapping_mul(7).wrapping_add(seed.wrapping_mul(37)) as u8,
                y.wrapping_mul(11).wrapping_add(seed.wrapping_mul(53)) as u8,
                seed.wrapping_mul(91) as u8,
            ])
        })
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg)
        .expect("jpeg should encode");
        out
    }

    fn dct_image(doc: &mut Document, bytes: Vec<u8>, edge: u32) -> ObjectId {
        doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => edge as i64,
                "Height" => edge as i64,
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
                "Filter" => "DCTDecode",
            },
            bytes,
        ))
    }

    /// Fixtures live on disk because that is where a store keeps an asset, and
    /// because [`PageStore`] deliberately takes a path rather than bytes: it
    /// must not hold the file in memory on top of the document parsed from it.
    fn on_disk(bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("scan.pdf");
        std::fs::File::create(&path)
            .expect("create")
            .write_all(bytes)
            .expect("write");
        (dir, path)
    }

    #[test]
    fn a_page_is_read_without_reading_the_rest() {
        // AC-693. Twenty pages of scan, one asked for: the derived bytes held
        // afterwards are one page's worth and not twenty. Measured on a real
        // hundred-page scan, the difference this stands for is 57 ms of work
        // against 5,860 ms.
        let (_dir, path) = on_disk(&scan(20, 64));
        let store = PageStore::default();
        assert_eq!(store.page_count("aa", &path).unwrap(), 20);

        let page = store.page("aa", &path, 1).unwrap().expect("page 1");
        let one = weight(&page);
        assert!(one > 0, "the fixture pages have to weigh something");
        assert_eq!(store.cached_bytes(), one);
        // Bytes held is the weaker half of this. A reader that read all twenty
        // and kept one would satisfy the line above and be twelve seconds
        // slower on a real filing, so what is actually asserted is the work.
        assert_eq!(store.pages_produced(), 1, "one page asked for, one page read");
    }

    #[test]
    fn the_page_count_costs_no_pages() {
        let (_dir, path) = on_disk(&scan(20, 64));
        let store = PageStore::default();
        assert_eq!(store.page_count("aa", &path).unwrap(), 20);
        assert_eq!(store.cached_bytes(), 0);
        assert_eq!(store.pages_produced(), 0, "counting pages is not reading them");
    }

    #[test]
    fn a_page_asked_for_twice_is_produced_once() {
        let (_dir, path) = on_disk(&scan(4, 64));
        let store = PageStore::default();
        let first = store.page("aa", &path, 2).unwrap().expect("page 2");
        let second = store.page("aa", &path, 2).unwrap().expect("page 2 again");
        assert!(
            Arc::ptr_eq(&first, &second),
            "the second read should hand back the page already produced"
        );
        assert_eq!(store.pages_produced(), 1, "the second ask did no work");
        assert_eq!(store.cached_bytes(), weight(&first));
    }

    #[test]
    fn there_is_no_page_zero_and_no_page_past_the_end() {
        let (_dir, path) = on_disk(&scan(3, 64));
        let store = PageStore::default();
        assert!(store.page("aa", &path, 0).unwrap().is_none());
        assert!(store.page("aa", &path, 4).unwrap().is_none());
        // No answer is not a page, so nothing was kept for one.
        assert_eq!(store.cached_bytes(), 0);
    }

    #[test]
    fn the_ceiling_holds_and_what_goes_is_the_least_recently_read() {
        let (_dir, path) = on_disk(&scan(6, 64));
        let one = {
            let store = PageStore::default();
            weight(&store.page("aa", &path, 1).unwrap().unwrap())
        };

        // Room for two pages and a half, then four pages read through it.
        let ceiling = one * 2 + one / 2;
        let store = PageStore::with_capacity(ceiling);
        for index in 1..=3 {
            store.page("aa", &path, index).unwrap().unwrap();
        }
        // Read page 2 again so that page 3 is now the older of the two, then
        // push a fourth in to force an eviction.
        store.page("aa", &path, 2).unwrap().unwrap();
        store.page("aa", &path, 4).unwrap().unwrap();

        assert!(store.cached_bytes() <= ceiling, "held {}", store.cached_bytes());
        let inner = store.inner.lock().unwrap();
        let held: Vec<u32> = inner.cached.iter().map(|((_, index), _)| *index).collect();
        assert!(held.contains(&2), "page 2 was read most recently: {held:?}");
        assert!(held.contains(&4), "page 4 was just read: {held:?}");
        assert!(!held.contains(&1), "page 1 was the oldest: {held:?}");
    }

    #[test]
    fn one_page_over_the_ceiling_is_still_returned() {
        // A document whose pages are each bigger than the whole cache is a
        // document that cannot be read at all if eviction is allowed to take
        // the page that was just asked for.
        let (_dir, path) = on_disk(&scan(3, 64));
        let store = PageStore::with_capacity(1);
        let page = store.page("aa", &path, 2).unwrap().expect("page 2");
        assert!(weight(&page) > 1);
        assert_eq!(store.cached_bytes(), weight(&page));
    }

    #[test]
    fn closing_a_folder_lets_go_of_the_file_and_keeps_the_pages() {
        let (_dir, path) = on_disk(&scan(4, 64));
        let store = PageStore::default();
        let page = store.page("aa", &path, 1).unwrap().expect("page 1");
        store.close("aa");
        assert!(
            store.inner.lock().unwrap().open.is_none(),
            "the document itself should have been let go"
        );
        assert_eq!(store.cached_bytes(), weight(&page));

        // And the page is still the one already produced, not a re-read.
        let again = store.page("aa", &path, 1).unwrap().expect("page 1 again");
        assert!(Arc::ptr_eq(&page, &again));
    }

    #[test]
    fn forgetting_a_file_forgets_only_its_pages() {
        let (_dir_a, a) = on_disk(&scan(3, 64));
        let (_dir_b, b) = on_disk(&scan(3, 48));
        let store = PageStore::default();
        let from_a = weight(&store.page("aa", &a, 1).unwrap().unwrap());
        let from_b = weight(&store.page("bb", &b, 1).unwrap().unwrap());
        assert_eq!(store.cached_bytes(), from_a + from_b);

        store.forget("aa");
        assert_eq!(store.cached_bytes(), from_b);
        let held: Vec<String> = store
            .inner
            .lock()
            .unwrap()
            .cached
            .iter()
            .map(|((hash, _), _)| hash.clone())
            .collect();
        assert_eq!(held, vec!["bb".to_string()]);
    }

    #[test]
    fn a_second_document_replaces_the_first_rather_than_joining_it() {
        // The measurement behind this: holding a document open costs about the
        // size of the file — a 51 MB scan adds 53 MB of working set — and the
        // asset ceiling is 512 MB. Two at once is potentially a gigabyte.
        //
        // What this asserts is the *resting* state, which is the half a test
        // can see. The other half — that they are never both resident even for
        // the length of a load — is a property of the two lines in
        // `ensure_open` and is argued there, because no assertion reaches it.
        let (_dir_a, a) = on_disk(&scan(3, 64));
        let (_dir_b, b) = on_disk(&scan(3, 48));
        let store = PageStore::default();
        store.page("aa", &a, 1).unwrap().unwrap();
        store.page("bb", &b, 1).unwrap().unwrap();
        let inner = store.inner.lock().unwrap();
        assert_eq!(inner.open.as_ref().map(|(hash, _)| hash.as_str()), Some("bb"));
    }

    #[test]
    fn a_file_that_is_not_there_is_an_error_rather_than_a_panic() {
        let store = PageStore::default();
        assert!(store.page("aa", Path::new("no/such/file.pdf"), 1).is_err());
        assert!(store.page_count("aa", Path::new("no/such/file.pdf")).is_err());
    }

    #[test]
    fn reading_every_page_of_a_document_adds_nothing_to_the_store() {
        // AC-692, and the whole of Q-206 in one assertion. A derived page has
        // no hash, so there is nothing to write into the document, nothing for
        // `referencedAssets` to miss, nothing for the boot sweep to collect and
        // nothing for a bundle to omit. This is the test that fails the day
        // somebody decides a page should be "just" ingested like a photograph.
        let dir = tempfile::tempdir().expect("tempdir");
        let store = crate::assets::AssetStore::new(dir.path().join("assets")).expect("store");
        let meta = store.ingest_bytes(&scan(12, 64), None).expect("ingest");
        assert_eq!(meta.mime, "application/pdf");

        let root = dir.path().join("assets");
        let before = crate::assets::walk_files(&root).expect("walk").len();
        let path = store
            .resolve(&meta.sha256, crate::assets::Variant::Original)
            .expect("resolve")
            .path;

        let pages = PageStore::default();
        assert_eq!(pages.page_count(&meta.sha256, &path).unwrap(), 12);
        for index in 1..=12 {
            pages.page(&meta.sha256, &path, index).unwrap().expect("page");
        }
        assert!(pages.cached_bytes() > 0, "twelve pages should have been produced");

        let after = crate::assets::walk_files(&root).expect("walk").len();
        assert_eq!(before, after, "reading pages must write nothing to the store");
    }

    #[test]
    fn a_page_reference_into_a_text_file_resolves_the_same_after_everything_derived_is_lost() {
        // AC-783, and the whole of T-298 in one assertion. A PDF's page
        // reference is stable because the file states its own pagination; a
        // text file's is stable because the rule that gave it one reads nothing
        // but the bytes. Two stores that have never met, over a file with no
        // pages of its own, agree about what page two is.
        let text: String = (0..crate::text::ROWS * 2 + 5)
            .map(|n| format!("paragraph {n}, and what the witness said about it"))
            .collect::<Vec<_>>()
            .join("\n");
        let (_dir, path) = on_disk(text.as_bytes());

        let first = PageStore::default();
        let second = PageStore::default();
        assert_eq!(first.page_count("aa", &path).unwrap(), 3);
        for index in 1..=3 {
            let a = first.page("aa", &path, index).unwrap().expect("page");
            let b = second.page("aa", &path, index).unwrap().expect("page");
            assert_eq!(a.as_ref(), b.as_ref(), "page {index}");
        }

        // Throwing the derived pages away costs time and nothing else — the
        // same claim AC-694 makes for a scan, now for the kind of document
        // whose pages this build invented rather than read.
        first.forget("aa");
        assert_eq!(first.cached_bytes(), 0);
        assert_eq!(
            first.page("aa", &path, 2).unwrap().expect("page"),
            second.page("aa", &path, 2).unwrap().expect("page")
        );
    }

    #[test]
    fn losing_every_derived_page_costs_time_and_nothing_else() {
        // AC-694. Two stores that have never met produce identical pages from
        // the same file, because the file is the only thing that was ever
        // authoritative. There is no state in here that can go stale, and none
        // that can be wrong — only absent.
        let (_dir, path) = on_disk(&scan(5, 64));
        let first = PageStore::default();
        let second = PageStore::default();
        for index in 1..=5 {
            let a = first.page("aa", &path, index).unwrap().expect("page");
            let b = second.page("aa", &path, index).unwrap().expect("page");
            assert_eq!(a.as_ref(), b.as_ref(), "page {index}");
        }
    }
}
