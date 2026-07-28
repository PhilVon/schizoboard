/**
 * The checker, against documents broken on purpose.
 *
 * This is the test that makes `fuzz.test.ts` mean anything. A fuzz harness that
 * finds nothing is indistinguishable from a fuzz harness that checks nothing,
 * and the difference between them is entirely here: every check in
 * `crdt/invariants.ts` is shown firing on a document hand-broken in exactly the
 * way it claims to catch, and shown silent on one that is fine.
 *
 * The breaking is done by writing straight at the `Y.Map`, which is the one
 * thing the rest of the application may never do — no op in `crdt/ops/` can
 * produce most of these states, which is rather the point. What is being tested
 * is the detector, not the reachability.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { checkConverged, checkInvariants, paintOrder } from "@/crdt/invariants";
import { commitStroke, createItems, createPin, createStringThrough } from "@/crdt/ops";
import type { YMap } from "@/crdt/schema";

let board: BoardDoc;

/** An item, two pins on it, a string between them, and a stroke on the cork. */
function furnish(): { item: string; p1: string; p2: string; stringId: string } {
  const item = createItems(board, [
    { type: "note", x: 0, y: 0, w: 200, h: 100, withPin: false },
  ])[0]!.itemId;
  const p1 = createPin(board, { parent: item, lx: -50, ly: 0 });
  const p2 = createPin(board, { parent: item, lx: 50, ly: 0 });
  const stringId = createStringThrough(board, [{ pin: p1 }, { pin: p2 }])!;
  commitStroke(board, {
    item: null,
    tool: "marker",
    color: "#1f1b17",
    size: 4,
    samples: [
      { x: 10, y: 10, pressure: 0.5 },
      { x: 40, y: 30, pressure: 0.6 },
      { x: 80, y: 20, pressure: 0.4 },
    ],
  });
  return { item, p1, p2, stringId };
}

/** Which invariants fired, so an expectation reads as a claim about one number. */
const fired = (): number[] => [...new Set(checkInvariants(board).map((v) => v.invariant))].sort();

const firstNode = (stringId: string): YMap =>
  (board.strings.get(stringId)!.get("nodes") as Y.Array<YMap>).get(0);

beforeEach(() => {
  board = openBoardDoc();
  board.doc.clientID = 1;
  initialiseBoard(board);
});

describe("checkInvariants", () => {
  it("says nothing about a board the ops built", () => {
    furnish();
    expect(checkInvariants(board)).toEqual([]);
  });

  it("1 — finds a NaN wherever it is, including one no field list would name", () => {
    const { item } = furnish();
    board.items.get(item)!.set("x", Number.NaN);
    expect(fired()).toContain(1);

    // The walk's whole justification: a number somewhere nobody enumerated.
    board.items.get(item)!.set("x", 0);
    board.meta.set("somethingNobodyThoughtOf", Number.POSITIVE_INFINITY);
    expect(fired()).toEqual([1]);
  });

  it("1 — finds one nested inside a plain object, and ignores packed ink", () => {
    const { item } = furnish();
    board.items.get(item)!.set("crop", { sx: 0, sy: 0, sw: Number.NaN, sh: 10 });
    const violations = checkInvariants(board);
    expect(violations.map((v) => v.invariant)).toEqual([1]);
    expect(violations[0]!.path).toBe(`items/${item}/crop.sw`);
  });

  it("2 — finds a slack that is zero, negative, or not there at all", () => {
    const { stringId } = furnish();
    for (const bad of [0, -0.5]) {
      firstNode(stringId).set("slackAfter", bad);
      expect(fired()).toContain(2);
    }
    firstNode(stringId).delete("slackAfter");
    expect(fired()).toEqual([2]);
  });

  /**
   * The one that proves reading raw matters. `readStringNodes` substitutes
   * `DEFAULT_SLACK` for a missing value, so the same document read through the
   * schema looks perfectly healthy — which is right for a renderer and would
   * make this check unfailable.
   */
  it("2 — catches what the schema readers would have quietly repaired", () => {
    const { stringId } = furnish();
    firstNode(stringId).set("slackAfter", "not a number");
    expect(fired()).toEqual([2]);
  });

  it("3 — finds a string whose nodes are not an array at all", () => {
    const { stringId } = furnish();
    board.strings.get(stringId)!.set("nodes", "gone");
    expect(fired()).toContain(3);
  });

  it("4 — finds a node whose pin is not even a reference", () => {
    const { stringId } = furnish();
    firstNode(stringId).set("pin", "");
    expect(fired()).toContain(4);
  });

  it("5 — finds a pin that resolves to no world position", () => {
    const { p1 } = furnish();
    // `readPin` refuses a parent that is neither a string nor null, and a pin it
    // refuses has nowhere to be drawn — neither parented nor free.
    board.pins.get(p1)!.set("parent", 42);
    expect(fired()).toContain(5);
  });

  /**
   * And the shape of 5 that cannot fire, said out loud so nobody spends an
   * afternoon on it: `readPin` coerces a non-finite `lx` to zero, so a broken
   * coordinate is caught by invariant 1 and the pin still resolves.
   */
  it("5 — is silent about a coordinate invariant 1 already owns", () => {
    const { p1 } = furnish();
    board.pins.get(p1)!.set("lx", Number.NaN);
    expect(fired()).toEqual([1]);
  });

  it("6 — finds a zero or negative dimension, which readItem would have clamped", () => {
    const { item } = furnish();
    for (const bad of [0, -20]) {
      board.items.get(item)!.set("w", bad);
      expect(fired()).toContain(6);
    }
  });

  it("7 — finds a bbox that no longer contains its own points", () => {
    furnish();
    const tile = [...board.boardInk.values()][0]!;
    const stroke = [...tile.values()][0]!;
    stroke.set("bbox", [0, 0, 1, 1]);
    const violations = checkInvariants(board);
    expect(violations.map((v) => v.invariant)).toEqual([7]);
    expect(violations[0]!.detail).toContain("does not contain");
  });

  it("8 — finds a tile left behind with no ink in it", () => {
    furnish();
    const key = [...board.boardInk.keys()][0]!;
    board.boardInk.get(key)!.clear();
    expect(fired()).toEqual([8]);
  });

  it("9 — finds a z key nothing could ever be stacked next to", () => {
    const { item } = furnish();
    // A key `fractional-indexing` refuses. The next `bringToFront` against this
    // item throws in the middle of a transaction, which is why it is an
    // invariant rather than a cosmetic complaint.
    board.items.get(item)!.set("z", "!!!not a key");
    expect(fired()).toContain(9);
  });

  it("reports every problem it finds, not just the first", () => {
    const { item, p1 } = furnish();
    board.items.get(item)!.set("w", -1);
    board.items.get(item)!.set("y", Number.NaN);
    board.pins.get(p1)!.set("parent", 42);
    expect(fired()).toEqual([1, 5, 6]);
  });

  it("does not repair anything it finds", () => {
    const { item } = furnish();
    board.items.get(item)!.set("w", -1);
    checkInvariants(board);
    checkInvariants(board);
    // Repair on read is a write storm in a shared session (DATA-MODEL 8.1), so
    // the second look has to find exactly what the first one did.
    expect(board.items.get(item)!.get("w")).toBe(-1);
  });
});

describe("checkConverged", () => {
  function twin(): BoardDoc {
    const other = openBoardDoc();
    other.doc.clientID = 2;
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(board.doc));
    return other;
  }

  it("says nothing about two documents that have seen the same updates", () => {
    furnish();
    expect(checkConverged(board, twin())).toEqual([]);
  });

  /**
   * What this actually catches is a merge that never happened — which would
   * otherwise turn every other check in the file into a check of one document
   * twice.
   */
  it("finds a document that was never merged into", () => {
    furnish();
    const other = twin();
    createItems(board, [{ type: "card", x: 5, y: 5, w: 50, h: 50 }]);
    expect(checkConverged(board, other).map((v) => v.invariant)).toContain(9);
  });

  it("finds a paint order the two documents disagree about", () => {
    const { item } = furnish();
    const other = twin();
    createItems(board, [{ type: "card", x: 5, y: 5, w: 50, h: 50 }]);
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(board.doc));
    expect(checkConverged(board, other)).toEqual([]);

    // Now move one item in one document only. Both roots and the order differ.
    other.items.get(item)!.set("z", "zzzz");
    const found = checkConverged(board, other);
    expect(found.some((v) => v.detail.includes("paint order differs"))).toBe(true);
  });

  it("is not fooled by two maps that hold the same keys in a different order", () => {
    furnish();
    const other = twin();
    // `Y.Map` iteration order is its own business, and two peers that inserted
    // the same fields in a different order hold identical content.
    const item = [...board.items.keys()][0]!;
    board.items.get(item)!.set("colour", "a");
    board.items.get(item)!.set("shade", "b");
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(board.doc));
    expect(checkConverged(board, other)).toEqual([]);
  });
});

describe("paintOrder", () => {
  it("breaks a tie on client id, so both peers sort the same way", () => {
    const a = createItems(board, [{ type: "note", x: 0, y: 0, w: 10, h: 10 }])[0]!.itemId;
    const b = createItems(board, [{ type: "note", x: 0, y: 0, w: 10, h: 10 }])[0]!.itemId;
    // The case `compareOrder` exists for: two peers generating the same key,
    // which the jitter makes rare and never impossible.
    board.items.get(a)!.set("z", "a0");
    board.items.get(b)!.set("z", "a0");
    board.items.get(a)!.set("createdBy", 9);
    board.items.get(b)!.set("createdBy", 2);
    expect(paintOrder(board)).toEqual([b, a]);
  });
});
