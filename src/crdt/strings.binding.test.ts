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
  scaleNodeSlack,
  scaleStringSlack,
  setNodeSlack,
  setStringSlack,
  setStringStyle,
} from "@/crdt/ops/strings";
import { MIN_SLACK, readString, type YMap } from "@/crdt/schema";
import { presetSlack } from "@/lib/slack";
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

    setStringSlack(board, [id], 0.6);
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

/**
 * The slack controls, end to end — DESIGN section 3.4.
 *
 * The chain a wheel notch travels is long and every link is somebody else's
 * module: the tool names a gap by node id, the op writes it, the binding
 * mirrors the run, and `RopeSet.sync` decides whether that was a topology change
 * or a slack change. These are the joins, which is the one thing no unit test
 * either side of them can see.
 */
describe("slack controls end to end", () => {
  /**
   * The addressing chain. `setNodeSlack` names a gap by the id of the node it
   * starts at rather than by index — an index read on one frame and written on
   * the next is one a concurrent insert may have moved — and the only way a tool
   * can know that id is if the mirror carries it.
   */
  it("mirrors the node ids a slack edit has to address gaps by", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b], slack: 0.2 })!;
    frame();

    const authored = readString(id, board.strings.get(id) as YMap)!;
    const mirrored = scene.strings.get(id)!;
    expect(mirrored.nodes.map((n) => n.nodeId)).toEqual(authored.nodes.map((n) => n.nodeId));
    expect(mirrored.nodes[0]!.nodeId).not.toBe(mirrored.nodes[1]!.nodeId);
  });

  it("adjusts the gap the id names, through the mirror and into the rope", () => {
    const [a, b] = twoPins();
    const c = createPin(board, { parent: null, lx: 400, ly: 0 });
    const id = createString(board, { pins: [a, b, c], slack: 0.1 })!;
    frame(3);
    const gaps = scene.strings.get(id)!.nodes.map((n) => n.nodeId);

    scaleNodeSlack(board, id, gaps[1]!, 4);
    frame();
    expect(scene.strings.get(id)!.nodes[0]!.slackAfter).toBeCloseTo(0.1, 12);
    expect(scene.strings.get(id)!.nodes[1]!.slackAfter).toBeCloseTo(0.4, 12);

    // And it is the far half of the run that drops, not the near one.
    for (let i = 0; i < 400 && ropes.awake > 0; i++) frame();
    const points = pointsOf(id);
    const lowestNear = Math.max(...points.slice(0, points.length / 2).map(([, y]) => y));
    const lowestFar = Math.max(...points.slice(points.length / 2).map(([, y]) => y));
    expect(lowestFar).toBeGreaterThan(lowestNear + 10);
  });

  /**
   * What one notch of the wheel actually does, which is the claim in
   * DESIGN section 3.4's table: "slack up or down; **the sag responds live**".
   *
   * A notch is a 22% change in the ratio, and on a 200-unit chord at 20% slack
   * that is about five board units of extra droop — enough to see, nowhere near
   * enough to startle. The number is asserted loosely because what is being
   * pinned down is the order of magnitude: a notch that moved the rope by a
   * tenth of a pixel would read as the wheel being broken, and one that moved it
   * fifty would read as the string being yanked.
   */
  it("moves the sag by a visible, proportionate amount for one notch", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b], slack: 0.2 })!;
    frame(3);
    const before = pointsOf(id);

    // The factor `state/tools/select.ts` produces for a single 100 px notch.
    scaleNodeSlack(board, id, scene.strings.get(id)!.nodes[0]!.nodeId, Math.exp(0.2));
    // > Wake on: ... a slack change — DESIGN section 5.3. Awake rather than
    // re-seeded, and the distinction is not cosmetic: seeding a rope puts every
    // particle on the new analytic catenary and marks it asleep *immediately*
    // (section 5.3), so a rope that is awake at all is a rope that is moving to
    // its new pose rather than having been placed at it.
    frame();
    expect(ropes.awake).toBe(1);

    for (let i = 0; i < 400 && ropes.awake > 0; i++) frame();
    const dropped = Math.max(...pointsOf(id).map(([, y], i) => y - before[i]![1]));
    expect(dropped).toBeGreaterThan(2);
    expect(dropped).toBeLessThan(15);
  });

  /**
   * And why the wheel hands the document a *factor* rather than a value: notches
   * compound. A tool that read the slack out of the scene and wrote back the
   * product would read a frame-old number every time, so a steady roll would
   * move the sag once and then keep re-deriving the same answer.
   */
  it("compounds a roll of the wheel into a real drape", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b], slack: 0.2 })!;
    frame(3);
    const before = pointsOf(id);

    const gap = scene.strings.get(id)!.nodes[0]!.nodeId;
    for (let i = 0; i < 10; i++) {
      scaleNodeSlack(board, id, gap, Math.exp(0.2));
      frame();
    }
    expect(scene.strings.get(id)!.nodes[0]!.slackAfter).toBeCloseTo(0.2 * Math.exp(2), 9);

    for (let i = 0; i < 400 && ropes.awake > 0; i++) frame();
    const dropped = Math.max(...pointsOf(id).map(([, y], i) => y - before[i]![1]));
    expect(dropped).toBeGreaterThan(60);
  });

  /** The `1`-`9` presets, which are the one slack verb that sets rather than
   *  scales — and which therefore land every gap on the same value. */
  it("flattens the run to one value for a preset, and only for a preset", () => {
    const [a, b] = twoPins();
    const c = createPin(board, { parent: null, lx: 400, ly: 0 });
    const id = createString(board, { pins: [a, b, c], slack: [0.05, 0.4, 0.4] })!;
    frame();

    scaleStringSlack(board, [id], 2);
    frame();
    const scaled = scene.strings.get(id)!.nodes.map((n) => n.slackAfter);
    expect(scaled[0]).toBeCloseTo(0.1, 12);
    expect(scaled[1]).toBeCloseTo(0.8, 12);

    setStringSlack(board, [id], presetSlack(9));
    frame();
    const preset = scene.strings.get(id)!.nodes.map((n) => n.slackAfter);
    expect(preset[0]).toBeCloseTo(preset[1]!, 12);
    expect(preset[0]).toBeCloseTo(presetSlack(9), 12);
  });

  /**
   * Invariant 2 from the far end of the chain: no route the user has can put a
   * rest length at or below the chord, where "the solver has no slack to absorb
   * error and the rope jitters visibly" (DESIGN section 5.4).
   */
  it("cannot drive a gap to or below the minimum by any route", () => {
    const [a, b] = twoPins();
    const id = createString(board, { pins: [a, b], slack: 0.2 })!;
    frame();
    const gap = scene.strings.get(id)!.nodes[0]!.nodeId;

    setNodeSlack(board, id, gap, -5);
    setStringSlack(board, [id], 0);
    setNodeSlack(board, id, gap, Number.NaN);
    for (let i = 0; i < 50; i++) scaleNodeSlack(board, id, gap, 0.5);
    scaleStringSlack(board, [id], 1e-12);
    frame();

    for (const node of scene.strings.get(id)!.nodes) {
      expect(node.slackAfter).toBeGreaterThanOrEqual(MIN_SLACK);
      expect(Number.isFinite(node.slackAfter)).toBe(true);
    }
    for (const [x, y] of pointsOf(id)) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });
});
