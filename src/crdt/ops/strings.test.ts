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
import { createPin, movePin } from "@/crdt/ops/pins";
import {
  appendStringNode,
  clampSlack,
  createString,
  DEFAULT_SLACK,
  deleteStrings,
  insertStringNode,
  removeStringNodes,
  setNodeSlack,
  setStringSlack,
  setStringStyle,
  stringsThroughPin,
} from "@/crdt/ops/strings";
import { MIN_SLACK, readString, type YMap } from "@/crdt/schema";
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
    setStringSlack(board, id, -1);
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
    setStringSlack(board, id, 0.5);
    expect(slacks(id)).toEqual([0.5, 0.5, 0.5]);
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
