//! A `.docx` read as its words — T-353.
//!
//! The fourth producer of [`crate::prose::Reading`], and the first that has to
//! open a container before it can read anything. T-352 got the file past the
//! ingest gate; this is what makes the folder have something in it.
//!
//! ## What a docx actually is
//!
//! A zip holding XML. `word/document.xml` is the one part this module reads —
//! the same part T-352's sniffer looks for to tell a docx from a spreadsheet —
//! and inside it WordprocessingML is a very regular thing:
//!
//! ```text
//! <w:p>
//!   <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
//!   <w:r><w:t>The Wexford statement</w:t></w:r>
//! </w:p>
//! ```
//!
//! Paragraphs hold runs, runs hold text, and both carry a properties element
//! that says what they are. So the walk below is `prose::Out`'s shape almost
//! exactly: a paragraph opens a block, its properties decide the role, and the
//! runs push characters into it.
//!
//! ## Where a heading comes from, and the one that is a trap
//!
//! `<w:pStyle w:val="Heading2"/>` and `<w:outlineLvl w:val="1"/>`, either of
//! them, because Word writes the first and other producers write the second.
//! The style *identifier* is what is matched and not the style's name — a
//! German Word calls the style "Uberschrift 2" where a person can see it and
//! still writes `Heading2` here — which is the same trap `rtf.rs` documents
//! and dodges the same way.
//!
//! **`<w:lastRenderedPageBreak/>` is deliberately ignored**, and it is the one
//! element in this format that would be actively wrong to honour. It is Word
//! recording where *its* layout engine happened to break a page, at the
//! typeface and paper size that machine had — which is precisely the class of
//! value `text.rs` refuses pagination to depend on, because it moves when a
//! font does and every stored citation moves with it. `<w:br w:type="page"/>`
//! is different: it is a break somebody *typed*, and that one becomes a form
//! feed like an `.rtf`'s page control word.
//!
//! ## What is left behind
//!
//! Tables, for `markdown.rs`'s reason: the reading surface has no sheet that
//! can set one, so a table is read as the words in its cells rather than
//! dropped. Fields, bookmarks, comments, revision marks, headers and footers
//! are all packaging and none of them reaches the page.

use std::io::Read;

use quick_xml::events::{BytesStart, Event};

use crate::prose::{Out, Reading, Role};

/// The part every WordprocessingML document keeps its body in.
const BODY_PART: &str = "word/document.xml";

/// How much decompressed XML this build will read from one document.
///
/// The same shape of bound `document.rs` puts on a PDF's structure and for the
/// same reason: a zip entry states its own uncompressed size and a malicious
/// one can lie, so the limit is enforced on what is actually read rather than
/// on what the header claims. Sixty-four megabytes is far past any real
/// document — `word/document.xml` for a two-hundred-page report is a couple of
/// megabytes — and far short of a zip bomb.
const MAX_BODY_BYTES: u64 = 64 * 1024 * 1024;

/// Read a docx as its words, or `None` if these bytes are not one.
///
/// `Option` for [`crate::rtf::read`]'s reason: the test is total, since a file
/// either has a `word/document.xml` in it or does not.
pub fn read(bytes: &[u8]) -> Option<Reading> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let mut body = String::new();
    archive
        .by_name(BODY_PART)
        .ok()?
        .take(MAX_BODY_BYTES)
        .read_to_string(&mut body)
        .ok()?;
    Some(parse(&body))
}

fn parse(xml: &str) -> Reading {
    let mut reader = quick_xml::Reader::from_str(xml);
    // **Nothing is trimmed globally, and the first draft of this got it wrong.**
    // A run that means to say a space says so with `xml:space="preserve"`, and
    // trimming here ate exactly those — "He arrived on the Tuesday train" came
    // back as "He arrived on theTuesdaytrain". The indentation of a
    // pretty-printed document is not a danger, because it is never *inside* a
    // `<w:t>` and `in_text` is what decides whether a character is the
    // document's.

    let mut out = Out::default();
    let mut state = State::default();

    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => start(&local(&tag), &tag, &mut out, &mut state),
            Ok(Event::Empty(tag)) => {
                // An empty element is a start and an end at once, and in this
                // format nearly every property is one: `<w:b/>`, `<w:i/>`,
                // `<w:pStyle .../>`, `<w:br .../>`.
                let name = local(&tag);
                start(&name, &tag, &mut out, &mut state);
                end(&name, &mut out, &mut state);
            }
            Ok(Event::End(tag)) => end(&local_end(&tag), &mut out, &mut state),
            Ok(Event::Text(text)) => {
                if state.in_text {
                    if let Ok(text) = text.decode() {
                        state.pending.push_str(&text);
                    }
                }
            }
            // **An entity arrives as its own event, not inside the text.**
            // `quick-xml` resolves references only behind its `escape` feature,
            // which is off here — so a `&amp;` in the middle of a sentence
            // reaches this loop as a `GeneralRef` between two `Text`s, and
            // ignoring it silently deleted the character. Which is the failure
            // this whole family of modules exists to prevent, arriving in the
            // parser rather than in the format.
            //
            // Taking it as a token rather than by string replacement also
            // retires the ordering trap for free: `&amp;lt;` is one reference
            // followed by three ordinary characters, so there is no way to
            // resolve it twice.
            Ok(Event::GeneralRef(reference)) => {
                if state.in_text {
                    if let Some(ch) = entity(&reference) {
                        state.pending.push(ch);
                    }
                }
            }
            Ok(Event::Eof) => break,
            // A malformed document stops where it stopped rather than losing
            // everything read so far. A truncated file still shows its first
            // pages, which is the failure a reader should have.
            Err(_) => break,
            _ => {}
        }
    }

    close_paragraph(&mut out, &mut state);
    out.finish()
}

/// The element name with its namespace prefix taken off.
///
/// `w:` in every document Word writes and something else in a document written
/// by a producer that chose a different prefix — the prefix is arbitrary and
/// the namespace it binds to is what carries meaning. Since `word/document.xml`
/// has exactly one vocabulary that uses these names, the local name alone is
/// unambiguous and is cheaper than resolving the binding.
fn local(tag: &BytesStart<'_>) -> String {
    String::from_utf8_lossy(tag.local_name().as_ref()).into_owned()
}

fn local_end(tag: &quick_xml::events::BytesEnd<'_>) -> String {
    String::from_utf8_lossy(tag.local_name().as_ref()).into_owned()
}

#[derive(Default)]
struct State {
    /// Inside a `<w:t>`, which is the only place a character of the document
    /// lives. Everything else with text in it — a style name, an instruction —
    /// is packaging.
    in_text: bool,
    /// Whether this `<w:t>` said `xml:space="preserve"`, which is how a run
    /// says the space at its edge is a space somebody typed.
    preserve: bool,
    /// This `<w:t>`'s characters, held until it closes.
    ///
    /// **Held rather than pushed as they arrive**, because an entity reference
    /// splits an element into several events and XML's whitespace rule is about
    /// the *element*, not about each piece of it. Trimming the pieces turned
    /// "Marks &amp; Spencer" into "Marks&Spencer" — the space before the
    /// entity was the end of one fragment and the space after it the start of
    /// the next, and both were read as edges of the element.
    pending: String,
    /// This paragraph's heading level, if its properties named one.
    heading: Option<u8>,
    /// This paragraph's list depth, if it is in a list.
    item: Option<u8>,
    /// Inside `<w:pPr>`, where the two above are declared. Needed because
    /// `<w:ilvl>` also appears inside numbering definitions elsewhere.
    in_paragraph_properties: bool,
    /// Which role this paragraph opened, so the same one is closed. `None` for
    /// a plain paragraph, which opens no span at all.
    opened: Option<Role>,
    /// Whether this paragraph has had its separation spent yet — a paragraph of
    /// three runs must not open three blocks. Separate from `opened` because a
    /// plain paragraph is started and opens nothing.
    started: bool,
    /// Whether a paragraph is open at all.
    in_paragraph: bool,
    /// Whether the paragraph before this one was a list item — see `emit`.
    last_was_item: bool,
    bold: bool,
    italic: bool,
}

fn start(name: &str, tag: &BytesStart<'_>, out: &mut Out, state: &mut State) {
    match name {
        "p" => {
            close_paragraph(out, state);
            state.in_paragraph = true;
            state.heading = None;
            state.item = None;
        }
        "pPr" => state.in_paragraph_properties = true,
        "pStyle" => {
            if state.in_paragraph_properties {
                if let Some(level) = heading_level(&attribute(tag, "val").unwrap_or_default()) {
                    state.heading = Some(level);
                }
            }
        }
        "outlineLvl" => {
            if state.in_paragraph_properties {
                // Zero-based here and one-based on the page, like an `.rtf`'s
                // `\outlinelevel`. Levels past the sixth are Word's way of
                // saying body text.
                if let Some(n) = attribute(tag, "val").and_then(|v| v.parse::<u8>().ok()) {
                    if n <= 5 {
                        state.heading = Some(n + 1);
                    }
                }
            }
        }
        "numPr" => {
            if state.in_paragraph_properties {
                state.item = Some(state.item.unwrap_or(0));
            }
        }
        "ilvl" => {
            if state.in_paragraph_properties && state.item.is_some() {
                if let Some(n) = attribute(tag, "val").and_then(|v| v.parse::<u8>().ok()) {
                    state.item = Some(n);
                }
            }
        }
        "b" => set_flag(out, &mut state.bold, on(tag), Role::Strong),
        "i" => set_flag(out, &mut state.italic, on(tag), Role::Emphasis),
        "t" => {
            state.in_text = true;
            // XML's own rule, which this format leans on: whitespace at the
            // edges of an element is insignificant unless the element says
            // otherwise. Word writes `preserve` on every run where it matters.
            state.preserve = attribute(tag, "space").as_deref() == Some("preserve");
        }
        "tab" => emit(out, state, "\t"),
        "br" => {
            // The only break in this format that a person typed. Everything
            // else `<w:br>` can be — a column break, a text-wrapping break — is
            // layout, and a plain `<w:br/>` is a line inside the paragraph.
            if attribute(tag, "type").as_deref() == Some("page") {
                close_paragraph(out, state);
                out.page_break();
            } else {
                out.line();
            }
        }
        _ => {}
    }
}

fn end(name: &str, out: &mut Out, state: &mut State) {
    match name {
        "p" => close_paragraph(out, state),
        "pPr" => state.in_paragraph_properties = false,
        "t" => {
            state.in_text = false;
            let text = std::mem::take(&mut state.pending);
            let text = if state.preserve { text.as_str() } else { text.trim() };
            if !text.is_empty() {
                emit(out, state, text);
            }
        }
        // A run's formatting belongs to the run, so both flags come off at its
        // end whether or not the next one turns them back on. Without this a
        // document whose first run is bold and whose second simply says nothing
        // about weight comes out bold to the last word.
        "r" => {
            set_flag(out, &mut state.bold, false, Role::Strong);
            set_flag(out, &mut state.italic, false, Role::Emphasis);
        }
        _ => {}
    }
}

/// Open the paragraph's role at its first character, and separate it from the
/// last one.
fn emit(out: &mut Out, state: &mut State, text: &str) {
    if !state.started && state.in_paragraph {
        state.started = true;
        // A list item sits on its own line inside the list, and the list as a
        // whole is a block — so the *first* item still gets a blank line above
        // it and only the ones after it run on.
        //
        // The `last_was_item` half of that was missing until `epub.rs` was
        // written and the two formats disagreed: a list after a heading opened
        // with a blank line in a markdown file, an `.rtf` and a book, and
        // without one in a docx. This format is the one with no list *element*
        // — `<w:numPr>` is a property of each paragraph — so "is this the first
        // item" is a thing to remember rather than a thing to read.
        if state.item.is_some() && state.last_was_item {
            out.line();
        } else {
            out.block();
        }
        if let Some(role) = state
            .heading
            .map(Role::Heading)
            .or_else(|| state.item.map(Role::Item))
        {
            out.open(role);
            state.opened = Some(role);
        }
    }
    out.push(text);
}

/// Close whatever role this paragraph opened, leaving bold and italic alone.
fn close_paragraph(out: &mut Out, state: &mut State) {
    // Only a paragraph that actually held something counts: an empty one
    // between two list items is a blank line in Word and must not break the run.
    if state.started {
        state.last_was_item = state.item.is_some();
    }
    state.in_paragraph = false;
    state.started = false;
    // `close_role` and not `close`, because the innermost open span at the end
    // of a heading is often a `Strong` that a run has not closed yet, and a
    // plain pop would end the bold and leave the heading running to the end of
    // the document. The same fix `rtf.rs` needed.
    if let Some(role) = state.opened.take() {
        out.close_role(role);
    }
}

fn set_flag(out: &mut Out, flag: &mut bool, on: bool, role: Role) {
    if *flag == on {
        return;
    }
    *flag = on;
    if on {
        out.open(role);
    } else {
        out.close_role(role);
    }
}

/// Whether a toggle property is on.
///
/// `<w:b/>` means bold and `<w:b w:val="0"/>` means the style said bold and
/// this run is taking it back — which is how a bold heading gets one plain word
/// in the middle of it.
fn on(tag: &BytesStart<'_>) -> bool {
    !matches!(attribute(tag, "val").as_deref(), Some("0" | "false" | "off"))
}

/// A built-in heading style's *identifier*, which is the same in every
/// language, unlike the name a person sees in the ribbon.
fn heading_level(style: &str) -> Option<u8> {
    let rest = style.strip_prefix("Heading").or_else(|| style.strip_prefix("heading"))?;
    rest.parse::<u8>().ok().filter(|n| (1..=6).contains(n))
}

/// One entity reference as the character it names.
///
/// The five XML defines, plus the numeric form. Nothing else: an HTML entity
/// like `&nbsp;` is not defined in XML and neither of these two formats permits
/// one, so a table of the several hundred would be carrying HTML's vocabulary
/// into a place it does not reach.
pub(crate) fn entity(reference: &quick_xml::events::BytesRef<'_>) -> Option<char> {
    if let Ok(Some(ch)) = reference.resolve_char_ref() {
        return Some(ch);
    }
    match reference.decode().ok()?.as_ref() {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        _ => None,
    }
}

/// An attribute by local name, so `w:val` and a differently-prefixed `val`
/// both answer.
fn attribute(tag: &BytesStart<'_>, name: &str) -> Option<String> {
    tag.attributes().flatten().find_map(|attribute| {
        (attribute.key.local_name().as_ref() == name.as_bytes())
            .then(|| String::from_utf8_lossy(&attribute.value).into_owned())
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    /// Wrap a body in the package a real docx is, so the fixtures go through
    /// the zip and the namespace rather than straight into the parser.
    pub(crate) fn package(body: &str) -> Vec<u8> {
        let xml = format!(
            concat!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
                r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">"#,
                "<w:body>{}</w:body></w:document>"
            ),
            body
        );
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        for (name, part) in [
            ("[Content_Types].xml", "<Types/>".to_owned()),
            ("_rels/.rels", "<Relationships/>".to_owned()),
            (BODY_PART, xml),
        ] {
            zip.start_file(name, options).unwrap();
            zip.write_all(part.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn read_ok(body: &str) -> Reading {
        read(&package(body)).expect("a package with a body is a docx")
    }

    fn roles(reading: &Reading) -> Vec<(Role, String)> {
        reading
            .roles
            .iter()
            .map(|s| (s.role, reading.text[s.start..s.end].to_owned()))
            .collect()
    }

    /// One paragraph of each thing Word writes, laid out the way it writes it.
    const STATEMENT: &str = concat!(
        r#"<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>"#,
        r#"<w:r><w:t>The Wexford statement</w:t></w:r></w:p>"#,
        r#"<w:p><w:r><w:t xml:space="preserve">He arrived on the </w:t></w:r>"#,
        r#"<w:r><w:rPr><w:b/></w:rPr><w:t>Tuesday</w:t></w:r>"#,
        r#"<w:r><w:t xml:space="preserve"> train, and </w:t></w:r>"#,
        r#"<w:r><w:rPr><w:i/></w:rPr><w:t>said nothing</w:t></w:r>"#,
        r#"<w:r><w:t>.</w:t></w:r></w:p>"#,
        r#"<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>"#,
        r#"<w:r><w:t>What was found</w:t></w:r></w:p>"#,
        r#"<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>"#,
        r#"<w:r><w:t>A brown envelope.</w:t></w:r></w:p>"#,
        r#"<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>"#,
        r#"<w:r><w:t>Three photographs.</w:t></w:r></w:p>"#,
    );

    /// AC-977. The whole of the bug: a docx used to open onto nothing at all.
    #[test]
    fn a_word_document_reads_as_its_sentences() {
        let read = read_ok(STATEMENT);
        assert_eq!(
            read.text,
            concat!(
                "The Wexford statement

",
                "He arrived on the Tuesday train, and said nothing.

",
                "What was found

",
                "A brown envelope.
",
                "Three photographs."
            )
        );
        assert!(!read.text.contains("<w:"), "markup reached the page");
        assert!(!read.text.contains("Heading1"), "a style name reached the page");
    }

    /// AC-978. The same six roles a markdown file and an rtf produce, so the
    /// sheet sets them without learning a fourth format.
    #[test]
    fn headings_lists_bold_and_italic_all_come_across() {
        let roles = roles(&read_ok(STATEMENT));
        assert!(roles.contains(&(Role::Heading(1), "The Wexford statement".into())), "{roles:?}");
        assert!(roles.contains(&(Role::Heading(2), "What was found".into())), "{roles:?}");
        assert!(roles.contains(&(Role::Item(0), "A brown envelope.".into())), "{roles:?}");
        assert!(roles.contains(&(Role::Strong, "Tuesday".into())), "{roles:?}");
        assert!(roles.contains(&(Role::Emphasis, "said nothing".into())), "{roles:?}");
    }

    /// A run's formatting belongs to the run. Without the reset at its end the
    /// first bold word makes the rest of the document bold.
    #[test]
    fn bold_stops_at_the_end_of_the_run_that_declared_it() {
        let read = read_ok(concat!(
            r#"<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold.</w:t></w:r>"#,
            r#"<w:r><w:t xml:space="preserve"> Plain.</w:t></w:r></w:p>"#,
        ));
        let strong = roles(&read);
        assert_eq!(strong, vec![(Role::Strong, "Bold.".into())]);

        // And the other half: a style says bold and one run takes it back.
        let read = read_ok(concat!(
            r#"<w:p><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>Not bold.</w:t></w:r></w:p>"#,
        ));
        assert!(roles(&read).is_empty(), "{:?}", roles(&read));
    }

    /// AC-979, and the one element in this format it would be actively wrong to
    /// honour. The typed break is a page; Word's note about where *its* layout
    /// engine broke one is not, because that moves when a font does and takes
    /// every stored citation with it.
    #[test]
    fn a_typed_page_break_is_a_page_and_a_rendered_one_is_not() {
        let typed = read_ok(concat!(
            r#"<w:p><w:r><w:t>One</w:t></w:r></w:p>"#,
            r#"<w:p><w:r><w:br w:type="page"/><w:t>Two</w:t></w:r></w:p>"#,
        ));
        assert_eq!(crate::text::page_count(&typed.text), 2);

        let rendered = read_ok(concat!(
            r#"<w:p><w:r><w:t>One</w:t></w:r></w:p>"#,
            r#"<w:p><w:r><w:lastRenderedPageBreak/><w:t>Two</w:t></w:r></w:p>"#,
        ));
        assert_eq!(crate::text::page_count(&rendered.text), 1);
        assert_eq!(rendered.text, "One

Two");
    }

    /// The five entities XML defines, and the ordering trap inside them.
    #[test]
    fn the_five_entities_come_off_in_the_right_order() {
        let read = read_ok(
            r#"<w:p><w:r><w:t>Marks &amp; Spencer, &lt;b&gt;, and &amp;lt; itself</w:t></w:r></w:p>"#,
        );
        assert_eq!(read.text, "Marks & Spencer, <b>, and &lt; itself");
    }

    /// Not a docx at all, and the two ways that happens.
    #[test]
    fn a_package_without_a_body_is_not_a_document() {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        zip.start_file("xl/workbook.xml", options).unwrap();
        zip.write_all(b"<workbook/>").unwrap();
        assert!(read(&zip.finish().unwrap().into_inner()).is_none());
        assert!(read(b"not a zip at all").is_none());
    }

    /// The tiling invariant D-65 rests on, checked rather than assumed: what
    /// comes out is a flat string, so every page range still concatenates back
    /// to the whole of it.
    #[test]
    fn the_read_words_still_tile() {
        let body: String = (0..400)
            .map(|n| format!(r"<w:p><w:r><w:t>Line {n} of the document.</w:t></w:r></w:p>"))
            .collect();
        let read = read_ok(&body);
        let joined: String = crate::text::paginate(&read.text)
            .into_iter()
            .map(|r| read.text[r].to_owned())
            .collect();
        assert_eq!(joined, read.text);
    }
}
