//! Pages for a document that has none of its own.
//!
//! > The page reference has to be stable, which is a constraint on how
//! > documents are paginated — a PDF has real page numbers and a .txt does not.
//! > Whatever we invent for the ones that have none has to survive reopening
//! > the board on another machine. — T-298
//!
//! [`crate::document`] has the easy half: a PDF states its own pagination, the
//! file is content-addressed, and `(sha256, index)` is already the key
//! [`crate::pages::PageStore`] caches on. This module is the other half — the
//! rule that gives that pair a second meaning when the file says nothing.
//!
//! ## Why the rule is in bytes and not in layout
//!
//! Three constraints, all of them already load-bearing somewhere else, and
//! together they leave one shape:
//!
//! - **It has to be countable at ingest, without reading a page.** DATA-MODEL
//!   section 10 has `pages` crossing the wire ahead of the bytes, because a
//!   peer who will never hold the file still draws the folder's thickness from
//!   it. The same bargain [`crate::media::probe_duration`] makes.
//! - **So it cannot touch layout.** Not the typeface, not the sheet size, not
//!   the item scale. Those are design values and every one of them has moved
//!   more than once on this board. A page number that moves with them silently
//!   rewrites every citation anybody stored — corruption by stylesheet edit,
//!   which is the worst kind, because nothing errors and nothing looks wrong.
//! - **Which leaves the bytes.** Same bytes, same pages, in any process on any
//!   machine in any build. That is stable for exactly the reason an asset id is
//!   stable, so it is D-6's argument reused rather than a new one asserted.
//!
//! It inverts the usual dependency, and that is deliberate: the reading
//! surface's sheet gets **sized to this grid**, rather than this grid being
//! measured off a sheet. Layout is downstream of pagination here, because
//! pagination is the half that has to hold still.
//!
//! ## What a page is
//!
//! A typewriter page: [`COLS`] columns by [`ROWS`] rows, filled greedily. A
//! logical line costs as many rows as it wraps to; a blank line costs one. Rows
//! run on across a page boundary, so a paragraph longer than a page continues
//! onto the next rather than being pushed whole.
//!
//! With one exception, which is the only case where the file *does* declare
//! pages: **a form feed is a page break.** `0x0C` is in real text — Gutenberg
//! etexts, printed reports, anything that has been through a line printer — and
//! a file that says where its pages end gets to keep them. A declared page too
//! long for the grid still continues onto the next rather than overflowing,
//! because a page that does not fit the sheet is not a page the reading surface
//! can draw.
//!
//! ## The two numbers, and when they stop being movable
//!
//! [`COLS`] and [`ROWS`] are the only taste in this module, and they can only
//! be judged against a page somebody is actually reading — which is T-275, and
//! does not exist yet. What matters is *when* they freeze: the moment the first
//! citation is stored (T-283), moving either number moves every stored
//! reference. Until then they are free. So they get looked at once, on the
//! reading surface, and then they are done.
//!
//! There is deliberately **no version key** in the asset record to survive a
//! later change to this rule. The argument for one is obvious and it is wrong:
//! all the pressure to change how a page looks — how much fits, what hand it is
//! set in, how wide the measure reads — lands on the layout side, which is the
//! side this rule is defined to be independent of. A field that exists to
//! survive a change nobody has an argument for is a field two writers can
//! disagree over, which is the cost DATA-MODEL section 10 names for exactly
//! this shape. A golden test is cheaper and says the same thing. If that turns
//! out wrong it becomes an ADR and a key, and `Y.Map` per-property LWW makes
//! that additive.

use std::ops::Range;

/// Columns on a page.
///
/// Typography's comfortable measure is somewhere between 45 and 75 characters
/// and this is the middle of it. It is a *character* count and not a width:
/// nothing here knows what a character is drawn as.
pub const COLS: usize = 66;

/// Rows on a page.
///
/// A sheet of A4 set at twelve point, single spaced, with a margin somebody
/// would actually leave. Together with [`COLS`] that is 3,036 cells, which
/// prose fills about two thirds of — so a page is around two thousand
/// characters, which is a page.
pub const ROWS: usize = 46;

/// Where a tab lands.
///
/// The classic eight. It matters at all because a table or an indented listing
/// pasted into a text file is columns made of tabs, and counting one as one
/// character would report a page and a half of table as a third of a page.
const TAB_STOP: usize = 8;

/// Turn a file's bytes into the text this module's rule is defined over, or
/// `None` if they are not text at all.
///
/// The judgement is made on the bytes and never on a name, which is the rule
/// `assets::sniff_mime` is built on — an extension is what somebody typed. It
/// is the last question worth asking of a file, though, and not the first: it
/// has no signature to match, so it can only ever be *what is left* once every
/// container has said no.
///
/// Three things are refused and each one is a file that would read as gibberish
/// on a sheet of paper: bytes that are not valid UTF-8 (or UTF-16 announced by
/// a byte order mark), a `NUL`, and any other C0 control that is not tab,
/// newline, carriage return or form feed. An escape byte is how a coloured
/// terminal log arrives, and setting the escape sequences on our own paper is
/// not reading the file, it is printing its punctuation.
///
/// Line endings are normalised to `\n` on the way out — CRLF and a lone CR
/// both. That is what makes the rule agree with itself across the two machines
/// this file might have been written on, and it means the byte offsets this
/// module hands back are offsets into the *decoded* text rather than into the
/// file. Everything downstream reads the decoded text, so there is nothing that
/// wants the other kind.
pub fn decode(bytes: &[u8]) -> Option<String> {
    let text = if let Some(rest) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        std::str::from_utf8(rest).ok()?.to_owned()
    } else if let Some(rest) = bytes.strip_prefix(&[0xff, 0xfe]) {
        utf16(rest, u16::from_le_bytes)?
    } else if let Some(rest) = bytes.strip_prefix(&[0xfe, 0xff]) {
        utf16(rest, u16::from_be_bytes)?
    } else {
        std::str::from_utf8(bytes).ok()?.to_owned()
    };
    if text.chars().any(is_refused_control) {
        return None;
    }
    Some(normalise(&text))
}

fn utf16(bytes: &[u8], order: fn([u8; 2]) -> u16) -> Option<String> {
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| order([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).ok()
}

fn is_refused_control(ch: char) -> bool {
    let code = ch as u32;
    code < 0x20 && !matches!(ch, '\t' | '\n' | '\r' | '\x0c')
}

/// Whether a window of bytes reads as text — the question `sniff_mime` asks.
///
/// The same three refusals [`decode`] makes, on a *prefix* rather than on a
/// whole file, and it lives here rather than in the sniffer so that the gate at
/// ingest and the decoder that reads the file afterwards cannot come to
/// different conclusions about what text is. Two writers of one rule is the
/// cost DATA-MODEL section 10 names, and this is a rule with two readers.
///
/// The one thing it does that [`decode`] does not: a multi-byte character cut
/// in half by the end of the window is not evidence of anything, so an
/// incomplete sequence at the tail is trimmed rather than counted against the
/// file. `error_len() == None` is `from_utf8`'s way of saying the input simply
/// stopped mid-character.
///
/// Empty is not text. A file with no bytes is one there is no evidence about,
/// and calling it a document would put an empty folder on the wall for every
/// stray zero-length file somebody drags in.
pub(crate) fn reads_as_text(head: &[u8]) -> bool {
    let text = match std::str::from_utf8(head) {
        Ok(text) => text,
        Err(error) if error.error_len().is_none() => {
            // `valid_up_to` is by definition a character boundary, so this
            // cannot fail; the fallback is here rather than an `unwrap`.
            std::str::from_utf8(&head[..error.valid_up_to()]).unwrap_or("")
        }
        Err(_) => return false,
    };
    !text.is_empty() && !text.chars().any(is_refused_control)
}

fn normalise(text: &str) -> String {
    if !text.contains('\r') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(ch);
        }
    }
    out
}

/// Every page of a page-less document, as byte ranges into `text`.
///
/// The ranges **tile the text**: the first starts at zero, each begins where
/// the last ended, and the last ends at `text.len()`. So concatenating every
/// page reproduces the document exactly, which is the property that makes a
/// page reference mean a place in the file rather than a place in a rendering.
///
/// There is always at least one page. An empty document is one empty sheet
/// rather than none, because `pages: 0` and no page count at all read
/// identically once the record is written — `readAsset` drops a zero — and a
/// folder with no thickness is a document this build could not count, which is
/// a different thing from a document with nothing in it.
pub fn paginate(text: &str) -> Vec<Range<usize>> {
    let mut starts = Vec::new();
    walk(text, |at| starts.push(at));
    seal(&mut starts);
    starts
        .iter()
        .enumerate()
        .map(|(i, &start)| start..starts.get(i + 1).copied().unwrap_or(text.len()))
        .collect()
}

/// How many pages, without building them.
///
/// The route ingest takes. It is the same walk [`paginate`] makes — one rule
/// with one implementation — and it exists separately only so that counting a
/// large file does not allocate a range per page to then throw them all away.
pub fn page_count(text: &str) -> usize {
    let mut count = 0usize;
    walk(text, |_| count += 1);
    count.max(1)
}

/// One page's text, by the number printed on it.
///
/// One-based, to agree with [`crate::document::Page::index`]: the two kinds of
/// document are cited the same way or the citation has to know which kind it
/// came from, which would put the reading surface's business in a reference.
pub fn page(text: &str, index: u32) -> Option<&str> {
    let index = usize::try_from(index).ok()?.checked_sub(1)?;
    paginate(text).get(index).map(|range| &text[range.clone()])
}

/// The first page always starts at zero and there is always a first page.
///
/// Anything before the first row — a document that opens on a form feed, or one
/// with nothing in it at all — belongs to page one rather than to no page, or
/// the ranges stop tiling and a byte of the file lives nowhere.
fn seal(starts: &mut Vec<usize>) {
    match starts.first_mut() {
        Some(first) => *first = 0,
        None => starts.push(0),
    }
}

/// The one walk. Calls `page` with the byte offset each page starts at.
fn walk(text: &str, mut page: impl FnMut(usize)) {
    let mut rows = 0usize;
    let mut open = false;
    let mut row = |at: usize, rows: &mut usize, open: &mut bool| {
        if !*open || *rows >= ROWS {
            page(at);
            *rows = 0;
            *open = true;
        }
        *rows += 1;
    };

    for (base, line) in lines(text) {
        // A form feed inside a line splits it: what follows starts a page, and
        // what preceded it finished one.
        let mut pieces = split_keeping_offsets(line, '\x0c').peekable();
        while let Some((offset, piece)) = pieces.next() {
            let last = pieces.peek().is_none();
            // An empty piece before a form feed is not a blank row — it is two
            // page breaks in a row, or a file that opens on one. Only the piece
            // a newline terminates is a line of the document.
            if last || !piece.is_empty() {
                for start in wrap(piece) {
                    row(base + offset + start, &mut rows, &mut open);
                }
            }
            if !last && open && rows > 0 {
                open = false;
                rows = 0;
            }
        }
    }
}

/// The document's logical lines, each with its byte offset.
///
/// `str::lines` would do it but does not say where anything was, and a trailing
/// newline ends the document rather than starting an empty line after it.
fn lines(text: &str) -> impl Iterator<Item = (usize, &str)> {
    let trimmed = text.strip_suffix('\n').unwrap_or(text);
    let mut at = 0usize;
    let empty = text.is_empty();
    std::iter::from_fn(move || {
        if empty || at > trimmed.len() {
            return None;
        }
        let rest = &trimmed[at..];
        let (line, next) = match rest.find('\n') {
            Some(end) => (&rest[..end], at + end + 1),
            None => (rest, trimmed.len() + 1),
        };
        let base = at;
        at = next;
        Some((base, line))
    })
}

fn split_keeping_offsets(text: &str, sep: char) -> impl Iterator<Item = (usize, &str)> {
    let mut at = 0usize;
    let mut done = false;
    std::iter::from_fn(move || {
        if done {
            return None;
        }
        let rest = &text[at..];
        let (piece, next) = match rest.find(sep) {
            Some(end) => (&rest[..end], at + end + sep.len_utf8()),
            None => {
                done = true;
                (rest, at)
            }
        };
        let base = at;
        at = next;
        Some((base, piece))
    })
}

/// Where each display row of one logical line begins, relative to it.
///
/// Greedy, breaking at the last space that fits and hard-breaking a word that
/// never does — a URL has to go somewhere. The space a line breaks at is
/// consumed by the break, the way a typesetter would, so it does not open the
/// next row with an indent nobody typed.
fn wrap(line: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    let mut row_start = 0usize;
    let mut col = 0usize;
    let mut last_space: Option<usize> = None;
    for (i, ch) in line.char_indices() {
        let mut w = advance(ch, col);
        if col + w > COLS {
            let next = match last_space {
                Some(space) if space >= row_start => space + 1,
                _ => i,
            };
            // A row has to make progress or the walk never ends. It cannot fail
            // to at these constants — the widest single character is a tab at
            // eight and COLS is sixty-six — but the guard is the cheap half of
            // that sentence and the reasoning is the expensive half.
            if next > row_start {
                starts.push(next);
                row_start = next;
                last_space = None;
                col = width(&line[next..i]);
                w = advance(ch, col);
            }
        }
        if ch == ' ' {
            last_space = Some(i);
        }
        col += w;
    }
    starts
}

fn width(text: &str) -> usize {
    let mut col = 0usize;
    for ch in text.chars() {
        col += advance(ch, col);
    }
    col
}

/// How many columns one character takes from where it stands.
///
/// A carriage return takes none. [`decode`] has already turned every one of
/// them into a newline, so this only ever sees text that came from somewhere
/// else — and a stray CR widening a line would be a rendering artefact
/// deciding where a page ends, which is the one thing this module is for.
fn advance(ch: char, col: usize) -> usize {
    match ch {
        '\t' => TAB_STOP - (col % TAB_STOP),
        '\r' => 0,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn starts(text: &str) -> Vec<usize> {
        paginate(text).into_iter().map(|r| r.start).collect()
    }

    /// The property every page reference rests on: a page is a place in the
    /// file, so the pages have to be the file.
    fn tiles(text: &str) {
        let pages = paginate(text);
        assert_eq!(pages.first().map(|r| r.start), Some(0), "starts at zero");
        assert_eq!(pages.last().map(|r| r.end), Some(text.len()), "ends at the end");
        for pair in pages.windows(2) {
            assert_eq!(pair[0].end, pair[1].start, "no gap and no overlap");
        }
        let rebuilt: String = pages.iter().map(|r| &text[r.clone()]).collect();
        assert_eq!(rebuilt, text, "the pages are the document");
    }

    fn lines_of(count: usize, text: &str) -> String {
        vec![text; count].join("\n")
    }

    #[test]
    fn an_empty_document_is_one_page_and_never_zero() {
        assert_eq!(page_count(""), 1);
        assert_eq!(paginate(""), vec![0..0]);
        tiles("");
    }

    #[test]
    fn a_short_document_is_one_page() {
        let text = "The witness signed it on the fourth.\nSo did the notary.\n";
        assert_eq!(page_count(text), 1);
        tiles(text);
    }

    #[test]
    fn a_blank_line_costs_a_row_like_any_other() {
        // ROWS blank lines fill a page exactly; one more starts the next. Each
        // newline terminates its own line, so ROWS of them is ROWS blank lines.
        let full = "\n".repeat(ROWS);
        assert_eq!(page_count(&full), 1);
        let over = "\n".repeat(ROWS + 1);
        assert_eq!(page_count(&over), 2);
        assert_eq!(starts(&over), vec![0, ROWS]);
        tiles(&over);
    }

    #[test]
    fn a_line_costs_as_many_rows_as_it_wraps_to() {
        // Three rows each: COLS columns of word plus one more character.
        let line = "x".repeat(COLS * 2 + 1);
        let text = lines_of(ROWS, &line);
        assert_eq!(page_count(&text), 3);
        tiles(&text);
    }

    #[test]
    fn a_paragraph_longer_than_a_page_continues_onto_the_next() {
        let text = "y".repeat(COLS * ROWS + COLS);
        let pages = paginate(&text);
        assert_eq!(pages.len(), 2);
        // Nothing is pushed whole and nothing is lost at the seam.
        assert_eq!(pages[0].end, COLS * ROWS);
        tiles(&text);
    }

    #[test]
    fn a_word_that_never_fits_is_broken_rather_than_left_hanging() {
        let url = format!("see {}", "z".repeat(COLS * 2));
        assert_eq!(wrap(&url), vec![0, 4, 4 + COLS]);
    }

    #[test]
    fn a_line_breaks_at_the_last_space_that_fits_and_eats_it() {
        let line = format!("{} tail", "w".repeat(COLS - 2));
        let rows = wrap(&line);
        assert_eq!(rows, vec![0, COLS - 1]);
        assert_eq!(&line[rows[1]..], "tail", "the space went into the break");
    }

    #[test]
    fn a_tab_reaches_the_next_stop_rather_than_costing_one() {
        // Eight tabs is sixty-four columns, so two more characters fit and the
        // third does not.
        let line = format!("{}abc", "\t".repeat(8));
        assert_eq!(width("\t"), TAB_STOP);
        assert_eq!(wrap(&line), vec![0, 8 + 2]);
    }

    #[test]
    fn a_form_feed_ends_the_page_it_is_on() {
        let text = "one\n\x0ctwo\n";
        assert_eq!(starts(text), vec![0, 5]);
        tiles(text);
    }

    #[test]
    fn a_declared_page_too_long_for_the_grid_continues_onto_the_next() {
        let long = lines_of(ROWS + 2, "line");
        let text = format!("{long}\x0cshort\n");
        let pages = paginate(&text);
        // Two pages of the over-long declared page, then the one after it.
        assert_eq!(pages.len(), 3);
        assert_eq!(&text[pages[2].clone()], "short\n");
        tiles(&text);
    }

    #[test]
    fn a_document_opening_on_a_form_feed_does_not_start_with_a_blank_page() {
        let text = "\x0c\x0cfirst\n";
        assert_eq!(page_count(text), 1);
        assert_eq!(&text[paginate(text)[0].clone()], text);
        tiles(text);
    }

    #[test]
    fn a_trailing_newline_ends_the_document_rather_than_starting_a_page() {
        assert_eq!(page_count(&lines_of(ROWS, "a")), 1);
        assert_eq!(page_count(&format!("{}\n", lines_of(ROWS, "a"))), 1);
    }

    #[test]
    fn page_is_one_based_and_agrees_with_paginate() {
        let text = lines_of(ROWS * 2 + 1, "a line");
        assert_eq!(page_count(&text), 3);
        assert_eq!(page(&text, 0), None);
        assert_eq!(page(&text, 1), Some(&text[paginate(&text)[0].clone()]));
        assert_eq!(page(&text, 3), Some(&text[paginate(&text)[2].clone()]));
        assert_eq!(page(&text, 4), None);
    }

    /// AC-780. The boundaries are written down rather than computed, because a
    /// test that derives its expectation from the code under test agrees with
    /// whatever the code does — including with a rule that has quietly changed
    /// and moved every citation on the board.
    #[test]
    fn the_grid_is_pinned_to_numbers_somebody_wrote_down() {
        assert_eq!((COLS, ROWS, TAB_STOP), (66, 46, 8));

        // Forty-seven lines of ten characters: forty-six on page one, one over.
        let text = lines_of(47, "0123456789");
        assert_eq!(starts(&text), vec![0, 46 * 11]);

        // A hundred and thirty-eight columns of unbroken text is three rows.
        let long = "q".repeat(138);
        assert_eq!(wrap(&long), vec![0, 66, 132]);

        // The worked mixed case: a heading, a blank, then wrapped prose.
        let body = format!("REPORT\n\n{}\n", "word ".repeat(40));
        assert_eq!(page_count(&body), 1);
        assert_eq!(starts(&body), vec![0]);
        tiles(&body);
    }

    #[test]
    fn the_same_bytes_paginate_identically_every_time() {
        let text = format!(
            "{}\x0c{}\n{}",
            lines_of(60, "alpha beta gamma"),
            "delta ".repeat(300),
            lines_of(20, "\tepsilon\tzeta")
        );
        let once = paginate(&text);
        let twice = paginate(&text);
        assert_eq!(once, twice);
        assert_eq!(once.len(), page_count(&text));
        tiles(&text);
    }

    #[test]
    fn utf8_is_counted_in_characters_and_never_in_bytes() {
        // Each of these is two bytes and one column.
        let line = "é".repeat(COLS + 1);
        assert_eq!(wrap(&line), vec![0, COLS * 2]);
    }

    // --- decode ------------------------------------------------------------

    #[test]
    fn plain_utf8_decodes_and_a_byte_order_mark_is_dropped() {
        assert_eq!(decode(b"hello").as_deref(), Some("hello"));
        assert_eq!(decode(b"\xef\xbb\xbfhello").as_deref(), Some("hello"));
    }

    #[test]
    fn utf16_decodes_only_when_the_file_announces_it() {
        let le: Vec<u8> = [0xff, 0xfe]
            .into_iter()
            .chain("hi".encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        assert_eq!(decode(&le).as_deref(), Some("hi"));
        let be: Vec<u8> = [0xfe, 0xff]
            .into_iter()
            .chain("hi".encode_utf16().flat_map(u16::to_be_bytes))
            .collect();
        assert_eq!(decode(&be).as_deref(), Some("hi"));
        // The same bytes without the mark are not valid UTF-8 and stay refused.
        assert_eq!(decode(&le[2..]), None);
    }

    #[test]
    fn line_endings_are_normalised_so_two_machines_agree() {
        assert_eq!(decode(b"a\r\nb\rc\nd").as_deref(), Some("a\nb\nc\nd"));
        // And the rule sees the same document either way.
        let crlf = decode(&lines_of(ROWS + 1, "a").replace('\n', "\r\n").into_bytes()).unwrap();
        assert_eq!(page_count(&crlf), 2);
    }

    #[test]
    fn bytes_that_would_read_as_gibberish_on_paper_are_refused() {
        assert_eq!(decode(b"\x89PNG\r\n\x1a\n"), None, "not UTF-8");
        assert_eq!(decode(b"before\0after"), None, "a NUL");
        assert_eq!(decode(b"\x1b[31mred\x1b[0m"), None, "terminal escapes");
        assert_eq!(decode(b"\x07bell"), None, "a C0 control");
    }

    #[test]
    fn the_four_controls_a_document_is_allowed_to_contain_survive() {
        assert_eq!(decode(b"a\tb\nc\x0cd").as_deref(), Some("a\tb\nc\x0cd"));
    }

    #[test]
    fn an_empty_file_is_text_and_is_one_page() {
        assert_eq!(decode(b"").as_deref(), Some(""));
        assert_eq!(page_count(""), 1);
    }
}
