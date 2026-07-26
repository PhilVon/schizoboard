/**
 * The whole chain, end to end: a document write becomes a rope.
 *
 *     crdt/ops/strings -> Y.Doc -> binding -> Scene.strings -> RopeSet
 *
 * Every other test in the project drives one link of that. This one drives all
 * of it, because the two acceptance criteria for T-108 are about the joins
 * rather than the parts: that the document reaches `sim/` only through the
 * scene mirror, and that a string created, re-slacked or cut is a rope set
 * change on the next frame — undo included.
 *
 * The frame here is deliberately the real one. `frame()` steps the rope set and
 * then clears the dirty sets, exactly as `render/loop.ts` phase 9 does, so a
 * change that fails to survive being consumed once shows up as a test that
 * needs two frames.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { Binding } from "@/crdt/binding";
import { openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { createPin, deletePins } from "@/crdt/ops/pins";
import {
  appendStringNode,
  createString,
  deleteStrings,
  setStringSlack,
  setStringStyle,
} from "@/crdt/ops/strings";
import { UndoHistory } from "@/crdt/undo";
import { RopeSet } from "@/sim/ropes";
import { DirtySets } from "@/state/dirty";
import { Scene, type Bounds } from "@/state/scene";

let board: BoardDoc;
let scene: Scene;
let dirty: DirtySets;
let binding: Binding;
let ropes: RopeSet;

const FRAME = 1000 / 60;
const box: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

function frame(n = 1): void {
  for (let i = 0; i < n; i++) {
    scene.layoutPins();
    ropes.step(scene, dirty, FRAME);
    dirty.clear();
  }
}

function pointsOf(id: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const pool = ropes.positions;
  ropes.visit(id, (at, count) => {
    for (let i = 0; i < count; i++) out.push([pool[at + i * 2], pool[at + i * 2 + 1]]);
  });
  return out;
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
  scene = new Scene();
  dirty = new DirtySets();
  binding = new Binding(board, scene, dirty);
  binding.start();
  ropes = new RopeSet();
});

describe("a string reaching the simulation", () => {
  it("becomes a rope on the next frame, hanging where the catenary says", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b], slack: 0.3 })!;

    // Before the frame the rope set has never heard of it.
    expect(ropes.size).toBe(0);
    frame();

    expect(ropes.size).toBe(1);
    const pts = pointsOf(id);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([200, 0]);
    // 30% slack over a 200-unit chord sags a long way below the pins.
    expect(ropes.boundsOf(id, box)!.maxY).toBeGreaterThan(30);
  });

  /** The point of the mirror: `sim/` never sees a `Y.Map`. */
  it("arrives through the scene and nothing else", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b] })!;
    const mirrored = scene.strings.get(id)!;
    expect(mirrored.nodes.map((n) => n.pin)).toEqual([a, b]);
    expect(mirrored.color).toBe("#a8322c");
    // Plain data, not a live view of the document.
    expect(Object.getPrototypeOf(mirrored.nodes[0])).toBe(Object.prototype);
  });

  it("is asleep the moment it exists, so a loaded board opens still", () => {
    const [a, b] = twoPins();
    createString(board, { pins: [a, b], slack: 0.3 });
    frame();
    expect(ropes.awake).toBe(0);
  });

  it("grows a rope when the run does", () => {
    const [a, b] = twoPins();
    const c = createPin(board, { parent: null, lx: 400, ly: 0 });
    const id = createString(board, { pins: [a, b] })!;
    frame();
    expect(ropes.size).toBe(1);

    appendStringNode(board, id, c);
    frame();
    expect(ropes.size).toBe(2);
    expect(ropes.boundsOf(id, box)!.maxX).toBeCloseTo(400, 6);
  });
});

describe("editing a string", () => {
  /**
   * > Wake on: ... a slack change — DESIGN section 5.3
   *
   * A slack edit wakes the rope rather than re-seeding it, so rolling the
   * wheel lets the sag out in front of you instead of snapping it through a
   * series of rest poses.
   */
  it("wakes on a slack change and settles deeper", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b], slack: 0.1 })!;
    frame();
    const before = ropes.boundsOf(id, { ...box })!.maxY;

    setStringSlack(board, id, 0.6);
    frame();
    expect(ropes.awake).toBe(1);

    for (let i = 0; i < 400 && ropes.awake > 0; i++) frame();
    expect(ropes.boundsOf(id, box)!.maxY).toBeGreaterThan(before + 20);
  });

  /** Colour, thickness and tuck-behind change no geometry, so they must not
   *  disturb a rope that has settled. */
  it("leaves a sleeping rope alone for a style change", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b] })!;
    frame(3);
    const settled = pointsOf(id);

    setStringStyle(board, [id], { color: "#2c5aa8", thickness: 6, layer: "under" });
    frame();
    expect(ropes.awake).toBe(0);
    expect(pointsOf(id)).toEqual(settled);
    // The renderer still hears about it — that is what `dirty.strings` is for.
    expect(scene.strings.get(id)!.layer).toBe("under");
  });

  it("wakes the rope when a pin under it moves", () => {
    const [a, b] = twoPins();
    createString(board, { pins: [a, b] });
    frame(3);
    expect(ropes.awake).toBe(0);

    createPin(board, { parent: null, lx: 0, ly: 0 });
    // Move the real one.
    const pin = board.pins.get(b)!;
    board.doc.transact(() => pin.set("ly", 300));
    frame();
    expect(ropes.awake).toBe(1);
  });
});

describe("a string going away", () => {
  it("takes its ropes with it, and leaves the pins", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b] })!;
    frame();
    expect(ropes.size).toBe(1);

    deleteStrings(board, [id]);
    frame();
    expect(ropes.size).toBe(0);
    expect(scene.pins.has(a)).toBe(true);
    expect(scene.pins.has(b)).toBe(true);
  });

  /**
   * The pin cascade removes the node, the string drops below two and deletes
   * itself, and the rope set finds out the same way it finds out about
   * everything — through the mirror.
   */
  it("goes when the last pin holding it does", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b] })!;
    frame();

    deletePins(board, [b]);
    frame();
    expect(scene.strings.has(id)).toBe(false);
    expect(ropes.size).toBe(0);
  });
});

describe("undo", () => {
  /** The second acceptance criterion: an undo restores the document *and* the
   *  rope, because the rope is derived and the derivation is the same one. */
  it("brings a cut string back as a rope", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b], slack: 0.3 })!;
    frame();

    const history = new UndoHistory(board);
    deleteStrings(board, [id]);
    frame();
    expect(ropes.size).toBe(0);

    history.undo();
    frame();
    expect(scene.strings.has(id)).toBe(true);
    expect(ropes.size).toBe(1);
    expect(ropes.boundsOf(id, box)!.maxY).toBeGreaterThan(30);
    history.destroy();
  });

  it("takes a string away again on redo", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b] })!;
    frame();

    const history = new UndoHistory(board);
    deleteStrings(board, [id]);
    frame();
    history.undo();
    frame();
    expect(ropes.size).toBe(1);

    history.redo();
    frame();
    expect(ropes.size).toBe(0);
    expect(scene.strings.has(id)).toBe(false);
    history.destroy();
  });
});

describe("a whole board being restored", () => {
  /** Load and resync both set `dirty.all`. Everything is rebuilt from the
   *  mirror and put back at rest, asleep — AC-62, from the top of the chain. */
  it("rebuilds every rope, asleep, and forgets the ones that went", () => {
    const [a, b] = twoPins();
    const c = createPin(board, { parent: null, lx: 0, ly: 400 });
    const keep = createString(board, { pins: [a, b], slack: 0.3 })!;
    const gone = createString(board, { pins: [a, c] })!;
    frame();
    expect(ropes.size).toBe(2);

    ropes.wake(keep);
    deleteStrings(board, [gone]);
    binding.resync();
    frame();

    expect(ropes.size).toBe(1);
    expect(ropes.awake).toBe(0);
    expect(pointsOf(keep)[0]).toEqual([0, 0]);
  });
});
