/**
 * The rest pose, with no scene, no document and no browser — the module is
 * pure geometry and the test file is the argument for it.
 *
 * AC-62 is "board opens perfectly still — no whip-crack on load", and what
 * that reduces to numerically is the pair of properties checked hardest
 * below: the sampled polyline is the length the string actually has, and it
 * is spaced evenly along its own arc. A seed that gets either wrong is a seed
 * the solver has to correct on frame one, which is the whip-crack.
 */

import { describe, expect, it } from "vitest";

import {
  catenaryLowestY,
  invSinhc,
  sampleCatenary,
  sampleChain,
  solveCatenary,
  type Catenary,
} from "@/sim/catenary";

/** Sample into a plain array — every assertion below reads points, not slots. */
function points(c: Catenary, count: number): Array<[number, number]> {
  const out = new Float64Array(count * 2);
  sampleCatenary(c, out, count);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) pts.push([out[i * 2], out[i * 2 + 1]]);
  return pts;
}

/** The lengths of the polyline's links, in order. */
function links(pts: Array<[number, number]>): number[] {
  const out: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    out.push(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return out;
}

function polylineLength(pts: Array<[number, number]>): number {
  return links(pts).reduce((a, b) => a + b, 0);
}

/**
 * A spread of geometries wide enough that anything shape-specific in the
 * solver shows up: level and steep, short and long, barely slack and heavily
 * draped, and both horizontal directions.
 */
interface Case {
  name: string;
  a: [number, number];
  b: [number, number];
  slack: number;
  /** Set where the curve folds tighter than a link can turn, so there is no
   *  chain to solve and `sampleChain` falls back — see the module comment. */
  noChain?: true;
}

const CASES: Case[] = [
  { name: "a level span with a normal drape", a: [0, 0], b: [200, 0], slack: 0.12 },
  { name: "a level span heavily draped", a: [0, 0], b: [200, 0], slack: 1 },
  { name: "a level span nearly taut", a: [0, 0], b: [200, 0], slack: 0.002 },
  { name: "a run that climbs to the right", a: [0, 0], b: [300, -180], slack: 0.2 },
  { name: "a run that falls to the right", a: [0, 0], b: [300, 180], slack: 0.2 },
  { name: "a run laid out right to left", a: [400, 50], b: [100, -20], slack: 0.3 },
  { name: "a steep run, barely off vertical", a: [0, 0], b: [4, 260], slack: 0.05, noChain: true },
  { name: "a short run between adjacent pins", a: [10, 10], b: [34, 12], slack: 0.4 },
  { name: "a run across a very large board", a: [-90000, 40000], b: [-40000, 41000], slack: 0.15 },
];

function solveCase(c: Case): Catenary {
  const chord = Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]);
  return solveCatenary(c.a[0], c.a[1], c.b[0], c.b[1], chord * (1 + c.slack));
}

describe("inverting sinhc", () => {
  /** The whole numerical burden of a catenary is this one root, so it gets
   *  checked against its own definition rather than against a table. */
  it("round-trips sinh(z)/z across every ratio a board can ask for", () => {
    for (let e = -9; e <= 7; e += 0.05) {
      const r = 1 + Math.pow(10, e);
      const z = invSinhc(r);
      expect(z).toBeGreaterThan(0);
      // Relative, because `r` reaches ten million and there is no absolute
      // tolerance that is meaningful at both ends of that.
      expect(Math.abs(Math.sinh(z) / z - r) / r).toBeLessThan(1e-12);
    }
  });

  it("is zero at and below a straight string, where there is no sag to solve", () => {
    expect(invSinhc(1)).toBe(0);
    expect(invSinhc(0.5)).toBe(0);
  });

  it("increases with the ratio, so more slack is always more sag", () => {
    let previous = 0;
    for (let r = 1.000001; r < 500; r *= 1.07) {
      const z = invSinhc(r);
      expect(z).toBeGreaterThan(previous);
      previous = z;
    }
  });

  /**
   * The series, the table and the asymptote each seed a different stretch of
   * the range, and a wrong branch or a botched seam would show as a step at
   * the join. Checked against bisection — slow, obvious, and sharing none of
   * the machinery it is judging.
   */
  it("agrees with plain bisection everywhere, seams included", () => {
    const bisect = (r: number): number => {
      let lo = 0;
      let hi = 1;
      while (Math.sinh(hi) / hi < r) hi *= 2;
      for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        if (Math.sinh(mid) / mid < r) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };
    for (let q = 0.0002; q < 14; q += 0.0007) {
      const r = Math.exp(q);
      expect(Math.abs(invSinhc(r) - bisect(r))).toBeLessThan(1e-9);
    }
  });
});

describe("the sampled pose", () => {
  it.each(CASES)("puts its ends exactly on the pins — $name", (c) => {
    const pts = points(solveCase(c), 17);
    expect(pts[0]).toEqual(c.a);
    expect(pts[pts.length - 1]).toEqual(c.b);
  });

  /**
   * The first half of AC-62. Densely sampled, the polyline is the curve, and
   * the curve has to be exactly as long as the string is — otherwise the
   * solver's first act on waking is to take up or pay out the difference.
   */
  it.each(CASES)("is as long as the string it represents — $name", (c) => {
    const cat = solveCase(c);
    const measured = polylineLength(points(cat, 4001));
    expect(Math.abs(measured / cat.length - 1)).toBeLessThan(1e-5);
  });

  /**
   * The second half — even spacing along the arc. Sampling at even *x*
   * instead, which is the obvious way to write this module and the wrong one,
   * fails this by tens of percent on anything with real sag.
   *
   * Sampled finely, because a chord is only the arc it spans once the
   * sampling resolves the curvature. Coarsely it is not, and that gap is the
   * entire reason `sampleChain` exists — see the suite at the bottom.
   */
  it.each(CASES)("spaces its particles evenly along the arc — $name", (c) => {
    const cat = solveCase(c);
    const measured = links(points(cat, 8001));
    const nominal = cat.length / 8000;
    for (const link of measured) expect(Math.abs(link / nominal - 1)).toBeLessThan(0.005);
  });

  it("never sags upward", () => {
    for (const c of CASES) {
      const cat = solveCase(c);
      const pts = points(cat, 61);
      const chordAt = (i: number): number => cat.ay + (cat.by - cat.ay) * (i / 60);
      // Every interior point hangs below the straight line between the pins.
      for (let i = 1; i < 60; i++) expect(pts[i][1]).toBeGreaterThan(chordAt(i));
    }
  });
});

describe("how deep it hangs", () => {
  it("agrees with a dense sample about its lowest point", () => {
    for (const c of CASES) {
      const cat = solveCase(c);
      const sampled = Math.max(...points(cat, 8001).map((p) => p[1]));
      expect(catenaryLowestY(cat)).toBeCloseTo(sampled, 3);
    }
  });

  it("hangs lower the more slack it is given", () => {
    let previous = -Infinity;
    for (const slack of [0.001, 0.01, 0.05, 0.2, 0.5, 1, 3]) {
      const cat = solveCatenary(0, 0, 200, 0, 200 * (1 + slack));
      const low = catenaryLowestY(cat);
      expect(low).toBeGreaterThan(previous);
      previous = low;
    }
  });

  it("puts the low point of a level span at its midpoint", () => {
    const cat = solveCatenary(-150, 20, 150, 20, 420);
    const pts = points(cat, 1001);
    let lowest = 0;
    for (let i = 1; i < pts.length; i++) if (pts[i][1] > pts[lowest][1]) lowest = i;
    expect(pts[lowest][0]).toBeCloseTo(0, 3);
  });

  /**
   * A short steep run can be entirely on one rising flank, with no low point
   * between its ends at all. Getting this wrong would put a phantom sag into
   * the bounds index and wake ropes that are nowhere near the viewport.
   */
  it("falls back to the lower pin when the curve never turns over", () => {
    // Steep and nearly taut: the whole run is on the descending flank and the
    // catenary's own low point is far below and past the second pin.
    const cat = solveCatenary(0, 0, 40, 400, 402);
    expect(cat.s0 + cat.length).toBeLessThan(0);
    expect(catenaryLowestY(cat)).toBe(400);
  });
});

describe("a string pulled straight", () => {
  /** > If the user drags pins further apart than the rest length, don't let
   *  > the solver fight it. — DESIGN section 5.4 */
  it("goes straight rather than reporting an error", () => {
    const cat = solveCatenary(0, 0, 300, 0, 100);
    expect(cat.a).toBe(Infinity);
    const pts = points(cat, 11);
    for (let i = 0; i < 11; i++) {
      expect(pts[i][0]).toBeCloseTo(i * 30, 9);
      expect(pts[i][1]).toBeCloseTo(0, 9);
    }
  });

  it("is straight and evenly spaced at exactly its rest length too", () => {
    const cat = solveCatenary(10, 10, 10 + 60, 10 + 80, 100);
    const measured = links(points(cat, 9));
    for (const link of measured) expect(link).toBeCloseTo(12.5, 9);
  });

  it("does not tip into a straight line one hair before it should", () => {
    const cat = solveCatenary(0, 0, 200, 0, 200 * (1 + 1e-9));
    expect(Number.isFinite(cat.a)).toBe(true);
    expect(catenaryLowestY(cat)).toBeGreaterThan(0);
    expect(polylineLength(points(cat, 2001)) / cat.length).toBeCloseTo(1, 6);
  });
});

describe("pins stacked vertically", () => {
  /** No horizontal span means no catenary — the string drops and folds back.
   *  The formulae divide by the span, so this is the one shape that would
   *  produce NaN if it were not handled. */
  it("folds instead of dividing by zero", () => {
    const cat = solveCatenary(50, 0, 50, 100, 300);
    const pts = points(cat, 25);
    expect(pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true);
    expect(pts[0]).toEqual([50, 0]);
    expect(pts[24]).toEqual([50, 100]);
  });

  it("drops to the depth the spare length allows", () => {
    // 300 of string between ends 100 apart: 200 down, then 100 back up.
    expect(catenaryLowestY(solveCatenary(50, 0, 50, 100, 300))).toBeCloseTo(200, 9);
    // And the same run inverted — the lower pin first.
    expect(catenaryLowestY(solveCatenary(50, 100, 50, 0, 300))).toBeCloseTo(200, 9);
  });

  /** The fold is two straight runs, so every link is exact except the single
   *  one straddling the turn — which can lose up to its own length. */
  it("is as long as the string, bar the one link that straddles the turn", () => {
    const measured = polylineLength(points(solveCatenary(50, 0, 50, 100, 300), 4001));
    expect(measured).toBeLessThanOrEqual(300);
    expect(300 - measured).toBeLessThan(300 / 4000);
  });
});

describe("orientation", () => {
  /** Gravity does not care which end you started from, so neither may the
   *  seed. A mismatch here would make a string jump when a pin re-parent
   *  reversed its node order. */
  it("hangs the same curve whichever end is given first", () => {
    for (const c of CASES) {
      const chord = Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]);
      const length = chord * (1 + c.slack);
      const forward = points(solveCatenary(c.a[0], c.a[1], c.b[0], c.b[1], length), 33);
      const backward = points(solveCatenary(c.b[0], c.b[1], c.a[0], c.a[1], length), 33).reverse();
      for (let i = 0; i < 33; i++) {
        expect(forward[i][0]).toBeCloseTo(backward[i][0], 6);
        expect(forward[i][1]).toBeCloseTo(backward[i][1], 6);
      }
    }
  });

  it("mirrors left to right", () => {
    const right = points(solveCatenary(0, 0, 200, 60, 260), 21);
    const left = points(solveCatenary(0, 0, -200, 60, 260), 21);
    for (let i = 0; i < 21; i++) {
      expect(left[i][0]).toBeCloseTo(-right[i][0], 6);
      expect(left[i][1]).toBeCloseTo(right[i][1], 6);
    }
  });
});

describe("writing into a buffer", () => {
  it("fills the slice it is given and leaves the rest alone", () => {
    const out = new Float64Array(20).fill(-1);
    sampleCatenary(solveCatenary(0, 0, 100, 0, 130), out, 6, 4);
    expect(Array.from(out.slice(0, 4))).toEqual([-1, -1, -1, -1]);
    expect(out[4]).toBe(0);
    expect(out[5]).toBe(0);
    expect(out[14]).toBe(100);
    expect(out[15]).toBe(0);
    expect(Array.from(out.slice(16))).toEqual([-1, -1, -1, -1]);
  });

  it("accepts the two particles a segment can have at minimum, and no fewer", () => {
    const out = new Float64Array(4);
    sampleCatenary(solveCatenary(0, 0, 10, 0, 14), out, 2);
    expect(Array.from(out)).toEqual([0, 0, 10, 0]);
    expect(() => sampleCatenary(solveCatenary(0, 0, 10, 0, 14), out, 1)).toThrow(RangeError);
  });
});

/** Sample the chain rather than the curve. */
function chain(c: Catenary, count: number): Array<[number, number]> {
  const out = new Float64Array(count * 2);
  sampleChain(c, out, count, 0);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) pts.push([out[i * 2], out[i * 2 + 1]]);
  return pts;
}

/** Particles spaced 10-14 board units, per DESIGN section 5.2. */
function particleCount(length: number): number {
  return Math.max(3, Math.round(length / 12) + 1);
}

describe("the chain the solver will actually hold", () => {
  /**
   * AC-62, stated exactly. Every link comes out at the rest length the
   * constraint projection in `verlet.ts` holds it at, so a seeded rope
   * satisfies every constraint it has before the first frame and there is
   * nothing for the solver to correct — asleep or awake.
   *
   * The last link is the one exception worth a word: the endpoint is written
   * from the pin rather than from the solve, so it carries the residual. A
   * part in a trillion of the string's length.
   */
  it.each(CASES.filter((c) => !c.noChain))(
    "holds every link at its rest length — $name",
    (c) => {
      const cat = solveCase(c);
      const count = particleCount(cat.length);
      const nominal = cat.length / (count - 1);
      for (const link of links(chain(cat, count))) {
        // A ten-thousandth of a pixel. The last link carries whatever residual
        // the solve left, because its far end is written from the pin.
        expect(Math.abs(link - nominal)).toBeLessThan(1e-6);
      }
    },
  );

  /**
   * What the chain solve is worth, in board units, on shapes nobody would
   * call a corner case. Two pins a couple of inches apart with a good drape
   * in the string leaves the smooth sample most of a unit out per link — and
   * a link that is 0.7 short is fourteen times the movement that counts as
   * awake, so it would settle visibly the first time anything touched it.
   */
  it.each([
    { name: "a short run between adjacent pins", a: [10, 10], b: [34, 12], slack: 0.4 },
    { name: "a steep run with room to fold", a: [0, 0], b: [40, 260], slack: 0.2 },
    { name: "a level span heavily draped", a: [0, 0], b: [200, 0], slack: 1 },
  ] as Case[])("is even where sampling the smooth curve is not — $name", (c) => {
    const cat = solveCase(c);
    const count = particleCount(cat.length);
    const nominal = cat.length / (count - 1);
    const off = (l: number[]): number => Math.max(...l.map((x) => Math.abs(x - nominal)));
    expect(off(links(points(cat, count)))).toBeGreaterThan(0.03);
    expect(off(links(chain(cat, count)))).toBeLessThan(1e-6);
  });

  /**
   * The fold that is tighter than a link. There is no chain of that link
   * length in tension that closes on both pins, so the solve is expected to
   * give up — and what matters is that it gives up *gracefully*, onto a pose
   * that still draws the right picture and still ends on its pins.
   */
  it("falls back cleanly where no chain closes on both pins", () => {
    const cat = solveCatenary(0, 0, 4, 260, 273);
    const count = particleCount(cat.length);
    const solved = chain(cat, count);
    expect(solved).toEqual(points(cat, count));
    expect(solved[0]).toEqual([0, 0]);
    expect(solved[count - 1]).toEqual([4, 260]);
    expect(solved.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true);
    // It still hangs the way the shape hangs: down past the lower pin and
    // back up. Not all the way to the curve's own bottom at 266.5 — two
    // dozen particles cannot land on the point of a fold that turns inside a
    // third of a board unit, and nothing can make them.
    expect(Math.max(...solved.map((p) => p[1]))).toBeGreaterThan(260);
    expect(catenaryLowestY(cat)).toBeGreaterThan(266);
  });

  it.each(CASES)("still ends on both pins — $name", (c) => {
    const pts = chain(solveCase(c), particleCount(solveCase(c).length));
    expect(pts[0]).toEqual(c.a);
    expect(pts[pts.length - 1]).toEqual(c.b);
  });

  /**
   * The chain and the curve agree about how deep the string hangs — the
   * chain solve reshapes the pose, it does not invent a different one.
   *
   * Within a link, and no tighter, for two reasons that pull opposite ways: a
   * chain of equal links has slightly more material to spend than the curve
   * of the same arc length, because every link cuts a corner, so it wants to
   * hang deeper; but its lowest *vertex* is only at the bottom of the curve
   * when a particle happens to land there, and with an odd number of links on
   * a level span none does. Neither is worth correcting, and asserting the
   * bound instead of a direction is what keeps this test honest about it.
   */
  it.each(CASES)("hangs as deep as the smooth curve does — $name", (c) => {
    const cat = solveCase(c);
    const count = particleCount(cat.length);
    const deepest = Math.max(...chain(cat, count).map((p) => p[1]));
    expect(Math.abs(deepest - catenaryLowestY(cat))).toBeLessThan(cat.length / (count - 1));
  });

  it("falls back to the smooth curve for the shapes with no chain to solve", () => {
    // Pulled straight.
    const taut = chain(solveCatenary(0, 0, 300, 0, 100), 5);
    expect(taut[2][0]).toBeCloseTo(150, 9);
    expect(taut[2][1]).toBeCloseTo(0, 9);
    // A perfectly vertical fold.
    const fold = chain(solveCatenary(50, 0, 50, 100, 300), 25);
    expect(fold.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true);
    expect(Math.max(...fold.map((p) => p[1]))).toBeCloseTo(200, 0);
    // A single link, which cannot express slack at all.
    expect(chain(solveCatenary(0, 0, 100, 0, 160), 2)).toEqual([
      [0, 0],
      [100, 0],
    ]);
  });

  it("writes only the slice it is given", () => {
    const out = new Float64Array(16).fill(-1);
    sampleChain(solveCatenary(0, 0, 100, 0, 130), out, 5, 2);
    expect(out[0]).toBe(-1);
    expect(out[1]).toBe(-1);
    expect(out[2]).toBe(0);
    expect(out[10]).toBe(100);
    expect(out[11]).toBe(0);
    expect(Array.from(out.slice(12))).toEqual([-1, -1, -1, -1]);
    expect(() => sampleChain(solveCatenary(0, 0, 10, 0, 14), out, 1)).toThrow(RangeError);
  });
});
