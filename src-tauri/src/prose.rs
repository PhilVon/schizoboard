//! A document read as its words, and what each stretch of them was — D-65.
//!
//! This is the shape [`crate::cues`] arrived at for a transcript and
//! [`crate::markdown`] took for a `.md`: **a flat string with the packaging
//! taken off, and a sidecar of role spans in byte offsets into that same
//! string.** D-65 has the argument in full; the short of it is that everything
//! downstream of the reading — `text::paginate`'s tiling, the page count on the
//! asset record, the search index, and the passage a quote is cut from — is
//! defined over a flat string, and `text.rs` will not have a page boundary that
//! depends on a typeface.
//!
//! It lives here rather than in `markdown.rs` because **markdown is not the
//! only format that says these things**. T-322 adds three more producers — an
//! `.rtf`, an `.html` and the two zip containers — and every one of them says
//! heading, list item, quotation, code, emphasis and strong, because those six
//! are what a *document* says and not what a *syntax* says. A shape shared by
//! four formats named after the one that happened to introduce it is a comment
//! nobody can write honestly, so it moved out on the second producer.
//!
//! What is *not* here is any reading. Each format keeps its own module and its
//! own parser, because the only thing they have in common is what comes out.

/// What a span of the read text is.
///
/// Deliberately small, and each of these earns its place by being something the
/// sheet can *draw* differently — DESIGN's reading surface sets a heading larger
/// and indents a list, and there is nothing it can do with the knowledge that
/// two words were a reference link rather than an inline one. Anything a format
/// says that the paper cannot say back is packaging, and packaging is what
/// these modules exist to take off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Role {
    /// `#` through `######`, an `<h1>`, a Word outline level. The level,
    /// one-based, because a sheet sets a second-level heading smaller than a
    /// first.
    Heading(u8),
    /// A bullet or a numbered item, with how deeply it is nested — zero at the
    /// top. The *marker* is not in the text: what was said is the words, and
    /// the sheet draws the bullet. A quote cut from a list cites the words.
    Item(u8),
    /// Inside a `>` block. Somebody else's words inside this document, which is
    /// a distinction this board of all boards should keep.
    Quote,
    /// Fenced, indented or inline. Set as it was written — code is the one
    /// place where the line breaks and the spaces *are* the content, so this is
    /// also the one role that suppresses the reflow in [`Out::push`].
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

/// A document with its marks taken off.
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    /// The words, and the shape of the page in blank lines. What paginates.
    pub text: String,
    /// In document order — outermost first where two overlap, so a reader
    /// walking these alongside the text meets a heading before the bold word
    /// inside it. [`Out::finish`] sorts them; a stack alone would give the
    /// reverse.
    pub roles: Vec<Span>,
}

/// The text being built, the spans open over it, and the whitespace it owes.
///
/// Separation is *pending* rather than written, which is what keeps a blank
/// line from being emitted before a block that turns out to be empty, and what
/// stops two blocks in a row producing four newlines. Nothing is appended until
/// there is something to append it before.
///
/// `pub(crate)` and not `pub`: this is machinery every extractor shares, and
/// nothing outside this crate has a document to take apart.
#[derive(Default)]
pub(crate) struct Out {
    text: String,
    roles: Vec<Span>,
    /// Open spans, innermost last.
    ///
    /// **The start is `None` until the span holds a character**, and that is not
    /// tidiness — it is the fix for a bug the heading and list tests both caught
    /// on markdown's first run. Separation between blocks is *owed* rather than
    /// written, so at the moment a heading opens, the two newlines before it
    /// have not been appended yet; taking `text.len()` there put them inside the
    /// span, and the second heading in a file came back reading "\n\nThree".
    /// Deciding the start at the first [`Out::push`] is what makes a span begin
    /// at its own first word — and it retires the empty-span check in
    /// [`Out::close`] into the same mechanism, since a span that never held a
    /// character never got one.
    stack: Vec<(Option<usize>, Role)>,
    /// `2` for a blank line between blocks, `1` for a new line, `0` for none.
    owed: u8,
    /// Inside code, where the line breaks are the content.
    pub(crate) verbatim: bool,
}

impl Out {
    /// A blank line before whatever comes next, if anything has been written.
    pub(crate) fn block(&mut self) {
        if !self.text.is_empty() {
            self.owed = self.owed.max(2);
        }
    }

    /// A new line before whatever comes next, if anything has been written.
    pub(crate) fn line(&mut self) {
        if !self.text.is_empty() {
            self.owed = self.owed.max(1);
        }
    }

    /// A page break the file declared.
    ///
    /// A form feed and not a marker of our own, because `text::paginate`
    /// already honours one: it is "the single case where a page-less file does
    /// state its own pagination" (`text.rs`), and an `.rtf`'s page control
    /// word, a `.docx`'s explicit break and an `.epub`'s spine boundary are all
    /// that same sentence in another format. So a declared page costs no new
    /// pagination rule and no new decision — T-322, AC-805.
    ///
    /// Written immediately rather than owed, because it is content: the tiling
    /// has to see it, and an owed break before a file that then ends would
    /// vanish, which is the one case where the pending trick is wrong.
    ///
    /// It **discards** the separation it owed rather than flushing it first. A
    /// page break already separates, and an `.rtf` spells a new page as
    /// `\par\page` — so writing the owed blank line as well put two empty rows
    /// at the foot of every declared page, which is a paragraph gap the
    /// document does not contain.
    pub(crate) fn page_break(&mut self) {
        if self.text.is_empty() {
            return;
        }
        self.owed = 0;
        self.text.push('\x0c');
    }

    /// Append text, opening any span that is still waiting for its first
    /// character at the point this lands.
    pub(crate) fn push(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.close_pending();
        let at = self.text.len();
        for (start, _) in self.stack.iter_mut() {
            if start.is_none() {
                *start = Some(at);
            }
        }
        if self.verbatim {
            self.text.push_str(text);
            return;
        }
        // A newline inside ordinary text is a producer handing back a line of a
        // paragraph, and a paragraph reflows onto the 66-column grid: honouring
        // the source's wrapping would set it ragged against a measure it was
        // never written for.
        for (i, piece) in text.split('\n').enumerate() {
            if i > 0 {
                self.text.push(' ');
            }
            self.text.push_str(piece);
        }
    }

    fn close_pending(&mut self) {
        for _ in 0..self.owed {
            self.text.push('\n');
        }
        self.owed = 0;
    }

    /// Open a span. It begins at the next character pushed, not here.
    pub(crate) fn open(&mut self, role: Role) {
        self.stack.push((None, role));
    }

    /// Close the innermost open span, unless it turned out to hold nothing.
    ///
    /// An empty span is a heading with no words in it or a list item that was
    /// only a nested list — real things in real files, and a zero-length span
    /// is a mark on the page with nothing under it.
    pub(crate) fn close(&mut self) {
        let Some((start, role)) = self.stack.pop() else {
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

    /// Close the innermost open span of this role, wherever it is on the stack,
    /// leaving the ones inside it open.
    ///
    /// For the formats whose emphasis is a **toggle** rather than a bracket —
    /// an `.rtf` says bold-on and bold-off with no promise that italic nests
    /// tidily inside, and neither does a run of `.docx` properties. A stack
    /// discipline is the wrong tool for a set of flags, so this closes the one
    /// that was asked for and re-opens whatever was above it at the point the
    /// text has reached.
    pub(crate) fn close_role(&mut self, role: Role) {
        let Some(at) = self.stack.iter().rposition(|(_, r)| *r == role) else {
            return;
        };
        let above: Vec<Role> = self.stack[at + 1..].iter().map(|(_, r)| *r).collect();
        // Close down to and including the one asked for, innermost first.
        for _ in at..self.stack.len() {
            self.close();
        }
        // And re-open what was inside it. Each begins at the next character, so
        // a span that ends here does not swallow the gap.
        for role in above {
            self.open(role);
        }
    }

    /// Everything still open closes, and the spans go into document order.
    pub(crate) fn finish(mut self) -> Reading {
        // Anything still open at the end is a file that stopped mid-structure.
        // Closed before the trim so a span never points past the text.
        while !self.stack.is_empty() {
            self.close();
        }
        // **Into document order**, which a stack does not give: spans are
        // recorded when they *close*, so an inner one always lands before the
        // outer one that contains it. Outermost first is the order a reader
        // walking the text alongside these wants — it meets a heading before
        // the bold word inside it, and a list item before the list nested in
        // it — so the sort is by where a span starts and then by the longer of
        // two that start together.
        self.roles
            .sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
        let text = self.text.trim_end();
        // The trim can leave a span pointing past the end — a file ending in a
        // heading followed by blank lines. Clamped rather than dropped: the
        // words are still there and it is only the trailing whitespace that
        // left.
        let end = text.len();
        let text = text.to_owned();
        let mut roles = self.roles;
        roles.retain(|s| s.start < end);
        for span in &mut roles {
            span.end = span.end.min(end);
        }
        // **Two spans of one role that touch are one span.** [`close_role`]
        // splits a run every time an outer toggle closes across it, so an
        // `.rtf` that turns bold off in the middle of an italic phrase would
        // otherwise hand the sheet two italic spans meeting at a boundary
        // nobody wrote. They draw identically either way; this is so the
        // sidecar says what the document says rather than what the parser did.
        // Keyed by role rather than scanning back, because the span that ended
        // where this one begins is not necessarily the previous one: a `Strong`
        // opening in the middle of the phrase sorts between the two halves of
        // the `Emphasis` it interrupts.
        let mut merged: Vec<Span> = Vec::with_capacity(roles.len());
        let mut last: std::collections::HashMap<Role, usize> = std::collections::HashMap::new();
        for span in roles {
            match last.get(&span.role).copied() {
                Some(i) if merged[i].end == span.start => merged[i].end = span.end,
                _ => {
                    last.insert(span.role, merged.len());
                    merged.push(span);
                }
            }
        }
        Reading {
            text,
            roles: merged,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The toggle discipline the flag formats need, and the one thing a plain
    /// stack gets wrong: bold opens, italic opens inside it, and bold closes
    /// first. Both words are bold; only the second is italic.
    #[test]
    fn a_role_closes_from_the_middle_of_the_stack() {
        let mut out = Out::default();
        out.open(Role::Strong);
        out.push("one ");
        out.open(Role::Emphasis);
        out.push("two");
        out.close_role(Role::Strong);
        out.push(" three");
        let read = out.finish();

        assert_eq!(read.text, "one two three");
        let strong = read.roles.iter().find(|s| s.role == Role::Strong).unwrap();
        assert_eq!(&read.text[strong.start..strong.end], "one two");
        // Emphasis outlives it, and covers the words on both sides of the close.
        let em = read.roles.iter().find(|s| s.role == Role::Emphasis).unwrap();
        assert_eq!(&read.text[em.start..em.end], "two three");
    }

    #[test]
    fn a_declared_page_break_is_a_form_feed_the_tiling_can_see() {
        let mut out = Out::default();
        out.push("one");
        out.page_break();
        out.push("two");
        let read = out.finish();

        assert_eq!(read.text, "one\x0ctwo");
        assert_eq!(crate::text::page_count(&read.text), 2);
    }

    /// A break before anything has been written is not a page — a file that
    /// opens with one would otherwise get a blank first page nobody asked for.
    #[test]
    fn a_page_break_at_the_very_start_is_not_a_page() {
        let mut out = Out::default();
        out.page_break();
        out.push("one");
        assert_eq!(out.finish().text, "one");
    }

    /// The trim at the end must not leave a span hanging past the text — a
    /// slice with either end past the string panics, and it would panic on the
    /// reading surface rather than here.
    #[test]
    fn a_span_never_points_past_the_trimmed_text() {
        let mut out = Out::default();
        out.push("words");
        out.block();
        out.open(Role::Heading(1));
        out.push("   ");
        out.close();
        let read = out.finish();

        for span in &read.roles {
            assert!(read.text.get(span.start..span.end).is_some());
        }
    }
}
