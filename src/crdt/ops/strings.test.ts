/**
 * The string schema, and the one decision it exists to make.
 *
 * D-5 says slack lives on the node rather than in a parallel array, and that
 * the reason is concurrent insertion. Most of the tests below are ordinary
 * coverage; the suite named after it is the one that would actually catch the
 * mistake, because a parallel array passes every other test in this file and
 * fails only when two people edit the same string at once.
 *
 * AC-66 is "slack is a ratio, never an absolute length" and AC-67 is the
 * terminal node's undefined slack. Both are as much documentation as code, so
 * both get tests that would fail if someone quietly changed their mind.
 */

import * as Y from "yjs";
import { beforeEach, describe, expect, it } from "vitest";

import { openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { createItems } from "@/crdt/ops/items";
import { createPin, movePin } from "@/crdt/ops/pins";
import { UndoHistory } from "@/crdt/undo";
import { splitSlack } from "@/lib/slack";
import {
  appendStringNode,
  clampSlack,
  createString,
  createStringThrough,
  DEFAULT_SLACK,
  deleteStrings,
  insertPinIntoString,
  insertStringNode,
  removeStringNodes,
  scaleNodeSlack,
  scaleStringSlack,
  setNodeSlack,
  setStringSlack,
  setStringStyle,
  stringsThroughPin,
} from "@/crdt/ops/strings";
import { MIN_SLACK, readString, type YMap } from "@/crdt/schema";
import { DEFAULT_STRING_MATERIAL } from "@/lib/material";
import { DEFAULT_STRING_COLOR, DEFAULT_STRING_THICKNESS } from "@/lib/palette";
import { MIN_SLACK as LIB_MIN_SLACK } from "@/lib/slack";

let board: BoardDoc;

/** The nodes of a string, read back through the schema reader. */
function nodes(id: string): Array<{ nodeId: string; pin: string; slackAfter: number }> {
  const map = board.strings.get(id);
  return map ? (readString(id, map)?.nodes ?? []) : [];
}

function pins(id: string): string[] {
  return nodes(id).map((n) => n.pin);
}

function slacks(id: string): number[] {
  return nodes(id).map((n) => n.slackAfter);
}

/** Two free pins, 200 board units apart. */
function twoPins(): [string, string] {
  return [
    createPin(board, { parent: null, lx: 0, ly: 0 }),
    createPin(board, { parent: null, lx: 200, ly: 0 }),
  ];
}

beforeEach(() => {
  board = openBoardDoc();
});

describe("making a string", () => {
  it("puts one node on each pin, in order", () => {
    const id = createString(board, { pins: ["p1", "p2", "p3"] })!;
    expect(pins(id)).toEqual(["p1", "p2", "p3"]);
  });

  it("gives every node its own identity", () => {
    const id = createString(board, { pins: ["p1", "p2", "p1"] })!;
    const ids = nodes(id).map((n) => n.nodeId);
    expect(new Set(ids).size).toBe(3);
  });

  /** > any number of nodes across any number of strings may point at the same
   *  > pin — DATA-MODEL section 5.1. That is hub pins, and it needs no code. */
  it("lets several strings and several nodes name the same pin", () => {
    const a = createString(board, { pins: ["hub", "p2"] })!;
    const b = createString(board, { pins: ["hub", "p3"] })!;
    const c = createString(board, { pins: ["p4", "hub", "p5"] })!;
    expect(stringsThroughPin(board, "hub").sort()).toEqual([a, b, c].sort());
  });

  it("refuses a run of fewer than two pins", () => {
    expect(createString(board, { pins: ["p1"] })).toBeNull();
    expect(createString(board, { pins: [] })).toBeNull();
    expect(board.strings.size).toBe(0);
  });

  it("defaults to cotton red, over, open, and a little weight in it", () => {
    const id = createString(board, { pins: ["p1", "p2"] })!;
    const s = readString(id, board.strings.get(id)!)!;
    expect(s.color).toBe("#a8322c");
    expect(s.layer).toBe("over");
    expect(s.material).toBe("string");
    expect(s.closed).toBe(false);
    expect(s.nodes[0].slackAfter).toBe(DEFAULT_SLACK);
  });

  it("takes a slack value per node when the caller has one", () => {
    const id = createString(board, { pins: ["p1", "p2", "p3"], slack: [0.4, 0.2, 0.3] })!;
    expect(slacks(id)).toEqual([0.4, 0.2, 0.3]);
  });
});

describe("slack is a ratio, not a length (AC-66)", () => {
  /**
   * The schema has nowhere to put a length, and this is the assertion of it.
   * A `restLength`, `length` or `chord` field appearing here later would be
   * physics writing to the document, which DESIGN section 5.1 forbids, and it
   * would have to be rewritten every time either pin moved.
   */
  it("stores no length anywhere on a string or its nodes", () => {
    const id = createString(board, { pins: ["p1", "p2"] })!;
    const map = board.strings.get(id)!;
    expect(Array.from(map.keys()).sort()).toEqual([
      "closed",
      "color",
      "createdAt",
      "createdBy",
      "layer",
      "material",
      "nodes",
      "thickness",
    ]);
    const node = (map.get("nodes") as Y.Array<YMap>).get(0);
    expect(Array.from(node.keys()).sort()).toEqual(["nodeId", "pin", "slackAfter"]);
  });

  /**
   * The consequence that makes it worth having: a ratio survives the pins
   * moving. Nothing in the document knows or cares where the pins went, so
   * dragging a photograph across the board cannot make a string need a write.
   */
  it("is untouched by the pins moving, and costs no write when they do", () => {
    const a = createPin(board, { parent: null, lx: 0, ly: 0 });
    const b = createPin(board, { parent: null, lx: 200, ly: 0 });
    const id = createString(board, { pins: [a, b], slack: 0.25 })!;

    let stringWrites = 0;
    const map = board.strings.get(id)!;
    map.observeDeep(() => stringWrites++);

    // Drag one pin four times as far away. A length would have to be rewritten
    // here — by the simulation, into the document, on every frame of the drag.
    movePin(board, b, 800, 300);
    movePin(board, b, -400, -900);

    expect(slacks(id)).toEqual([0.25, 0.25]);
    expect(stringWrites).toBe(0);
  });

  /** Invariant 2: strictly greater than zero, clamped to a small minimum. At
   *  rest length equal to the chord the solver jitters visibly. */
  it("never lets a gap reach zero", () => {
    expect(clampSlack(0)).toBe(MIN_SLACK);
    expect(clampSlack(-5)).toBe(MIN_SLACK);
    expect(clampSlack(MIN_SLACK / 2)).toBe(MIN_SLACK);
    expect(clampSlack(0.3)).toBe(0.3);

    const id = createString(board, { pins: ["p1", "p2"], slack: 0 })!;
    expect(slacks(id)[0]).toBe(MIN_SLACK);
    setStringSlack(board, [id], -1);
    expect(slacks(id)[0]).toBe(MIN_SLACK);
  });

  /**
   * The minimum is written down twice — here and in `lib/slack.ts`, which
   * splits and merges it — because `lib/` is dependency-free and may not
   * import `crdt/`. This is the assertion that stops the two copies drifting
   * apart in silence, made from the side that is allowed to see both.
   */
  it("is the same minimum the split and merge clamp to", () => {
    expect(MIN_SLACK).toBe(LIB_MIN_SLACK);
  });

  /**
   * The same arrangement, for the colour and the thickness a string is born
   * with. `lib/palette.ts` holds the policy — what an untouched string looks
   * like, which the menu also has to draw swatches of — and `crdt/schema.ts`
   * holds a *reader* fallback for a string that arrives from a peer without
   * the field. Two literals, one meaning, and this is the side of the seam
   * that can see both.
   */
  it("is born the palette's colour and weight, whichever literal answered", () => {
    const id = createString(board, { pins: ["p1", "p2"] })!;
    const made = readString(id, board.strings.get(id)!)!;
    expect([made.color, made.thickness]).toEqual([
      DEFAULT_STRING_COLOR,
      DEFAULT_STRING_THICKNESS,
    ]);

    // And the reader's own fallback, for a field a peer never wrote.
    board.strings.get(id)!.delete("color");
    board.strings.get(id)!.delete("thickness");
    const bare = readString(id, board.strings.get(id)!)!;
    expect([bare.color, bare.thickness]).toEqual([
      DEFAULT_STRING_COLOR,
      DEFAULT_STRING_THICKNESS,
    ]);
  });

  /** And the third of them — `lib/material.ts`'s default against the reader's
   *  own literal, the same two-literals-one-meaning arrangement. */
  it("is born plain string, whichever literal answered", () => {
    const id = createString(board, { pins: ["p1", "p2"] })!;
    expect(readString(id, board.strings.get(id)!)!.material).toBe(DEFAULT_STRING_MATERIAL);

    board.strings.get(id)!.delete("material");
    expect(readString(id, board.strings.get(id)!)!.material).toBe(DEFAULT_STRING_MATERIAL);
  });

  /** A slack that fails every comparison would reach a rest length, a particle
   *  position, and every peer, as a rope that has left the board. */
  it("keeps NaN out of the document", () => {
    expect(clampSlack(Number.NaN)).toBe(DEFAULT_SLACK);
    expect(clampSlack(Infinity)).toBe(DEFAULT_SLACK);
    const id = createString(board, { pins: ["p1", "p2"], slack: Number.NaN })!;
    expect(slacks(id)[0]).toBe(DEFAULT_SLACK);
  });
});

describe("the terminal node's slack (AC-67)", () => {
  /**
   * > `slackAfter` on the terminal node of an open string is unused and
   * > undefined. When `closed` is `true` it becomes the wrap-around segment.
   * > State this explicitly or someone will write a bug against it.
   * > — DATA-MODEL section 5.2
   *
   * So it exists and is a perfectly good number. What it is not is *read*: an
   * open run of n nodes has n-1 gaps, and the last node starts none of them.
   */
  it("is written, valid, and one more than there are gaps", () => {
    const id = createString(board, { pins: ["p1", "p2", "p3"] })!;
    const s = readString(id, board.strings.get(id)!)!;
    expect(s.closed).toBe(false);
    expect(s.nodes).toHaveLength(3);
    expect(s.nodes[2].slackAfter).toBeGreaterThan(0);
    // Three nodes, two gaps. The third node's value has no gap to describe.
    expect(s.nodes.length - 1).toBe(2);
  });

  /** Closing the string is what gives it a meaning — and it acquires one
   *  without being rewritten, which is why it is stored rather than left a
   *  hole in the first place. */
  it("becomes the wrap-around gap when the string closes, unchanged", () => {
    const id = createString(board, { pins: ["p1", "p2", "p3"], slack: [0.1, 0.2, 0.3] })!;
    const terminal = slacks(id)[2];
    setStringStyle(board, [id], { closed: true });
    const s = readString(id, board.strings.get(id)!)!;
    expect(s.closed).toBe(true);
    expect(s.nodes[2].slackAfter).toBe(terminal);
    // Closed: as many gaps as nodes, and the last one is that value.
    expect(s.nodes).toHaveLength(3);
  });
});

describe("concurrent insertion — the reason for the schema (D-5)", () => {
  /**
   * The test a parallel `slack: Y.Array<number>` would fail, and the only one
   * in this file that would notice the difference.
   *
   * Two peers split different gaps of the same string at the same moment.
   * Whatever order the updates land in, every original gap must still carry
   * the slack it was authored with — because the value travelled inside the
   * node rather than at an index that the other peer's insert renumbered.
   */
  it("keeps every slack welded to its own gap when two peers insert at once", () => {
    const id = createString(board, {
      pins: ["p1", "p2", "p3", "p4"],
      slack: [0.11, 0.22, 0.33, 0.44],
    })!;

    const alice = openBoardDoc();
    const bob = openBoardDoc();
    const base = Y.encodeStateAsUpdate(board.doc);
    Y.applyUpdate(alice.doc, base);
    Y.applyUpdate(bob.doc, base);

    // Alice splits the first gap; Bob splits the third. Neither has seen the
    // other, and both compute their index from the same prior state.
    insertStringNode(alice, id, 1, "alice", 0.05, 0.06);
    insertStringNode(bob, id, 3, "bob", 0.07, 0.08);

    const fromAlice = Y.encodeStateAsUpdate(alice.doc);
    const fromBob = Y.encodeStateAsUpdate(bob.doc);
    Y.applyUpdate(alice.doc, fromBob);
    Y.applyUpdate(bob.doc, fromAlice);

    const read = (d: BoardDoc): Array<[string, number]> =>
      (readString(id, d.strings.get(id)!)?.nodes ?? []).map((n) => [n.pin, n.slackAfter]);

    // Converged, and both new pins are present.
    expect(read(alice)).toEqual(read(bob));
    const merged = read(alice);
    expect(merged).toHaveLength(6);
    expect(merged.map(([pin]) => pin)).toContain("alice");
    expect(merged.map(([pin]) => pin)).toContain("bob");

    // And the gaps neither of them touched still carry their own values. p2's
    // 0.22 is the one that matters: Alice's insert moved it from index 1 to
    // index 2, and Bob never knew.
    const slackOf = (pin: string): number => merged.find(([p]) => p === pin)![1];
    expect(slackOf("p2")).toBe(0.22);
    expect(slackOf("p4")).toBe(0.44);
    // The gaps they did author are theirs.
    expect(slackOf("alice")).toBe(0.06);
    expect(slackOf("bob")).toBe(0.08);
  });

  it("converges when both peers adjust different gaps of the same string", () => {
    const id = createString(board, { pins: ["p1", "p2", "p3"], slack: [0.1, 0.2, 0.3] })!;
    const alice = openBoardDoc();
    const bob = openBoardDoc();
    const base = Y.encodeStateAsUpdate(board.doc);
    Y.applyUpdate(alice.doc, base);
    Y.applyUpdate(bob.doc, base);

    const first = readString(id, alice.strings.get(id)!)!.nodes[0].nodeId;
    const second = readString(id, bob.strings.get(id)!)!.nodes[1].nodeId;
    setNodeSlack(alice, id, first, 0.9);
    setNodeSlack(bob, id, second, 0.8);

    Y.applyUpdate(alice.doc, Y.encodeStateAsUpdate(bob.doc));
    Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(alice.doc));

    const a = readString(id, alice.strings.get(id)!)!.nodes.map((n) => n.slackAfter);
    expect(a).toEqual(readString(id, bob.strings.get(id)!)!.nodes.map((n) => n.slackAfter));
    expect(a).toEqual([0.9, 0.8, 0.3]);
  });
});

describe("growing and shrinking a run", () => {
  it("appends a pin and inherits the drape already in the string", () => {
    const id = createString(board, { pins: ["p1", "p2"], slack: 0.4 })!;
    appendStringNode(board, id, "p3");
    expect(pins(id)).toEqual(["p1", "p2", "p3"]);
    expect(slacks(id)[1]).toBe(0.4);
  });

  it("inserts into the middle and reads in run order", () => {
    const id = createString(board, { pins: ["p1", "p3"] })!;
    insertStringNode(board, id, 1, "p2");
    expect(pins(id)).toEqual(["p1", "p2", "p3"]);
  });

  it("lets the caller author both halves of a split", () => {
    const id = createString(board, { pins: ["p1", "p3"], slack: 0.3 })!;
    insertStringNode(board, id, 1, "p2", 0.12, 0.18);
    expect(slacks(id).slice(0, 2)).toEqual([0.12, 0.18]);
  });

  it("removes a node by id and leaves the rest alone", () => {
    const id = createString(board, { pins: ["p1", "p2", "p3"], slack: [0.1, 0.2, 0.3] })!;
    const middle = nodes(id)[1].nodeId;
    removeStringNodes(board, id, new Set([middle]));
    expect(pins(id)).toEqual(["p1", "p3"]);
    expect(slacks(id)).toEqual([0.1, 0.3]);
  });

  /** > A string left with fewer than two valid nodes deletes itself.
   *  > — DATA-MODEL section 5.3, invariant 3 */
  it("deletes itself rather than surviving as one node", () => {
    const id = createString(board, { pins: ["p1", "p2", "p3"] })!;
    const [a, b] = nodes(id);
    removeStringNodes(board, id, new Set([a.nodeId, b.nodeId]));
    expect(board.strings.has(id)).toBe(false);
  });

  /** The deletion is inside the same transaction as the removal, so undo
   *  restores a string rather than an empty husk of one. */
  it("removes and self-deletes in one update", () => {
    const id = createString(board, { pins: ["p1", "p2"] })!;
    let updates = 0;
    board.doc.on("update", () => updates++);
    removeStringNodes(board, id, new Set([nodes(id)[0].nodeId]));
    expect(updates).toBe(1);
    expect(board.strings.has(id)).toBe(false);
  });

  it("shrugs at a string that is already gone", () => {
    const id = createString(board, { pins: ["p1", "p2"] })!;
    deleteStrings(board, [id]);
    expect(() => removeStringNodes(board, id, new Set(["nope"]))).not.toThrow();
    expect(appendStringNode(board, id, "p3")).toBeNull();
    expect(insertStringNode(board, id, 0, "p3")).toBeNull();
  });
});

describe("making a string through a run of anchors", () => {
  /**
   * `insertPinIntoString`'s settle, plural — and the thing that makes this op
   * different from the pin ops, which each settle one sheet of paper. A run
   * pushes a pin into every item it was clicked through, so a four-click run
   * can stop two things hanging at once, and both were drawn at poses the
   * document does not hold. The run, the pins it made and those poses are one
   * transaction; anything less and `Ctrl+Z` would take the string back and
   * leave two sheets of paper at angles nobody authored.
   */
  it("settles every item the run pinned, in the same entry", () => {
    // Each hanging on the one pin it was created with, so the pin the run
    // pushes in is the second, and the second is the one that stops the swing.
    const [note, card] = createItems(board, [
      { type: "note", x: 0, y: 0, w: 200, h: 200, rot: 0 },
      { type: "card", x: 400, y: 0, w: 200, h: 200, rot: 0 },
    ]);
    const a = note!.itemId;
    const b = card!.itemId;
    const history = new UndoHistory(board);

    let updates = 0;
    board.doc.on("update", () => updates++);
    const id = createStringThrough(
      board,
      [{ parent: a, lx: 10, ly: -20 }, { parent: b, lx: -10, ly: -20 }],
      { slack: 0.2 },
      new Map([
        [a, { x: 5, y: 7, rot: 0.3 }],
        [b, { x: 395, y: -9, rot: -0.6 }],
      ]),
    )!;
    expect(updates).toBe(1);

    // A second pin in each sheet of paper, which is what makes both settles
    // the run's business rather than two things the caller has to remember.
    const made = pins(id);
    expect(made).toHaveLength(2);
    expect(board.pins.get(made[0])!.get("parent")).toBe(a);
    expect(board.pins.get(made[1])!.get("parent")).toBe(b);
    expect(board.pins.size).toBe(4);

    const settledNote = board.items.get(a)!;
    expect(settledNote.get("x")).toBe(5);
    expect(settledNote.get("y")).toBe(7);
    expect(settledNote.get("rot")).toBe(0.3);
    const settledCard = board.items.get(b)!;
    expect(settledCard.get("x")).toBe(395);
    expect(settledCard.get("y")).toBe(-9);
    expect(settledCard.get("rot")).toBe(-0.6);

    history.undo();
    expect(board.strings.has(id)).toBe(false);
    // The two the items were created with, and neither of the run's.
    expect(board.pins.size).toBe(2);
    expect(board.items.get(a)!.get("x")).toBe(0);
    expect(board.items.get(a)!.get("rot")).toBe(0);
    expect(board.items.get(b)!.get("x")).toBe(400);
    expect(board.items.get(b)!.get("rot")).toBe(0);
    history.destroy();
  });
});

describe("pushing a pin into the middle of a run", () => {
  /**
   * A cut halfway along a 200-unit chord, both halves 100. The op divides the
   * segment's *own* slack against this, so a test that wants to know what came
   * out asks `splitSlack` the same question — see `CUT` below.
   */
  const EVEN_SPLIT = { chord: 200, first: 100, second: 100, t: 0.5 };
  /** An off-centre cut, so the two halves are visibly unequal. */
  const CUT = { chord: 200, first: 120, second: 140, t: 0.45 };

  /** > A new pin is born at that point on the string, free-floating, and
   *  > follows your cursor. The string now runs *through* it.
   *  > — DESIGN section 3.4 */
  it("makes the pin and the node in one update", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b], slack: 0.3 })!;
    let updates = 0;
    board.doc.on("update", () => updates++);

    const made = insertPinIntoString(
      board, id, 1, { parent: null, lx: 100, ly: 60 }, EVEN_SPLIT,
    )!;
    expect(updates).toBe(1);
    expect(board.pins.has(made)).toBe(true);
    expect(pins(id)).toEqual([a, made, b]);
    // An even cut of a 0.3 segment gives both halves 0.3 back: rest is
    // 200 × 1.3 = 260, half of it is 130 over a 100 chord.
    expect(slacks(id)[0]).toBeCloseTo(0.3, 12);
    expect(slacks(id)[1]).toBeCloseTo(0.3, 12);
  });

  /**
   * The two halves are what stop the sag jumping (AC-18) — and they are the
   * *op's* to work out, not the caller's, because the slack they divide is
   * document state and the caller's copy of it is a gesture old (DATA-MODEL
   * section 5.4). The caller supplies only the geometry it alone can measure.
   */
  it("divides the segment's own slack against the geometry it is given", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b], slack: 0.3 })!;
    const [before, after] = splitSlack(CUT.chord, 0.3, CUT.first, CUT.second, CUT.t);
    insertPinIntoString(board, id, 1, { parent: null, lx: 90, ly: 70 }, CUT);
    expect(slacks(id)[0]).toBeCloseTo(before, 12);
    expect(slacks(id)[1]).toBeCloseTo(after, 12);
  });

  /**
   * The point of the whole change. A peer re-slacks the segment after the
   * gesture began — which, with the write queued to the next flush, is a wide
   * window — and the split must divide the value that is actually there.
   *
   * Under the old signature this was not expressible: the two halves arrived
   * already computed from 0.3 and the 0.9 would have been overwritten.
   */
  it("splits the slack as it is at the write, not as it was at the gesture", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b], slack: 0.3 })!;

    // Everything the tool measured, captured while the segment was still 0.3.
    const asTheGestureSawIt = 0.3;

    // ...and then somebody else pulls a lot more slack into it.
    setStringSlack(board, [id], 0.9);
    insertPinIntoString(board, id, 1, { parent: null, lx: 90, ly: 70 }, CUT);

    const [before, after] = splitSlack(CUT.chord, 0.9, CUT.first, CUT.second, CUT.t);
    expect(slacks(id)[0]).toBeCloseTo(before, 12);
    expect(slacks(id)[1]).toBeCloseTo(after, 12);

    // And demonstrably not the answer the stale number would have given.
    const [staleBefore] = splitSlack(CUT.chord, asTheGestureSawIt, CUT.first, CUT.second, CUT.t);
    expect(slacks(id)[0]).not.toBeCloseTo(staleBefore, 6);
  });

  /**
   * The conservation law the gesture lives or dies by, now that the op owns it:
   * the two new rest lengths add up to the one they replaced, so the sag does
   * not jump at the instant the pin lands (AC-18, DESIGN section 3.4).
   */
  it("conserves the rest length it split, so the sag does not jump", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b], slack: 0.35 })!;
    insertPinIntoString(board, id, 1, { parent: null, lx: 90, ly: 70 }, CUT);

    const [before, after] = slacks(id);
    const restBefore = CUT.chord * (1 + 0.35);
    const restAfter = CUT.first * (1 + before!) + CUT.second * (1 + after!);
    expect(restAfter).toBeCloseTo(restBefore, 9);
  });

  it("can push the new node onto an item, so it rides with the paper", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b] })!;
    const made = insertPinIntoString(
      board, id, 1, { parent: "note-1", lx: 10, ly: -20 }, EVEN_SPLIT,
    )!;
    expect(board.pins.get(made)!.get("parent")).toBe("note-1");
  });

  /**
   * The mirror of what `deletePins` does with its `settle`. The pin that makes
   * two is the pin that stops an item hanging, and the pose it was drawn at
   * while it hung is not in the document — so it arrives alongside the insert
   * and lands in the same entry, or `Ctrl+Z` puts the paper back and leaves the
   * pose behind.
   */
  it("settles the item it just pinned, in the same entry", () => {
    const [item] = createItems(board, [
      { type: "note", x: 0, y: 0, w: 200, h: 200, rot: 0, withPin: false },
    ]);
    const itemId = item!.itemId;
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b] })!;
    const history = new UndoHistory(board);

    let updates = 0;
    board.doc.on("update", () => updates++);
    const made = insertPinIntoString(
      board, id, 1, { parent: itemId, lx: 10, ly: -20 }, EVEN_SPLIT,
      new Map([[itemId, { x: 30, y: 40, rot: 0.5 }]]),
    )!;
    expect(updates).toBe(1);

    const settled = board.items.get(itemId)!;
    expect(settled.get("x")).toBe(30);
    expect(settled.get("y")).toBe(40);
    expect(settled.get("rot")).toBe(0.5);

    history.undo();
    expect(board.pins.has(made)).toBe(false);
    expect(board.items.get(itemId)!.get("x")).toBe(0);
    expect(board.items.get(itemId)!.get("rot")).toBe(0);
    history.destroy();
  });

  it("can run the string through a pin that already exists", () => {
    const [a, b] = twoPins();
    const hub = createPin(board, { parent: null, lx: 100, ly: 100 });
    const id = createString(board, { pins: [a, b] })!;
    expect(insertPinIntoString(board, id, 1, { pin: hub }, EVEN_SPLIT)).toBe(hub);
    expect(pins(id)).toEqual([a, hub, b]);
    expect(board.pins.size).toBe(3);
  });

  it("makes no pin at all when the string has gone", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b] })!;
    deleteStrings(board, [id]);
    const before = board.pins.size;
    expect(
      insertPinIntoString(board, id, 1, { parent: null, lx: 0, ly: 0 }, EVEN_SPLIT),
    ).toBeNull();
    expect(board.pins.size).toBe(before);
  });

  /** AC-71: Esc mid-drag reverts topology completely. Nothing is written until
   *  the release, so the revert is that the write never happened — and if one
   *  did, undo takes the pin with it because they are one entry. */
  it("undoes as one thing, taking its pin with it", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b], slack: 0.3 })!;
    const history = new UndoHistory(board);
    const made = insertPinIntoString(
      board, id, 1, { parent: null, lx: 100, ly: 60 }, EVEN_SPLIT,
    )!;
    expect(board.pins.has(made)).toBe(true);

    history.undo();
    expect(board.pins.has(made)).toBe(false);
    expect(pins(id)).toEqual([a, b]);
    expect(slacks(id)[0]).toBeCloseTo(0.3, 12);
    history.destroy();
  });
});

describe("editing a string", () => {
  /** Addressed by node id rather than index: an index read on one frame and
   *  written on the next is one a concurrent insert may have moved. */
  it("adjusts one gap without disturbing its neighbours", () => {
    const id = createString(board, { pins: ["p1", "p2", "p3"], slack: [0.1, 0.2, 0.3] })!;
    setNodeSlack(board, id, nodes(id)[1].nodeId, 0.75);
    expect(slacks(id)).toEqual([0.1, 0.75, 0.3]);
  });

  it("adjusts the whole string at once", () => {
    const id = createString(board, { pins: ["p1", "p2", "p3"], slack: [0.1, 0.2, 0.3] })!;
    setStringSlack(board, [id], 0.5);
    expect(slacks(id)).toEqual([0.5, 0.5, 0.5]);
  });

  /** A preset applied to a multiple selection is one thing the user did, so it
   *  is one transaction and therefore one undo entry. */
  it("adjusts several strings in one transaction", () => {
    const a = createString(board, { pins: ["p1", "p2"], slack: 0.1 })!;
    const b = createString(board, { pins: ["p2", "p3"], slack: 0.4 })!;
    const history = new UndoHistory(board);
    setStringSlack(board, [a, b], 0.5);
    expect([...slacks(a), ...slacks(b)]).toEqual([0.5, 0.5, 0.5, 0.5]);
    history.undo();
    expect(slacks(a)[0]).toBeCloseTo(0.1, 12);
    expect(slacks(b)[0]).toBeCloseTo(0.4, 12);
    history.destroy();
  });

  /**
   * `Alt`+wheel, and the whole reason it is a different op from the preset
   * above.
   *
   * > | Adjust the whole string | `Alt`+wheel | All segments together |
   * > — DESIGN section 3.4
   *
   * "Together" means the run keeps its shape. A run that has had a pin pulled
   * out of its middle has deliberately unequal ratios — `lib/slack.ts` gives the
   * short chord the large one — and setting them all to a single value would
   * throw that away on the first notch of the wheel.
   */
  it("scales the whole string without flattening its shape", () => {
    const id = createString(board, { pins: ["p1", "p2", "p3"], slack: [0.1, 0.2, 0.4] })!;
    scaleStringSlack(board, [id], 1.5);
    expect(slacks(id)[0]).toBeCloseTo(0.15, 12);
    expect(slacks(id)[1]).toBeCloseTo(0.3, 12);
    expect(slacks(id)[2]).toBeCloseTo(0.6, 12);
  });

  /**
   * The wheel over one segment, and it takes a factor rather than a value for a
   * reason the tool could not work around: a tool reads the scene one frame
   * before its write lands, so a roll that multiplied in the tool would keep
   * re-deriving the same product from the same stale number. Compounding has to
   * happen where the current value is.
   */
  it("compounds a run of notches on one gap", () => {
    const id = createString(board, { pins: ["p1", "p2", "p3"], slack: [0.1, 0.2, 0.3] })!;
    const gap = nodes(id)[1].nodeId;
    for (let i = 0; i < 4; i++) scaleNodeSlack(board, id, gap, 1.2);
    expect(slacks(id)[1]).toBeCloseTo(0.2 * 1.2 ** 4, 12);
    // And its neighbours are where they were.
    expect(slacks(id)[0]).toBeCloseTo(0.1, 12);
    expect(slacks(id)[2]).toBeCloseTo(0.3, 12);
  });

  /**
   * And what it does *not* buy, which is worth a test so that nobody reads the
   * factor as a CRDT trick. `slackAfter` is a `Y.Map` field, so it is
   * last-write-wins: two people adjusting one gap at once converge on one of the
   * two answers rather than on the product. That is the right resolution for a
   * scalar — the alternative is a gap whose slack is neither person's — and it is
   * why the concurrency D-5 worries about is insertion rather than adjustment.
   */
  it("resolves two clients adjusting one gap to one of their answers", () => {
    const alice = openBoardDoc();
    const bob = openBoardDoc();
    const id = createString(board, { pins: ["p1", "p2"], slack: 0.2 })!;
    const base = Y.encodeStateAsUpdate(board.doc);
    Y.applyUpdate(alice.doc, base);
    Y.applyUpdate(bob.doc, base);
    const gap = nodes(id)[0].nodeId;

    scaleNodeSlack(alice, id, gap, 1.5);
    scaleNodeSlack(bob, id, gap, 2);
    const fromAlice = Y.encodeStateAsUpdate(alice.doc);
    const fromBob = Y.encodeStateAsUpdate(bob.doc);
    Y.applyUpdate(alice.doc, fromBob);
    Y.applyUpdate(bob.doc, fromAlice);

    const settled = (doc: BoardDoc): number =>
      readString(id, doc.strings.get(id) as YMap)!.nodes[0].slackAfter;
    expect(settled(alice)).toBe(settled(bob));
    expect([0.3, 0.4]).toContain(Number(settled(alice).toFixed(12)));
  });

  /**
   * Scaling down far enough pins the slackest gaps to the floor along with the
   * tightest, and scaling back up does not restore the shape. That is correct
   * rather than merely tolerated: the run went taut, and there is no more string
   * to pay back out by turning the wheel the other way either.
   */
  it("cannot scale a gap below the minimum, and does not remember trying", () => {
    const id = createString(board, { pins: ["p1", "p2", "p3"], slack: [0.02, 0.5, 0.5] })!;
    scaleStringSlack(board, [id], 1e-6);
    expect(slacks(id)).toEqual([MIN_SLACK, MIN_SLACK, MIN_SLACK]);
    scaleStringSlack(board, [id], 1e6);
    expect(slacks(id).every((s) => s === slacks(id)[0])).toBe(true);
  });

  it("refuses a factor that is not a positive number", () => {
    const id = createString(board, { pins: ["p1", "p2"], slack: 0.2 })!;
    for (const factor of [0, -1, Number.NaN, Infinity]) {
      scaleStringSlack(board, [id], factor);
      scaleNodeSlack(board, id, nodes(id)[0].nodeId, factor);
      expect(slacks(id)[0]).toBeCloseTo(0.2, 12);
    }
  });

  it("ignores a node id and a string id that are not there", () => {
    const id = createString(board, { pins: ["p1", "p2"], slack: 0.2 })!;
    expect(() => scaleNodeSlack(board, id, "nope", 2)).not.toThrow();
    expect(() => scaleNodeSlack(board, "s-nope", nodes(id)[0].nodeId, 2)).not.toThrow();
    expect(() => scaleStringSlack(board, ["s-nope"], 2)).not.toThrow();
    expect(() => setStringSlack(board, ["s-nope"], 0.5)).not.toThrow();
    expect(slacks(id)[0]).toBeCloseTo(0.2, 12);
  });

  it("restyles colour, thickness, material and layer", () => {
    const id = createString(board, { pins: ["p1", "p2"] })!;
    setStringStyle(board, [id], {
      color: "#2c5aa8",
      thickness: 5,
      material: "wire",
      layer: "under",
    });
    const s = readString(id, board.strings.get(id)!)!;
    expect([s.color, s.thickness, s.material, s.layer]).toEqual(["#2c5aa8", 5, "wire", "under"]);
  });

  it("restyles several strings in one transaction", () => {
    const a = createString(board, { pins: ["p1", "p2"] })!;
    const b = createString(board, { pins: ["p3", "p4"] })!;
    let updates = 0;
    board.doc.on("update", () => updates++);
    setStringStyle(board, [a, b], { layer: "under" });
    expect(updates).toBe(1);
    expect(readString(a, board.strings.get(a)!)!.layer).toBe("under");
    expect(readString(b, board.strings.get(b)!)!.layer).toBe("under");
  });
});

describe("cutting a string", () => {
  /** > String removed; its pins stay where they are. — DESIGN section 3.4 */
  it("takes the string and nothing else", () => {
    const a = createString(board, { pins: ["p1", "p2"] })!;
    const b = createString(board, { pins: ["p2", "p3"] })!;
    deleteStrings(board, [a]);
    expect(board.strings.has(a)).toBe(false);
    expect(board.strings.has(b)).toBe(true);
    expect(stringsThroughPin(board, "p2")).toEqual([b]);
  });
});
