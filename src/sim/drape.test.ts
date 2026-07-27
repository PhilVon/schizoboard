/**
 * Draping — what happens when a string and a photograph want the same piece of
 * board.
 *
 * > An `over` string cannot sag through an item. It rests on it. […] A rope
 * > crossing a photograph therefore comes to rest along the photograph's top
 * > edge instead of cutting through it, exactly as real string does.
 * > — DESIGN section 5.6
 *
 * The tests below are written against the rope's *settled* pose rather than
 * against any one frame, because that sentence is a statement about where a
 * string ends up. Each one settles the same rope twice — once with nothing in
 * the way and once with a photograph — and places the photograph relative to
 * the first, so the numbers asserted on are the simulation's own rather than
 * constants copied out of a run that happened to look right.
 *
 * ## Sleep is half the feature
 *
 * A rope that is asleep is not stepped, so it does not collide either — and a
 * rope on a board where nothing has happened is always asleep. Putting a
 * photograph under a settled string has to *wake* it or nothing happens at all,
 * which is T-139 and the last group below. The tests that are about resting
 * rather than about waking let the arriving photograph do the waking, because
 * that is what happens on a real board.
 *
 * The one place `ropes.wake` is still called by hand is the free-hanging
 * baseline, where there is no photograph to do it and the point is to settle
 * the rope through the same solver the draped runs go through.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { RopeSet } from "@/sim/ropes";
import { DirtySets } from "@/state/dirty";
import { Scene, type ItemPose } from "@/state/scene";

let scene: Scene;
let dirty: DirtySets;
let ropes: RopeSet;

/** One 60fps frame, which is two fixed steps. */
const FRAME = 1000 / 60;

/** The span the tests hang string across, and the slack they hang it with —
 *  the middle of DATA-MODEL's useful range rather than an end of the ladder. */
const LEFT = 0;
const RIGHT = 400;
const SLACK = 0.2;

/** The photograph, and the stretch of board it covers when it is upright. */
const PHOTO_W = 240;
const PHOTO_H = 200;
const PHOTO_LEFT = (LEFT + RIGHT) / 2 - PHOTO_W / 2;
const PHOTO_RIGHT = (LEFT + RIGHT) / 2 + PHOTO_W / 2;

/** How far a particle may be from where the geometry says it should be. The
 *  solver's residual stretch is a few tenths of a unit (`sim/tuning.ts`). */
const SLOP = 0.5;

beforeEach(() => {
  reset();
});

function reset(): void {
  scene = new Scene();
  dirty = new DirtySets();
  ropes = new RopeSet();
}

function pin(id: string, wx: number, wy: number, parent: string | null = null): void {
  scene.putPin({ id, parent, lx: wx, ly: wy, kind: "pushpin", color: "#c8352f", wx, wy });
}

function item(id: string, pose: Partial<ItemPose> = {}): void {
  scene.putItem(
    { id, type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x: 0, y: 0, rot: 0, w: PHOTO_W, h: PHOTO_H, ...pose },
  );
  dirty.item(id);
}

function span(id = "s1", layer = "over"): void {
  pin("p1", LEFT, 0);
  pin("p2", RIGHT, 0);
  ropes.setString(scene, dirty, id, ["p1", "p2"], [SLACK], false, "cotton", layer);
}

function frame(): void {
  ropes.step(scene, dirty, FRAME);
  dirty.clear();
}

/** Frames until nothing is awake, then the pose. A rope that never settles
 *  runs out the limit and the caller's assertion is the one that fails. */
function settle(id = "s1", limit = 3000): Array<[number, number]> {
  for (let i = 0; i < limit; i++) {
    frame();
    if (ropes.awake === 0) break;
  }
  return points(id);
}

function points(id: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const pool = ropes.positions;
  ropes.visit(id, (at, count) => {
    for (let i = 0; i < count; i++) out.push([pool[at + i * 2]!, pool[at + i * 2 + 1]!]);
  });
  return out;
}

/**
 * Which of a rope's particles are lying on something — the lift shadow's
 * input (T-66), in the same order `points` reports.
 */
function lifts(id: string): boolean[] {
  const out: boolean[] = [];
  const flags = ropes.lifted;
  ropes.visit(id, (at, count) => {
    for (let i = 0; i < count; i++) out.push(flags[at / 2 + i] === 1);
  });
  return out;
}

/** The lowest a rope hangs. Board y grows downward, so this is the maximum. */
function lowest(pose: Array<[number, number]>): number {
  return Math.max(...pose.map(([, y]) => y));
}

/**
 * How far the same rope hangs with nothing in its way — settled, not seeded, so
 * it is comparable with the draped runs particle for particle. Every test
 * places its photograph relative to this rather than to a guessed constant, and
 * leaves a clean board behind.
 */
function freeSag(): number {
  span();
  ropes.wake("s1");
  const free = lowest(settle());
  reset();
  return free;
}

/** A photograph whose top edge is `top`, upright and centred on the span. */
function photoWithTopAt(top: number, id = "photo"): void {
  item(id, { x: (LEFT + RIGHT) / 2, y: top + PHOTO_H / 2 });
}

/**
 * A string hung across the span and left to settle, with the board's items
 * indexed — which is the state every one of these tests starts a photograph
 * arriving into.
 *
 * Settling first is not ceremony. A photograph landing on the very first frame
 * a board is stepped lands while the item index is still being built from
 * scratch, and a rebuild reports no *movement* because on the frame a board
 * loads there has not been any. So the first frame is spent being a board.
 */
function settledSpan(id = "s1", layer = "over"): void {
  span(id, layer);
  ropes.wake(id);
  settle(id);
}

describe("a rope crossing a photograph", () => {
  /** AC-81. */
  it("rests on its top edge instead of cutting through", () => {
    const free = freeSag();
    // Top edge halfway down the free sag, so the rope wants to be well inside
    // the paper and cannot be.
    const top = free / 2;
    settledSpan();
    photoWithTopAt(top);
    const pose = settle();

    // Across the middle of the paper, the rope is *on* the top edge — not
    // through it and not hovering above it.
    const middle = pose.filter(([x]) => x > PHOTO_LEFT + 20 && x < PHOTO_RIGHT - 20);
    expect(middle.length).toBeGreaterThan(4);
    for (const [, y] of middle) expect(y).toBeCloseTo(top, 1);
  });

  /** The invariant behind the sentence: no part of the string is inside the
   *  paper, anywhere, including around the corners. */
  it("puts no part of itself inside the paper", () => {
    const free = freeSag();
    const top = free / 2;
    settledSpan();
    photoWithTopAt(top);

    for (const [x, y] of settle()) {
      const inside =
        x > PHOTO_LEFT + SLOP &&
        x < PHOTO_RIGHT - SLOP &&
        y > top + SLOP &&
        y < top + PHOTO_H - SLOP;
      expect(inside).toBe(false);
    }
  });

  /** The other half of it: it must still be a rope. The parts beyond the paper
   *  hang past the edge rather than being flattened along it. */
  it("still hangs either side of what it is resting on", () => {
    const free = freeSag();
    const top = free / 2;
    settledSpan();
    photoWithTopAt(top);
    const pose = settle();

    const beyond = pose.filter(([x]) => x < PHOTO_LEFT || x > PHOTO_RIGHT).map(([, y]) => y);
    expect(Math.max(...beyond)).toBeGreaterThan(top + 5);
  });

  /**
   * > `under` strings — string that a photograph was later pinned over — skip
   * > collision entirely and draw beneath the item layer. — DESIGN section 5.6
   */
  it("passes straight through it when the string is tucked behind", () => {
    const free = freeSag();
    settledSpan("s1", "under");
    photoWithTopAt(free / 2);
    ropes.wake("s1");
    expect(Math.abs(lowest(settle()) - free)).toBeLessThan(SLOP);
  });

  /** A rope with nothing near it must hang exactly where it always did — the
   *  guard against draping quietly changing every string on the board. */
  it("hangs where it always did when there is nothing in the way", () => {
    const free = freeSag();
    settledSpan();
    item("elsewhere", { x: 3000, y: 3000 });
    ropes.wake("s1");
    expect(Math.abs(lowest(settle()) - free)).toBeLessThan(SLOP);
  });

  /**
   * The push-out works in the item's own frame, so a turned photograph holds
   * the string off along the edge it actually has — not along the corners of an
   * upright box drawn round it.
   */
  it("rests on the edge of a photograph that has been turned", () => {
    const free = freeSag();
    const top = free / 2;
    settledSpan();
    // A quarter turn: 240 x 200 becomes 200 wide by 240 tall, so the paper now
    // reaches from 100 to 300 rather than from 80 to 320.
    item("photo", { x: (LEFT + RIGHT) / 2, y: top + PHOTO_W / 2, rot: Math.PI / 2 });
    const pose = settle();

    const middle = pose.filter(([x]) => x > 120 && x < 280);
    expect(middle.length).toBeGreaterThan(4);
    for (const [, y] of middle) expect(y).toBeCloseTo(top, 1);

    // And where the upright box would have reached but the turned paper does
    // not — between 80 and 100 — the rope is free to hang below the edge.
    const corner = pose.filter(([x]) => x > 80 && x < 100).map(([, y]) => y);
    if (corner.length > 0) expect(Math.max(...corner)).toBeGreaterThan(top);
  });

  /**
   * A rope that never stops moving never sleeps, and a hundred of those is the
   * whole frame budget (DESIGN section 5.3). Resting on something has to rest.
   */
  it("goes to sleep resting on it", () => {
    const free = freeSag();
    settledSpan();
    photoWithTopAt(free / 2);

    let frames = 0;
    for (; frames < 3000; frames++) {
      frame();
      if (ropes.awake === 0) break;
    }
    expect(ropes.awake).toBe(0);
  });
});

/**
 * A parented pin's world position is derived from its item's pose, so the pin
 * is inside that item's silhouette by construction. If the item were an
 * obstacle to its own string, every string on the board would kink hard around
 * a photograph's edge the moment it left its own pin.
 */
describe("the photograph a string is pinned to", () => {
  it("is not something that string drapes over", () => {
    // A wide photograph with the left pin pushed well inside it.
    item("photo", { x: 0, y: 0, w: 400, h: 300 });
    pin("p1", 0, 0, "photo");
    pin("p2", 600, 0);
    ropes.setString(scene, dirty, "s1", ["p1", "p2"], [SLACK], false, "cotton", "over");
    ropes.wake("s1");
    const pose = settle();

    // The particle next to the pin is still next to the pin — on the paper,
    // where the pin is, rather than flung to the edge of it. One particle
    // spacing is about 12 units (`ROPE_SPACING`).
    const [, second] = pose;
    expect(Math.hypot(second![0], second![1])).toBeLessThan(30);
  });

  it("is still an obstacle to somebody else's string", () => {
    const free = freeSag();
    const top = free / 2;
    photoWithTopAt(top);
    // A pin on the photograph holding a string that goes nowhere near ours.
    pin("mine", (LEFT + RIGHT) / 2, top + PHOTO_H / 2, "photo");
    pin("far", 1200, 600);
    ropes.setString(scene, dirty, "other", ["mine", "far"], [0.1], false, "cotton", "over");
    span();
    ropes.wake("s1");
    const pose = settle();

    const middle = pose.filter(([x]) => x > PHOTO_LEFT + 20 && x < PHOTO_RIGHT - 20);
    expect(middle.length).toBeGreaterThan(4);
    for (const [, y] of middle) expect(y).toBeCloseTo(top, 1);
  });
});

/**
 * T-66's input. The renderer draws a wider, fainter shadow along the stretches
 * of string that are held off the cork by the paper under them, and this is
 * where it is told which stretches those are.
 *
 * Produced by the collision pass because "is this particle on a photograph" is
 * the test that pass is already doing — so what is worth pinning here is that
 * the flag follows the *lying on*, which is not the same thing as the pushing
 * out: a string tied to a photograph is lying on it and is never pushed off it.
 */
describe("which part of a string is lying on something", () => {
  it("marks the stretch resting on the paper and nothing else", () => {
    const free = freeSag();
    const top = free / 2;
    settledSpan();
    photoWithTopAt(top);
    const pose = settle();
    const flags = lifts("s1");

    for (let i = 0; i < pose.length; i++) {
      const [x] = pose[i]!;
      // Well inside the paper's span it is resting; well outside, on bare cork.
      if (x > PHOTO_LEFT + 20 && x < PHOTO_RIGHT - 20) expect(flags[i]).toBe(true);
      if (x < PHOTO_LEFT - 20 || x > PHOTO_RIGHT + 20) expect(flags[i]).toBe(false);
    }
  });

  /** The item a string is pinned to is not an obstacle to it, but the string
   *  is still lying on it — the commonest way a string is on a photograph at
   *  all, and the one a flag driven off the push-out would miss. */
  it("marks a string lying on the photograph it is pinned to", () => {
    item("photo", { x: 0, y: 0, w: 400, h: 300 });
    pin("p1", 0, 0, "photo");
    pin("p2", 600, 0);
    ropes.setString(scene, dirty, "s1", ["p1", "p2"], [SLACK], false, "cotton", "over");
    ropes.wake("s1");
    const pose = settle();
    const flags = lifts("s1");

    // The pin is in the middle of the paper, so the string leaves it lying on
    // the paper and is off it well before x = 600.
    expect(flags[0]).toBe(true);
    expect(flags[1]).toBe(true);
    expect(flags[flags.length - 1]).toBe(false);
    // Nothing outside the paper is marked.
    for (let i = 0; i < pose.length; i++) {
      if (pose[i]![0]! > 220) expect(flags[i]).toBe(false);
    }
  });

  it("stops marking anything once the photograph is taken away", () => {
    const free = freeSag();
    settledSpan();
    item("photo", { x: 3000, y: 3000 });
    settle();
    scene.setPose("photo", { x: (LEFT + RIGHT) / 2, y: free / 2 + PHOTO_H / 2 });
    dirty.item("photo");
    settle();
    expect(lifts("s1").some(Boolean)).toBe(true);

    scene.setPose("photo", { x: 3000, y: 3000 });
    dirty.item("photo");
    settle();
    expect(lifts("s1").some(Boolean)).toBe(false);
  });

  /** An `under` string passes behind items, so it is never on one. */
  it("marks nothing on a string that is tucked behind", () => {
    const free = freeSag();
    settledSpan("s1", "under");
    photoWithTopAt(free / 2);
    ropes.wake("s1");
    settle();
    expect(lifts("s1").some(Boolean)).toBe(false);
  });

  /**
   * A rope put back on its analytic rest pose knows nothing about what is in
   * the way — the seed is pure catenary. Left set, the flags would open a
   * reloaded board with a shadow lifted onto nothing, along a rope that is no
   * longer where it was resting.
   */
  it("forgets what it was resting on when the rope is re-seeded", () => {
    const free = freeSag();
    settledSpan();
    photoWithTopAt(free / 2);
    settle();
    expect(lifts("s1").some(Boolean)).toBe(true);

    // A topology change rebuilds the segments and re-seeds them, which is the
    // same path a load takes.
    pin("p3", RIGHT, 200);
    ropes.setString(scene, dirty, "s1", ["p1", "p2", "p3"], [SLACK, SLACK], false, "cotton", "over");
    expect(lifts("s1").length).toBeGreaterThan(0);
    expect(lifts("s1").some(Boolean)).toBe(false);
  });
});

/**
 * T-139. Everything above is about where an awake rope comes to rest, and a
 * rope on a board where nothing has happened is not awake — so all of it is
 * dead code unless a moving photograph is an event the simulation hears about.
 *
 * The pin index cannot answer this. It turns *a pin moved* into the one or two
 * segments tied to it, and the photograph somebody is dragging across a string
 * is, in the ordinary case, nothing to do with that string's pins at all.
 */
describe("a photograph moving under a string", () => {
  /** Where the photograph is parked when it is meant to be out of the way. */
  const AWAY = 3000;

  function photoParkedAway(): void {
    item("photo", { x: AWAY, y: AWAY });
    settle();
  }

  function dragPhotoTo(x: number, y: number): void {
    scene.setPose("photo", { x, y });
    dirty.item("photo");
  }

  it("wakes the string, so the string ends up resting on it", () => {
    const free = freeSag();
    const top = free / 2;
    settledSpan();
    photoParkedAway();
    expect(ropes.awake).toBe(0);

    dragPhotoTo((LEFT + RIGHT) / 2, top + PHOTO_H / 2);
    const pose = settle();

    const middle = pose.filter(([x]) => x > PHOTO_LEFT + 20 && x < PHOTO_RIGHT - 20);
    expect(middle.length).toBeGreaterThan(4);
    for (const [, y] of middle) expect(y).toBeCloseTo(top, 1);
  });

  /**
   * The other direction, and the one a "wake what the item now overlaps" rule
   * would get wrong: by the time the drag is over, the photograph is nowhere
   * near the string it was holding up. It is the *swept* rectangle that has to
   * wake it.
   */
  it("lets the string fall back to its own sag when it is taken away", () => {
    const free = freeSag();
    const top = free / 2;
    settledSpan();
    photoParkedAway();
    dragPhotoTo((LEFT + RIGHT) / 2, top + PHOTO_H / 2);
    settle();
    expect(lowest(points("s1"))).toBeLessThan(free - 5);

    dragPhotoTo(AWAY, AWAY);
    expect(Math.abs(lowest(settle()) - free)).toBeLessThan(SLOP);
  });

  it("wakes the string when the photograph it is resting on is deleted", () => {
    const free = freeSag();
    settledSpan();
    photoParkedAway();
    dragPhotoTo((LEFT + RIGHT) / 2, free / 2 + PHOTO_H / 2);
    settle();

    scene.removeItem("photo");
    dirty.item("photo");
    expect(Math.abs(lowest(settle()) - free)).toBeLessThan(SLOP);
  });

  /** AC: a frame in which no item moved wakes nothing. This is the whole of
   *  why five hundred sleeping strings cost nothing (DESIGN section 5.3). */
  it("wakes nothing on a frame where no item moved", () => {
    const free = freeSag();
    settledSpan();
    photoParkedAway();
    dragPhotoTo((LEFT + RIGHT) / 2, free / 2 + PHOTO_H / 2);
    settle();
    expect(ropes.awake).toBe(0);

    ropes.step(scene, dirty, FRAME);
    expect(ropes.awake).toBe(0);
    // Not stepped, not marked dirty, not even asked — AC-65's standard.
    expect(dirty.ropes.size).toBe(0);
  });

  /** An `under` string passes behind items, so an item moving over it is not
   *  news. Waking it would be a rope stepped for nothing, every frame of every
   *  drag, on the layer that exists precisely so string can be ignored. */
  it("does not wake a string that is tucked behind", () => {
    const free = freeSag();
    settledSpan("s1", "under");
    photoParkedAway();
    dragPhotoTo((LEFT + RIGHT) / 2, free / 2 + PHOTO_H / 2);

    ropes.step(scene, dirty, FRAME);
    expect(ropes.awake).toBe(0);
  });
});
