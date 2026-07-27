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
import { ROPE_SLEEP_STEPS, SIM_STEP_MS } from "@/sim/tuning";
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

function frame(n = 1): void {
  for (let i = 0; i < n; i++) {
    ropes.step(scene, dirty, FRAME);
    dirty.clear();
  }
}

/**
 * Exactly one fixed step, where `frame` is two of them at 60 Hz.
 *
 * For the plucks, which are the only assertions here about what the rope is
 * doing *during* a disturbance rather than where it ends up. Both of them
 * already meant one step — "the kick lands on `prev`, so it is one step that
 * turns it into motion" — and got away with asking for a frame while the
 * projection was soft enough that a wave took several to cross the rope.
 *
 * Solving the chain exactly (T-147) put the tension up to what the analysis
 * says it should be, and a transverse wave travels at the root of tension, so
 * the ringing is now quicker than the frame that was being used to sample it:
 * one fixed step after a downward pluck the middle of the rope is two units
 * below its rest pose, and one frame after it, it has already been through the
 * bottom and is on its way back up. Sampling a faster oscillation at the old
 * rate reads as the pluck having stopped working, which is what this is here
 * to stop somebody concluding.
 */
function fixedStep(n = 1): void {
  for (let i = 0; i < n; i++) {
    ropes.step(scene, dirty, SIM_STEP_MS);
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

  it("wakes on request, for a pluck or an impulse", () => {
    string("s1");
    dirty.clear();
    ropes.wake("s1");
    expect(ropes.awake).toBe(1);
  });
});

describe("plucking", () => {
  /** > A travelling wave runs down it and damps out. Purely for joy.
   *  > — DESIGN section 3.4 */
  const TAUT = 0.01;

  /** How far every particle sits from where it started, the largest first. */
  function offsets(id: string, from: Array<[number, number]>): number[] {
    return points(id)
      .map(([x, y], i) => Math.hypot(x - from[i]![0], y - from[i]![1]))
      .sort((a, b) => b - a);
  }

  it("shakes the rope, from a point on it", () => {
    string("s1", TAUT);
    frame(4);
    const rest = points("s1");

    expect(ropes.pluck("s1", 100, 0)).toBe(true);
    frame(4);
    expect(offsets("s1", rest)[0]).toBeGreaterThan(1);
  });

  /**
   * Sideways, and downward.
   *
   * The impulse is perpendicular to the rope because a kick *along* it is
   * absorbed by the first projection pass - the links resist stretching almost
   * completely - so a lengthwise kick would move nothing at all.
   *
   * Down of the two perpendiculars, because a real string is released and falls
   * through, and because choosing the side by the rope's own geometry rather
   * than by where the cursor is means a click landing exactly *on* the string
   * still has a direction.
   *
   * The particles also travel a comparable distance *along* the span, which is
   * not a bug and is why this asserts the direction rather than a ratio: a taut
   * rope bowing sideways has to draw its own length in from the ends, and at 1%
   * slack there is very little to draw.
   */
  it("kicks the rope across itself, downward", () => {
    string("s1", TAUT);
    frame(4);
    const rest = points("s1");
    const mid = Math.floor(rest.length / 2);

    ropes.pluck("s1", 100, 0);
    // One fixed step, because that is how long the answer stays a direction: a
    // rope this taut is through the middle and heading back up by the next
    // one, and ringing is the point. It was one *frame* until T-147 made the
    // rope as stiff as the analysis says it is — see `fixedStep`.
    fixedStep(1);
    // Downward, which is the direction this test is named for and the thing
    // that would be wrong if the perpendicular were picked the other way.
    expect(points("s1")[mid]![1]).toBeGreaterThan(rest[mid]![1]);

    // And it has to be a *visible* kick, not a numerical one. The threshold
    // used to be a whole unit within this same step; solving the chain exactly
    // (T-147) made the rope about four times stiffer, so the same impulse now
    // buys a quarter of the displacement and buys it back faster. Peak swing
    // on a 200-unit taut string went from about 21 units to about 5.
    //
    // So the assertion moved from "how far in one step" to "how far at all",
    // which is the part a person actually sees, and it is a floor a long way
    // under the 5 that is measured rather than a number fitted to it. If a
    // stiffer solver ever takes the pluck below this, that is worth being told
    // about rather than worth adjusting: T-148 is the open question of whether
    // `PLUCK_SPEED` should be raised to put the old swing back.
    let peak = 0;
    for (let i = 0; i < 24; i++) {
      fixedStep(1);
      peak = Math.max(peak, Math.abs(points("s1")[mid]![1] - rest[mid]![1]));
    }
    expect(peak).toBeGreaterThan(3);
  });

  /**
   * A bump, not a spike.
   *
   * Kicking one particle gives the solver a kink, and a kink is what a
   * projection pass is *for* - it comes out as a small, fast ripple rather than
   * as a wave. The tell is the shape of the crest one frame in: the seven
   * particles the kick reaches should all have moved about as far as each
   * other, where a single-particle kick leaves a peak with the rest of the rope
   * trailing off behind it. Measured, that is a seventh-largest displacement at
   * 90% of the largest here against 50% with the reach turned off.
   */
  it("kicks a run of particles rather than one", () => {
    string("s1", TAUT);
    frame(4);
    const rest = points("s1");

    ropes.pluck("s1", 100, 0);
    // The kick lands on `prev`, so it is one step that turns it into motion —
    // one fixed step, literally, now that the ringing is quick enough to care
    // about the difference. See `fixedStep`.
    fixedStep(1);
    const moved = offsets("s1", rest);
    // Seven: PLUCK_REACH of 3 either side of the particle that was hit. A
    // literal rather than the constant, so that retuning the reach makes
    // somebody look at this number rather than making the test agree with
    // itself whatever it is set to.
    // 0.6 rather than the 0.7 this was written at. The number that matters is
    // the one it is being told apart from — the comment above measured 50% with
    // the reach turned off — and a crest at 66% is still unambiguously a bump
    // rather than a spike. The few points it lost are T-147's: a stiffer chain
    // passes the kink outward faster, so one step in, the shoulders of the
    // crest have already begun to run away from its middle.
    expect(moved[6]!).toBeGreaterThan(moved[0]! * 0.6);
  });

  /**
   * > Physics never writes to the document. — DESIGN section 5.1
   *
   * And the corollary that matters here: a rope that has been plucked goes back
   * to sleep on its own, so a board where somebody twanged a string ten minutes
   * ago costs exactly what an untouched one does.
   */
  it("wakes the rope and lets it settle again", () => {
    string("s1", TAUT);
    untilAsleep();
    expect(ropes.awake).toBe(0);

    ropes.pluck("s1", 100, 0);
    expect(ropes.awake).toBe(1);
    expect(untilAsleep()).toBeLessThan(1000);
    expect(ropes.awake).toBe(0);
  });

  /**
   * A wave cannot cross a pin, because a pin is a fixed anchor - so only the
   * segment that was plucked moves. Waking the neighbours instead would show a
   * wave appearing on the far side of something that never moved.
   */
  it("stays in the segment it was given to", () => {
    pin("p3", 400, 0);
    ropes.setString(scene, dirty, "s1", ["p1", "p2", "p3"], [TAUT, TAUT]);
    frame(4);

    ropes.pluck("s1", 100, 0);
    expect(ropes.awake).toBe(1);
  });

  it("does nothing for a string that is not there", () => {
    expect(ropes.pluck("nope", 0, 0)).toBe(false);
  });

  /** Two particles is all anchor: both ends are pins, and `sim/verlet.ts` seats
   *  those every micro-step, so there is nothing a kick could survive on. */
  it("does nothing to a rope with no interior", () => {
    // A span far shorter than ROPE_SPACING, so it seeds with two particles.
    pin("q1", 0, 400);
    pin("q2", 1, 400);
    ropes.setString(scene, dirty, "short", ["q1", "q2"], [TAUT]);
    expect(points("short")).toHaveLength(2);
    expect(ropes.pluck("short", 0.5, 400)).toBe(false);
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

  /** Nodes can arrive before the pins they name under concurrent editing, so
   *  the pin turning up has to be what gives the rope its shape. */
  it("takes shape when the pin finally turns up", () => {
    ropes.setString(scene, dirty, "s1", ["p1", "ghost"], [0.2]);
    dirty.clear();

    pin("ghost", 300, 100);
    dirty.pin("ghost");
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
