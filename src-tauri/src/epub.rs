//! An `.epub` read as its words — T-354.
//!
//! The last of T-322's four, and the only one that arrives already divided.
//!
//! ## What an epub is, in three files
//!
//! `META-INF/container.xml` — at a fixed path, because otherwise nothing could
//! find anything — points at a **package document**. The package holds a
//! `<manifest>` naming every file in the book and a `<spine>` saying which of
//! them are *read*, in order. Each spine item is one XHTML document.
//!
//! So the walk is: find the package, read the spine, and set each chapter's
//! words down in turn. A cover image, a stylesheet and a navigation document
//! are all in the manifest and none of them is in the spine, which is how the
//! format itself answers a question this board otherwise could not.
//!
//! ## The XHTML in here is not the HTML D-66 refused, and the difference is
//! the whole reason this module exists
//!
//! D-66 says a `.html` file dropped on the board is refused, because the sheet
//! draws six roles and a *web page* is a layout — nav, sidebar, columns — and
//! nothing can tell an article-shaped page from a real one.
//!
//! **An epub's XHTML is neither of those things.** It is a chapter of a book:
//! headings, paragraphs, lists, quotations and emphasis, authored as a document
//! by somebody who was writing rather than arranging. And the part D-66 could
//! not solve is solved here *by the format* rather than by a heuristic — the
//! reader-mode problem is "which of this page is the writing", and the spine
//! answers it exactly, from the author, with no scoring and no guessing.
//!
//! Which is why the walker below is deliberately **private to this module**. It
//! is not an HTML reader that happens to live here; it reads the six things a
//! book chapter says, and pointing it at a saved web page would reopen a
//! decision that has already been made.

use std::io::Read;

use quick_xml::events::{BytesStart, Event};

use crate::prose::{Out, Reading, Role};

/// Where every epub keeps the pointer to its package document. Fixed by OCF,
/// which is the same clause that pins `mimetype` to the first entry and makes
/// [`crate::assets::sniff_mime`]'s epub arm possible.
const CONTAINER: &str = "META-INF/container.xml";

/// How much decompressed XML this build will read from one book.
///
/// [`crate::docx`]'s bound and its reasoning, over the whole spine rather than
/// one part: a zip entry states its own uncompressed size and a malicious one
/// can lie, so this counts what is actually read.
const MAX_BOOK_BYTES: usize = 64 * 1024 * 1024;

/// Read an epub as its words, or `None` if these bytes are not one.
pub fn read(bytes: &[u8]) -> Option<Reading> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let package_path = package_path(&mut archive)?;
    let package = entry(&mut archive, &package_path)?;
    let chapters = spine(&package);
    // Relative to the package document's own directory, which is where an
    // `href` in the manifest is measured from — a book with its package in
    // `OEBPS/` and its chapters beside it writes `ch1.xhtml`, not
    // `OEBPS/ch1.xhtml`.
    let base = parent_of(&package_path);

    let mut out = Out::default();
    let mut budget = MAX_BOOK_BYTES;
    let mut first = true;
    for href in chapters {
        let Some(path) = join(&base, &href) else {
            continue;
        };
        let Some(xhtml) = entry(&mut archive, &path) else {
            // A spine entry naming a file that is not in the package is a
            // broken book, and the chapters that *are* there are still worth
            // reading. Skipped rather than refused, for `docx.rs`'s reason: a
            // reader should lose the part it cannot read and not the rest.
            continue;
        };
        budget = budget.saturating_sub(xhtml.len());
        if budget == 0 {
            break;
        }
        // **A chapter boundary is a page boundary** — Q-337. A form feed, so
        // `text::paginate` needs not one line changed: it is the fourth time
        // this board says the same sentence, after a text file's own form feed,
        // an `.rtf`'s page control word and a `.docx`'s typed break.
        //
        // Not before the first, or the book opens on a blank page.
        if !first {
            out.page_break();
        }
        first = false;
        chapter(&xhtml, &mut out);
    }

    Some(out.finish())
}

/// The path of the package document, from the one file whose location is fixed.
fn package_path<R: Read + std::io::Seek>(archive: &mut zip::ZipArchive<R>) -> Option<String> {
    let container = entry(archive, CONTAINER)?;
    let mut reader = quick_xml::Reader::from_str(&container);
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag) | Event::Empty(tag)) => {
                if tag.local_name().as_ref() == b"rootfile" {
                    if let Some(path) = attribute(&tag, "full-path") {
                        return Some(path);
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => return None,
            _ => {}
        }
    }
}

/// The chapters, in the order the spine states them.
///
/// The manifest is read first because a spine names *identifiers* and the
/// manifest is what turns one into a file. Both live in the same document, and
/// the manifest is required to come first, but this does not rely on that: it
/// collects the manifest as it goes and resolves the spine at the end.
fn spine(package: &str) -> Vec<String> {
    let mut reader = quick_xml::Reader::from_str(package);
    let mut manifest: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut order: Vec<String> = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag) | Event::Empty(tag)) => match tag.local_name().as_ref() {
                b"item" => {
                    if let (Some(id), Some(href)) = (attribute(&tag, "id"), attribute(&tag, "href"))
                    {
                        manifest.insert(id, href);
                    }
                }
                b"itemref" => {
                    // `linear="no"` is the format saying this is an aside — a
                    // note page, an advertisement — reachable but not part of
                    // the reading. Left out, because the spine's whole value
                    // here is that it says what the reading *is*.
                    if attribute(&tag, "linear").as_deref() == Some("no") {
                        continue;
                    }
                    if let Some(idref) = attribute(&tag, "idref") {
                        order.push(idref);
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    order
        .into_iter()
        .filter_map(|id| manifest.get(&id).cloned())
        .collect()
}

/// One chapter's words, appended to the book being built.
///
/// The six roles and nothing else. Everything a chapter can contain that the
/// sheet cannot set — a figure, a table, a footnote marker, a stylesheet class
/// — is either read as the words in it or dropped, which is `markdown.rs`'s
/// rule and the failure mode all four of these readers want.
fn chapter(xhtml: &str, out: &mut Out) {
    let mut reader = quick_xml::Reader::from_str(xhtml);
    // XHTML is XML, but a book in the wild is not always well-formed and a
    // reader that gave up on the first stray `<br>` would read very few of
    // them.
    reader.config_mut().check_end_names = false;

    let mut state = State::default();
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                let name = lower(tag.local_name().as_ref());
                start(&name, out, &mut state);
            }
            Ok(Event::Empty(tag)) => {
                let name = lower(tag.local_name().as_ref());
                if name == "br" {
                    out.line();
                }
            }
            Ok(Event::End(tag)) => {
                let name = lower(tag.local_name().as_ref());
                end(&name, out, &mut state);
            }
            Ok(Event::Text(text)) => {
                if state.skipping == 0 {
                    if let Ok(text) = text.decode() {
                        state.pending.push_str(&text);
                    }
                }
            }
            Ok(Event::GeneralRef(reference)) => {
                if state.skipping == 0 {
                    if let Some(ch) = crate::docx::entity(&reference) {
                        state.pending.push(ch);
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        flush(out, &mut state);
    }
    flush(out, &mut state);
    while state.open > 0 {
        out.close();
        state.open -= 1;
    }
}

#[derive(Default)]
struct State {
    /// How deeply nested we are inside something whose text is not the book's —
    /// a `<script>`, a `<style>`, the `<head>`. A depth rather than a flag,
    /// because these nest.
    skipping: u32,
    /// List nesting, so an item knows how far in it is.
    depth: u8,
    /// Spans this chapter has opened and not yet closed, so the end of the
    /// chapter closes exactly them.
    open: u32,
    /// Characters seen since the last element boundary. Held for
    /// [`crate::docx`]'s reason: an entity reference splits a run of text into
    /// several events, and whitespace has to be judged over the whole of it.
    pending: String,
}

/// Push what has accumulated, with runs of whitespace collapsed.
///
/// **Collapsed and not preserved**, which is the opposite of `docx.rs` and is
/// right for the opposite reason: XHTML source is indented and wrapped by
/// whoever wrote it, and every one of those newlines is insignificant by the
/// language's own rule. A paragraph reflows onto the 66-column grid anyway, so
/// honouring the source's wrapping would set it ragged against a measure it was
/// never written for — `markdown.rs`'s argument about a soft break, in a second
/// format.
fn flush(out: &mut Out, state: &mut State) {
    if state.pending.is_empty() {
        return;
    }
    let text = std::mem::take(&mut state.pending);
    // **Both edges, and the leading one was missed first time round.** A text
    // node between two elements is whitespace at both ends of it — the space
    // after `</strong>` in "…the <strong>Tuesday</strong> train…" is the *start*
    // of the next node, not the end of the last — and dropping it gave
    // "theTuesdaytrain". One edge is half a rule.
    let leading = text.starts_with(char::is_whitespace);
    let trailing = text.ends_with(char::is_whitespace);

    let mut collapsed = String::with_capacity(text.len());
    let mut gap = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            gap = true;
            continue;
        }
        if gap && !collapsed.is_empty() {
            collapsed.push(' ');
        }
        gap = false;
        collapsed.push(ch);
    }

    if collapsed.is_empty() {
        // Whitespace and nothing else, which is what sits between two elements
        // on separate lines of the source.
        out.space();
        return;
    }
    if leading {
        out.space();
    }
    out.push(&collapsed);
    if trailing {
        out.space();
    }
}

fn start(name: &str, out: &mut Out, state: &mut State) {
    if state.skipping > 0 {
        // Everything inside a skipped element is skipped, including elements
        // this function would otherwise act on.
        state.skipping += 1;
        return;
    }
    match name {
        "script" | "style" | "head" | "title" => state.skipping = 1,
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            out.block();
            let level = name.as_bytes()[1] - b'0';
            out.open(Role::Heading(level));
            state.open += 1;
        }
        "p" | "div" | "section" | "figure" | "table" => out.block(),
        "ul" | "ol" => {
            if state.depth == 0 {
                out.block();
            } else {
                out.line();
            }
            state.depth = state.depth.saturating_add(1);
        }
        "li" | "tr" => {
            out.line();
            out.open(Role::Item(state.depth.saturating_sub(1)));
            state.open += 1;
        }
        "blockquote" => {
            out.block();
            out.open(Role::Quote);
            state.open += 1;
        }
        "pre" => {
            out.block();
            out.verbatim = true;
            out.open(Role::Code);
            state.open += 1;
        }
        "code" | "kbd" | "samp" => {
            out.open(Role::Code);
            state.open += 1;
        }
        "em" | "i" | "cite" | "dfn" => {
            out.open(Role::Emphasis);
            state.open += 1;
        }
        "strong" | "b" => {
            out.open(Role::Strong);
            state.open += 1;
        }
        _ => {}
    }
}

fn end(name: &str, out: &mut Out, state: &mut State) {
    if state.skipping > 0 {
        state.skipping -= 1;
        return;
    }
    match name {
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "tr" | "blockquote" | "code" | "kbd"
        | "samp" | "em" | "i" | "cite" | "dfn" | "strong" | "b" => {
            out.close();
            state.open = state.open.saturating_sub(1);
        }
        "pre" => {
            out.verbatim = false;
            out.close();
            state.open = state.open.saturating_sub(1);
        }
        "ul" | "ol" => state.depth = state.depth.saturating_sub(1),
        _ => {}
    }
}

/// One entry's text, or `None` if it is not there or is not text.
fn entry<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    path: &str,
) -> Option<String> {
    let mut text = String::new();
    archive
        .by_name(path)
        .ok()?
        .take(MAX_BOOK_BYTES as u64)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

fn lower(name: &[u8]) -> String {
    String::from_utf8_lossy(name).to_ascii_lowercase()
}

fn attribute(tag: &BytesStart<'_>, name: &str) -> Option<String> {
    tag.attributes().flatten().find_map(|attribute| {
        (attribute.key.local_name().as_ref() == name.as_bytes())
            .then(|| String::from_utf8_lossy(&attribute.value).into_owned())
    })
}

/// The directory a path is in, with its trailing slash, or empty for a path at
/// the root of the archive.
fn parent_of(path: &str) -> String {
    match path.rfind('/') {
        Some(at) => path[..=at].to_owned(),
        None => String::new(),
    }
}

/// A manifest `href` resolved against the package document's directory.
///
/// Zip entry names are always `/`-separated and never absolute, so this is
/// string work rather than `Path` work — and it must stay that way, because a
/// `Path` on Windows would introduce a backslash that no archive contains.
/// `None` for a reference that climbs out of the archive, which is the entry
/// this function exists to refuse.
fn join(base: &str, href: &str) -> Option<String> {
    // A fragment names a place *inside* a chapter and not another file.
    let href = href.split('#').next().unwrap_or(href);
    let mut parts: Vec<&str> = Vec::new();
    for part in base.split('/').chain(href.split('/')) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    /// Build a book the way the format requires one, so the fixtures exercise
    /// the container and the package rather than going straight to the walker.
    ///
    /// `pub(crate)` because `assets.rs` needs a *real* epub to assert its
    /// sniffer against, and two fixtures for one format is how they drift.
    pub(crate) fn book(chapters: &[&str]) -> Vec<u8> {
        let manifest: String = (0..chapters.len())
            .map(|n| {
                format!(
                    r#"<item id="c{n}" href="ch{n}.xhtml" media-type="application/xhtml+xml"/>"#
                )
            })
            .collect();
        let spine: String = (0..chapters.len())
            .map(|n| format!(r#"<itemref idref="c{n}"/>"#))
            .collect();
        let package = format!(
            concat!(
                r#"<?xml version="1.0"?>"#,
                r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0">"#,
                r#"<manifest>{}<item id="css" href="style.css" media-type="text/css"/></manifest>"#,
                "<spine>{}</spine></package>"
            ),
            manifest, spine
        );
        let container = concat!(
            r#"<?xml version="1.0"?>"#,
            r#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">"#,
            r#"<rootfiles><rootfile full-path="OEBPS/content.opf""#,
            r#" media-type="application/oebps-package+xml"/></rootfiles></container>"#
        );

        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let stored: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let deflated: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();

        // First and stored, which OCF makes normative and which is what
        // `assets::sniff_mime` reads.
        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(crate::assets::EPUB.as_bytes()).unwrap();
        zip.start_file(CONTAINER, deflated).unwrap();
        zip.write_all(container.as_bytes()).unwrap();
        zip.start_file("OEBPS/content.opf", deflated).unwrap();
        zip.write_all(package.as_bytes()).unwrap();
        zip.start_file("OEBPS/style.css", deflated).unwrap();
        zip.write_all(b"p { margin: 0 }").unwrap();
        for (n, chapter) in chapters.iter().enumerate() {
            zip.start_file(format!("OEBPS/ch{n}.xhtml"), deflated).unwrap();
            let xhtml = format!(
                concat!(
                    r#"<?xml version="1.0" encoding="utf-8"?>"#,
                    r#"<html xmlns="http://www.w3.org/1999/xhtml">"#,
                    "<head><title>A chapter</title>",
                    "<style>p {{ color: red }}</style></head>",
                    "<body>{}</body></html>"
                ),
                chapter
            );
            zip.write_all(xhtml.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn read_ok(chapters: &[&str]) -> Reading {
        read(&book(chapters)).expect("a book with a spine reads")
    }

    fn roles(reading: &Reading) -> Vec<(Role, String)> {
        reading
            .roles
            .iter()
            .map(|s| (s.role, reading.text[s.start..s.end].to_owned()))
            .collect()
    }

    const CHAPTER: &str = concat!(
        "<h1>The Wexford statement</h1>",
        "<p>He arrived on the <strong>Tuesday</strong> train, and\n",
        "   <em>said nothing</em> about the folder.</p>",
        "<h2>What was found</h2>",
        "<ul><li>A brown envelope.</li><li>Three photographs.",
        "<ul><li>One of them is dated.</li></ul></li></ul>",
        "<blockquote>He would not say where.</blockquote>",
    );

    /// AC-982 and AC-984. The chapter reads as its words, with the six roles.
    #[test]
    fn a_chapter_reads_as_its_words() {
        let read = read_ok(&[CHAPTER]);
        assert_eq!(
            read.text,
            concat!(
                "The Wexford statement\n\n",
                "He arrived on the Tuesday train, and said nothing about the folder.\n\n",
                // A blank line before the list, because a list is a block —
                // the same in all four formats, which took writing the fourth
                // one to notice was not true of the third.
                "What was found\n\n",
                "A brown envelope.\n",
                "Three photographs.\n",
                "One of them is dated.\n\n",
                "He would not say where."
            )
        );
        assert!(!read.text.contains('<'), "markup reached the page");
        // The stylesheet and the `<style>` block are not the book.
        assert!(!read.text.contains("margin"), "css reached the page");
        assert!(!read.text.contains("color"), "an inline style reached the page");
        // Nor is the `<title>`, which is metadata rather than the chapter.
        assert!(!read.text.contains("A chapter"), "the title reached the page");

        let roles = roles(&read);
        assert!(roles.contains(&(Role::Heading(1), "The Wexford statement".into())), "{roles:?}");
        assert!(roles.contains(&(Role::Heading(2), "What was found".into())), "{roles:?}");
        assert!(roles.contains(&(Role::Item(0), "A brown envelope.".into())), "{roles:?}");
        assert!(roles.contains(&(Role::Item(1), "One of them is dated.".into())), "{roles:?}");
        assert!(roles.contains(&(Role::Strong, "Tuesday".into())), "{roles:?}");
        assert!(roles.contains(&(Role::Emphasis, "said nothing".into())), "{roles:?}");
        assert!(roles.contains(&(Role::Quote, "He would not say where.".into())), "{roles:?}");
    }

    /// A gap between two elements is a gap in the sentence, and the source's
    /// own wrapping is not. Both halves of one rule.
    #[test]
    fn the_space_between_two_elements_survives_and_the_indentation_does_not() {
        let read = read_ok(&["<p>Said <em>one</em> <em>two</em> three.</p>"]);
        assert_eq!(read.text, "Said one two three.");

        let read = read_ok(&["<p>A paragraph\n   wrapped by whoever\n   wrote it.</p>"]);
        assert_eq!(read.text, "A paragraph wrapped by whoever wrote it.");
    }

    /// AC-983. The spine says what the reading is, which is the whole of the
    /// answer a saved web page could only have been guessed at.
    #[test]
    fn only_what_the_spine_lists_is_read_and_in_its_order() {
        let read = read_ok(&["<p>One.</p>", "<p>Two.</p>", "<p>Three.</p>"]);
        let at = |needle: &str| read.text.find(needle).expect(needle);
        assert!(at("One.") < at("Two.") && at("Two.") < at("Three."));

        // A file in the package that the spine does not list is not the book.
        // The fixture always writes a stylesheet into the manifest and leaves it
        // out of the spine, so this is that arrangement asserted rather than
        // assumed.
        assert!(!read.text.contains("margin"));
    }

    /// Q-337. A chapter boundary is a page boundary, which is the fourth time
    /// this board says that sentence.
    #[test]
    fn a_chapter_boundary_is_a_page() {
        let read = read_ok(&["<p>One.</p>", "<p>Two.</p>", "<p>Three.</p>"]);
        assert_eq!(read.text, "One.\u{c}Two.\u{c}Three.");
        assert_eq!(crate::text::page_count(&read.text), 3);

        // And a book of one chapter does not open on a blank page.
        assert_eq!(crate::text::page_count(&read_ok(&["<p>One.</p>"]).text), 1);
    }

    /// The two ways a file can look like a book and not be one.
    #[test]
    fn a_zip_without_a_package_is_not_a_book() {
        assert!(read(b"not a zip at all").is_none());

        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        zip.start_file(CONTAINER, options).unwrap();
        let names = r#"<container><rootfiles><rootfile full-path="gone.opf"/></rootfiles></container>"#;
        zip.write_all(names.as_bytes()).unwrap();
        assert!(read(&zip.finish().unwrap().into_inner()).is_none());
    }

    /// A relative reference that climbs out of the archive is refused rather
    /// than resolved — the entry that stops a book naming a file on the disk.
    #[test]
    fn a_reference_cannot_climb_out_of_the_book() {
        assert_eq!(join("OEBPS/", "ch1.xhtml").as_deref(), Some("OEBPS/ch1.xhtml"));
        assert_eq!(join("OEBPS/", "../text/ch1.xhtml").as_deref(), Some("text/ch1.xhtml"));
        assert_eq!(join("OEBPS/", "ch1.xhtml#part2").as_deref(), Some("OEBPS/ch1.xhtml"));
        assert_eq!(join("OEBPS/", "../../etc/passwd"), None);
    }

    /// The tiling invariant D-65 rests on, in the last of the four formats.
    #[test]
    fn the_read_words_still_tile() {
        let chapters: Vec<String> = (0..20)
            .map(|c| (0..30).map(|n| format!("<p>Chapter {c} line {n}.</p>")).collect())
            .collect();
        let refs: Vec<&str> = chapters.iter().map(String::as_str).collect();
        let read = read_ok(&refs);
        let joined: String = crate::text::paginate(&read.text)
            .into_iter()
            .map(|r| read.text[r].to_owned())
            .collect();
        assert_eq!(joined, read.text);
    }
}
