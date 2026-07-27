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
 * ## Why every test wakes the rope by hand
 *
 * A rope that is asleep is not stepped, so it does not collide either — and a
 * rope on a board where nothing has happened is always asleep. Putting a
 * photograph under a settled string therefore changes nothing at all until
 * something wakes the string, and nothing yet does: waking on a *disturbed
 * item* is T-139. Until it lands, `ropes.wake` stands in for it here, and these
 * tests are about where an awake rope comes to rest rather than about what
 * wakes it.
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

describe("a rope crossing a photograph", () => {
  /** AC-81. */
  it("rests on its top edge instead of cutting through", () => {
    const free = freeSag();
    // Top edge halfway down the free sag, so the rope wants to be well inside
    // the paper and cannot be.
    const top = free / 2;
    span();
    photoWithTopAt(top);
    ropes.wake("s1");
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
    span();
    photoWithTopAt(top);
    ropes.wake("s1");

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
    span();
    photoWithTopAt(top);
    ropes.wake("s1");
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
    span("s1", "under");
    photoWithTopAt(free / 2);
    ropes.wake("s1");
    expect(lowest(settle())).toBeCloseTo(free, 1);
  });

  /** A rope with nothing near it must hang exactly where it always did — the
   *  guard against draping quietly changing every string on the board. */
  it("hangs where it always did when there is nothing in the way", () => {
    const free = freeSag();
    span();
    item("elsewhere", { x: 3000, y: 3000 });
    ropes.wake("s1");
    expect(lowest(settle())).toBeCloseTo(free, 1);
  });

  /**
   * The push-out works in the item's own frame, so a turned photograph holds
   * the string off along the edge it actually has — not along the corners of an
   * upright box drawn round it.
   */
  it("rests on the edge of a photograph that has been turned", () => {
    const free = freeSag();
    const top = free / 2;
    span();
    // A quarter turn: 240 x 200 becomes 200 wide by 240 tall, so the paper now
    // reaches from 100 to 300 rather than from 80 to 320.
    item("photo", { x: (LEFT + RIGHT) / 2, y: top + PHOTO_W / 2, rot: Math.PI / 2 });
    ropes.wake("s1");
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
    span();
    photoWithTopAt(free / 2);
    ropes.wake("s1");

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
