/**
 * The page a pin is stuck to — T-330, and the document half of it.
 *
 * A quote card's thread is *taped* to the page it came out of (Q-286), and
 * until this field existed the tape was stuck to the folder: it stayed on the
 * cork when the folder shut, and it sat on top of page twelve while it was
 * holding page four. The field is `StrokeFields.page`'s exact counterpart and
 * these tests are `ink.test.ts`'s, asked of a pin.
 *
 * **The back-compat claim is the one worth testing hardest**, because it is the
 * one nobody would notice breaking. A board of ordinary pins has to produce
 * byte-identical records to the build before this one — a key that is present
 * and null is a key an older build can misread, and it makes every pin anybody
 * has ever pushed in count as edited the first time a peer on this version
 * touches it. So the assertion is `has("page") === false` and not
 * `get("page") === null`, which would pass with the field written
 * unconditionally.
 *
 * Every test below was proved by sabotaging the thing it is about — the write's
 * two guards, the reader's two, and the clipboard's carry — and watching it
 * fail. Nothing here passed with its mechanism broken.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { copySubgraph, pasteClip } from "@/crdt/ops/clip";
import { createItems } from "@/crdt/ops/items";
import { createPin } from "@/crdt/ops/pins";
import { createQuoteCard } from "@/crdt/ops/quote";
import { readPin } from "@/crdt/schema";

let board: BoardDoc;

beforeEach(() => {
  board = openBoardDoc();
});

/** A case file to tape things to, and its own pin. */
function folder(): string {
  const [made] = createItems(board, [
    { type: "polaroid", x: 0, y: 0, w: 400, h: 300, rot: 0 },
  ]);
  return made!.itemId;
}

describe("what the write stores", () => {
  it("puts the page on a pin stuck to one", () => {
    const item = folder();
    const id = createPin(board, { parent: item, lx: 10, ly: 20, kind: "tape", page: 4 });
    expect(readPin(id, board.pins.get(id)!)?.page).toBe(4);
  });

  /**
   * The byte-identity claim. `has` and not `get`: writing `null` would satisfy
   * every "the page is null" assertion in this file and would still be the
   * change that makes a whole board look edited.
   */
  it("stores no key at all on a pin that is not on a page", () => {
    const item = folder();
    const id = createPin(board, { parent: item, lx: 10, ly: 20 });
    expect(board.pins.get(id)!.has("page")).toBe(false);
    expect(readPin(id, board.pins.get(id)!)?.page).toBeNull();
  });

  /**
   * The second of the write's two guards, and the counterpart of `ops/ink.ts`
   * refusing a page to a run on bare cork. The cork belongs to no item and has
   * no document to have a page of, so a number here could only be a caller's
   * mistake — and one stored on a free pin would be read by a layer that then
   * asked an item-keyed resolver about `null`.
   */
  it("refuses a page to a pin free in the cork", () => {
    const id = createPin(board, { parent: null, lx: 10, ly: 20, kind: "tape", page: 4 });
    expect(board.pins.get(id)!.has("page")).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %p, which is not a page",
    (page) => {
      const item = folder();
      const id = createPin(board, { parent: item, lx: 0, ly: 0, kind: "tape", page });
      expect(board.pins.get(id)!.has("page")).toBe(false);
    },
  );
});

describe("what the reader trusts", () => {
  /**
   * A peer's number, and the asymmetry with `size` and `opacity` two fields
   * along. A nonsense width is clamped because a mark should still be erasable
   * rather than invisible; a nonsense page has no range to be clamped into, and
   * picking one would tape somebody's thread to a page they never opened.
   */
  it.each([0, -3, 2.5, "4", null])("reads %p back as no page", (value) => {
    const item = folder();
    const id = createPin(board, { parent: item, lx: 0, ly: 0, kind: "tape" });
    board.pins.get(id)!.set("page", value);
    expect(readPin(id, board.pins.get(id)!)?.page).toBeNull();
  });

  /**
   * A page that reached a *free* pin — from a build without the write's second
   * guard, or from a peer that reparented it into the cork without clearing the
   * field. Dropped at the reader as well as at the writer, because the writer is
   * ours and this is not.
   */
  it("drops a page that arrived on a free pin", () => {
    const item = folder();
    const id = createPin(board, { parent: item, lx: 0, ly: 0, kind: "tape", page: 4 });
    board.pins.get(id)!.set("parent", null);
    expect(readPin(id, board.pins.get(id)!)?.page).toBeNull();
  });
});

describe("the tape a quote card hangs from", () => {
  function quote(page?: number): string {
    const source = folder();
    const card = createQuoteCard(board, {
      quote: "the passage",
      reference: "scan.pdf p. 4",
      x: 500,
      y: 0,
      w: 200,
      h: 120,
      source: { itemId: source, lx: 10, ly: 20, page },
    });
    return card!.sourcePin;
  }

  it("is stuck to the page the rectangle was drawn on", () => {
    const pin = quote(4);
    expect(readPin(pin, board.pins.get(pin)!)?.page).toBe(4);
  });

  /**
   * A quote off something with one face — a photograph, a note. There is no
   * page to be on, so the tape is on the object, and the record is the one the
   * build before this wrote.
   */
  it("stores no page when what was quoted has only one face", () => {
    const pin = quote();
    expect(board.pins.get(pin)!.has("page")).toBe(false);
  });
});

describe("copying a case file with a thread taped to it", () => {
  /**
   * A copied filing that loses which page its threads were taped to comes back
   * with every one of them on page one — which is a worse answer than none,
   * because it is one somebody could believe.
   */
  it("carries the page across a copy and a paste", () => {
    const source = folder();
    const card = createQuoteCard(board, {
      quote: "the passage",
      reference: "scan.pdf p. 7",
      x: 500,
      y: 0,
      w: 200,
      h: 120,
      source: { itemId: source, lx: 10, ly: 20, page: 7 },
    })!;

    const clip = copySubgraph(board, { items: [source, card.itemId], pins: [] })!;
    expect(clip.pins.some((pin) => pin.page === 7)).toBe(true);

    const before = new Set(board.pins.keys());
    pasteClip(board, clip, { x: 2000, y: 2000 });
    const pasted = [...board.pins.keys()].filter((id) => !before.has(id));
    const pages = pasted.map((id) => readPin(id, board.pins.get(id)!)?.page);
    expect(pages).toContain(7);
    // And the card's own pin, which is in a polaroid and on no page, is still
    // keyless — a paste of ordinary pins has to write what the pin tool writes.
    expect(pasted.filter((id) => board.pins.get(id)!.has("page"))).toHaveLength(1);
  });
});
