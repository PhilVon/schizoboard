/**
 * How far a settled rope hangs below the pose it is *seeded* at, as a function
 * of how many particles it is carrying.
 *
 * `golden.test.ts` already asks whether a disturbed rope comes back to the
 * catenary, and bounds it at a part in a hundred and fifty. This asks the same
 * question along the axis that turned out to drive the answer, which that
 * table does not cover: its longest case is a 400-unit span at 41 particles,
 * and the error there is a part in four hundred — comfortably inside the bound
 * and four times better than a rope twice as long.
 *
 * ## Why the seeded pose is the thing to measure against (T-147)
 *
 * Because it is the pose the application will snap to. `world.endGesture`
 * notifies its rasterize listeners past a 1.25x scale change, `main.ts`
 * answers with `dirty.everything()`, and `RopeSet.step` reads `dirty.all` and
 * re-seeds every segment onto its analytic catenary. So a gap between where a
 * rope *settles* and where it would be *seeded* is not academic: it is a
 * string that visibly jumps when somebody zooms out, having sat in the wrong
 * pose since the last time an item moved. That is what T-147 was, and it was
 * measured at about a part in twenty-six on a real board.
 *
 * The comparison is deliberately against a re-seed rather than against
 * `catenary.ts` directly, so that it measures the jump a person actually sees
 * rather than a quantity only this file knows about.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { RopeSet } from "@/sim/ropes";
import { DirtySets } from "@/state/dirty";
import { Scene } from "@/state/scene";

let scene: Scene;
let dirty: DirtySets;
let ropes: RopeSet;

const FRAME = 1000 / 60;
const SLACK = 0.2;

function pin(id: string, x: number, y: number): void {
  scene.putPin({ id, parent: null, lx: x, ly: y, kind: "pushpin", color: "#c8352f", wx: x, wy: y });
}

function movePin(id: string, x: number, y: number): void {
  const p = scene.pins.get(id)!;
  p.lx = x;
  p.ly = y;
  p.wx = x;
  p.wy = y;
  dirty.pin(id);
}

/**
 * The string goes into the scene mirror as well as the rope set, because the
 * re-seed below runs through `dirty.all`, and that path starts by dropping
 * every rope whose string the mirror does not have.
 */
function install(span: number): void {
  pin("p1", 0, 0);
  pin("p2", span, 0);
  scene.putString({
    id: "s",
    nodes: [
      { nodeId: "n0", pin: "p1", slackAfter: SLACK },
      { nodeId: "n1", pin: "p2", slackAfter: SLACK },
    ],
    color: "#d8a32c",
    thickness: 3,
    material: "string",
    layer: "over",
    closed: false,
  });
  ropes.setString(scene, dirty, "s", ["p1", "p2"], [SLACK, SLACK], false);
}

function settle(limit = 6000): number {
  for (let i = 0; i < limit; i++) {
    ropes.step(scene, dirty, FRAME);
    dirty.clear();
    if (ropes.awake === 0) return i + 1;
  }
  return limit;
}

/** The lowest point of the drawn polyline — the sag a person actually sees. */
function deepest(): number {
  let low = -Infinity;
  const pool = ropes.positions;
  ropes.visit("s", (at, count) => {
    for (let i = 0; i < count; i++) low = Math.max(low, pool[at + i * 2 + 1]!);
  });
  return low;
}

function particles(): number {
  let n = 0;
  ropes.visit("s", (_at, count) => {
    n += count;
  });
  return n;
}

/** What a re-raster or a reload does to every rope on the board. */
function reseed(): void {
  dirty.everything();
  ropes.step(scene, dirty, FRAME);
  dirty.clear();
}

beforeEach(() => {
  scene = new Scene();
  dirty = new DirtySets();
  ropes = new RopeSet();
});

/**
 * A part in three hundred of the chord.
 *
 * Set from what a person can see rather than from what the solver happens to
 * manage: the worst case here is a thousand-unit span, and a part in three
 * hundred of that is three board units — one and a third screen pixels at
 * 100% zoom, and well under one at the 44% a whole board is read at. A string
 * that moves by less than a pixel when the camera re-rasters has not visibly
 * moved.
 *
 * Before T-147 the same rope was out by thirteen and a half units, a part in
 * seventy-four.
 */
const BOUND = 1 / 300;

describe("a settled rope sits where a seeded one would, whatever it is carrying", () => {
  /**
   * Built at one span and then moved to another, because that is the case the
   * application actually produces — an item is dragged, the chord changes, and
   * the segment keeps the particle count it was seeded with. A rope seeded
   * long and then shortened is the worst of these by a wide margin: it carries
   * the most particles over the shortest span, and the tension a link has to
   * hold grows with the number of them hanging below it.
   */
  const CASES = [
    { name: "a short span, undisturbed", built: 220, span: 220 },
    { name: "a short span, moved", built: 220, span: 300 },
    { name: "the longest span golden.test.ts covers", built: 400, span: 400 },
    { name: "half as long again", built: 600, span: 600 },
    { name: "a span the width of a board", built: 1000, span: 1000 },
    { name: "the same, moved", built: 1000, span: 1020 },
    { name: "stretched to twice what it was seeded at", built: 500, span: 1020 },
    { name: "shortened to two thirds of what it was seeded at", built: 1500, span: 1020 },
  ];

  it.each(CASES)("$name", (c) => {
    expect(gap(c)).toBeLessThan(BOUND);
  });
});

/**
 * Settle the rope, then measure how far it sits below where a re-seed would
 * put it, as a fraction of the span.
 */
function gap(c: { built: number; span: number }): number {
  install(c.built);
  settle();
  if (c.span !== c.built) {
    movePin("p2", c.span, 0);
    settle();
  } else {
    ropes.wake("s");
    settle();
  }

  const settled = deepest();
  expect(particles()).toBeGreaterThan(2);
  reseed();
  const seeded = deepest();

  // Below, never above: gravity stretches a rope and never compresses one, so
  // a rope resting *higher* than its seed would mean the solver had overshot,
  // which is a different bug wearing the same number.
  expect(settled).toBeGreaterThan(seeded - 1);
  return (settled - seeded) / c.span;
}
