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
use crate::prose::{Out, Reading, Role};

/// Read markdown as its words.
///
/// Takes text already decoded and normalised by [`crate::text::decode`], so the
/// line endings are `\n` and the offsets below index the same string every other
/// reader sees.
///
/// The shape that comes back is [`crate::prose::Reading`], which four formats
/// now share — see that module for why it does not live here.
pub fn read(text: &str) -> Reading {
    // Tables, footnotes and strikethrough stay off. Each is a further piece of
    // syntax to have an opinion about on paper, and the three of them together
    // are a table renderer this board has no sheet for — a file using them is
    // read as the words in them, which is the failure mode this module wants
    // when it does not understand something.
    let parser = Parser::new_ext(text, Options::empty());

    let mut out = Out::default();
    let mut depth: u8 = 0;

    for event in parser {
        match event {
            Event::Start(tag) => match tag {
                Tag::Heading { level, .. } => {
                    out.block();
                    out.open(Role::Heading(level_of(level)));
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
                    out.open(Role::Item(depth.saturating_sub(1)));
                }
                Tag::BlockQuote(_) => {
                    out.block();
                    out.open(Role::Quote);
                }
                Tag::CodeBlock(_) => {
                    out.block();
                    out.verbatim = true;
                    out.open(Role::Code);
                }
                Tag::Emphasis => out.open(Role::Emphasis),
                Tag::Strong => out.open(Role::Strong),
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
                TagEnd::Heading(_) | TagEnd::Item | TagEnd::BlockQuote(_) => out.close(),
                TagEnd::CodeBlock => {
                    out.verbatim = false;
                    out.close();
                }
                TagEnd::Emphasis | TagEnd::Strong => out.close(),
                TagEnd::List(_) => depth = depth.saturating_sub(1),
                _ => {}
            },
            Event::Text(text) | Event::Code(text) => out.push(&text),
            // A soft break is where the *author* wrapped, and markdown says it
            // is not a line break — the paragraph reflows. Ours reflows onto a
            // 66-column grid, so honouring the source's wrapping would set a
            // paragraph ragged against a measure it was never written for. A
            // hard break is two spaces or a backslash and was meant.
            Event::SoftBreak => out.push(" "),
            Event::HardBreak => out.line(),
            Event::Rule => out.block(),
            // Raw HTML in a markdown file is markup this board does not draw,
            // exactly like the asterisks. Dropped rather than set as characters.
            Event::Html(_) | Event::InlineHtml(_) => {}
            _ => {}
        }
    }

    out.finish()
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
    use crate::prose::Span;

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
