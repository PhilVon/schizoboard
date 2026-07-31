/**
 * The rope set: what exists, what is awake, and what it costs when nothing is.
 *
 * AC-64 is the sleep rule and AC-65 is what sleeping buys, and the second is
 * the one worth being strict about — "zero simulation" has to mean a sleeping
 * rope is not stepped, not marked dirty, and not even *asked* whether it
 * should wake. So several tests below assert on `dirty.ropes` being empty
 * rather than on positions, because an empty dirty set is what lets
 * `render/ropes/` keep the Path2D it already baked.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { RopeSet } from "@/sim/ropes";
import { MAX_AWAKE_PARTICLES, ROPE_SLEEP_STEPS, SIM_STEP_MS } from "@/sim/tuning";
import { DirtySets } from "@/state/dirty";
import { Scene, type Bounds, type ItemPose } from "@/state/scene";

let scene: Scene;
let dirty: DirtySets;
let ropes: RopeSet;

/** One 60fps frame, which is two fixed steps. */
const FRAME = 1000 / 60;

function pin(id: string, wx: number, wy: number, parent: string | null = null): void {
  scene.putPin({ id, parent, lx: wx, ly: wy, kind: "pushpin", color: "#c8352f", wx, wy });
}

function item(id: string, pose: Partial<ItemPose> = {}): void {
  scene.putItem(
    { id, type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x: 0, y: 0, rot: 0, w: 240, h: 200, ...pose },
  );
}

/** A two-pin string with the given slack. */
function string(id: string, slack = 0.2): void {
  ropes.setString(scene, dirty, id, ["p1", "p2"], [slack]);
}

/**
 * A run put into the scene and marked dirty, which is how the *binding* hands
 * a string over — `setString` is what `sync` decides to call, not the route in.
 * Tests that turn on a node's pin coming or going have to come this way, since
 * that is a question `sync` answers and `setString` is only told the answer to.
 */
function run(id: string, pins: readonly string[], slack: readonly number[], closed = false): void {
  scene.putString({
    id,
    nodes: pins.map((pin, i) => ({ nodeId: `${id}-${i}`, pin, slackAfter: slack[i] ?? 0.2 })),
    color: "#c8352f",
    thickness: 2,
    material: "cotton",
    layer: "over",
    closed,
  });
  dirty.string(id);
}

/** How far the lowest particle of a string hangs — sag, measured. */
function lowest(id: string): number {
  let y = -Infinity;
  for (const [, py] of points(id)) if (py > y) y = py;
  return y;
}

function frame(n = 1): void {
  for (let i = 0; i < n; i++) {
    ropes.step(scene, dirty, FRAME);
    dirty.clear();
  }
}

/** Run frames until nothing is awake, and report how many it took. */
function untilAsleep(limit = 2000): number {
  for (let i = 0; i < limit; i++) {
    frame();
    if (ropes.awake === 0) return i + 1;
  }
  return limit;
}

function points(id: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const pool = ropes.positions;
  ropes.visit(id, (at, count) => {
    for (let i = 0; i < count; i++) out.push([pool[at + i * 2], pool[at + i * 2 + 1]]);
  });
  return out;
}

const box: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

beforeEach(() => {
  scene = new Scene();
  dirty = new DirtySets();
  ropes = new RopeSet();
  pin("p1", 0, 0);
  pin("p2", 200, 0);
});

describe("building a string", () => {
  it("makes one rope per gap between pins", () => {
    pin("p3", 400, 0);
    ropes.setString(scene, dirty, "s1", ["p1", "p2", "p3"], [0.2, 0.2]);
    let segments = 0;
    ropes.visit("s1", () => segments++);
    expect(segments).toBe(2);
    expect(ropes.size).toBe(2);
  });

  /** > closed: Loops the last node back to the first. — DATA-MODEL section 5 */
  it("closes the loop with one more rope than an open run has", () => {
    pin("p3", 200, 200);
    ropes.setString(scene, dirty, "s1", ["p1", "p2", "p3"], [0.2, 0.2, 0.2], true);
    let segments = 0;
    ropes.visit("s1", () => segments++);
    expect(segments).toBe(3);
  });

  it("holds nothing for a string with fewer than two nodes", () => {
    ropes.setString(scene, dirty, "s1", ["p1"], []);
    expect(ropes.size).toBe(0);
    expect(ropes.boundsOf("s1", box)).toBeNull();
  });

  it("replaces a string's ropes rather than accumulating them", () => {
    pin("p3", 400, 0);
    string("s1");
    ropes.setString(scene, dirty, "s1", ["p1", "p2", "p3"], [0.2, 0.2]);
    ropes.setString(scene, dirty, "s1", ["p1", "p2"], [0.2]);
    expect(ropes.size).toBe(1);
  });

  it("takes its ropes with it when the string goes", () => {
    string("s1");
    ropes.removeString(dirty, "s1");
    expect(ropes.size).toBe(0);
    let segments = 0;
    ropes.visit("s1", () => segments++);
    expect(segments).toBe(0);
  });

  it("spaces particles at roughly the design figure", () => {
    string("s1", 0.2);
    const pts = points("s1");
    // Rest length is 240 board units at 12 apart, so around 21 particles.
    expect(pts.length).toBeGreaterThan(15);
    expect(pts.length).toBeLessThan(28);
  });
});

describe("a string that has just been made", () => {
  /** AC-62 again, one layer up: seeded at rest, and asleep on the frame it
   *  was created, so a board full of them opens perfectly still. */
  it("is asleep before it has ever been stepped", () => {
    string("s1");
    expect(ropes.awake).toBe(0);
  });

  it("hangs where the catenary says, not along the chord", () => {
    string("s1", 0.3);
    const bounds = ropes.boundsOf("s1", box)!;
    // Both pins are at y=0 and the string has 30% slack, so it must sag well
    // below them and not at all above.
    expect(bounds.maxY).toBeGreaterThan(30);
    expect(bounds.minY).toBeCloseTo(0, 6);
    expect(bounds.minX).toBeCloseTo(0, 6);
    expect(bounds.maxX).toBeCloseTo(200, 6);
  });

  it("starts and ends exactly on its pins", () => {
    string("s1");
    const pts = points("s1");
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([200, 0]);
  });

  it("stays asleep through a frame in which nothing moved", () => {
    string("s1");
    frame(5);
    expect(ropes.awake).toBe(0);
    ropes.step(scene, dirty, FRAME);
    expect(dirty.ropes.size).toBe(0);
  });
});

/**
 * The viewport gate and the particle cap — DESIGN section 9.2 (T-223).
 *
 * > A rope simulates only if its bounds, expanded by maximum sag, intersect the
 * > viewport margin; otherwise it force-sleeps at its cached pose. A global cap
 * > on awake particles, prioritised by on-screen area, means a pathological
 * > board degrades gracefully instead of dropping frames.
 *
 * Every other test in this file passes no view, which is the contract for
 * "simulate everything" — so the whole of the gate lives in here, and the fact
 * that the rest of the suite is untouched by it is the point rather than an
 * omission.
 */
describe("the viewport gate", () => {
  /** A rectangle around the pins the tests start with, and one far away. */
  const NEAR: Bounds = { minX: -500, minY: -500, maxX: 700, maxY: 500 };
  const FAR: Bounds = { minX: 40_000, minY: 40_000, maxX: 41_000, maxY: 41_000 };

  function seen(view: Bounds | null, n = 1): void {
    for (let i = 0; i < n; i++) {
      ropes.step(scene, dirty, FRAME, view);
      dirty.clear();
    }
  }

  /** Shove a free pin and mark it, which is what wakes the ropes on it. */
  function shove(id: string, dx: number, dy = 0): void {
    const p = scene.pins.get(id)!;
    p.lx += dx;
    p.ly += dy;
    dirty.pin(id);
  }

  it("force-sleeps a rope whose bounds are nowhere near the camera", () => {
    string("s1");
    shove("p1", -40);
    seen(FAR);
    expect(ropes.awake).toBe(0);
  });

  it("steps that same rope when the camera can see it", () => {
    string("s1");
    shove("p1", -40);
    seen(NEAR);
    expect(ropes.awake).toBe(1);
  });

  it("leaves an off-screen rope's pose exactly where it was", () => {
    string("s1");
    const before = points("s1");
    shove("p1", -40);
    seen(FAR, 5);
    expect(points("s1")).toEqual(before);
  });

  /**
   * The exposure section 9.2 exists for, and the one the sleep manager cannot
   * cover: something keeps disturbing an off-screen rope, so it keeps being
   * woken, so it never gets to sleep on its own. Sixty frames of that must
   * still cost nothing.
   */
  it("costs nothing when something off screen keeps disturbing it", () => {
    string("s1");
    for (let i = 0; i < 60; i++) {
      shove("p1", i % 2 === 0 ? -1 : 1);
      ropes.step(scene, dirty, FRAME, FAR);
      expect(ropes.awake).toBe(0);
      dirty.clear();
    }
  });

  /**
   * The correctness half. A gated rope's pins can move a long way while nobody
   * is watching, and resuming from the cached pose would haul the particles
   * after them — a whip, not a string. Coming back it must be at rest under the
   * pins as they stand *now*.
   */
  it("puts a returning rope at rest under the pins it has now", () => {
    string("s1");
    // Off screen, and then dragged a thousand units down while off screen.
    shove("p1", 0, 1000);
    shove("p2", 0, 1000);
    seen(FAR, 10);
    // Still where it was built, because nothing stepped it.
    expect(lowest("s1")).toBeLessThan(200);

    const back: Bounds = { minX: -500, minY: 500, maxX: 700, maxY: 2000 };
    seen(back);

    const pts = points("s1");
    expect(pts[0]).toEqual([0, 1000]);
    expect(pts[pts.length - 1]).toEqual([200, 1000]);
    // At rest, not mid-flight: a seeded rope is asleep on the frame it lands.
    expect(ropes.awake).toBe(0);
  });

  it("marks a returning rope dirty so the painter re-bakes it", () => {
    string("s1");
    shove("p1", 0, 1000);
    shove("p2", 0, 1000);
    seen(FAR, 3);
    ropes.step(scene, dirty, FRAME, { minX: -500, minY: 500, maxX: 700, maxY: 2000 });
    expect(dirty.ropes.has("s1")).toBe(true);
  });

  /** A rope that settled on screen and then left it is not re-seeded on the way
   *  back, because it never went anywhere: the two poses are the same one. */
  it("brings a rope that was already asleep back unchanged", () => {
    string("s1");
    shove("p1", -40);
    seen(NEAR, 400);
    expect(ropes.awake).toBe(0);
    const settled = points("s1");
    seen(FAR, 5);
    seen(NEAR, 5);
    for (const [i, [x, y]] of points("s1").entries()) {
      expect(x).toBeCloseTo(settled[i]![0]!, 6);
      expect(y).toBeCloseTo(settled[i]![1]!, 6);
    }
  });

  it("gates nothing at all when there is no camera to gate by", () => {
    string("s1");
    shove("p1", -40);
    seen(null);
    expect(ropes.awake).toBe(1);
  });
});

describe("the awake particle cap", () => {
  /** A rope long enough to be a real fraction of the budget on its own:
   *  `span` across, so `span * 1.2 / ROPE_SPACING` particles. */
  function longString(id: string, y: number, span = 6000): void {
    pin(`${id}-a`, 0, y);
    pin(`${id}-b`, span, y);
    ropes.setString(scene, dirty, id, [`${id}-a`, `${id}-b`], [0.2]);
    const p = scene.pins.get(`${id}-a`)!;
    p.lx -= 1;
    dirty.pin(`${id}-a`);
  }

  function countOf(id: string): number {
    let n = 0;
    ropes.visit(id, (_at, count) => (n += count));
    return n;
  }

  it("counts particles rather than ropes, which is what the budget is in", () => {
    string("s1");
    expect(ropes.awakeParticles).toBe(0);
    const p1 = scene.pins.get("p1")!;
    p1.lx = -40;
    dirty.pin("p1");
    ropes.step(scene, dirty, FRAME);
    expect(ropes.awake).toBe(1);
    expect(ropes.awakeParticles).toBe(countOf("s1"));
  });

  /**
   * Four ropes over the budget, and the view clips the last one so it is the
   * least on screen. Three fit; the fourth is the one that loses.
   */
  it("steps the most visible ropes and defers the rest", () => {
    for (const [i, id] of ["a", "b", "c", "d"].entries()) longString(id, i * 1000);
    const each = countOf("a");
    expect(each * 4).toBeGreaterThan(MAX_AWAKE_PARTICLES);
    expect(each * 3).toBeLessThanOrEqual(MAX_AWAKE_PARTICLES);

    // Wide enough for all four to meet it, high enough that "d" is clipped to
    // a sliver while the other three sit inside it whole.
    const view: Bounds = { minX: -1000, minY: -1000, maxX: 7000, maxY: 3100 };
    const before = new Map(["a", "b", "c", "d"].map((id) => [id, lowest(id)]));
    ropes.step(scene, dirty, FRAME, view);

    for (const id of ["a", "b", "c"]) {
      expect(lowest(id)).not.toBe(before.get(id));
    }
    expect(lowest("d")).toBe(before.get("d"));
  });

  /** A deferral, not a decision: the loser keeps its pose and keeps its place
   *  in the queue, so it is still awake and still owed a step. */
  it("leaves the deferred rope awake rather than sleeping it", () => {
    for (const [i, id] of ["a", "b", "c", "d"].entries()) longString(id, i * 1000);
    ropes.step(scene, dirty, FRAME, { minX: -1000, minY: -1000, maxX: 7000, maxY: 3100 });
    expect(ropes.awake).toBe(4);
  });

  /** Move the camera onto the one that lost, and it is the one that wins. */
  it("re-decides from where the camera is now", () => {
    for (const [i, id] of ["a", "b", "c", "d"].entries()) longString(id, i * 1000);
    const before = lowest("a");
    ropes.step(scene, dirty, FRAME, { minX: -1000, minY: 900, maxX: 7000, maxY: 5000 });
    expect(lowest("a")).toBe(before);
  });

  /** One rope bigger than the whole budget still moves. Freezing a string for
   *  the life of the board is a worse failure than one slow frame. */
  it("steps a single rope that is larger than the entire budget", () => {
    longString("huge", 0, MAX_AWAKE_PARTICLES * 12);
    expect(countOf("huge")).toBeGreaterThan(MAX_AWAKE_PARTICLES);
    const before = lowest("huge");
    ropes.step(scene, dirty, FRAME, { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 });
    expect(lowest("huge")).not.toBe(before);
  });

  it("does not cap when there is no camera to prioritise by", () => {
    for (const [i, id] of ["a", "b", "c", "d"].entries()) longString(id, i * 1000);
    const before = lowest("d");
    ropes.step(scene, dirty, FRAME);
    expect(lowest("d")).not.toBe(before);
  });
});

describe("waking", () => {
  it("wakes the ropes on a pin that moved, and only those", () => {
    pin("p3", 400, 0);
    pin("p4", 600, 0);
    ropes.setString(scene, dirty, "s1", ["p1", "p2"], [0.2]);
    ropes.setString(scene, dirty, "s2", ["p3", "p4"], [0.2]);
    dirty.clear();

    const p1 = scene.pins.get("p1")!;
    p1.lx = -40;
    dirty.pin("p1");
    ropes.step(scene, dirty, FRAME);

    expect(ropes.awake).toBe(1);
    expect(dirty.ropes.has("s1")).toBe(true);
    expect(dirty.ropes.has("s2")).toBe(false);
  });

  /** > moving one pin only wakes the two segments adjacent to it
   *  > — DESIGN section 2.3 */
  it("wakes only the two gaps either side of a pin in a long run", () => {
    for (let i = 3; i <= 5; i++) pin(`p${i}`, 200 * (i - 1), 0);
    ropes.setString(scene, dirty, "s1", ["p1", "p2", "p3", "p4", "p5"], [0.2, 0.2, 0.2, 0.2]);
    dirty.clear();
    expect(ropes.size).toBe(4);

    const p3 = scene.pins.get("p3")!;
    p3.ly = 60;
    dirty.pin("p3");
    ropes.step(scene, dirty, FRAME);
    expect(ropes.awake).toBe(2);
  });

  /** A hub pin is the case the "two" in that sentence is not a rule. */
  it("wakes every string through a hub pin", () => {
    pin("p3", 0, 200);
    pin("p4", 0, -200);
    ropes.setString(scene, dirty, "s1", ["p1", "p2"], [0.2]);
    ropes.setString(scene, dirty, "s2", ["p1", "p3"], [0.2]);
    ropes.setString(scene, dirty, "s3", ["p1", "p4"], [0.2]);
    dirty.clear();

    scene.pins.get("p1")!.lx = -30;
    dirty.pin("p1");
    ropes.step(scene, dirty, FRAME);
    expect(ropes.awake).toBe(3);
  });

  /**
   * A parented pin moves when its photograph does, and the item is what is
   * dirty then — the pin never appears in `dirty.pins` at all.
   */
  it("wakes a rope whose pin rides on an item that moved", () => {
    item("i1");
    pin("p3", 0, 0, "i1");
    scene.layoutPins();
    ropes.setString(scene, dirty, "s1", ["p2", "p3"], [0.2]);
    dirty.clear();

    scene.setPose("i1", { x: 90, y: 40 });
    dirty.item("i1");
    ropes.step(scene, dirty, FRAME);
    expect(ropes.awake).toBe(1);
  });

  /**
   * The guard that keeps a collaborator's cursor from holding a board awake.
   * A pose arriving every frame for something that is not really moving marks
   * the item dirty, and must not be enough on its own.
   */
  it("ignores a pin that was dirtied but did not actually move", () => {
    string("s1");
    dirty.clear();
    dirty.pin("p1");
    ropes.step(scene, dirty, FRAME);
    expect(ropes.awake).toBe(0);
    expect(dirty.ropes.size).toBe(0);
  });

  it("wakes on request, for a change that did not go through the document", () => {
    string("s1");
    dirty.clear();
    ropes.wake("s1");
    expect(ropes.awake).toBe(1);
  });
});

describe("sleeping", () => {
  /** AC-64. Twelve consecutive quiet frames, and the counter restarts the
   *  moment anything moves it again. */
  it("takes twelve quiet frames to drop off", () => {
    string("s1");
    dirty.clear();
    ropes.wake("s1");
    // Settle first, so what is being counted is the sleep rule and not the
    // rope still moving.
    for (let i = 0; i < 400 && ropes.awake > 0; i++) frame();
    expect(ropes.awake).toBe(0);

    ropes.wake("s1");
    let frames = 0;
    while (ropes.awake > 0 && frames < 100) {
      frame();
      frames++;
    }
    // A rope woken where it already rests is quiet immediately, so the only
    // thing left to count is the twelve.
    expect(frames).toBe(ROPE_SLEEP_STEPS);
  });

  it("restarts the count when something disturbs it again", () => {
    string("s1");
    dirty.clear();
    ropes.wake("s1");
    frame(ROPE_SLEEP_STEPS - 1);
    expect(ropes.awake).toBe(1);

    scene.pins.get("p1")!.ly = 50;
    dirty.pin("p1");
    frame(ROPE_SLEEP_STEPS - 1);
    expect(ropes.awake).toBe(1);
  });

  /** AC-65. Not stepped, not marked dirty, and the pose it went to sleep
   *  holding is the pose it still has — which is what the renderer's cached
   *  Path2D is banking on. */
  it("costs nothing at all once asleep", () => {
    string("s1");
    dirty.clear();
    ropes.wake("s1");
    untilAsleep();
    const settled = points("s1");

    for (let i = 0; i < 50; i++) {
      ropes.step(scene, dirty, FRAME);
      expect(dirty.ropes.size).toBe(0);
      dirty.clear();
    }
    expect(points("s1")).toEqual(settled);
  });

  it("sleeps a whole board of strings after one disturbance", () => {
    for (let i = 0; i < 12; i++) {
      pin(`q${i}`, i * 50, 0);
      pin(`r${i}`, i * 50, 300);
      ropes.setString(scene, dirty, `s${i}`, [`q${i}`, `r${i}`], [0.25]);
    }
    dirty.clear();
    for (let i = 0; i < 12; i++) ropes.wake(`s${i}`);
    expect(ropes.awake).toBe(12);
    untilAsleep();
    expect(ropes.awake).toBe(0);
  });
});

describe("finding the string under the cursor", () => {
  /**
   * > Hover a string. The nearest point on the rope highlights, tracking your
   * > cursor along the curve. — DESIGN section 3.4
   *
   * Against the particles, not the chord — which is the whole point. A string
   * with any drape in it is nowhere near the straight line between its pins,
   * and a hit test against that line would find nothing where the string
   * visibly is and something where it visibly is not.
   */
  it("finds the rope where it hangs, not where its chord runs", () => {
    string("s1", 0.4);
    const bounds = ropes.boundsOf("s1", { ...box })!;
    // The middle of the chord is at y = 0; the string is far below it.
    expect(bounds.maxY).toBeGreaterThan(40);
    expect(ropes.nearest(100, 0, 10)).toBeNull();
    const hit = ropes.nearest(100, bounds.maxY, 10)!;
    expect(hit.string).toBe("s1");
    expect(hit.distance).toBeLessThan(10);
  });

  it("gives back nothing when the cursor is nowhere near a string", () => {
    string("s1");
    expect(ropes.nearest(5000, 5000, 20)).toBeNull();
  });

  /** `t` is the arc-length fraction, which is what the slack split needs. The
   *  particles are evenly spaced by rest length, so walking them walks the
   *  string at constant speed and `t` comes out for free. */
  it("reports where along the string the point fell", () => {
    string("s1", 0.3);
    const pts = points("s1");
    const near = (i: number) => ropes.nearest(pts[i][0], pts[i][1], 5)!.t;
    expect(near(0)).toBeCloseTo(0, 6);
    expect(near(pts.length - 1)).toBeCloseTo(1, 6);
    // Monotonic along the run, and the midpoint particle is at the midpoint.
    expect(near(Math.floor((pts.length - 1) / 2))).toBeCloseTo(0.5, 1);
    let previous = -1;
    for (let i = 0; i < pts.length; i++) {
      const t = near(i);
      expect(t).toBeGreaterThan(previous);
      previous = t;
    }
  });

  /** A run of several segments has to say *which* gap was hit, because that
   *  is the index the new node goes after. */
  it("names the segment, so the insert knows where it goes", () => {
    pin("p3", 400, 0);
    pin("p4", 600, 0);
    ropes.setString(scene, dirty, "s1", ["p1", "p2", "p3", "p4"], [0.3, 0.3, 0.3]);
    const at = (x: number) => {
      const box2 = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      ropes.boundsOf("s1", box2);
      // Sweep down from the chord to find the string below x.
      for (let y = 0; y < 200; y += 0.5) {
        const hit = ropes.nearest(x, y, 2);
        if (hit) return hit;
      }
      return null;
    };
    expect(at(100)!.node).toBe(0);
    expect(at(300)!.node).toBe(1);
    expect(at(500)!.node).toBe(2);
  });

  it("picks the nearer of two strings that overlap", () => {
    pin("p3", 0, 40);
    pin("p4", 200, 40);
    ropes.setString(scene, dirty, "s1", ["p1", "p2"], [0.15]);
    ropes.setString(scene, dirty, "s2", ["p3", "p4"], [0.15]);
    const lower = ropes.boundsOf("s2", { ...box })!.maxY;
    expect(ropes.nearest(100, lower, 8)!.string).toBe("s2");
  });

  it("ignores a string that has no particles yet", () => {
    ropes.setString(scene, dirty, "s1", ["p1", "ghost"], [0.2]);
    expect(ropes.nearest(100, 0, 500)).toBeNull();
  });
});

describe("bounds", () => {
  it("covers the sag rather than just the pins", () => {
    string("s1", 0.5);
    const bounds = ropes.boundsOf("s1", box)!;
    expect(bounds.maxY).toBeGreaterThan(50);
  });

  it("unions every gap of a multi-pin run", () => {
    pin("p3", 400, -100);
    ropes.setString(scene, dirty, "s1", ["p1", "p2", "p3"], [0.2, 0.2]);
    const bounds = ropes.boundsOf("s1", box)!;
    expect(bounds.minX).toBeCloseTo(0, 6);
    expect(bounds.maxX).toBeCloseTo(400, 6);
    expect(bounds.minY).toBeCloseTo(-100, 6);
  });

  it("finds the strings that meet a rectangle and skips the rest", () => {
    pin("p3", 5000, 0);
    pin("p4", 5200, 0);
    ropes.setString(scene, dirty, "s1", ["p1", "p2"], [0.2]);
    ropes.setString(scene, dirty, "s2", ["p3", "p4"], [0.2]);

    expect(ropes.stringsIn({ minX: -10, minY: -10, maxX: 300, maxY: 300 }, [])).toEqual(["s1"]);
    expect(ropes.stringsIn({ minX: 4900, minY: -10, maxX: 5300, maxY: 300 }, [])).toEqual(["s2"]);
    expect(ropes.stringsIn({ minX: -10, minY: -10, maxX: 6000, maxY: 300 }, [])).toHaveLength(2);
    expect(ropes.stringsIn({ minX: 1000, minY: 1000, maxX: 2000, maxY: 2000 }, [])).toEqual([]);
  });

  it("follows the rope as it moves", () => {
    string("s1", 0.2);
    const before = ropes.boundsOf("s1", { ...box })!.maxY;
    dirty.clear();
    scene.pins.get("p2")!.ly = 400;
    dirty.pin("p2");
    frame(20);
    expect(ropes.boundsOf("s1", box)!.maxY).toBeGreaterThan(before);
  });
});

describe("a document restore", () => {
  /** Load and undo both set `dirty.all`, and both are a state restore rather
   *  than an event: everything goes back to its analytic pose, asleep. */
  it("puts every rope back at rest and asleep", () => {
    string("s1", 0.3);
    dirty.clear();
    ropes.wake("s1");
    frame(3);
    expect(ropes.awake).toBe(1);

    dirty.everything();
    ropes.step(scene, dirty, FRAME);
    expect(ropes.awake).toBe(0);
    expect(dirty.ropes.has("s1")).toBe(true);
  });
});

describe("pins that are not there", () => {
  /** > A string node pointing at a missing pin is skipped at render time.
   *  > — DATA-MODEL section 8.1 */
  it("holds no particles for a rope whose pin has not arrived", () => {
    ropes.setString(scene, dirty, "s1", ["p1", "ghost"], [0.2]);
    expect(points("s1")).toEqual([]);
    expect(ropes.boundsOf("s1", box)).toBeNull();
  });

  /**
   * *Skipped*, which means the run closes up around it — not stopped at.
   *
   * A segment per adjacent pair puts the missing pin on the end of two of them
   * and both are then unbuildable, so a three-node run that lost its middle pin
   * drew nothing whatsoever: no particles, no bounds, nothing to hover, while
   * sitting in the scene with all three nodes and satisfying invariant 3. And
   * not transiently — that state comes from a merge no cascade can reach (T-76)
   * and lasts until the janitor gets to it.
   */
  it("spans a dead node rather than breaking at it", () => {
    pin("p3", 400, 0);
    run("s1", ["p1", "ghost", "p3"], [0.2, 0.4, 0.6]);
    frame();

    let spans = 0;
    ropes.visit("s1", () => spans++);
    expect(spans).toBe(1);
    // Straight from the first surviving pin to the last, past the dead one.
    const pts = points("s1");
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([400, 0]);
    expect(ropes.boundsOf("s1", box)).not.toBeNull();
  });

  /** The gap takes the slack of the node it starts at. Nothing is merged in:
   *  that needs the chord either side of the vanished pin, and a pin that is
   *  gone has no position — `crdt/ops/cascade.ts` bails for the same reason. */
  it("hangs the spanning gap on the surviving node's own slack", () => {
    pin("p3", 400, 0);
    run("s1", ["p1", "ghost", "p3"], [0.05, 0.9, 0.9]);
    untilAsleep();
    const shallow = lowest("s1");

    // The dead node's own 0.9 is never consulted, so only the first number
    // moves the rope. A merge would have let go far more than this.
    run("s1", ["p1", "ghost", "p3"], [0.5, 0.9, 0.9]);
    untilAsleep();
    expect(lowest("s1")).toBeGreaterThan(shallow);
  });

  /** An insert goes at `node + 1`, so `nearest` has to name the node the
   *  segment starts at and not the segment's own place in the list. */
  it("names the run index a spanning segment starts at", () => {
    pin("p3", 400, 0);
    run("s1", ["p1", "ghost", "p3"], [0.2, 0.2, 0.2]);
    frame();
    expect(ropes.nearest(200, 20, 100)?.node).toBe(0);
  });

  it("names it correctly when the dead node comes first", () => {
    pin("p3", 400, 0);
    run("s1", ["ghost", "p1", "p3"], [0.2, 0.2, 0.2]);
    frame();
    expect(ropes.nearest(200, 20, 100)?.node).toBe(1);
  });

  /** Nodes can arrive before the pins they name under concurrent editing, so
   *  the pin turning up has to be what gives the rope its shape. The route is
   *  the run being re-read — `crdt/binding.ts` dirties every string naming a
   *  pin whose *presence* changed, which is the whole reason it keeps that
   *  index. */
  it("takes shape when the pin finally turns up", () => {
    run("s1", ["p1", "ghost"], [0.2]);
    frame();
    expect(points("s1")).toEqual([]);

    pin("ghost", 300, 100);
    dirty.pin("ghost");
    dirty.string("s1");
    ropes.step(scene, dirty, FRAME);

    expect(points("s1").length).toBeGreaterThan(2);
    expect(ropes.awake).toBe(0);
    expect(dirty.ropes.has("s1")).toBe(true);
  });

  it("stops stepping a rope whose pin vanishes mid-swing", () => {
    string("s1");
    dirty.clear();
    ropes.wake("s1");
    frame();
    expect(ropes.awake).toBe(1);

    scene.removePin("p2");
    ropes.step(scene, dirty, FRAME);
    expect(ropes.awake).toBe(0);
  });
});

describe("the particle pool", () => {
  it("reuses the space a deleted string gave back", () => {
    string("s1");
    const used = ropes.positions.length;
    for (let i = 0; i < 40; i++) {
      ropes.removeString(dirty, "s1");
      string("s1");
    }
    expect(ropes.positions.length).toBe(used);
  });

  it("keeps each rope's particles to itself", () => {
    pin("p3", 0, 400);
    pin("p4", 200, 400);
    ropes.setString(scene, dirty, "s1", ["p1", "p2"], [0.2]);
    ropes.setString(scene, dirty, "s2", ["p3", "p4"], [0.2]);
    for (const [, y] of points("s1")) expect(y).toBeLessThan(200);
    for (const [, y] of points("s2")) expect(y).toBeGreaterThan(200);
  });

  it("survives a great many strings without losing any of them", () => {
    for (let i = 0; i < 200; i++) {
      pin(`a${i}`, i * 30, 0);
      pin(`b${i}`, i * 30, 250);
      ropes.setString(scene, dirty, `s${i}`, [`a${i}`, `b${i}`], [0.2]);
    }
    expect(ropes.size).toBe(200);
    for (let i = 0; i < 200; i++) {
      const pts = points(`s${i}`);
      expect(pts[0]).toEqual([i * 30, 0]);
      expect(pts[pts.length - 1]).toEqual([i * 30, 250]);
    }
  });

  it("forgets everything on a clear", () => {
    string("s1");
    ropes.clear();
    expect(ropes.size).toBe(0);
    expect(points("s1")).toEqual([]);
  });
});

describe("the frame clock", () => {
  /** The accumulator lives here so every rope on the board agrees what time
   *  it is — two strings on the same pin stepping different amounts would
   *  disagree about where that pin was. */
  it("does no work at all on a frame worth less than one fixed step", () => {
    string("s1");
    dirty.clear();
    ropes.wake("s1");
    ropes.step(scene, dirty, SIM_STEP_MS / 4);
    expect(dirty.ropes.size).toBe(0);
    // Still awake — nothing has been stepped, so nothing has settled either.
    expect(ropes.awake).toBe(1);
  });
});
