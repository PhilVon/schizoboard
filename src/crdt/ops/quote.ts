/**
 * The quote card — T-281, D-46 section 3.
 *
 * > Select a passage — or drag a rectangle over it — and an index card comes out
 * > carrying the quote and its page reference, in the same hand the notes use.
 * > And it arrives **already threaded**: a pin at the source, a pin on the card,
 * > one string between them. There is no new machinery in that sentence.
 * > — D-46 section 3
 *
 * That sentence has one word wrong in it now, and the word is load-bearing.
 * **The source end is taped, not pinned** (Q-286): you cannot push a pin
 * through a sheet lying inside a folder, and what holds a thread to paper is
 * tape. It is a `kind` of pin rather than a new sort of string anchor, so
 * nothing above changes — but `Scene.pinCount` skips it, which is what stops
 * quoting a case file from ending its hang and throwing an open one 156 board
 * units across the wall (T-328).
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
 * document's page reference and a film's timestamp are both built by
 * `lib/objects.ts` — `pageReference` and `timeReference`, beside the labels
 * those same objects wear — and a transcript's is a line: three callers, one
 * card (D-46's symmetry constraint, I-52). What crosses this boundary is a
 * *string somebody could read aloud*, which is the one form all three share.
 *
 * ## The one fork, and why it is not a second machine
 *
 * A quote is words on index stock; a **clipping** is pixels on a polaroid
 * (Q-283, Q-284). That is one conditional in one `createItems` call, and every
 * other line below is shared — the same transaction, the same two pins, the
 * same string, the same undo entry, the same sentence written by the same
 * function. The object differs because what was quoted differs, and nothing
 * else about quoting does.
 */

import { mutate, type BoardDoc } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";
import { createItems, setItemStyle, type AssetInput, type Pose } from "@/crdt/ops/items";
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
  /**
   * Which page of the source the tape is stuck to, or null for a tape on the
   * object itself — T-330.
   *
   * The caller's for `lx`/`ly`'s reason and one more. Only the gesture knows
   * what face was on show when the rectangle was drawn, and by the time this
   * write lands the reader may have turned: a page reference is quoted out of
   * the page it was read on, not out of the page you happen to be on when the
   * card arrives.
   *
   * Left out by a quote from anything that is not an open case file — a tape on
   * a photograph is a tape on the photograph, and `buildPin` stores no key at
   * all for it.
   */
  readonly page?: number | null;
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
  /**
   * The pixels, when what was quoted was a picture rather than words — a
   * rectangle cut out of a scanned page (T-282), or a still off a tape (T-287).
   *
   * **Its presence is what decides the object, and that is the whole rule.**
   * With it the card is a *polaroid* carrying the clipping, with the reference
   * written in its caption; without it the card is a sheet on index stock
   * carrying the passage, with the reference written under it. Q-283 and Q-284
   * answered together: one gesture, and what comes out is what was actually
   * there. A photograph of a scan and a card of a quotation are different
   * things and should not look alike.
   *
   * The hash and its record travel together for `createItems`' reason — the
   * asset has to be registered in this transaction or a peer merging the card
   * learns a hash with nothing to draw and no way to ask for the bytes.
   */
  readonly clipping?: QuoteClipping;
  /** The one gap's slack. The string's own default when omitted. */
  readonly slack?: number;
}

/** A lifted rectangle, already ingested, with the record the document keeps. */
export interface QuoteClipping {
  readonly sha256: string;
  readonly asset: AssetInput;
}

/** Everything one gesture made, for a caller that wants to select or undo it. */
export interface QuoteCard {
  readonly itemId: string;
  /** The pin in the card, at its top centre — `createItems` puts it there. */
  readonly cardPin: string;
  /**
   * The **tape** on the source, where the selection was — a pin of kind
   * `tape`, so it anchors the thread without holding the page up (Q-286).
   */
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
 *
 * **A clipping passes an empty quote and gets the bare reference**, which is
 * the third branch below rather than a special case bolted on. The picture is
 * the passage on a clipping card, so the caption has nothing to say except
 * where it came from — and a caption reading `— scan.pdf p. 4` with nothing
 * above the dash is a quotation with the quote missing.
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
    const clipping = input.clipping;
    const [card] = createItems(board, [
      {
        // A clipping is a picture, so it arrives as the thing this board
        // already draws a picture on. Everything else is a quotation in words,
        // and is *not* a `card` item: Q-179 struck that type from the archetype
        // table because an index card is a *stock*, and any sheet's Paper strip
        // will give you one. A quote is a note written on the card you had.
        type: clipping === undefined ? "note" : "polaroid",
        x: input.x,
        y: input.y,
        w: input.w,
        h: input.h,
        // The reference alone on a clipping — the picture is the passage, so
        // `quoteCardText` is handed an empty quote and answers with the bare
        // citation. Called on both arms rather than branched around, because
        // what a quote card says is one decision (Q-282) and this is the one
        // place it is made.
        text: quoteCardText(input.quote, input.reference),
        ...(clipping === undefined
          ? {}
          : { assetId: clipping.sha256, asset: clipping.asset }),
      },
    ]);
    if (!card || card.pinId === null) return null;
    // Index stock only on the written card. A polaroid has no paper stock —
    // its face is a print in a white frame — and writing one would be a style
    // override that no renderer reads, which is the T-240 shape exactly.
    if (clipping === undefined) setItemStyle(board, [card.itemId], { paperStock: "index" });

    // Built here rather than handed to `createStringThrough` as a bare anchor,
    // because the caller is owed the id: the pin at the source is what a
    // citation tab hangs off (T-284) and what following the thread back lands
    // on (T-285), and neither can find it by looking.
    const source = buildPin(board, {
      parent: input.source.itemId,
      lx: input.source.lx,
      ly: input.source.ly,
      // **Taped, not pinned — Q-286.** You cannot push a pin through a sheet
      // lying inside a folder; the thing that holds a thread to paper is tape.
      // It is still a pin in every other respect, which is what keeps D-1's
      // "strings attach to pins, never to items" intact and keeps this op the
      // shape T-281 built. What the kind buys is that `Scene.pinCount` skips
      // it, so quoting a case file does not stop it hanging — and does not
      // move an open one, whose turn is measured about its sole pin (T-328).
      kind: "tape",
      // **And it is stuck to the page rather than to the folder** — T-330. A
      // thread taped to page four goes inside the folder when it shuts and runs
      // under the sheet on show when you turn past it, which is what tape on
      // paper does and what a pin through the cover could never do.
      page: input.source.page,
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
