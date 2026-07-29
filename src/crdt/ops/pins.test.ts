/**
 * The pose that arrives with a pin.
 *
 * `ops.test.ts` covers what a pin *is* — the two-field write, the frames it is
 * expressed in, the parent that vanished. This file covers the argument the pin
 * ops grew afterwards, which is about something else entirely: the paper the
 * pin lands in.
 *
 * An item hanging on a single pin is drawn at `rot + swing` about a shifted
 * centre (DESIGN section 5.5), and neither of those numbers is in the document.
 * Change the pin count and they stop existing, so the paper snaps to a pose
 * nobody chose and nobody could have seen — which is the whole of T-107, and
 * unmistakably a bug on screen.
 *
 * `deletePins` took a `settle` first, for an item losing the pin it hung from.
 * These are the mirror image: an item that had one pin and now has two has
 * stopped hanging just as surely, and `placePin` manages both at once. Every
 * test here asserts the same three things, because they are the three that
 * matter — the pose lands, it lands in **one** update, and one `Ctrl+Z` takes
 * the pin and the pose back together. Two entries would mean a single undo
 * leaves the paper at a pose the document was never asked to hold, which is the
 * same bug wearing a different hat.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { createItems } from "@/crdt/ops/items";
import { setItemPoses } from "@/crdt/ops/items";
import { createPin, placePin, rehomePins } from "@/crdt/ops/pins";
import { readItem, readPin, type ItemType } from "@/crdt/schema";
import { UndoHistory } from "@/crdt/undo";

let board: BoardDoc;

/** An item hanging on the one pin `createItems` gives it, authored straight
 *  rather than scattered, so a settled rotation is visibly not the authored
 *  one and undo putting it back cannot pass by accident. */
function hanging(type: ItemType, x: number): { itemId: string; pinId: string } {
  const [made] = createItems(board, [{ type, x, y: 0, w: 200, h: 200, rot: 0 }]);
  return { itemId: made!.itemId, pinId: made!.pinId! };
}

/** An item's pose, read back through the schema reader. */
function pose(itemId: string): [number, number, number] {
  const item = readItem(itemId, board.items.get(itemId)!)!;
  return [item.x, item.y, item.rot];
}

beforeEach(() => {
  board = openBoardDoc();
});

describe("pushing a new pin in", () => {
  /**
   * The mirror of what `deletePins` does with its `settle`, and the reason
   * `createPin` has one at all: the pin that makes two is the pin that stops an
   * item hanging. The pose it was drawn at while it hung is not in the
   * document, so it arrives alongside the pin and lands in the same entry — or
   * `Ctrl+Z` takes the pin out and leaves the paper where nobody put it.
   */
  it("settles the item it just pinned, in the same entry", () => {
    const { itemId } = hanging("note", 0);
    const history = new UndoHistory(board);

    let updates = 0;
    board.doc.on("update", () => updates++);
    const made = createPin(
      board,
      { parent: itemId, lx: 40, ly: 30 },
      new Map([[itemId, { x: 30, y: 40, rot: 0.5 }]]),
    );
    expect(updates).toBe(1);
    expect(board.pins.get(made)!.get("parent")).toBe(itemId);
    expect(pose(itemId)).toEqual([30, 40, 0.5]);

    history.undo();
    expect(board.pins.has(made)).toBe(false);
    expect(pose(itemId)).toEqual([0, 0, 0]);
    history.destroy();
  });
});

describe("putting a pin down", () => {
  /**
   * The op that can name **two** items, because a re-parent changes the pin
   * count at both ends. The note's only pin leaves, so it stops hanging and
   * lies loose on the cork; the card gains a second, so it stops hanging and
   * goes rigid. Both were drawn at poses the document does not hold, and both
   * land inside the one transaction the two-field write already had.
   */
  it("settles both ends of a re-parent, in the same entry", () => {
    const note = hanging("note", 0);
    const card = hanging("card", 400);
    const history = new UndoHistory(board);

    let updates = 0;
    board.doc.on("update", () => updates++);
    placePin(board, note.pinId, card.itemId, 20, -30, new Map([
      [note.itemId, { x: 12, y: -8, rot: 0.25 }],
      [card.itemId, { x: 410, y: 6, rot: -0.4 }],
    ]));
    expect(updates).toBe(1);

    const moved = readPin(note.pinId, board.pins.get(note.pinId)!)!;
    expect([moved.parent, moved.lx, moved.ly]).toEqual([card.itemId, 20, -30]);
    expect(pose(note.itemId)).toEqual([12, -8, 0.25]);
    expect(pose(card.itemId)).toEqual([410, 6, -0.4]);

    history.undo();
    expect(readPin(note.pinId, board.pins.get(note.pinId)!)!.parent).toBe(note.itemId);
    expect(pose(note.itemId)).toEqual([0, 0, 0]);
    expect(pose(card.itemId)).toEqual([400, 0, 0]);
    history.destroy();
  });
});

/**
 * T-193. `rehomePins` is the only pin write on the board that nobody asked for:
 * it fires off the back of somebody moving a *different* object, because the
 * frame a pin's numbers live in stopped being a choice and became a fact about
 * where the pin is (D-31).
 *
 * So the things worth asserting are not about geometry — `Scene.rehomes`
 * computes that and `state/scene.test.ts` tests it. They are about the write:
 * that it is one update, that it declines to invent anything, and that undo
 * takes the frame back with whatever moved.
 */
describe("re-homing a pin onto the paper it is stuck through", () => {
  it("re-parents in one update, coordinates and all", () => {
    const note = hanging("note", 0);
    const card = hanging("card", 400);

    let updates = 0;
    board.doc.on("update", () => updates++);
    rehomePins(board, [{ id: note.pinId, parent: card.itemId, lx: 20, ly: -30 }]);
    expect(updates).toBe(1);

    const moved = readPin(note.pinId, board.pins.get(note.pinId)!)!;
    expect([moved.parent, moved.lx, moved.ly]).toEqual([card.itemId, 20, -30]);
  });

  it("writes nothing at all when every pin already agrees", () => {
    const note = hanging("note", 0);
    let updates = 0;
    board.doc.on("update", () => updates++);
    // The common case by a wide margin: the scan runs behind every committed
    // drag and almost always has nothing to say.
    rehomePins(board, []);
    rehomePins(board, [{ id: note.pinId, parent: note.itemId, lx: 999, ly: 999 }]);
    expect(updates).toBe(0);
    const still = readPin(note.pinId, board.pins.get(note.pinId)!)!;
    expect([still.lx, still.ly]).not.toEqual([999, 999]);
  });

  it("leaves a pin alone rather than freeing it onto a parent that is not there", () => {
    // A named parent this client has not got is a race, not a free pin. Writing
    // null would move the pin, and moving a pin is the one thing this must
    // never do.
    const note = hanging("note", 0);
    rehomePins(board, [{ id: note.pinId, parent: "nobody", lx: 5, ly: 5 }]);
    const still = readPin(note.pinId, board.pins.get(note.pinId)!)!;
    expect(still.parent).toBe(note.itemId);
  });

  it("refuses a coordinate that is not a number", () => {
    const note = hanging("note", 0);
    rehomePins(board, [{ id: note.pinId, parent: null, lx: Number.NaN, ly: 0 }]);
    expect(readPin(note.pinId, board.pins.get(note.pinId)!)!.parent).toBe(note.itemId);
  });

  it("rides the undo entry of the write in front of it", () => {
    // The hazard T-176 named when it declined to build this: an undo entry
    // where a move is secretly also a re-parent. It is defused by being the
    // *same* entry — one Ctrl+Z puts the paper and the pin's frame back
    // together, so the pin lands where it started rather than being towed back
    // by an item it had not been stuck through yet.
    const note = hanging("note", 0);
    const card = hanging("card", 400);
    const history = new UndoHistory(board);

    setItemPoses(board, new Map([[card.itemId, { x: 0, y: 0, rot: 0 }]]));
    rehomePins(board, [{ id: note.pinId, parent: card.itemId, lx: 20, ly: -30 }]);
    expect(readPin(note.pinId, board.pins.get(note.pinId)!)!.parent).toBe(card.itemId);

    history.undo();
    expect(readPin(note.pinId, board.pins.get(note.pinId)!)!.parent).toBe(note.itemId);
    expect(pose(card.itemId)).toEqual([400, 0, 0]);
    history.destroy();
  });

  it("is a separate entry if a boundary gets between it and its cause", () => {
    // Why `app/main.ts` queues `undo.boundary()` rather than calling it, and
    // why the re-home is pushed onto the write queue immediately behind the
    // edit that caused it. Let the boundary land in between and the pin's frame
    // becomes its own Ctrl+Z — one that appears to move a pin nobody touched.
    const note = hanging("note", 0);
    const card = hanging("card", 400);
    const history = new UndoHistory(board);

    setItemPoses(board, new Map([[card.itemId, { x: 0, y: 0, rot: 0 }]]));
    history.boundary();
    rehomePins(board, [{ id: note.pinId, parent: card.itemId, lx: 20, ly: -30 }]);

    history.undo();
    expect(readPin(note.pinId, board.pins.get(note.pinId)!)!.parent).toBe(note.itemId);
    // Still moved: the undo spent itself on the re-home alone.
    expect(pose(card.itemId)).toEqual([0, 0, 0]);
    history.destroy();
  });
});
