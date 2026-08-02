/**
 * The one rule a needle and a haystack are both put through.
 *
 * It lives here rather than beside either of its two callers because there are
 * two of them, and a search where the two disagree is worse than either rule
 * on its own. `TextIndex` (`app/textindex.ts`) normalises a document's pages
 * when they land; `Search` (`state/search.ts`) normalises an item's mirrored
 * text and the query on every keystroke. Before this was one function they
 * differed by exactly one clause — the index collapsed runs of whitespace and
 * the walk did not — so a two-word phrase typed with two spaces between them
 * found a case file and missed the note pinned beside it, which is a difference
 * nobody could have explained and nothing on screen would have hinted at.
 *
 * Collapsing rather than merely lowercasing is what the document side needs and
 * the board side does not mind. A PDF splits a line at every font and kerning
 * change and the shell joins those runs by a **gap rule** rather than by the
 * reading surface's line-breaking one (`document::joined`), so the two sides
 * agree about the characters and disagree about which whitespace sits between
 * them. On a note it costs a pass over a sentence and changes nothing you could
 * see: a needle typed with one space still finds a body typed with one space.
 */

/** Lowercased, every run of whitespace collapsed to one space, ends trimmed. */
export function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
