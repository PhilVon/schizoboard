/**
 * The quote card — T-281, and the four things AC-661 to AC-664 ask of it.
 *
 * Every test here is really one property said four ways: **a quote is one
 * thing**. The card, the pin at the source, the pin on the card and the string
 * between them arrive in a single transaction, land as a single update on the
 * wire, and go back on a single `Ctrl+Z`. Split any of that and the failure is
 * silent and horrible: one undo leaves a card hanging on a string to nowhere,
 * or a pin in somebody's evidence with nothing on the other end of it.
 *
 * The rest is the argument that this needed no new machinery. What comes out is
 * a `note` on index stock with its reference in its own text — nothing a build
 * that has never heard of quoting would fail to read, and nothing to migrate.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { checkInvariants } from "@/crdt/invariants";
import { createItems, itemText } from "@/crdt/ops/items";
import { createQuoteCard, quoteCardText } from "@/crdt/ops/quote";
import { deleteStrings } from "@/crdt/ops/strings";
import { readAsset, readItem, readPin, readString } from "@/crdt/schema";
import { UndoHistory } from "@/crdt/undo";

let board: BoardDoc;

/** The thing being quoted: a case file, as far as this file is concerned. */
function source(): string {
  return createItems(board, [{ type: "note", x: 0, y: 0, w: 400, h: 560, rot: 0 }])[0]!.itemId;
}

function quote(itemId: string): ReturnType<typeof createQuoteCard> {
  return createQuoteCard(board, {
    quote: "the third invoice has no counter-signature",
    reference: "scan.pdf p. 4",
    x: 900,
    y: -200,
    w: 320,
    h: 200,
    source: { itemId, lx: -40, ly: 120 },
  });
}

/** What an item's text says. A `Y.Text` rather than a schema field, because
 *  two people can type into one note — see `itemText`. */
function textOf(itemId: string): string {
  return itemText(board, itemId)?.toString() ?? "";
}

beforeEach(() => {
  board = openBoardDoc();
  initialiseBoard(board);
});

describe("a quote card", () => {
  it("comes out threaded: a card, two pins and one string", () => {
    const itemId = source();
    const made = quote(itemId)!;

    expect(made).not.toBeNull();
    expect(readItem(made.itemId, board.items.get(made.itemId)!)?.type).toBe("note");

    // The pin at the source is *in* the source, in its own frame — which is
    // what makes it move when the folder does.
    const at = readPin(made.sourcePin, board.pins.get(made.sourcePin)!)!;
    expect(at.parent).toBe(itemId);
    expect([at.lx, at.ly]).toEqual([-40, 120]);

    // The pin on the card is the one `createItems` gave it. A quote does not
    // get a second pin: a card on two pins is rigid, and this one hangs.
    expect(readPin(made.cardPin, board.pins.get(made.cardPin)!)?.parent).toBe(made.itemId);

    const run = readString(made.stringId, board.strings.get(made.stringId)!)!;
    expect(run.nodes.map((n) => n.pin)).toEqual([made.sourcePin, made.cardPin]);

    expect(checkInvariants(board)).toEqual([]);
  });

  /**
   * AC-661. One update on the wire and one entry on the stack — the property
   * every other one here is downstream of.
   */
  it("is one update and one undo entry", () => {
    const itemId = source();
    const history = new UndoHistory(board);

    let updates = 0;
    board.doc.on("update", () => updates++);
    const made = quote(itemId)!;
    expect(updates).toBe(1);

    history.undo();
    expect(board.items.has(made.itemId)).toBe(false);
    expect(board.pins.has(made.sourcePin)).toBe(false);
    expect(board.pins.has(made.cardPin)).toBe(false);
    expect(board.strings.has(made.stringId)).toBe(false);
    // And the thing that was quoted is untouched by the undo, which is the half
    // of "one entry" that a too-greedy transaction would break.
    expect(board.items.has(itemId)).toBe(true);
    history.destroy();
  });

  /**
   * AC-662. Nothing here is a new kind of thing: a build that has never heard
   * of quoting reads a note on index stock with some text on it, which is
   * exactly what it is.
   */
  it("is a plain note on index stock, carrying its reference in its own text", () => {
    const itemId = source();
    const made = quote(itemId)!;

    const item = readItem(made.itemId, board.items.get(made.itemId)!)!;
    expect(item.type).toBe("note");
    expect(item.style.paperStock).toBe("index");
    expect(textOf(made.itemId)).toContain("the third invoice has no counter-signature");
    expect(textOf(made.itemId)).toContain("scan.pdf p. 4");
    expect(item.assetId).toBeNull();
  });

  /**
   * AC-663. Cutting the string is how somebody says *it was not from there*,
   * and it must cost them neither the card nor the evidence.
   */
  it("survives having its string cut, at both ends", () => {
    const itemId = source();
    const made = quote(itemId)!;

    deleteStrings(board, [made.stringId]);

    expect(board.strings.has(made.stringId)).toBe(false);
    expect(board.items.has(made.itemId)).toBe(true);
    expect(board.items.has(itemId)).toBe(true);
    expect(textOf(made.itemId)).toContain("scan.pdf p. 4");
    expect(checkInvariants(board)).toEqual([]);
  });

  /**
   * AC-664. The three kinds reference themselves in three different units — a
   * page, a timestamp, a line — and the card only ever says one of them out
   * loud, so all three are the same call with a different sentence in it.
   */
  it("is the same call for a page, a frame and a transcript line", () => {
    const refs = ["scan.pdf p. 4", "interview.mp4 12:04", "interview.srt line 88"];
    const cards = refs.map((reference, i) => {
      const itemId = source();
      return createQuoteCard(board, {
        quote: "said the same thing twice",
        reference,
        x: 900,
        y: i * 300,
        w: 320,
        h: 200,
        source: { itemId, lx: 0, ly: 0 },
      })!;
    });

    expect(cards.every((c) => c !== null)).toBe(true);
    cards.forEach((card, i) => expect(textOf(card.itemId)).toContain(refs[i]!));
    expect(checkInvariants(board)).toEqual([]);
  });

  /**
   * The gesture measured the source when the pointer went down; the write
   * happens later, and a collaborator can take the folder away in between. A
   * pin whose parent does not exist is the dangling reference the janitor was
   * built to collect, so it is refused before it is written rather than
   * cleaned up after.
   */
  it("refuses to quote an item that has gone, and writes nothing", () => {
    let updates = 0;
    board.doc.on("update", () => updates++);

    expect(quote("no-such-item")).toBeNull();

    expect(updates).toBe(0);
    expect(board.pins.size).toBe(0);
    expect(board.strings.size).toBe(0);
  });

  /**
   * Invariant 1's skip in `createItems`, seen from here: the card is refused,
   * and because it is built first there is no pin left in the source with
   * nothing on the other end of it.
   */
  it("leaves no pin behind when the card itself is refused", () => {
    const itemId = source();

    const made = createQuoteCard(board, {
      quote: "unplaceable",
      reference: "scan.pdf p. 1",
      x: Number.NaN,
      y: 0,
      w: 320,
      h: 200,
      source: { itemId, lx: 0, ly: 0 },
    });

    expect(made).toBeNull();
    // The item's own pin from `source()` is the only one on the board.
    expect(board.pins.size).toBe(1);
    expect(board.strings.size).toBe(0);
    expect(checkInvariants(board)).toEqual([]);
  });
});

describe("what the card says", () => {
  it("puts the passage first and the citation under it", () => {
    expect(quoteCardText("a passage", "scan.pdf p. 4")).toBe("a passage\n\n— scan.pdf p. 4");
  });

  /** A rectangle dragged over a chart selects no words at all (T-282). */
  it("is just the reference when there is nothing to quote", () => {
    expect(quoteCardText("   ", "scan.pdf p. 4")).toBe("scan.pdf p. 4");
  });

  it("is just the passage when there is nothing to cite", () => {
    expect(quoteCardText("a passage", "")).toBe("a passage");
  });
});

describe("the source end is taped, not pinned", () => {
  it("tapes the thread to the page it came out of", () => {
    // Q-286. You cannot push a pin through a sheet lying inside a folder, and
    // what holds a thread to paper is tape.
    const itemId = source();
    const made = quote(itemId)!;
    expect(readPin(made.sourcePin, board.pins.get(made.sourcePin)!)!.kind).toBe("tape");
  });

  it("leaves the card's own pin a pin", () => {
    // The card is a piece of paper on a corkboard and hangs from a pin like
    // everything else. Only the end stuck to the page is tape.
    const made = quote(source())!;
    expect(readPin(made.cardPin, board.pins.get(made.cardPin)!)!.kind).toBe("pushpin");
  });

  it("is still a pin in every other respect", () => {
    // Which is what keeps D-1 — strings attach to pins, never to items — and
    // what T-284's citation tabs and T-285's thread-back hang off.
    const itemId = source();
    const made = quote(itemId)!;
    const pin = readPin(made.sourcePin, board.pins.get(made.sourcePin)!)!;
    expect(pin.parent).toBe(itemId);
    const run = readString(made.stringId, board.strings.get(made.stringId)!)!;
    expect(run.nodes.map((n) => n.pin)).toContain(made.sourcePin);
  });
});

describe("a clipping, which is a picture rather than words", () => {
  const SHA = "b17c".padEnd(64, "0");

  function clip(itemId: string): ReturnType<typeof createQuoteCard> {
    return createQuoteCard(board, {
      quote: "",
      reference: "scan.pdf p. 4",
      x: 900,
      y: -200,
      w: 320,
      h: 200,
      source: { itemId, lx: -40, ly: 120 },
      clipping: {
        sha256: SHA,
        asset: { w: 640, h: 400, mime: "image/webp", size: 21_804, origName: "scan.pdf" },
      },
    });
  }

  it("comes out as a polaroid and not as a sheet of paper", () => {
    // Q-283. The object matches its content: a photograph of a scan and a card
    // of a quotation are different things and should not look alike.
    const made = clip(source())!;
    expect(readItem(made.itemId, board.items.get(made.itemId)!)!.type).toBe("polaroid");
  });

  it("carries the pixels, with a record a peer could ask for them by", () => {
    // Registered in this transaction or a peer merging the card learns a hash
    // with nothing to draw and no way to request the bytes.
    const made = clip(source())!;
    expect(readItem(made.itemId, board.items.get(made.itemId)!)!.assetId).toBe(SHA);
    expect(board.assets.has(SHA)).toBe(true);
    expect(readAsset(SHA, board.assets.get(SHA)!)!.mime).toBe("image/webp");
  });

  it("says only where it came from, because the picture is the passage", () => {
    // Not "— scan.pdf p. 4": a quotation with the quote missing.
    expect(textOf(clip(source())!.itemId)).toBe("scan.pdf p. 4");
  });

  it("takes no paper stock, having no paper", () => {
    // A style override no renderer reads is the T-240 shape exactly.
    const made = clip(source())!;
    expect(readItem(made.itemId, board.items.get(made.itemId)!)!.style.paperStock).toBeUndefined();
  });

  it("is threaded exactly as a written card is", () => {
    // The fork is one conditional in one createItems call. Everything that
    // makes a quote card a quote card is shared.
    const itemId = source();
    const made = clip(itemId)!;
    expect(readPin(made.sourcePin, board.pins.get(made.sourcePin)!)!.parent).toBe(itemId);
    expect(readPin(made.cardPin, board.pins.get(made.cardPin)!)!.parent).toBe(made.itemId);
    const run = readString(made.stringId, board.strings.get(made.stringId)!)!;
    expect(run.nodes.map((n) => n.pin)).toEqual([made.sourcePin, made.cardPin]);
  });

  it("is one undo entry, like every other quote", () => {
    const itemId = source();
    const history = new UndoHistory(board);
    const made = clip(itemId)!;
    history.undo();
    expect(board.items.has(made.itemId)).toBe(false);
    expect(board.pins.has(made.sourcePin)).toBe(false);
    expect(board.strings.has(made.stringId)).toBe(false);
    // The thing quoted is not what was undone.
    expect(board.items.has(itemId)).toBe(true);
    history.destroy();
  });

  it("leaves the document sound", () => {
    clip(source());
    expect(checkInvariants(board)).toEqual([]);
  });

  it("stores nothing at all when the source has gone", () => {
    // The asset is written inside the transaction, so a refusal must not leave
    // bytes registered against a card that was never made.
    const itemId = source();
    board.items.delete(itemId);
    expect(clip(itemId)).toBeNull();
    expect(board.assets.has(SHA)).toBe(false);
  });
});
