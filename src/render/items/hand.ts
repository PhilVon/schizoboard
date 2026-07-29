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
 */

import { charJitter } from "@/lib/seed";

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
 * glyph in it leans a different way.
 */
export function writeHand(host: HTMLElement, text: string, seed: number): void {
  const key = `${seed}:${text}`;
  if (host.dataset["hand"] === key) return;
  host.dataset["hand"] = key;
  host.textContent = "";
  if (text.length === 0) return;

  const frag = document.createDocumentFragment();
  // The index into the *string*, which is what the jitter is addressable by —
  // so the third character of a note keeps its lean whether it arrived as the
  // third character or ended up there.
  let index = 0;
  let glyphs = 0;

  // Alternating runs of whitespace and not. `\s` rather than a literal space:
  // a newline is what makes the second line of a note a second line, and a tab
  // is a tab, and both have to survive as text for `pre-wrap` to honour them.
  const runs = text.split(/(\s+)/);
  for (const run of runs) {
    if (run.length === 0) continue;
    if (/^\s/.test(run)) {
      frag.append(run);
      index += run.length;
      continue;
    }
    if (glyphs >= MAX_GLYPHS) {
      frag.append(run);
      index += run.length;
      continue;
    }

    const parts = graphemes(run);
    let word = newWord();
    let inWord = 0;
    for (const glyph of parts) {
      if (inWord === MAX_WORD_GLYPHS) {
        frag.append(word);
        word = newWord();
        inWord = 0;
      }
      word.append(glyphs < MAX_GLYPHS ? leaning(glyph, seed, index) : glyph);
      index += glyph.length;
      inWord++;
      glyphs++;
    }
    frag.append(word);
  }

  host.append(frag);
}

function newWord(): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = WORD_CLASS;
  return el;
}

/**
 * One glyph in a box of its own, displaced and turned.
 *
 * `transform-origin` is in the stylesheet rather than here: it is the same for
 * every glyph on the board, and it is the bottom of the box rather than its
 * centre because a hand's letters lean from where they meet the line, not from
 * their middles.
 */
function leaning(glyph: string, seed: number, index: number): HTMLSpanElement {
  const j = charJitter(seed, index);
  const el = document.createElement("span");
  el.style.transform =
    `translate(${j.dx.toFixed(4)}em, ${j.dy.toFixed(4)}em)` +
    ` rotate(${j.rot.toFixed(5)}rad)` +
    ` scale(${j.scale.toFixed(4)})`;
  el.textContent = glyph;
  return el;
}
