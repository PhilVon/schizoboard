//! A markdown file read as what it says — T-337, T-346, D-65.
//!
//! The bug is `cues.rs`'s, in a second format. A `.md` sniffs as `text/plain`
//! (Q-255 — the store judges bytes, never a name), text is a case file (D-60),
//! and `text::paginate` sets it on paper verbatim. So a markdown file turns up
//! on a sheet reading
//!
//! ```text
//! ## The Wexford statement
//!
//! He arrived on the **Tuesday** train, see [the timetable](https://…).
//! ```
//!
//! — the file's own packaging, set in our own hand, with a rectangle dragged
//! over it cutting a card that carries the asterisks along.
//!
//! ## What comes out, and why it is not runs
//!
//! A **flat string with the marks removed, and role spans as byte offsets into
//! that same string**. D-65 has the argument in full; the short of it is that
//! everything downstream of `of_text` — the tiling, the page count on the asset
//! record, the search index and the passage a quote is cut from — is defined
//! over a flat string, and `text.rs` will not have a page boundary that depends
//! on a typeface. A `Vec<TextRun>` would break all of that at once, and a run
//! has no identity to cite anyway.
//!
//! So this is `cues::speech`'s shape exactly: one substitution, a sidecar of
//! offsets beside it, and nothing downstream knows the format exists.
//!
//! ## And why there is no "is it markdown" question here
//!
//! `cues.rs` asks one and answers `None` when the file is not a transcript,
//! because it can: every block has to be a cue, and that test is total. There
//! is no equivalent. **Every text file is valid markdown** — a file with no
//! marks in it is a markdown file of one paragraph — so a content test would
//! either recognise everything or draw an arbitrary line. Measured on this
//! repository, reading all text this way would alter 96% of source files, since
//! a hash beginning a line is a comment in half the languages anybody drops.
//!
//! That is why the recognition lives on the asset record instead (Q-324,
//! T-345), decided at the one place a filename exists. By the time this module
//! is called the question is already settled, so it takes text and returns a
//! reading rather than an `Option` — the honest signature for "read this as
//! markdown", as against "is this markdown".

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

/// What a span of the read text is.
///
/// Deliberately small, and each of these earns its place by being something the
/// sheet can *draw* differently — DESIGN's reading surface sets a heading larger
/// and indents a list, and there is nothing it can do with the knowledge that
/// two words were a reference link rather than an inline one. Anything markdown
/// says that the paper cannot say back is packaging, and packaging is what this
/// module exists to take off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// `#` through `######`. The level, one-based, because a sheet sets a
    /// second-level heading smaller than a first.
    Heading(u8),
    /// A bullet or a numbered item, with how deeply it is nested — zero at the
    /// top. The *marker* is not in the text: what was said is the words, and
    /// the sheet draws the bullet. A quote cut from a list cites the words.
    Item(u8),
    /// Inside a `>` block. Somebody else's words inside this document, which is
    /// a distinction this board of all boards should keep.
    Quote,
    /// Fenced, indented or inline. Set as it was written — a code block is the
    /// one place in markdown where the line breaks and the spaces *are* the
    /// content, so this is also the one role that suppresses the reflow below.
    Code,
    Emphasis,
    Strong,
}

/// A run of the read text, and what it is.
///
/// `start` and `end` are byte offsets into [`Reading::text`] — the same units
/// `text::paginate` tiles in and the same units `cues::Mark` uses, so a page's
/// range and these spans are comparable without a second opinion about what a
/// character is.
///
/// Spans **nest**: a `Strong` inside a `Heading` produces both, and neither is
/// clipped to the other. The sheet draws them by containment, which is what a
/// bold word in a heading actually is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    pub role: Role,
}

/// A markdown file with its marks taken off.
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    /// The words, and the shape of the page in blank lines. What paginates.
    pub text: String,
    /// In document order — outermost first where two overlap, so a reader
    /// walking these alongside the text meets a heading before the bold word
    /// inside it. `read` sorts them; a stack alone would give the reverse.
    pub roles: Vec<Span>,
}

/// Read markdown as its words.
///
/// Takes text already decoded and normalised by [`crate::text::decode`], so the
/// line endings are `\n` and the offsets below index the same string every other
/// reader sees.
pub fn read(text: &str) -> Reading {
    // Tables, footnotes and strikethrough stay off. Each is a further piece of
    // syntax to have an opinion about on paper, and the three of them together
    // are a table renderer this board has no sheet for — a file using them is
    // read as the words in them, which is the failure mode this module wants
    // when it does not understand something.
    let parser = Parser::new_ext(text, Options::empty());

    let mut out = Out::default();
    // Open spans, innermost last. A stack rather than the parser's own source
    // offsets, because what is being described is the read text and the two do
    // not line up: every mark taken off moves everything after it.
    //
    // **The start is `None` until the span holds a character**, and that is not
    // tidiness — it is the fix for a bug the heading and list tests both caught
    // on the first run. Separation between blocks is *owed* rather than
    // written, so at the moment a heading opens, the two newlines before it
    // have not been appended yet; taking `text.len()` there put them inside the
    // span, and the second heading in a file came back reading "\n\nThree".
    // Deciding the start at the first `push` is what makes a span begin at its
    // own first word — and it retires the empty-span check in `close` into the
    // same mechanism, since a span that never held a character never got one.
    let mut open: Vec<(Option<usize>, Role)> = Vec::new();
    let mut depth: u8 = 0;

    for event in parser {
        match event {
            Event::Start(tag) => match tag {
                Tag::Heading { level, .. } => {
                    out.block();
                    open.push((None, Role::Heading(level_of(level))));
                }
                Tag::Paragraph => out.block(),
                Tag::List(_) => {
                    // Only a list that *starts* a block wants a blank line
                    // before it. A nested one is already inside an item, and
                    // separating it would put a gap in the middle of the list
                    // it belongs to — which is what "milk, bread, blank, rye"
                    // was on the first run.
                    if depth == 0 {
                        out.block();
                    } else {
                        out.line();
                    }
                    // Saturating, because markdown will nest as deeply as
                    // somebody indents and a `u8` is not the place to find out.
                    depth = depth.saturating_add(1);
                }
                Tag::Item => {
                    out.line();
                    open.push((None, Role::Item(depth.saturating_sub(1))));
                }
                Tag::BlockQuote(_) => {
                    out.block();
                    open.push((None, Role::Quote));
                }
                Tag::CodeBlock(_) => {
                    out.block();
                    out.verbatim = true;
                    open.push((None, Role::Code));
                }
                Tag::Emphasis => open.push((None, Role::Emphasis)),
                Tag::Strong => open.push((None, Role::Strong)),
                // **A link becomes its own text and loses its address**, which
                // is the whole of the bug this module was raised for. Nothing
                // on this sheet is clickable — a page is paper — so a URL set
                // in the middle of a sentence is a string of characters nobody
                // can use, in the one place a person is trying to read.
                //
                // An image is the same answer for a different reason: the file
                // it names is not in this board's store and cannot be fetched
                // from a sheet, so what is left of it is its alt text, which is
                // the words somebody wrote *for* the case where it is missing.
                Tag::Link { .. } | Tag::Image { .. } => {}
                _ => {}
            },
            Event::End(end) => match end {
                TagEnd::Heading(_) | TagEnd::Item | TagEnd::BlockQuote(_) => out.close(&mut open),
                TagEnd::CodeBlock => {
                    out.verbatim = false;
                    out.close(&mut open);
                }
                TagEnd::Emphasis | TagEnd::Strong => out.close(&mut open),
                TagEnd::List(_) => depth = depth.saturating_sub(1),
                _ => {}
            },
            Event::Text(text) | Event::Code(text) => out.push(&text, &mut open),
            // A soft break is where the *author* wrapped, and markdown says it
            // is not a line break — the paragraph reflows. Ours reflows onto a
            // 66-column grid, so honouring the source's wrapping would set a
            // paragraph ragged against a measure it was never written for. A
            // hard break is two spaces or a backslash and was meant.
            Event::SoftBreak => out.push(" ", &mut open),
            Event::HardBreak => out.newline(),
            Event::Rule => out.block(),
            // Raw HTML in a markdown file is markup this board does not draw,
            // exactly like the asterisks. Dropped rather than set as characters.
            Event::Html(_) | Event::InlineHtml(_) => {}
            _ => {}
        }
    }

    // Anything still open at the end is a file that stopped mid-structure —
    // pulldown-cmark closes its own tags, so this is belt and braces rather
    // than a case anybody has seen. Closed at the end of the text so a span
    // never points past it.
    while !open.is_empty() {
        out.close(&mut open);
    }

    // **Into document order**, which a stack does not give: spans are recorded
    // when they *close*, so an inner one always lands before the outer one that
    // contains it. Outermost first is the order a reader walking the text
    // alongside these wants — it meets a heading before the bold word inside
    // it, and a list item before the list nested in it — so the sort is by
    // where a span starts and then by the longer of two that start together.
    out.roles.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));

    Reading {
        text: out.text.trim_end().to_owned(),
        roles: out.roles,
    }
}

/// The text being built, and the whitespace it owes.
///
/// Separation is *pending* rather than written, which is what keeps a blank
/// line from being emitted before a block that turns out to be empty, and what
/// stops two blocks in a row producing four newlines. Nothing is appended until
/// there is something to append it before.
#[derive(Default)]
struct Out {
    text: String,
    roles: Vec<Span>,
    /// `2` for a blank line between blocks, `1` for a new line, `0` for none.
    owed: u8,
    /// Inside a code block, where the line breaks are the content.
    verbatim: bool,
}

impl Out {
    fn block(&mut self) {
        if !self.text.is_empty() {
            self.owed = self.owed.max(2);
        }
    }

    fn line(&mut self) {
        if !self.text.is_empty() {
            self.owed = self.owed.max(1);
        }
    }

    fn newline(&mut self) {
        self.line();
    }

    fn push(&mut self, text: &str, open: &mut [(Option<usize>, Role)]) {
        if text.is_empty() {
            return;
        }
        for _ in 0..self.owed {
            self.text.push('\n');
        }
        self.owed = 0;
        // Every span still waiting for a first character begins here — see the
        // stack's comment in `read`.
        let at = self.text.len();
        for (start, _) in open.iter_mut() {
            if start.is_none() {
                *start = Some(at);
            }
        }
        if self.verbatim {
            self.text.push_str(text);
            return;
        }
        // A newline inside ordinary text is the parser handing back a line of a
        // paragraph, and it reflows for `SoftBreak`'s reason.
        for (i, piece) in text.split('\n').enumerate() {
            if i > 0 {
                self.text.push(' ');
            }
            self.text.push_str(piece);
        }
    }

    /// Close the innermost open span, unless it turned out to hold nothing.
    ///
    /// An empty span is a heading with no words in it or a list item that was
    /// only a nested list — real things in real files, and a zero-length span
    /// is a mark on the page with nothing under it.
    fn close(&mut self, open: &mut Vec<(Option<usize>, Role)>) {
        let Some((start, role)) = open.pop() else {
            return;
        };
        // No start at all means nothing was ever pushed inside it.
        let Some(start) = start else {
            return;
        };
        let end = self.text.len();
        if end > start {
            self.roles.push(Span { start, end, role });
        }
    }
}

fn level_of(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roles(text: &str) -> Vec<(Role, String)> {
        let read = read(text);
        read.roles
            .iter()
            .map(|s| (s.role, read.text[s.start..s.end].to_owned()))
            .collect()
    }

    #[test]
    fn takes_the_marks_off_and_leaves_the_words() {
        let read = read("## The statement\n\nHe arrived on the **Tuesday** train.\n");
        assert_eq!(read.text, "The statement\n\nHe arrived on the Tuesday train.");
        assert!(!read.text.contains('#'));
        assert!(!read.text.contains('*'));
    }

    #[test]
    fn says_which_words_were_a_heading_and_at_what_level() {
        assert_eq!(
            roles("# One\n\n### Three\n"),
            vec![
                (Role::Heading(1), "One".to_owned()),
                (Role::Heading(3), "Three".to_owned()),
            ]
        );
    }

    #[test]
    fn every_span_indexes_the_text_it_came_with() {
        // The property the whole design rests on: an offset is into the READ
        // text, not into the source, because every mark taken off moves
        // everything after it. A span borrowed from the source would name the
        // wrong words by exactly the number of asterisks above it.
        let read = read("**bold** then *soft* then more\n");
        for span in &read.roles {
            assert!(span.end <= read.text.len(), "span runs past the text");
            assert!(span.start < span.end, "an empty span was kept");
        }
        assert_eq!(
            roles("**bold** then *soft* then more\n"),
            vec![
                (Role::Strong, "bold".to_owned()),
                (Role::Emphasis, "soft".to_owned()),
            ]
        );
    }

    #[test]
    fn a_link_becomes_its_own_words_and_loses_its_address() {
        // The bug this module was raised for. Nothing on a sheet is clickable,
        // so a URL set in the middle of a sentence is characters nobody can use.
        let read = read("See [the timetable](https://example.com/t?a=1) for times.\n");
        assert_eq!(read.text, "See the timetable for times.");
    }

    #[test]
    fn an_image_leaves_the_words_written_for_its_absence() {
        let read = read("![a platform at dusk](photo.jpg)\n");
        assert_eq!(read.text, "a platform at dusk");
    }

    #[test]
    fn a_list_keeps_its_words_and_its_depth_but_grows_no_bullets() {
        // The marker is the sheet's to draw. What was *said* is the words, and
        // a quote cut from a list should cite those rather than a hyphen
        // somebody's editor inserted.
        let read = read("- milk\n- bread\n  - rye\n");
        assert_eq!(read.text, "milk\nbread\nrye");
        // **The nested list is inside "bread", not beside it**, which is what
        // CommonMark says a nested list is and what the first version of this
        // test got wrong. So the second item spans its own words *and* the item
        // under it, exactly as a heading spans a bold word inside it — spans
        // nest here, and the sheet draws the innermost depth it finds.
        assert_eq!(
            read.roles,
            vec![
                Span { start: 0, end: 4, role: Role::Item(0) },
                Span { start: 5, end: 14, role: Role::Item(0) },
                Span { start: 11, end: 14, role: Role::Item(1) },
            ]
        );
    }

    #[test]
    fn puts_the_outer_span_before_the_one_inside_it() {
        // A stack records a span when it *closes*, so without the sort in
        // `read` the inner one arrives first and a reader walking the text
        // alongside these meets a bold word before the heading holding it.
        let read = read("# A **hard** word\n\n- one\n  - two\n");
        let starts: Vec<usize> = read.roles.iter().map(|s| s.start).collect();
        let mut sorted = starts.clone();
        sorted.sort_unstable();
        assert_eq!(starts, sorted, "spans are not in document order");
        assert_eq!(read.roles[0].role, Role::Heading(1));
    }

    #[test]
    fn a_paragraph_reflows_and_a_code_block_does_not() {
        // Two different answers to one question, and both are the format's own
        // rule rather than a preference. Where an author wrapped a paragraph is
        // not a line break; inside a fence the line breaks are the content.
        assert_eq!(read("one\ntwo\nthree\n").text, "one two three");
        assert_eq!(
            read("```\nlet a = 1;\nlet b = 2;\n```\n").text,
            "let a = 1;\nlet b = 2;"
        );
    }

    #[test]
    fn keeps_someone_elses_words_marked_as_theirs() {
        assert_eq!(
            roles("> He said it plainly.\n"),
            vec![(Role::Quote, "He said it plainly.".to_owned())]
        );
    }

    #[test]
    fn nests_a_span_inside_another_rather_than_clipping_it() {
        // A bold word in a heading is both, and the sheet draws them by
        // containment. Neither is trimmed to fit the other.
        assert_eq!(
            roles("# A **hard** word\n"),
            vec![
                (Role::Heading(1), "A hard word".to_owned()),
                (Role::Strong, "hard".to_owned()),
            ]
        );
    }

    #[test]
    fn reads_a_file_with_no_marks_in_it_as_itself() {
        // Every text file is valid markdown, and this is what that means in
        // practice: a file nobody marked up comes back as its own words. It is
        // also why the recognition cannot live here — see the module header.
        let plain = "Just a note.\n\nWith a second paragraph.";
        assert_eq!(read(plain).text, plain);
        assert!(read(plain).roles.is_empty());
    }

    #[test]
    fn drops_raw_html_rather_than_setting_it_as_characters() {
        assert_eq!(read("<div>\n\nA word.\n\n</div>\n").text, "A word.");
    }

    #[test]
    fn keeps_no_span_that_holds_nothing() {
        // A heading with no words, and a list item that is only a nested list.
        // A zero-length span is a mark on the page with nothing under it.
        for source in ["#\n", "-\n", "*  *\n"] {
            for span in read(source).roles {
                assert!(span.start < span.end, "{source:?} kept an empty span");
            }
        }
    }
}
