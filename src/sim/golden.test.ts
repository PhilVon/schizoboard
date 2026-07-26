/**
 * Golden tests for the rope: wherever a rope has been, it settles onto the
 * catenary, and it does it in a bounded number of frames.
 *
 * The other rope suites each check one module against its own contract.
 * This one checks the *simulation* against the *analysis* — the whole of
 * `ropes.ts` + `verlet.ts`, disturbed and left to settle, against
 * `catenary.ts`, which is independently checked against plain bisection. Two
 * routes to the same answer, and neither shares any arithmetic with the other
 * beyond the rest length itself.
 *
 * That is what makes it the regression net for D-17. At DESIGN 5.2's original
 * six constraint iterations a rope settles 23% longer than its rest length and
 * 19 board units below where it belongs, and *every other test in the project
 * passed with that in place*. The bounds below are the ones that would not
 * have.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { catenaryLowestY, sampleChain, solveCatenary } from "@/sim/catenary";
import { RopeSet } from "@/sim/ropes";
import { ROPE_SLEEP_STEPS, ROPE_SPACING } from "@/sim/tuning";
import { DirtySets } from "@/state/dirty";
import { Scene } from "@/state/scene";

let scene: Scene;
let dirty: DirtySets;
let ropes: RopeSet;

const FRAME = 1000 / 60;

/**
 * Geometries wide enough that anything shape-specific shows up: level and
 * steep, short and long, barely slack and heavily draped, both directions.
 *
 * The near-vertical fold that `sampleChain` cannot seed is deliberately not
 * here — D-16 says the seed for that family is the smooth curve rather than
 * the chain, so it has no golden pose to be measured against. It is covered
 * where it belongs, in `catenary.test.ts`.
 */
const CASES: Array<{ name: string; a: [number, number]; b: [number, number]; slack: number }> = [
  { name: "a level span", a: [0, 0], b: [220, 0], slack: 0.15 },
  { name: "a level span heavily draped", a: [0, 0], b: [220, 0], slack: 0.6 },
  { name: "a level span barely slack", a: [0, 0], b: [220, 0], slack: 0.03 },
  { name: "a run that climbs", a: [0, 0], b: [300, -180], slack: 0.2 },
  { name: "a run that falls", a: [0, 0], b: [300, 180], slack: 0.2 },
  { name: "a run laid out right to left", a: [400, 50], b: [100, -20], slack: 0.3 },
  { name: "a short run between adjacent pins", a: [10, 10], b: [40, 16], slack: 0.35 },
  { name: "a steep run with room to fold", a: [0, 0], b: [60, 260], slack: 0.2 },
  { name: "a run across a very large board", a: [-90000, 40000], b: [-89600, 40120], slack: 0.18 },
];

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

function frame(): void {
  ropes.step(scene, dirty, FRAME);
  dirty.clear();
}

/** Frames until nothing is awake. Returns `limit` if it never settles. */
function settle(limit = 3000): number {
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

/** The analytic pose the simulation is being judged against. */
function golden(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  slack: number,
  /**
   * Particles, when the rope under test has a count of its own.
   *
   * It has to be asked rather than derived, because `ropes.ts` fixes a
   * segment's particle count when it is seeded and holds it for the segment's
   * life — slack is a ratio, so dragging the pins apart lengthens the rope,
   * and re-counting mid-drag would mean reallocating and re-seeding in the
   * middle of a gesture. So a rope that has been dragged has the count its
   * original geometry asked for, and that is the pose it must be judged
   * against.
   */
  particles?: number,
): { pts: Array<[number, number]>; length: number; lowestY: number } {
  const chord = Math.hypot(bx - ax, by - ay);
  const cat = solveCatenary(ax, ay, bx, by, chord * (1 + slack));
  const count = particles ?? Math.max(2, Math.round(cat.length / ROPE_SPACING) + 1);
  const buf = new Float64Array(count * 2);
  sampleChain(cat, buf, count);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) pts.push([buf[i * 2], buf[i * 2 + 1]]);
  return { pts, length: cat.length, lowestY: catenaryLowestY(cat) };
}

beforeEach(() => {
  scene = new Scene();
  dirty = new DirtySets();
  ropes = new RopeSet();
});

describe("wherever it has been, it settles onto the catenary", () => {
  /**
   * The rope is built somewhere else entirely and then dragged to the
   * geometry under test, so the pose it settles into owes nothing to the
   * analytic seed it started from — it is the solver's own answer, reached by
   * simulating.
   *
   * A part in a hundred and fifty of the rope's own length — a board unit and
   * a half on a 250-unit span, which is a pixel and a half at 100% zoom and
   * invisible at any zoom a person uses.
   *
   * Not an arbitrary round number. Position-based dynamics holds a load by
   * holding a violation, so a settled rope is always slightly longer than its
   * rest length and hangs slightly below the curve (D-17), and the bound is
   * set by the worst case in the table: a **barely slack** one. That is the
   * hardest rope for this solver, not the easiest — a nearly taut string
   * carries its weight at high tension, so the violation needed to generate
   * that tension is the largest of any shape here. The draped ones come in at
   * three or four times inside the bound.
   *
   * At DESIGN's original six iterations this fails by a factor of twenty.
   */
  it.each(CASES)("settles within a part in a hundred and fifty — $name", (c) => {
    // Built where it belongs, then dragged a long way off and back, so the
    // pose it ends on is one it simulated its way to rather than the analytic
    // one it was seeded with.
    pin("p1", c.a[0], c.a[1]);
    pin("p2", c.b[0], c.b[1]);
    ropes.setString(scene, dirty, "s", ["p1", "p2"], [c.slack, c.slack]);
    movePin("p1", c.a[0] - 400, c.a[1] - 300);
    settle();
    movePin("p1", c.a[0], c.a[1]);
    const frames = settle();
    expect(frames).toBeLessThan(3000);

    const got = points("s");
    const want = golden(c.a[0], c.a[1], c.b[0], c.b[1], c.slack, got.length);

    const tolerance = want.length / 150;
    for (let i = 0; i < got.length; i++) {
      expect(Math.hypot(got[i][0] - want.pts[i][0], got[i][1] - want.pts[i][1])).toBeLessThan(
        tolerance,
      );
    }
  });

  /** The sag is the whole visible character of a hanging string, and the one
   *  number a person would notice being wrong. */
  it.each(CASES)("hangs as deep as the analysis says — $name", (c) => {
    pin("p1", c.a[0], c.a[1]);
    pin("p2", c.b[0], c.b[1]);
    ropes.setString(scene, dirty, "s", ["p1", "p2"], [c.slack, c.slack]);
    ropes.wake("s");
    settle();

    const got = points("s");
    const want = golden(c.a[0], c.a[1], c.b[0], c.b[1], c.slack, got.length);
    const deepest = Math.max(...got.map((p) => p[1]));
    // Symmetric, and it has to be: the residual stretch pushes the rope below
    // the curve, but the deepest *particle* only sits at the curve's low point
    // when one happens to land there — on a steep run none does, and the rope
    // reads a fraction shallow for that reason alone.
    expect(Math.abs(deepest - want.lowestY)).toBeLessThan(want.length / 200);
  });

  /**
   * The measurement D-17 turns on, asserted so it cannot come back quietly.
   * Set `ROPE_SUBSTEPS` to 1 and `ROPE_ITERATIONS` to 6 — DESIGN 5.2's
   * original working numbers — and this fails at 23%.
   */
  it.each(CASES)("holds its rest length while carrying its own weight — $name", (c) => {
    pin("p1", c.a[0], c.a[1]);
    pin("p2", c.b[0], c.b[1]);
    ropes.setString(scene, dirty, "s", ["p1", "p2"], [c.slack, c.slack]);
    ropes.wake("s");
    settle();

    const got = points("s");
    const want = golden(c.a[0], c.a[1], c.b[0], c.b[1], c.slack, got.length);
    const link = want.length / (got.length - 1);
    let total = 0;
    for (let i = 1; i < got.length; i++) {
      const len = Math.hypot(got[i][0] - got[i - 1][0], got[i][1] - got[i - 1][1]);
      // Long rather than short: gravity stretches a rope, it never compresses
      // one, so a short link would mean the solver had overshot.
      expect(len).toBeGreaterThan(link * 0.999);
      expect(len / link - 1).toBeLessThan(0.01);
      total += len;
    }
    expect(total / want.length - 1).toBeLessThan(0.01);
  });
});

describe("and it stops", () => {
  /**
   * > A board with 500 strings has, in normal use, between zero and four awake
   * > at any moment. — DESIGN section 5.3
   *
   * Which is only true if a disturbed rope actually finishes. Five seconds is
   * the bound because five seconds is what it measures, and the *shape* of the
   * measurement is the interesting part: a 70-unit nudge and a 500-unit yank
   * both settle in about 250 frames. So this is not the swing damping out —
   * that is a 0.29 s half-life and would show up as a bound that grew with the
   * log of the disturbance. It is the solver creeping the last fraction of a
   * unit onto its own equilibrium, which is the same slow convergence D-17 is
   * about, seen from the time axis instead of the distance one.
   *
   * Worth knowing rather than worth fixing here: the rope looks settled long
   * before it is declared settled, so the cost is a few ropes reported awake,
   * not anything visible. T-109 has the idea for shortening it.
   */
  it.each(CASES)("goes quiet inside five seconds, however hard it is hit — $name", (c) => {
    pin("p1", c.a[0], c.a[1]);
    pin("p2", c.b[0], c.b[1]);
    ropes.setString(scene, dirty, "s", ["p1", "p2"], [c.slack, c.slack]);
    movePin("p1", c.a[0] - 60, c.a[1] - 40);
    expect(settle()).toBeLessThan(300);

    movePin("p1", c.a[0] - 400, c.a[1] - 300);
    settle();
    movePin("p1", c.a[0], c.a[1]);
    expect(settle()).toBeLessThan(300);
  });

  /**
   * A rope woken where it already rests still cannot sleep in fewer than the
   * twelve still frames the rule asks for — that is the floor, and a sleep
   * manager that ever beat it would be sleeping ropes that were still moving.
   *
   * It takes about twice that rather than exactly that, and the extra is the
   * same creep as above: the analytic pose a rope is *seeded* at is not quite
   * the pose this solver holds it at, so even an undisturbed rope has a
   * fraction of a unit to travel before it is still. AC-62 is unaffected — a
   * seeded rope is asleep and never steps at all until something wakes it.
   */
  it("cannot sleep faster than the sleep rule allows", () => {
    pin("p1", 0, 0);
    pin("p2", 220, 0);
    ropes.setString(scene, dirty, "s", ["p1", "p2"], [0.2, 0.2]);
    ropes.wake("s");
    const frames = settle();
    expect(frames).toBeGreaterThanOrEqual(ROPE_SLEEP_STEPS);
    expect(frames).toBeLessThan(ROPE_SLEEP_STEPS * 3);
  });

  /** Sleep has to be final. A rope that woke itself again would burn a frame
   *  forever and never show up as a bug, only as a board that is never idle. */
  it("stays asleep once it has stopped", () => {
    pin("p1", 0, 0);
    pin("p2", 220, 0);
    ropes.setString(scene, dirty, "s", ["p1", "p2"], [0.4, 0.4]);
    movePin("p1", -120, -80);
    settle();
    const resting = points("s");

    for (let i = 0; i < 600; i++) frame();
    expect(ropes.awake).toBe(0);
    expect(points("s")).toEqual(resting);
  });

  /** A board of them settles together rather than one at a time, and none of
   *  them is left awake by the others. */
  it("settles twenty ropes at once and sleeps every one", () => {
    for (let i = 0; i < 20; i++) {
      pin(`a${i}`, i * 40, 0);
      pin(`b${i}`, i * 40 + 30, 220);
      ropes.setString(scene, dirty, `s${i}`, [`a${i}`, `b${i}`], [0.25, 0.25]);
    }
    settle();
    for (let i = 0; i < 20; i++) movePin(`a${i}`, i * 40 - 60, -40);
    expect(settle()).toBeLessThan(300);
    expect(ropes.awake).toBe(0);
  });
});

describe("a multi-pin run", () => {
  /** Each segment is an independent rope pinned at both ends (DESIGN section
   *  2.3), so each one has to land on its own catenary — a run is not a
   *  special case, and this is the assertion that it is not treated as one. */
  it("settles every segment onto its own catenary", () => {
    const stops: Array<[number, number]> = [
      [0, 0],
      [240, -60],
      [520, 40],
      [760, -20],
    ];
    stops.forEach(([x, y], i) => pin(`p${i}`, x, y));
    ropes.setString(
      scene,
      dirty,
      "s",
      stops.map((_, i) => `p${i}`),
      stops.map(() => 0.22),
    );
    ropes.wake("s");
    settle();

    const got = points("s");
    let at = 0;
    for (let i = 0; i < stops.length - 1; i++) {
      const want = golden(stops[i][0], stops[i][1], stops[i + 1][0], stops[i + 1][1], 0.22);
      for (let k = 0; k < want.pts.length; k++) {
        const p = got[at + k];
        expect(Math.hypot(p[0] - want.pts[k][0], p[1] - want.pts[k][1])).toBeLessThan(
          want.length / 500,
        );
      }
      at += want.pts.length;
    }
    expect(at).toBe(got.length);
  });
});
