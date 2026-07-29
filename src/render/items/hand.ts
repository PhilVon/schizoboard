/**
 * Handwriting: the thing that stops typed text looking typed.
 *
 * > Text renders in a handwritten face by default, with slight per-character
 * > baseline and rotation jitter so it doesn't look typeset. Jitter is seeded
 * > per character index so it's stable across re-renders — text that shimmers
 * > when you scroll past is worse than no jitter at all. — DESIGN section 3.6
 *
 * The face is a stylesheet's business. What is here is the jitter, and the
 * jitter is the half that costs something: a transform applies to a box, so
 * every character that leans has to *be* a box.
 *
 * ## Two nested spans, not one
 *
 * A `transform` does not apply to a non-replaced inline box, so each glyph has
 * to be `inline-block` — and adjacent `inline-block`s are a line-break
 * opportunity, so a note of plain prose would break mid-word at the right edge
 * of the paper. Hence the word wrapper: `white-space: pre` inside it means a
 * word is atomic again and wrapping happens between words, exactly as it did
 * when this was one text node.
 *
 * The wrapper is also what makes the whitespace work. Runs of spaces and
 * newlines are left as bare text nodes between the wrappers, so `pre-wrap` on
 * the container goes on treating them as it always did — a blank line in a note
 * is still a blank line, and the trailing space of a wrapped line still
 * collapses at the break.
 *
 * A word longer than `MAX_WORD_GLYPHS` is emitted as several wrappers, because
 * an atomic word wider than the paper has nowhere to go and `.paper-surface`
 * would clip it. That is the one case where this differs from the
 * `word-break: break-word` it replaces, and it differs only in *where* the
 * break falls.
 *
 * ## One root, always
 *
 * All of that goes inside a single wrapper element, and that is not tidiness.
 * A polaroid's caption strip is a flex container — it is how a one-line caption
 * sits centred in the 11% of the frame it has — and a flex container turns each
 * run of text between its children into an anonymous item, then **does not
 * render the ones that are only white space**. Writing the words as siblings
 * therefore deleted every space in the caption: "the pier, 1974" drew as
 * "thepier,1974", with the space text nodes still in the DOM and `textContent`
 * still reading correctly, so nothing but pixels could have caught it. One root
 * means one flex item, and the words are laid out inside it as text.
 *
 * ## Jitter in `em`
 *
 * `lib/seed.ts` hands back displacement in `em` rather than board units so that
 * one set of amounts serves both surfaces this writes on. A polaroid caption is
 * sized as a fraction of its frame and a note's body is 17px in board units;
 * absolute displacement would read as a whisper on one and a stagger on the
 * other.
 *
 * ## Nothing here is called per frame
 *
 * Rebuilding a few hundred spans is not free, and `bind()` runs for reasons
 * that have nothing to do with text — a photograph re-binds on every frame of
 * its develop (T-174), which would rebuild its caption sixty times a second for
 * a second and a half. So `writeHand` records what it wrote on the node and
 * returns early when asked for the same thing again. That guard is inside
 * rather than at the call sites because a view that forgets it is a view whose
 * captions stutter, and the failure is invisible until somebody profiles it.
 *
 * The counterpart is `clearHand`, which a released view owes: these nodes are
 * pooled, and a node emptied without clearing the record would recognise the
 * next item's identical text as already written and stay blank.
 *
 * ## One `innerHTML` write, and why it is worth the care it needs
 *
 * The first version built this element by element. Measured over a hand-speed
 * pan across a 300-note board of 170-character notes, against the same board
 * with the jitter compiled out - DOM phase p99, median of three runs:
 *
 * | zoom | mounted | glyph boxes | plain | one string | element by element |
 * |------|---------|-------------|-------|------------|--------------------|
 * | 100% |      54 |       7,926 | 5.6ms |     10.0ms |             12.7ms |
 * |  70% |      86 |      12,615 | 6.9ms |     11.8ms |             15.5ms |
 * |  50% |     160 |      23,474 | 9.6ms |     15.8ms |             20.7ms |
 *
 * So the boxes cost something real on the frames that mount a batch - about
 * two thirds again on top of a phase that is already the expensive one - and
 * parsing one string is about 40% cheaper than building the same tree node by
 * node. `cloneNode` plus `setAttribute` was measured too and lands between
 * them. The steady state is free either way: p50 is zero in every column,
 * because the guard above means panning past a note rebuilds nothing.
 *
 * What is *not* solved here is that all of this is spent on text that, below
 * about half zoom, nobody can read. Not gating on drawn size is deliberate -
 * `bind()` does not re-run on a zoom, so a gate would leave a note typeset
 * until something else dirtied it - and that plumbing is T-90's LOD tiers.
 *
 * That makes the escape below load-bearing rather than hygiene. Note text comes
 * from a peer's document and is the *only* untrusted thing in the string; every
 * attribute value here is a number this file computed. Escaping `&` and `<`
 * means no markup can be formed at all, which is the whole of what is required
 * for element content - there is no attribute context for a quote to escape
 * from. If a future field ever does go into an attribute, it does not go in
 * through here.
 */

import { charJitter } from "@/lib/seed";

/** The single wrapper everything else goes inside. */
const ROOT_CLASS = "hand";

/** The word wrapper. Glyphs are its unclassed children — see `items.css`. */
const WORD_CLASS = "hand-word";

/**
 * Where a word stops being a word and starts being something pasted.
 *
 * Longer than any English word anyone writes on a note, short enough that a
 * URL still finds somewhere to break.
 */
const MAX_WORD_GLYPHS = 24;

/**
 * The paper clips, so past a point this is building boxes nobody can see.
 *
 * A note is a fixed size and only scrolls while it is being written on (Q-93),
 * and the field covers the static text while that is happening — so everything
 * past the fold is out of view in every state this node is ever shown in. The
 * remainder is appended as one plain text node: still there, still selectable
 * by a find, simply not written by hand.
 */
const MAX_GLYPHS = 512;

/**
 * Graphemes, not code units.
 *
 * Splitting UTF-16 puts each half of an emoji's surrogate pair in its own
 * rotated box, which renders as two replacement glyphs leaning away from each
 * other. `Intl.Segmenter` additionally keeps a combining accent with the letter
 * it belongs to; where it is missing, code points are the honest fallback and
 * cover everything but combining marks.
 */
let segmenter: Intl.Segmenter | null = null;

function graphemes(word: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const out: string[] = [];
    for (const s of segmenter.segment(word)) out.push(s.segment);
    return out;
  }
  return Array.from(word);
}

/** Empty `host` and forget what was written on it. Owed by a released view. */
export function clearHand(host: HTMLElement): void {
  host.textContent = "";
  delete host.dataset["hand"];
}

/**
 * Write `text` on `host` by hand, replacing whatever was there.
 *
 * A no-op when the node already carries this text for this seed. The seed is in
 * that comparison because view nodes are pooled and recycled: the same node
 * showing the same string for a *different* item is a different hand, and every
 * glyph in it leans a different way. `plain` is in it too, so crossing a LOD
 * boundary rewrites rather than recognising the text it already has.
 *
 * ## `plain` — the same words, without the boxes (T-198, DESIGN section 6.6)
 *
 * Below 35% zoom the writing goes down as a single text node: same string, same
 * face, no lean. Which is not what DESIGN 6.6 originally asked for — it asked
 * for a pre-rasterised snapshot, on the grounds that "live text layout is by far
 * the largest cost when many items are visible" — and Q-115 amended the section
 * after that reason was measured and did not survive (D-33).
 *
 * With 500 notes of real prose at 5% zoom: as it is, the median frame is
 * 194.5 ms and the stage fits seven frames into a second and a half. As one text
 * node, 7.0 ms and 112 frames. And writing **no text at all** measures the same
 * as writing it plainly, everywhere, within run-to-run noise — so none of what
 * was being paid for was the layout. It was the transform boxes, which exist for
 * the jitter and not for the words: 73,014 nodes for 500 items, against 7,101
 * without them.
 *
 * So a raster would have bought nothing over this, at the price of a canvas per
 * texted item, a re-raster on every keystroke and every tier crossing, and a
 * reimplementation of the word wrapping four lines below this comment get for
 * free.
 *
 * The cost is honest and is a *look*: crossing 35% straightens every note on the
 * board. At that zoom a line of handwriting is around four device pixels tall,
 * where the lean was already carrying nothing a person could see.
 */
export function writeHand(host: HTMLElement, text: string, seed: number, plain = false): void {
  const key = `${seed}:${plain ? "p" : "h"}:${text}`;
  if (host.dataset["hand"] === key) return;
  host.dataset["hand"] = key;
  if (text.length === 0) {
    host.textContent = "";
    return;
  }
  if (plain) {
    // `textContent`, so nothing here has to escape anything — and the wrapping,
    // the `pre-wrap` whitespace handling and the ruling alignment all go on
    // being the browser's problem, exactly as they were before the jitter
    // existed.
    host.textContent = text;
    return;
  }

  let html = ROOT_OPEN;
  // The index into the *string*, which is what the jitter is addressable by -
  // so the third character of a note keeps its lean whether it arrived as the
  // third character or ended up there.
  let index = 0;
  let glyphs = 0;

  // Alternating runs of whitespace and not. `\s` rather than a literal space:
  // a newline is what makes the second line of a note a second line, and a tab
  // is a tab, and both have to survive as text for `pre-wrap` to honour them.
  for (const run of text.split(/(\s+)/)) {
    if (run.length === 0) continue;
    if (/^\s/.test(run) || glyphs >= MAX_GLYPHS) {
      html += escape(run);
      index += run.length;
      continue;
    }

    html += OPEN_WORD;
    let inWord = 0;
    for (const glyph of graphemes(run)) {
      if (inWord === MAX_WORD_GLYPHS) {
        html += CLOSE_SPAN + OPEN_WORD;
        inWord = 0;
      }
      html += glyphs < MAX_GLYPHS ? leaning(glyph, seed, index) : escape(glyph);
      index += glyph.length;
      inWord++;
      glyphs++;
    }
    html += CLOSE_SPAN;
  }

  host.innerHTML = html + CLOSE_SPAN;
}

/** See "One root, always" above: this is what keeps a flex host honest. */
const ROOT_OPEN = `<span class="${ROOT_CLASS}">`;
const OPEN_WORD = `<span class="${WORD_CLASS}">`;
const CLOSE_SPAN = "</span>";

/**
 * The only untrusted thing in the string this file builds.
 *
 * `&` and `<` are the two characters that can begin markup, so escaping them is
 * the whole of what element content needs; `>` goes with them so the output is
 * well-formed for anyone who ever reads it.
 */
function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * One glyph in a box of its own, displaced and turned.
 *
 * `transform-origin` is in the stylesheet rather than here: it is the same for
 * every glyph on the board, and it is the bottom of the box rather than its
 * centre because a hand's letters lean from where they meet the line, not from
 * their middles.
 */
function leaning(glyph: string, seed: number, index: number): string {
  const j = charJitter(seed, index);
  const transform =
    `translate(${j.dx.toFixed(4)}em,${j.dy.toFixed(4)}em)` +
    ` rotate(${j.rot.toFixed(5)}rad)` +
    ` scale(${j.scale.toFixed(4)})`;
  return `<span style="transform:${transform}">${escape(glyph)}</span>`;
}
