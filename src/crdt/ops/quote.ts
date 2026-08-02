/**
 * The quote card — T-281, D-46 section 3.
 *
 * > Select a passage — or drag a rectangle over it — and an index card comes out
 * > carrying the quote and its page reference, in the same hand the notes use.
 * > And it arrives **already threaded**: a pin at the source, a pin on the card,
 * > one string between them. There is no new machinery in that sentence.
 * > — D-46 section 3
 *
 * That last line is what this file is: **no new machinery**. There is no quote
 * relation, no citation record and nothing to migrate. A card is a `note` on
 * index stock, its reference is in its own text, and what says where it came
 * from is a string — which is D-1's claim (pins are the primitive) doing the
 * most useful thing it has done since the strings were built.
 *
 * ## Why it is one function rather than three calls at the gesture
 *
 * **One transaction, therefore one undo entry and one update on the wire.** A
 * card, two pins and a string are one thing the person did, and three ops in a
 * row would be four entries on the undo stack: pressing Ctrl+Z once would leave
 * a card hanging on a string to nowhere, and pressing it four times would be
 * asking somebody to know how many writes their gesture happened to make. It is
 * the same argument `createItems` makes for pasting twenty photographs at once
 * and `createStringThrough` makes for a four-click run.
 *
 * The composition is by nesting rather than by re-implementing: `mutate` is
 * `doc.transact`, and a Yjs transaction opened inside another one *is* the
 * outer one. So the ops called here keep their own guarantees — invariant 1's
 * skip in `createItems`, `buildPin`'s coercion, `buildString`'s refusal under
 * two pins — and the whole of it still lands as a single origin-tagged update.
 *
 * ## What this file deliberately does not know
 *
 * Which page the quote is on, what a timestamp is, and how either reads. A
 * document's page reference is `app/pages.ts`'s and T-298's business, a film's
 * is a timestamp, and a transcript's is a line — three callers, one card
 * (D-46's symmetry constraint, I-52). What crosses this boundary is a *string
 * somebody could read aloud*, which is the one form all three share.
 */

import { mutate, type BoardDoc } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";
import { createItems, setItemStyle, type Pose } from "@/crdt/ops/items";
import { buildPin } from "@/crdt/ops/pins";
import { createStringThrough } from "@/crdt/ops/strings";

/** The thing being quoted, and where on it the pin goes in. */
export interface QuoteSource {
  /** The item quoted — a case file, a tape, a cassette, or any sheet. */
  readonly itemId: string;
  /**
   * Item-local and un-rotated, the frame every pin op takes — see
   * `placePin`. The caller is a gesture and the gesture is the only thing that
   * knows the item's *rendered* pose, so converting from board coordinates here
   * would put the pin where the paper would have been if it were not hanging.
   */
  readonly lx: number;
  readonly ly: number;
}

export interface QuoteCardInput {
  /**
   * What the person selected, and nothing else — no summary, no suggested
   * title, no entities, no related passages (D-46 section 3, I-48).
   */
  readonly quote: string;
  /**
   * Where it came from, already in words: `scan.pdf p. 4`, `interview.mp4
   * 12:04`. A string rather than a page number, because the three kinds
   * reference themselves in three different units and the card only ever says
   * one of them out loud.
   */
  readonly reference: string;
  /** Where the card lands and how big it is, board units. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly source: QuoteSource;
  /** The one gap's slack. The string's own default when omitted. */
  readonly slack?: number;
}

/** Everything one gesture made, for a caller that wants to select or undo it. */
export interface QuoteCard {
  readonly itemId: string;
  /** The pin in the card, at its top centre — `createItems` puts it there. */
  readonly cardPin: string;
  /** The pin in the source, where the selection was. */
  readonly sourcePin: string;
  readonly stringId: string;
}

/**
 * What the card says, in one place.
 *
 * **Q-282 — answered: the citation goes under the quote**, not above it as a
 * header. The passage is what somebody is reading and the source is what they
 * check afterwards, which is the order a cutting is filed in. An em-dash rather
 * than "from", because the card is a quotation and that is how a quotation
 * names its source.
 *
 * Its own function rather than inlined, because it is the one part of a quote
 * that is a *taste* decision and the three gestures above it must not each
 * grow their own version of it.
 */
export function quoteCardText(quote: string, reference: string): string {
  const said = quote.trim();
  const from = reference.trim();
  if (from === "") return said;
  if (said === "") return from;
  return `${said}\n\n— ${from}`;
}

/**
 * One gesture's worth of quoting: a card, a pin at the source, a pin on the
 * card and the string between them — AC-661.
 *
 * `null` when there was nothing to quote *from*: an item that has been deleted,
 * or that a peer took away between the gesture starting and this write. The
 * source is read inside the transaction for that reason rather than trusted
 * from the caller, which measured it when the pointer went down.
 *
 * `settle` is `createStringThrough`'s argument, unchanged: pinning into a sheet
 * that was hanging on one pin stops it hanging, and the pose it was drawn at
 * belongs in this transaction so that the paper does not jump on the frame the
 * quote arrives.
 */
export function createQuoteCard(
  board: BoardDoc,
  input: QuoteCardInput,
  settle?: ReadonlyMap<string, Pose>,
): QuoteCard | null {
  return mutate(board, Origin.LOCAL_USER, () => {
    if (!board.items.has(input.source.itemId)) return null;

    // The card first, so that a refusal costs nothing. `createItems` skips an
    // item whose numbers are not finite (invariant 1), and everything below
    // this line refers to the card — so a skipped card must not leave a pin in
    // somebody's document with nothing on the other end of it.
    const [card] = createItems(board, [
      {
        // Not a `card` item: Q-179 struck that type from the archetype table
        // because an index card is a *stock*, and any sheet's Paper strip will
        // give you one. A quote is a note written on the card you had.
        type: "note",
        x: input.x,
        y: input.y,
        w: input.w,
        h: input.h,
        text: quoteCardText(input.quote, input.reference),
      },
    ]);
    if (!card || card.pinId === null) return null;
    setItemStyle(board, [card.itemId], { paperStock: "index" });

    // Built here rather than handed to `createStringThrough` as a bare anchor,
    // because the caller is owed the id: the pin at the source is what a
    // citation tab hangs off (T-284) and what following the thread back lands
    // on (T-285), and neither can find it by looking.
    const source = buildPin(board, {
      parent: input.source.itemId,
      lx: input.source.lx,
      ly: input.source.ly,
    });
    board.pins.set(source.id, source.map);

    const stringId = createStringThrough(
      board,
      [{ pin: source.id }, { pin: card.pinId }],
      input.slack === undefined ? {} : { slack: input.slack },
      settle,
    );
    if (stringId === null) return null;

    return {
      itemId: card.itemId,
      cardPin: card.pinId,
      sourcePin: source.id,
      stringId,
    };
  });
}
