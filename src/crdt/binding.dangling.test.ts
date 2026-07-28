/**
 * Invariant 3 at the mirror: a string is only a string while two of its nodes
 * resolve to a pin.
 *
 * The test that used to run here counted *well-formed* nodes, which is a
 * different and weaker question — so a two-node string with one surviving pin
 * reached the scene, and `sim/ropes.ts` then found the missing anchor, slept the
 * segment and drew nothing. Inert and invisible, but present: the janitor and
 * `crdt/invariants.ts` both said the string did not exist and `scene.strings`
 * said it did.
 *
 * Applying the real test is half the work. The other half is that failing it is
 * temporary — on a fresh connection a run and the pins it hangs from arrive in
 * whatever order the document hands them over — so the binding has to be able to
 * find a string again when the pin it was waiting for turns up. Both halves are
 * below, and so is the thing that must *not* happen: a pin moving is not a pin
 * arriving, and re-mirroring a run at drag rate would re-seed the rope every
 * frame of the gesture.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { Binding } from "@/crdt/binding";
import { openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { createPin, movePin } from "@/crdt/ops/pins";
import { createString } from "@/crdt/ops/strings";
import { readString } from "@/crdt/schema";
import { DirtySets } from "@/state/dirty";
import { Scene } from "@/state/scene";

let board: BoardDoc;
let scene: Scene;
let dirty: DirtySets;
let binding: Binding;

beforeEach(() => {
  board = openBoardDoc();
  scene = new Scene();
  dirty = new DirtySets();
  binding = new Binding(board, scene, dirty);
  binding.start();
});

/** Two free pins and a string between them, all present and correct. */
function strung(): { a: string; b: string; id: string } {
  const a = createPin(board, { parent: null, lx: 0, ly: 0 });
  const b = createPin(board, { parent: null, lx: 200, ly: 0 });
  return { a, b, id: createString(board, { pins: [a, b] })! };
}

/**
 * A pin removed the way a *peer* removes one: the record goes and nothing
 * touches the strings.
 *
 * `deletePins` cascades, so it cannot produce this state — but the cascade runs
 * on the machine that did the deleting, and T-76 established that a delete
 * meeting a concurrent edit to the same run leaves the node behind on the
 * merge. This is that document, built directly.
 */
function vanish(pinId: string): Record<string, unknown> {
  const record = board.pins.get(pinId)!.toJSON();
  board.doc.transact(() => board.pins.delete(pinId));
  return record;
}

/** That pin again, from a peer that never saw the delete. */
function restore(pinId: string, record: Record<string, unknown>): void {
  board.doc.transact(() => {
    const map = new Y.Map<unknown>();
    board.pins.set(pinId, map);
    for (const [key, value] of Object.entries(record)) map.set(key, value);
  });
}

describe("a node that resolves to nothing does not count", () => {
  it("keeps a string out of the scene when only one of its two pins survives", () => {
    const { a, id } = strung();
    expect(scene.strings.has(id)).toBe(true);

    vanish(a);

    // The run in the document is untouched — still two well-formed nodes, which
    // is exactly what the old test asked about and passed on.
    expect(readString(id, board.strings.get(id)!)!.nodes).toHaveLength(2);
    expect(scene.strings.has(id)).toBe(false);
    expect(dirty.strings.has(id)).toBe(true);
  });

  it("keeps a three-node string that still has two anchors", () => {
    const a = createPin(board, { parent: null, lx: 0, ly: 0 });
    const b = createPin(board, { parent: null, lx: 100, ly: 0 });
    const c = createPin(board, { parent: null, lx: 200, ly: 0 });
    const id = createString(board, { pins: [a, b, c] })!;

    vanish(b);

    // Two of three still resolve, so it is still a string — and the run it
    // mirrors is the document's, dangling node and all. Dropping the node here
    // would be repair on read, which DATA-MODEL section 8.1 forbids.
    expect(scene.strings.has(id)).toBe(true);
    expect(scene.strings.get(id)!.nodes.map((n) => n.pin)).toEqual([a, b, c]);
  });

  it("drops it when the second anchor goes too", () => {
    const a = createPin(board, { parent: null, lx: 0, ly: 0 });
    const b = createPin(board, { parent: null, lx: 100, ly: 0 });
    const c = createPin(board, { parent: null, lx: 200, ly: 0 });
    const id = createString(board, { pins: [a, b, c] })!;

    vanish(b);
    expect(scene.strings.has(id)).toBe(true);
    vanish(c);
    expect(scene.strings.has(id)).toBe(false);
  });
});

describe("arrival order cannot strand a string", () => {
  /**
   * The real case, not a simulation of it: three peers, and the update that
   * creates the string reaches us before the update that created its pins.
   *
   * The two writes have to come from *different* clients for this to be
   * possible at all — a single client's updates carry consecutive clocks, and
   * Yjs holds one back rather than leaving a gap, so a board can never see one
   * peer's second write without its first. Two peers have no such ordering
   * between them, which is exactly why arrival order is a real hazard and not a
   * contrived one.
   */
  it("mirrors the string when the pins turn up afterwards", () => {
    const pinner = openBoardDoc();
    const a = createPin(pinner, { parent: null, lx: 0, ly: 0 });
    const b = createPin(pinner, { parent: null, lx: 200, ly: 0 });
    const pinsArrived = Y.encodeStateAsUpdate(pinner.doc);

    const stringer = openBoardDoc();
    Y.applyUpdate(stringer.doc, pinsArrived);
    const beforeString = Y.encodeStateVector(stringer.doc);
    const id = createString(stringer, { pins: [a, b] })!;
    const stringArrived = Y.encodeStateAsUpdate(stringer.doc, beforeString);

    Y.applyUpdate(board.doc, stringArrived);
    // Nothing to hang from yet. It is in the document and out of the scene.
    expect(board.strings.has(id)).toBe(true);
    expect(scene.strings.has(id)).toBe(false);

    Y.applyUpdate(board.doc, pinsArrived);

    // Nothing touched the string's own record — the pins arriving is the only
    // event, and it has to be enough.
    expect(scene.strings.has(id)).toBe(true);
    expect(scene.strings.get(id)!.nodes.map((n) => n.pin)).toEqual([a, b]);
    expect(dirty.strings.has(id)).toBe(true);
  });

  it("restores a string when its lost pin comes back", () => {
    const { a, id } = strung();
    const record = vanish(a);
    expect(scene.strings.has(id)).toBe(false);

    restore(a, record);

    expect(scene.strings.has(id)).toBe(true);
  });

  it("stops watching a pin the run no longer names", () => {
    const { a, b, id } = strung();
    const c = createPin(board, { parent: null, lx: 400, ly: 0 });
    const record = vanish(a);
    expect(scene.strings.has(id)).toBe(false);

    // Rewrite the run onto two pins, neither of them `a`.
    board.doc.transact(() => {
      const nodes = board.strings.get(id)!.get("nodes") as Y.Array<Y.Map<unknown>>;
      nodes.delete(0, nodes.length);
      for (const pin of [b, c]) {
        const node = new Y.Map<unknown>();
        nodes.push([node]);
        node.set("nodeId", `n-${pin}`);
        node.set("pin", pin);
        node.set("slackAfter", 0.1);
      }
    });
    expect(scene.strings.has(id)).toBe(true);

    // `a` is nobody's anchor now, so its return says nothing about this string.
    // An index that only ever grew would re-read the run here — harmless today,
    // and a rope re-seeded for nothing on a board where pins come and go.
    dirty.clear();
    restore(a, record);
    expect(dirty.strings.has(id)).toBe(false);
  });
});

describe("a pin moving is not a pin arriving", () => {
  it("does not re-mirror a run when a pin is dragged", () => {
    const { a, id } = strung();
    dirty.clear();

    // What a drag writes, several times a second for the length of the gesture.
    for (let i = 1; i <= 5; i++) movePin(board, a, i * 10, 0);

    expect(dirty.pins.has(a)).toBe(true);
    // `state/dirty.ts`: "a rope set that rebuilt itself on every frame of a drag
    // would re-seed the pose it was in the middle of simulating".
    expect(dirty.strings.size).toBe(0);
    expect(scene.strings.has(id)).toBe(true);
  });
});

describe("resync", () => {
  it("rebuilds the mirror without carrying a stale index across", () => {
    const { a, id } = strung();
    const record = vanish(a);
    expect(scene.strings.has(id)).toBe(false);

    binding.resync();
    expect(scene.strings.has(id)).toBe(false);

    // And the rebuilt index is live, not merely empty.
    restore(a, record);
    expect(scene.strings.has(id)).toBe(true);
  });
});
