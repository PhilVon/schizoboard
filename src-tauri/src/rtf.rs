//! An `.rtf` read as its words — T-350, and `cues.rs`'s bug in a third format.
//!
//! An RTF is ASCII, so `text::decode` accepts it and `assets::sniff_mime` used
//! to call it `text/plain`. It became a manilla folder, `text::paginate` set it
//! on the 66-column grid, and what turned up on the sheet was
//!
//! ```text
//! {\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\fnil\fcharset0 Calibri;}}
//! \viewkind4\uc1\pard\sa200\sl276\slmult1\f0\fs22 He came up from Wexford
//! ```
//!
//! — the file's own packaging, set in the board's hand, with a rectangle
//! dragged over it cutting a card that carries the control words along. That is
//! worse than a refusal, because the object says it is a case file and the page
//! says it is not.
//!
//! ## The recognition is total, so it is asked of the content
//!
//! This is the `cues.rs` half of the split and not the `markdown.rs` half. An
//! RTF **declares itself in its first five bytes** — [`SIGNATURE`], which the
//! specification requires and every writer emits — so there is a total content
//! test and no need for the asset record to carry a field. T-345's flag stays
//! the one exception it was argued to be (Q-324): markdown has no signature,
//! and this does.
//!
//! The same bytes are asked in two places and it is one fact rather than two
//! writers: [`crate::assets::sniff_mime`] asks them of the file so the record
//! says `text/rtf` and an export writes `.rtf` rather than `.txt`, and [`read`]
//! asks them of the decoded text because `Reader::of_text` is handed a `String`
//! and has no mime to consult. Both go through [`is_rtf`].
//!
//! ## What comes out, and what is deliberately left behind
//!
//! [`crate::prose::Reading`] — the flat string plus role spans that D-65
//! settled and every reader on this board now shares.
//!
//! **Bold and italic** become `Strong` and `Emphasis`. They are *toggles* in
//! this format rather than brackets — `\b` on, `\b0` off, with no promise that
//! `\i` nests tidily inside — which is why `prose::Out` grew `close_role`
//! instead of making do with a stack pop.
//!
//! **A heading** comes from `\outlinelevelN`, which is what Word writes on a
//! paragraph styled as one. Not from the stylesheet: resolving `\s3` to
//! "Heading 3" means holding the whole `\stylesheet` destination and matching
//! on the style's *name*, which is localised — a German Word writes
//! "Uberschrift 3" — so it would read headings in one language and miss them in
//! another. An outline level is a number and means the same thing everywhere.
//!
//! **A list item** comes from `\ls`, with `\ilvl` for its depth. The bullet
//! glyph itself lives in a `\listtext` or `\pntext` destination and is skipped
//! with the rest of them, which is exactly what `prose::Role::Item` asks for:
//! what was said is the words, and the sheet draws the marker.
//!
//! **A page** comes from `\page`, and it becomes a form feed for `text.rs`'s
//! stated reason — the one case where a file that states no layout does declare
//! its own pagination.
//!
//! Everything else is packaging. Fonts, colours, styles, revision tables,
//! embedded pictures, headers and footers are all *destinations*, and a
//! destination this module does not understand is skipped whole rather than
//! having its contents set as characters. That is the failure mode `cues.rs`
//! was written for: not understanding something must lose the packaging, never
//! the writing.

use crate::prose::{Out, Reading, Role};

/// The bytes an RTF opens with, and the whole of the recognition.
///
/// `{\rtf` and not `{\rtf1`: the version digit is part of the header the
/// specification defines, but it is a *version*, and matching on it would
/// refuse a file written by something that had moved on. Five bytes is already
/// a stronger signature than the MPEG frame header `sniff_mime` accepts.
pub const SIGNATURE: &[u8] = br"{\rtf";

/// Whether these bytes open an RTF.
///
/// The one place the question is asked, so the ingest gate and the reader
/// cannot drift apart.
pub fn is_rtf(bytes: &[u8]) -> bool {
    bytes.starts_with(SIGNATURE)
}

/// How many characters follow a `\uN` as its fallback, before `\uc` says
/// otherwise. The specification's default.
const DEFAULT_SKIP: u32 = 1;

/// Destinations whose contents are not the document.
///
/// Not an exhaustive list of RTF's destinations, and it does not need to be: a
/// destination introduced by `\*` is skipped whatever it is called, which is
/// what `\*` means and what covers everything a later Word invents. This list
/// is the ones that are *not* marked ignorable — the ones a 1994 reader was
/// expected to know by name.
const SKIPPED: &[&str] = &[
    "fonttbl",
    "colortbl",
    "stylesheet",
    "listtable",
    "listoverridetable",
    "info",
    "pict",
    "header",
    "headerl",
    "headerr",
    "headerf",
    "footer",
    "footerl",
    "footerr",
    "footerf",
    "footnote",
    "filetbl",
    "revtbl",
    "listtext",
    "pntext",
    "pntxta",
    "pntxtb",
    "field",
    "object",
    "xe",
    "tc",
];

/// Read an RTF as its words, or `None` if these are not an RTF at all.
///
/// `Option` and not a bare `Reading`, for [`crate::cues::speech`]'s reason and
/// against [`crate::markdown::read`]'s: the test here is total, so the honest
/// signature is "is this one, and if so what does it say".
pub fn read(text: &str) -> Option<Reading> {
    if !is_rtf(text.as_bytes()) {
        return None;
    }
    Some(parse(text))
}

fn parse(text: &str) -> Reading {
    let mut out = Out::default();
    let mut state = State::default();
    // One frame per open brace. A group's *formatting* is local to it — leaving
    // a group restores bold, italic and the fallback count to what they were on
    // the way in — which is the whole reason a brace here is not just a
    // bracket.
    let mut groups: Vec<Frame> = Vec::new();

    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '{' => {
                groups.push(Frame {
                    bold: state.bold,
                    italic: state.italic,
                    uc: state.uc,
                    skipping: state.skipping,
                });
                state.skip = 0;
                state.head = true;
            }
            '}' => {
                if let Some(frame) = groups.pop() {
                    // Leaving a group with bold still on is an ordinary file —
                    // the toggle belongs to the group — so the span closes here
                    // rather than running to the end of the document.
                    set_flag(&mut out, &mut state.bold, frame.bold, Role::Strong);
                    set_flag(&mut out, &mut state.italic, frame.italic, Role::Emphasis);
                    state.uc = frame.uc;
                    state.skipping = frame.skipping;
                }
                state.skip = 0;
                state.head = false;
            }
            '\\' => {
                let Some(&next) = chars.peek() else { break };
                if next.is_ascii_alphabetic() {
                    let (word, param) = control_word(&mut chars);
                    apply(&word, param, &mut out, &mut state, groups.len());
                } else {
                    chars.next();
                    control_symbol(next, &mut chars, &mut out, &mut state);
                }
            }
            // Raw line endings carry no meaning in this format; `\par` does.
            '\r' | '\n' => {}
            _ => emit(&mut out, &mut state, &c.to_string()),
        }
    }

    out.finish()
}

/// A control *symbol*: one character, no parameter. The ones that matter are
/// the escapes for the three characters this format spends on syntax.
fn control_symbol<I>(symbol: char, chars: &mut std::iter::Peekable<I>, out: &mut Out, state: &mut State)
where
    I: Iterator<Item = char>,
{
    match symbol {
        '\\' | '{' | '}' => emit(out, state, &symbol.to_string()),
        '~' => emit(out, state, "\u{a0}"),
        // A non-breaking hyphen is a hyphen; an optional one is only where a
        // word *could* break, and is not in the text.
        '_' => emit(out, state, "-"),
        '-' => {}
        '\'' => match hex_byte(chars) {
            Some(byte) => emit(out, state, &cp1252(byte).to_string()),
            // Malformed, and the two characters after it have already been left
            // where they were — this is one bad escape, not a reason to stop.
            None => {}
        },
        // A newline directly after a backslash is `\par` in the old spelling,
        // and some writers still emit it.
        '\r' | '\n' => break_paragraph(out, state),
        // The only symbol that leaves the group head intact, because it is
        // half of a destination rather than content.
        '*' => {
            state.ignorable = true;
            return;
        }
        _ => {}
    }
    state.head = false;
}

/// What is true right now, and restored group by group.
#[derive(Default)]
struct State {
    bold: bool,
    italic: bool,
    /// Whether we are inside a destination whose contents are packaging.
    skipping: bool,
    /// This group's `\uc` fallback count.
    uc: Option<u32>,
    /// A `\*` seen, waiting for the destination word it introduces.
    ignorable: bool,
    /// Whether nothing but a `\*` has happened since this group opened.
    ///
    /// A destination is only a destination at the **head of its own group**,
    /// and without this a `ield` appearing in the middle of a paragraph — a
    /// page number, a cross-reference — swallows every word after it up to the
    /// enclosing brace. Which is the failure this module exists to prevent, so
    /// it is a field rather than an assumption.
    head: bool,
    /// How many characters of a `\uN` fallback are still to be swallowed.
    ///
    /// Not part of a group's saved formatting in the specification's sense, but
    /// reset on every brace anyway: a fallback that ran off the end of its own
    /// group is a malformed file, and swallowing the first words of the next
    /// paragraph is the worse of the two ways to be wrong about it.
    skip: u32,
    /// The list depth of the paragraph being written, if it is a list item.
    item: Option<u8>,
    /// The outline level of the paragraph being written, if it has one.
    heading: Option<u8>,
    /// Which role this paragraph opened, so the same one is closed again. A
    /// paragraph's properties arrive *before* its text, so the span can only be
    /// opened once there is text for it to start at.
    opened: Option<Role>,
}

struct Frame {
    bold: bool,
    italic: bool,
    uc: Option<u32>,
    skipping: bool,
}

fn control_word<I>(chars: &mut std::iter::Peekable<I>) -> (String, Option<i32>)
where
    I: Iterator<Item = char>,
{
    let mut word = String::new();
    while let Some(&c) = chars.peek() {
        if !c.is_ascii_alphabetic() {
            break;
        }
        word.push(c);
        chars.next();
    }
    let mut digits = String::new();
    if let Some(&'-') = chars.peek() {
        digits.push('-');
        chars.next();
    }
    while let Some(&c) = chars.peek() {
        if !c.is_ascii_digit() {
            break;
        }
        digits.push(c);
        chars.next();
    }
    // **A single space after a control word is the delimiter and not a space in
    // the document.** Getting this wrong is how a naive stripper turns every
    // paragraph into one with a space in front of every word.
    if let Some(&' ') = chars.peek() {
        chars.next();
    }
    (word, digits.parse().ok())
}

fn apply(word: &str, param: Option<i32>, out: &mut Out, state: &mut State, depth: usize) {
    // A destination is only a destination at the head of its own group, which
    // is what stops a `\field` appearing mid-paragraph from swallowing the rest
    // of it. The pending `\*` is consumed here whichever way the test goes.
    let ignorable = std::mem::take(&mut state.ignorable);
    let head = std::mem::take(&mut state.head);
    if !state.skipping && depth > 0 && head && (ignorable || SKIPPED.contains(&word)) {
        state.skipping = true;
        return;
    }
    if state.skipping {
        return;
    }
    // Any control word other than `\u` itself ends a pending fallback. The
    // specification counts the fallback in *characters*, so a word arriving
    // inside one means the writer has moved on and the count is stale — and a
    // stale count eats real words, which is the failure worth being blunt
    // about.
    if word != "u" {
        state.skip = 0;
    }
    match word {
        "par" | "sect" => break_paragraph(out, state),
        "line" => break_line(out),
        "page" => {
            close_paragraph(out, state);
            out.page_break();
        }
        "tab" => emit(out, state, "\t"),
        // `\pard` resets paragraph formatting, which is where the list and
        // heading roles live. Character formatting is a group's business and is
        // deliberately untouched by it.
        "pard" => {
            close_paragraph(out, state);
            state.item = None;
            state.heading = None;
        }
        "b" => set_flag(out, &mut state.bold, param != Some(0), Role::Strong),
        "i" => set_flag(out, &mut state.italic, param != Some(0), Role::Emphasis),
        "uc" => state.uc = param.map(|n| n.max(0) as u32),
        "u" => {
            if let Some(ch) = unicode_char(param) {
                let held = std::mem::take(&mut state.skip);
                emit(out, state, &ch.to_string());
                state.skip = held;
            }
            state.skip = state.uc.unwrap_or(DEFAULT_SKIP);
        }
        "ls" => state.item = Some(state.item.unwrap_or(0)),
        "ilvl" => state.item = Some(param.unwrap_or(0).clamp(0, u8::MAX as i32) as u8),
        "outlinelevel" => {
            // Nine levels, and `\outlinelevel9` is Word's "body text" — which
            // is not a heading, and is how a styled paragraph says it has gone
            // back to being prose.
            state.heading = param.and_then(|n| (0..=5).contains(&n).then_some(n as u8 + 1));
        }
        // An unknown control word is formatting, and formatting is what this
        // module drops.
        _ => {}
    }
}

/// Emit document text, opening the paragraph's role if this is its first
/// character.
fn emit(out: &mut Out, state: &mut State, text: &str) {
    state.head = false;
    if state.skipping {
        return;
    }
    if state.skip > 0 {
        state.skip -= 1;
        return;
    }
    if state.opened.is_none() {
        let role = state
            .heading
            .map(Role::Heading)
            .or_else(|| state.item.map(Role::Item));
        if let Some(role) = role {
            out.open(role);
            state.opened = Some(role);
        }
    }
    out.push(text);
}

fn break_paragraph(out: &mut Out, state: &mut State) {
    let was_item = state.item.is_some();
    close_paragraph(out, state);
    // A list item sits on its own line inside the list; anything else is a
    // block. `markdown.rs` draws the same distinction for the same reason:
    // separating items with a blank line puts a gap in the middle of one list.
    if was_item {
        out.line();
    } else {
        out.block();
    }
}

/// A `\line` is inside the paragraph, so its role stays open across it —
/// which is what makes a two-line heading one heading.
fn break_line(out: &mut Out) {
    out.line();
}

/// Close whatever role this paragraph opened, leaving bold and italic alone.
///
/// `close_role` and not `close`, because the innermost open span at the end of
/// a heading is very often a `Strong` that the group has not closed yet — a
/// plain pop would end the bold run and leave the heading running to the end of
/// the document.
fn close_paragraph(out: &mut Out, state: &mut State) {
    if let Some(role) = state.opened.take() {
        out.close_role(role);
    }
}

/// The two hex digits of a `\'` escape.
fn hex_byte<I>(chars: &mut std::iter::Peekable<I>) -> Option<u8>
where
    I: Iterator<Item = char>,
{
    let mut hex = String::new();
    for _ in 0..2 {
        let &c = chars.peek()?;
        if !c.is_ascii_hexdigit() {
            return None;
        }
        hex.push(c);
        chars.next();
    }
    u8::from_str_radix(&hex, 16).ok()
}

/// A `\uN` parameter as a character.
///
/// The parameter is a **signed** 16-bit number, so anything above `U+7FFF`
/// arrives negative and wraps — the format's own workaround for a field it made
/// too small. A lone surrogate is refused rather than mapped to a replacement
/// character: the pair that would have made a real character is two `\u`s and
/// this reader does not join them, so dropping it is a smaller lie than a page
/// of question marks.
fn unicode_char(param: Option<i32>) -> Option<char> {
    let n = param?;
    let code = if n < 0 { (n + 65536) as u32 } else { n as u32 };
    char::from_u32(code)
}

/// Windows-1252, which is what a `\'` escape means in practice.
///
/// The header names a code page — `\ansicpg1252` in everything Word has written
/// this century — and honouring that field properly means a table per code page
/// for files that would in any case be using `\u` if they had anything unusual
/// to say. The 32 bytes from `0x80` are the only ones where 1252 and Latin-1
/// disagree, and they are exactly the curly quotes and dashes an English
/// document does contain, so they are worth the table and the rest is Latin-1.
fn cp1252(byte: u8) -> char {
    const HIGH: [char; 32] = [
        '\u{20ac}', '\u{fffd}', '\u{201a}', '\u{0192}', '\u{201e}', '\u{2026}', '\u{2020}',
        '\u{2021}', '\u{02c6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{fffd}',
        '\u{017d}', '\u{fffd}', '\u{fffd}', '\u{2018}', '\u{2019}', '\u{201c}', '\u{201d}',
        '\u{2022}', '\u{2013}', '\u{2014}', '\u{02dc}', '\u{2122}', '\u{0161}', '\u{203a}',
        '\u{0153}', '\u{fffd}', '\u{017e}', '\u{0178}',
    ];
    match byte {
        0x80..=0x9f => HIGH[(byte - 0x80) as usize],
        _ => byte as char,
    }
}

/// Turn a flag on or off, opening or closing its span.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// What Word writes, cut down: a header with a font table, a colour table,
    /// an ignorable generator destination, and then the document.
    const WORD: &str = concat!(
        r"{\rtf1\ansi\ansicpg1252\deff0\nouicompat\deflang2057",
        r"{\fonttbl{\f0\fnil\fcharset0 Calibri;}}",
        r"{\colortbl ;\red0\green0\blue255;}",
        r"{\*\generator Riched20 10.0.19041;}",
        "\r\n",
        r"\viewkind4\uc1",
        "\r\n",
        r"\pard\outlinelevel0\b\fs32 The Wexford statement\b0\fs22\par",
        r"\pard He arrived on the \b Tuesday\b0  train, and \i said nothing\i0 .\par",
        "}"
    );

    fn read_ok(text: &str) -> Reading {
        read(text).expect("these bytes open an RTF")
    }

    fn roles(reading: &Reading) -> Vec<(Role, String)> {
        reading
            .roles
            .iter()
            .map(|s| (s.role, reading.text[s.start..s.end].to_owned()))
            .collect()
    }

    /// AC-957, and the whole of the bug: the page reads sentences, not the
    /// control words and not the font table.
    #[test]
    fn a_word_file_reads_as_its_sentences() {
        let read = read_ok(WORD);
        assert_eq!(
            read.text,
            "The Wexford statement\n\nHe arrived on the Tuesday train, and said nothing."
        );
        assert!(!read.text.contains('\\'), "a control word reached the page");
        assert!(!read.text.contains("Calibri"), "the font table reached the page");
        assert!(!read.text.contains("Riched20"), "the generator reached the page");
    }

    /// AC-959. Bold and italic are toggles in this format, and they come out as
    /// the same two spans a markdown file's asterisks do.
    #[test]
    fn bold_and_italic_survive_as_spans_over_the_words() {
        let read = read_ok(WORD);
        let roles = roles(&read);
        assert!(roles.contains(&(Role::Heading(1), "The Wexford statement".into())), "{roles:?}");
        assert!(roles.contains(&(Role::Strong, "Tuesday".into())), "{roles:?}");
        assert!(roles.contains(&(Role::Emphasis, "said nothing".into())), "{roles:?}");
    }

    /// The one a plain stack pop gets wrong, and the reason `prose::Out` grew
    /// `close_role`: bold opens, italic opens inside it, bold closes first.
    #[test]
    fn a_toggle_closing_across_another_ends_the_right_one() {
        let read = read_ok(concat!(
            r"{\rtf1\pard\b one \i two\b0  three\i0 .\par}",
        ));
        let roles = roles(&read);
        assert!(roles.contains(&(Role::Strong, "one two".into())), "{roles:?}");
        assert!(roles.contains(&(Role::Emphasis, "two three".into())), "{roles:?}");
    }

    /// AC-960 — and it is `text.rs`'s form feed rule rather than a new one, so
    /// the assertion is on the page count and not on a character.
    #[test]
    fn a_page_control_word_is_a_page() {
        let read = read_ok(r"{\rtf1\pard One\par\page Two\par}");
        assert_eq!(read.text, "One\x0cTwo");
        assert_eq!(crate::text::page_count(&read.text), 2);
    }

    /// AC-958. The test is the first five bytes and nothing else, so a text
    /// file that merely talks about the format is a text file.
    #[test]
    fn a_file_that_mentions_rtf_is_not_one() {
        assert!(read(r"An RTF starts with {\rtf1 and nothing else does.").is_none());
        assert!(read("").is_none());
        assert!(read(r"{\rtf1}").is_some());
    }

    /// A control word's delimiting space is not a space in the document. Get
    /// this wrong and every word gets one in front of it.
    #[test]
    fn the_space_after_a_control_word_is_the_delimiter() {
        assert_eq!(read_ok(r"{\rtf1\pard\f0\fs22 One two three\par}").text, "One two three");
    }

    /// A `\field` in the middle of a paragraph is a page number or a
    /// cross-reference, and it must not swallow the words after it.
    #[test]
    fn a_destination_mid_paragraph_does_not_eat_the_rest() {
        let read = read_ok(r"{\rtf1\pard Before {\field{\*\fldinst PAGE}{\fldrslt 7}} after.\par}");
        assert_eq!(read.text, "Before  after.");
    }

    /// The two spellings of a character above ASCII, and the fallback the
    /// second one carries for readers that cannot manage it.
    #[test]
    fn an_escaped_character_is_the_character_it_names() {
        // A cp1252 `\'92` is a right single quote, and `舒` is an em dash
        // with a `?` written behind it for a reader that cannot manage one.
        // The `?` is the fallback and must not reach the page — `\uc1` says it
        // is exactly one character long.
        let read = read_ok(concat!(r"{\rtf1\uc1\pard It\'92s here ", r"\", "u8212 ? now", r"\par}"));
        assert_eq!(read.text, "It\u{2019}s here \u{2014} now");

        // And the same character in the spelling the format is forced into
        // above U+7FFF, where its own parameter field runs out and wraps.
        let read = read_ok(r"{\rtf1\uc1\pard A \u-3600 ? B\par}");
        assert_eq!(read.text, "A \u{f1f0} B");
    }

    /// AC-959 again from the other side: a list item is its words, and the
    /// bullet the file drew is packaging.
    #[test]
    fn a_list_item_is_its_words_and_the_bullet_is_not() {
        let read = read_ok(concat!(
            r"{\rtf1\pard\ls1\ilvl0{\listtext\'b7\tab}Milk\par",
            r"\pard\ls1\ilvl0{\listtext\'b7\tab}Bread\par}"
        ));
        assert_eq!(read.text, "Milk\nBread");
        let roles = roles(&read);
        assert!(roles.contains(&(Role::Item(0), "Milk".into())), "{roles:?}");
        assert!(roles.contains(&(Role::Item(0), "Bread".into())), "{roles:?}");
    }

    /// The tiling invariant D-65 rests on, checked here rather than assumed:
    /// what comes out is a flat string, so every page range still concatenates
    /// back to the whole of it.
    #[test]
    fn the_read_words_still_tile() {
        let body: String = (0..400).map(|n| format!(r"\pard Line {n} of the file.\par")).collect();
        let read = read_ok(&format!(r"{{\rtf1{body}}}"));
        let joined: String = crate::text::paginate(&read.text)
            .into_iter()
            .map(|r| read.text[r].to_owned())
            .collect();
        assert_eq!(joined, read.text);
    }
}
