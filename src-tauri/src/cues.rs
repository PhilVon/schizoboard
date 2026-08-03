//! A subtitle file read as speech — T-287, Q-301.
//!
//! A sidecar `.srt` or `.vtt` is stored as an ordinary text asset, because
//! `assets::sniff_mime` judges bytes and never a name (Q-255). That was enough
//! to make a recording *searchable* — the words are in the file and the index
//! reads the file. It is not enough to make one **readable**, and driving it is
//! what showed the difference: a transcript turned up on a sheet read
//!
//! ```text
//! 1
//! 00:00:00,000 --> 00:00:03,200
//! He came up from Wexford on the Tuesday train.
//! ```
//!
//! and a rectangle dragged over those words cut a card carrying the cue number
//! and the arrow with them. That is the file's *packaging* set on paper in our
//! own hand — the timings are how a player knows when to put a line on screen,
//! and this board is not a player.
//!
//! So this module is one question asked of a file: **is it made of cues?** If
//! it is, what comes out is the speech alone, and everything downstream —
//! [`crate::text::paginate`], the page count on the asset record, the reading
//! surface, the search index and the quote gesture — works on that instead, and
//! none of them needs to know a transcript exists. If it is not, the answer is
//! `None` and a text file is a text file.
//!
//! ## Why the test is "made of cues" and not "contains an arrow"
//!
//! `-->` occurs in prose, in code and in every HTML comment ever written, and a
//! log file with one arrow in it must not lose the rest of its lines to a
//! parser that thought it was a transcript. So the rule below is total: every
//! block in the file has to be a cue, and anything left over that is not blank,
//! not a cue identifier and not a `WEBVTT` header means this is not a subtitle
//! file and nothing is stripped. A file either is one or it is not, and a
//! partial reading is the one answer that would silently throw writing away.
//!
//! This is the same shape as the decision one level up: the *extension* is what
//! found the file beside the recording (`paste.ts`), and the *content* is what
//! decides what it is. A file named `interview.srt` that holds a shopping list
//! is a shopping list.

/// Where in the speech a cue starts, and when it is said.
///
/// `offset` is a byte offset into [`Speech::text`] — the same units
/// `text::paginate` tiles in, so a page's range and these marks are comparable
/// without a second opinion about what a character is. `at` is seconds from the
/// start of the recording, which is what a citation says out loud.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mark {
    pub offset: usize,
    pub at: f32,
}

/// A subtitle file with its packaging taken off.
#[derive(Debug, Clone, PartialEq)]
pub struct Speech {
    /// The spoken lines and nothing else, one cue per line.
    pub text: String,
    /// One per cue, in order, and never empty when [`speech`] answered `Some`.
    pub marks: Vec<Mark>,
}

impl Speech {
    /// When the passage at this byte offset was said, or `None` before the
    /// first cue.
    ///
    /// The cue the offset falls *in*, which is the last mark at or before it —
    /// a quote is cited from where it starts, the way a page reference is.
    pub fn at(&self, offset: usize) -> Option<f32> {
        let mut said = None;
        for mark in &self.marks {
            if mark.offset > offset {
                break;
            }
            said = Some(mark.at);
        }
        said
    }
}

/// Read a file as speech, or `None` if it is not a subtitle file.
///
/// Takes text already decoded and normalised by [`crate::text::decode`], so
/// line endings are `\n` and the offsets below are offsets into the same string
/// every other reader sees.
pub fn speech(text: &str) -> Option<Speech> {
    let mut out = String::new();
    let mut marks: Vec<Mark> = Vec::new();
    let mut lines = text.lines().peekable();

    // A `WEBVTT` header, and whatever the file says on the same line. Only at
    // the very top, which is where the format puts it — one further down is a
    // line of dialogue that happens to read WEBVTT, and taking it as a header
    // would be reading the file wrong in the one way this module must not.
    if lines
        .peek()
        .is_some_and(|first| first.trim_start_matches('\u{feff}').starts_with("WEBVTT"))
    {
        lines.next();
        // Everything to the first blank line belongs to the header.
        for line in lines.by_ref() {
            if line.trim().is_empty() {
                break;
            }
        }
    }

    // Where in a cue block the walk is. Both formats are the same grammar —
    // an optional identifier, a timing line, then the words until a blank line
    // — and the state is what makes an SRT cue *number* an identifier rather
    // than a word. Without it the "2" above the second cue is appended to the
    // first cue's speech, which is how this was actually wrong: the card came
    // out reading "on the Tuesday train. 2".
    enum At {
        /// Between cues: the next line is an identifier or a timing line.
        Between,
        /// An identifier has been seen and only a timing line may follow it.
        Identified,
        /// Inside a cue: every line until the blank one is speech.
        Words,
    }
    let mut at = At::Between;

    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            // A blank line closes a block. One that arrives while an identifier
            // is still waiting for its timing means the line was not an
            // identifier at all — see the module note.
            if matches!(at, At::Identified) {
                return None;
            }
            at = At::Between;
            continue;
        }

        if let Some((start, _)) = timing(trimmed) {
            at = At::Words;
            // The separator goes in *before* the mark is taken, so the offset
            // recorded is where this cue's first word will actually land. The
            // other order is off by one for every cue after the first, which is
            // a citation naming the line above the one somebody quoted.
            if !out.is_empty() {
                out.push('\n');
            }
            marks.push(Mark {
                offset: out.len(),
                at: start,
            });
            continue;
        }

        match at {
            At::Between => at = At::Identified,
            // Two lines running with no timing between them. That is prose, or
            // a log, or a note — whatever it is, it is not a transcript, and
            // reading it as one would throw every untimed line away.
            At::Identified => return None,
            // Inside a cue: the words. A subtitle is broken across lines to fit
            // somebody else's screen, and those breaks are that renderer's
            // rather than the speaker's — so they are joined with a space and
            // our own measure decides where the line ends (`text::COLS`).
            //
            // Stripped here rather than at the end, because taking characters
            // out of the finished string would move every offset already
            // recorded past it — the marks are into `out` as it stands.
            At::Words => {
                let started = marks.last().is_some_and(|mark| mark.offset == out.len());
                if !started {
                    out.push(' ');
                }
                out.push_str(&strip_tags(trimmed));
            }
        }
    }

    if matches!(at, At::Identified) || marks.is_empty() {
        return None;
    }

    Some(Speech { text: out, marks })
}

/// The two times on a cue's timing line, in seconds, or `None` if it is not
/// one.
///
/// The settings a `.vtt` may put after the second timestamp — `align:start`,
/// `line:0` — are allowed and ignored: they position the text on a player's
/// screen, and there is no player here.
fn timing(line: &str) -> Option<(f32, f32)> {
    let (before, after) = line.split_once("-->")?;
    let start = timestamp(before.trim())?;
    // Only the timestamp; whatever follows it is positioning.
    let end_word = after.split_whitespace().next()?;
    let end = timestamp(end_word)?;
    Some((start, end))
}

/// `HH:MM:SS,mmm`, `HH:MM:SS.mmm` or `MM:SS.mmm` as seconds.
///
/// Both spellings of the decimal separator, because that is the one place the
/// two formats differ: SubRip writes a comma and WebVTT a full stop, and a file
/// that mixes them is still a file somebody has to read.
fn timestamp(word: &str) -> Option<f32> {
    let word = word.trim();
    if word.is_empty() {
        return None;
    }
    let mut parts = word.split(':');
    let a = parts.next()?;
    let b = parts.next()?;
    let c = parts.next();
    if parts.next().is_some() {
        return None;
    }
    let (hours, minutes, seconds) = match c {
        Some(c) => (number(a)?, number(b)?, c),
        // `MM:SS.mmm` — WebVTT's short form, and the hour is nothing.
        None => (0.0, number(a)?, b),
    };
    if minutes < 0.0 || hours < 0.0 {
        return None;
    }
    let seconds = seconds.replace(',', ".");
    let seconds: f32 = seconds.parse().ok()?;
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

/// A whole number of hours or minutes, and nothing else.
///
/// Strict on purpose: `12abc` parsing as twelve would let a line of prose
/// containing an arrow read as a cue, which is the one thing the module rule
/// above is defined to prevent.
fn number(word: &str) -> Option<f32> {
    if word.is_empty() || !word.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    word.parse().ok()
}

/// Take the styling tags out of a cue's words.
///
/// `<i>`, `<b>`, and WebVTT's `<v Bob>` voice spans and `<00:00:02.000>` word
/// timings. They are markup for a player's overlay, and setting them on paper
/// would print the punctuation rather than read the file — the same argument
/// [`crate::text::decode`] makes about an escape sequence in a coloured log.
///
/// Deliberately only angle brackets. SubRip also carries the occasional
/// `{\an8}` positioning override borrowed from another format, and a brace is
/// far too common in ordinary writing to strip on sight; one showing through on
/// a rare file is a better failure than a stripped brace in a quotation.
fn strip_tags(text: &str) -> String {
    if !text.contains('<') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut depth = 0usize;
    for ch in text.chars() {
        match ch {
            '<' => depth += 1,
            '>' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRT: &str = "1\n\
00:00:00,000 --> 00:00:03,200\n\
He came up from Wexford on the Tuesday train.\n\
\n\
2\n\
00:00:03,200 --> 00:01:07,400\n\
I asked him twice and he gave me the same answer\n\
both times, word for word.\n";

    #[test]
    fn a_subrip_file_reads_as_its_speech_and_nothing_else() {
        let read = speech(SRT).expect("a subtitle file");
        assert_eq!(
            read.text,
            "He came up from Wexford on the Tuesday train.\n\
             I asked him twice and he gave me the same answer both times, word for word."
        );
        // No cue number, no arrow, no timestamp — the whole point.
        assert!(!read.text.contains("-->"));
        assert!(!read.text.contains("00:00"));
    }

    #[test]
    fn every_cue_is_marked_where_its_words_actually_start() {
        let read = speech(SRT).expect("a subtitle file");
        assert_eq!(read.marks.len(), 2);
        assert_eq!(read.marks[0].offset, 0);
        assert_eq!(read.marks[0].at, 0.0);
        // The second cue opens at the byte after the newline that closed the
        // first — the off-by-one this asserts is a citation naming the line
        // above the one somebody quoted.
        let second = read.marks[1].offset;
        assert_eq!(&read.text[second..second + 7], "I asked");
        assert_eq!(read.marks[1].at, 3.2);
    }

    #[test]
    fn a_quote_is_cited_from_the_cue_it_falls_in() {
        let read = speech(SRT).expect("a subtitle file");
        let second = read.marks[1].offset;
        assert_eq!(read.at(0), Some(0.0));
        assert_eq!(read.at(second - 1), Some(0.0), "still the first cue");
        assert_eq!(read.at(second), Some(3.2));
        assert_eq!(read.at(read.text.len()), Some(3.2), "the last cue runs on");
    }

    #[test]
    fn an_hour_in_is_an_hour_in() {
        let read = speech(
            "1\n01:05:07,500 --> 01:05:09,000\nlate on\n",
        )
        .expect("a subtitle file");
        assert_eq!(read.marks[0].at, 3907.5);
    }

    #[test]
    fn a_webvtt_file_reads_the_same_way_with_its_own_punctuation() {
        let read = speech(
            "WEBVTT - the interview\n\
             \n\
             00:00.000 --> 00:03.200 align:start line:0\n\
             <v Wexford>He came up on the Tuesday train.\n",
        )
        .expect("a subtitle file");
        assert_eq!(read.text, "He came up on the Tuesday train.");
        assert_eq!(read.marks[0].at, 0.0);
    }

    #[test]
    fn a_file_that_merely_contains_an_arrow_is_left_alone() {
        // The failure this rule exists to prevent: a note, a log or a page of
        // markup losing every line that is not a cue.
        assert_eq!(speech("the flow is A --> B\nand back again\n"), None);
        assert_eq!(speech("<!-- a comment -->\n<p>hello</p>\n"), None);
        assert_eq!(speech("ordinary prose, two lines\nof it\n"), None);
        assert_eq!(speech(""), None);
    }

    #[test]
    fn a_transcript_with_something_else_in_it_is_not_a_transcript() {
        // Every block has to be a cue. A partial reading is the one answer
        // that would throw somebody's writing away without saying so.
        let mixed = format!("{SRT}\nand then a line nobody timed\nand another\n");
        assert_eq!(speech(&mixed), None);
    }

    #[test]
    fn the_words_are_stripped_of_a_players_markup_but_not_of_a_brace() {
        let read = speech("1\n00:00:01,000 --> 00:00:02,000\n<i>said</i> {softly}\n")
            .expect("a subtitle file");
        assert_eq!(read.text, "said {softly}");
    }

    #[test]
    fn a_cue_with_no_identifier_is_still_a_cue() {
        // WebVTT's identifier is optional and SubRip's is conventional, so a
        // file without them must not read as prose.
        let read = speech("00:00:01,000 --> 00:00:02,000\nno number above me\n")
            .expect("a subtitle file");
        assert_eq!(read.text, "no number above me");
    }
}
