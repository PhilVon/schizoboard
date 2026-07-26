/**
 * The rope solver, with no scene, no document and no browser.
 *
 * AC-63 is "behaviour is framerate-independent; a stalled tab does not explode
 * on resume", and it splits cleanly in two: the accumulator decides *how many*
 * fixed steps a frame is worth, and the solver only ever sees fixed steps. So
 * the first suite pins the accumulator against wall-clock time, and the rest
 * drive the solver in substeps and never mention frames at all.
 *
 * The suite in the middle is the one that matters most, because it is where
 * T-38 and T-39 have to agree: a rope seeded from the catenary must already
 * satisfy every constraint this file projects. If it does not, the board does
 * not open still.
 */

import { describe, expect, it } from "vitest";

import { sampleChain, solveCatenary, type Catenary } from "@/sim/catenary";
import {
  ROPE_SLEEP_MOVE,
  ROPE_SPACING,
  SIM_MAX_SUBSTEPS,
  SIM_STEP_MS,
} from "@/sim/tuning";
import { FixedStep, stepRope } from "@/sim/verlet";

interface Rope {
  pos: Float64Array;
  prev: Float64Array;
  count: number;
  link: number;
  cat: Catenary;
}

/** A rope at its analytic rest pose, the way `sim/ropes.ts` will create one. */
function seeded(ax: number, ay: number, bx: number, by: number, slack: number): Rope {
  const chord = Math.hypot(bx - ax, by - ay);
  const cat = solveCatenary(ax, ay, bx, by, chord * (1 + slack));
  const count = Math.max(3, Math.round(cat.length / ROPE_SPACING) + 1);
  const pos = new Float64Array(count * 2);
  sampleChain(cat, pos, count);
  return { pos, prev: pos.slice(), count, link: cat.length / (count - 1), cat };
}

/** A rope pulled dead straight between its pins, with all its slack unspent —
 *  the worst starting pose there is, and what seeding exists to avoid. */
function straight(ax: number, ay: number, bx: number, by: number, slack: number): Rope {
  const r = seeded(ax, ay, bx, by, slack);
  for (let i = 0; i < r.count; i++) {
    const t = i / (r.count - 1);
    r.pos[i * 2] = ax + (bx - ax) * t;
    r.pos[i * 2 + 1] = ay + (by - ay) * t;
  }
  r.prev.set(r.pos);
  return r;
}

function step(r: Rope, substeps: number, anchors?: [number, number, number, number]): number {
  const [ax, ay, bx, by] = anchors ?? [
    r.cat.ax,
    r.cat.ay,
    r.cat.bx,
    r.cat.by,
  ];
  return stepRope(r.pos, r.prev, 0, r.count, r.link, ax, ay, bx, by, substeps);
}

/** Settle a rope and report how many substeps it took to go quiet. */
function settle(r: Rope, limit = 4000): number {
  for (let i = 0; i < limit; i++) {
    if (step(r, 1) < ROPE_SLEEP_MOVE) return i + 1;
  }
  return limit;
}

function linkLengths(r: Rope): number[] {
  const out: number[] = [];
  for (let i = 1; i < r.count; i++) {
    out.push(
      Math.hypot(r.pos[i * 2] - r.pos[i * 2 - 2], r.pos[i * 2 + 1] - r.pos[i * 2 - 1]),
    );
  }
  return out;
}

describe("the fixed timestep", () => {
  /** > behaviour doesn't change with frame rate — DESIGN section 5.2 */
  it("spends the same simulated time whatever the display is doing", () => {
    // 30fps is the interesting end: a 33.3ms frame is exactly the four steps
    // the cap allows, so it is the slowest display that still loses no time.
    for (const fps of [30, 60, 90, 144, 240]) {
      const clock = new FixedStep();
      const frameMs = 1000 / fps;
      let steps = 0;
      for (let f = 0; f < 2 * fps; f++) steps += clock.advance(frameMs);
      // Two seconds at 120 Hz is 240 steps, bar whatever is still in the
      // accumulator when the loop stops.
      expect(steps).toBeGreaterThanOrEqual(239);
      expect(steps).toBeLessThanOrEqual(240);
    }
  });

  it("never runs more than the four substeps a frame is allowed", () => {
    const clock = new FixedStep();
    expect(clock.advance(60_000)).toBe(SIM_MAX_SUBSTEPS);
    expect(clock.advance(5_000)).toBe(SIM_MAX_SUBSTEPS);
  });

  /** The cap discards time rather than deferring it. A minute in the
   *  accumulator paid back four substeps at a time would take a minute of
   *  frames to work through, which is the freeze it exists to prevent. */
  it("throws the excess away rather than owing it back", () => {
    const clock = new FixedStep();
    clock.advance(60_000);
    expect(clock.pending).toBeLessThan(SIM_STEP_MS);
    expect(clock.advance(0)).toBe(0);
  });

  it("carries the remainder so fast frames still add up", () => {
    const clock = new FixedStep();
    // Three frames at 144 Hz is 20.8ms, which is two and a half fixed steps.
    const frame = 1000 / 144;
    expect(clock.advance(frame) + clock.advance(frame) + clock.advance(frame)).toBe(2);
    expect(clock.pending).toBeCloseTo(3 * frame - 2 * SIM_STEP_MS, 9);
  });

  it("forgets its carried time on reset", () => {
    const clock = new FixedStep();
    clock.advance(7);
    clock.reset();
    expect(clock.pending).toBe(0);
  });
});

describe("a rope seeded from the catenary", () => {
  const CASES: Array<[string, number, number, number, number, number]> = [
    ["a level span", 0, 0, 200, 0, 0.12],
    ["a level span heavily draped", 0, 0, 200, 0, 1],
    ["a run that climbs", 0, 0, 300, -180, 0.2],
    ["a run laid out right to left", 400, 50, 100, -20, 0.3],
    ["a short run between adjacent pins", 10, 10, 34, 12, 0.4],
    ["a steep run with room to fold", 0, 0, 40, 260, 0.2],
  ];

  /**
   * AC-62 and AC-63 shaking hands, and the reason the seed is worth having.
   *
   * A rope created from the catenary is marked asleep and never stepped, so
   * the board opens still whatever this number is. What it measures is what
   * happens the first time something *does* wake it: under a board unit, all
   * of it in the first step, and then nothing. Simulating from a straight line
   * instead moves the same rope through 60 board units of whip-crack.
   */
  it.each(CASES)("barely moves when something wakes it — %s", (_n, ax, ay, bx, by, slack) => {
    const r = seeded(ax, ay, bx, by, slack);
    expect(step(r, 1)).toBeLessThan(1);
  });

  it.each(CASES)("stays where it was seeded — %s", (_n, ax, ay, bx, by, slack) => {
    const r = seeded(ax, ay, bx, by, slack);
    const before = r.pos.slice();
    for (let i = 0; i < 240; i++) step(r, 1);
    for (let i = 0; i < r.pos.length; i++) {
      expect(Math.abs(r.pos[i] - before[i])).toBeLessThan(1);
    }
  });

  it.each(CASES)("goes quiet, and quickly — %s", (_n, ax, ay, bx, by, slack) => {
    const r = seeded(ax, ay, bx, by, slack);
    // A tenth of a second. `ropes.ts` wants twelve consecutive still steps
    // before it sleeps a rope, so anything in this range sleeps promptly.
    expect(settle(r, 120)).toBeLessThan(120);
  });

  /**
   * The working point `ROPE_SUBSTEPS` was chosen at, asserted rather than
   * remembered. Position-based dynamics holds a load by holding a violation,
   * so a rope under gravity always settles a little longer than its rest
   * length — at six passes and no substepping that "little" was 23% and the
   * rope was frankly elastic. A tenth of a board unit is the budget the
   * measurements in `tuning.ts` bought, and it is well under a pixel.
   */
  it.each(CASES)("holds its length to a tenth of a board unit — %s", (_n, ax, ay, bx, by, s) => {
    const r = seeded(ax, ay, bx, by, s);
    settle(r);
    for (const len of linkLengths(r)) {
      expect(Math.abs(len - r.link)).toBeLessThan(0.1);
      // And always long rather than short: gravity stretches a rope, it never
      // compresses one, so a short link would mean the solver had overshot.
      expect(len).toBeGreaterThan(r.link - 1e-6);
    }
  });
});

describe("the constraint projection", () => {
  /**
   * The alternating sweep, measured. A rope carries its weight to both
   * anchors, and sweeping the same direction six times only ever carries it
   * to one — the rope then hangs below where its own rest length says it can
   * reach. Every link landing on its rest length from the worst possible
   * start is the assertion that this is not happening.
   */
  it("pulls every link back to its rest length from a dead straight start", () => {
    const r = straight(0, 0, 200, 0, 0.3);
    settle(r);
    for (const len of linkLengths(r)) expect(len / r.link).toBeCloseTo(1, 2);
  });

  it("finds the shape the catenary predicted, from a start that is nothing like it", () => {
    const r = straight(0, 0, 200, 0, 0.3);
    settle(r);
    const seed = seeded(0, 0, 200, 0, 0.3);
    // The deepest point is the whole visible character of a hanging string.
    const sag = (p: Float64Array): number => {
      let low = 0;
      for (let i = 1; i < p.length; i += 2) low = Math.max(low, p[i]);
      return low;
    };
    expect(sag(r.pos)).toBeCloseTo(sag(seed.pos), 0);
  });

  it("hangs downward, not upward", () => {
    const r = straight(0, 0, 200, 0, 0.3);
    settle(r);
    for (let i = 3; i < r.pos.length - 2; i += 2) expect(r.pos[i]).toBeGreaterThan(0);
  });

  it("always leaves both ends exactly on their pins", () => {
    const r = seeded(0, 0, 200, 0, 0.2);
    step(r, 3, [5, -7, 190, 40]);
    expect(r.pos[0]).toBe(5);
    expect(r.pos[1]).toBe(-7);
    expect(r.pos[r.pos.length - 2]).toBe(190);
    expect(r.pos[r.pos.length - 1]).toBe(40);
  });

  it("carries a moved pin into the rope rather than stretching one link", () => {
    const r = seeded(0, 0, 200, 0, 0.2);
    const before = r.pos[2];
    step(r, 4, [-60, 0, 200, 0]);
    // The particle next to the pin has come with it, and the link joining
    // them is still a link rather than a rubber band.
    expect(r.pos[2]).toBeLessThan(before);
    expect(Math.hypot(r.pos[2] - r.pos[0], r.pos[3] - r.pos[1]) / r.link).toBeCloseTo(1, 1);
  });
});

describe("degenerate ropes", () => {
  it("does nothing to a two-particle segment but sit it on its pins", () => {
    const pos = new Float64Array([0, 0, 0, 0]);
    const prev = new Float64Array(4);
    expect(stepRope(pos, prev, 0, 2, 50, 1, 2, 3, 4, 8)).toBe(0);
    expect(Array.from(pos)).toEqual([1, 2, 3, 4]);
  });

  it("still seats the pins on a frame that is worth no substeps", () => {
    const r = seeded(0, 0, 200, 0, 0.2);
    expect(step(r, 0, [9, 9, 191, 3])).toBe(0);
    expect(r.pos[0]).toBe(9);
    expect(r.pos[r.pos.length - 1]).toBe(3);
  });

  it("survives every particle landing on the same point", () => {
    const count = 6;
    const pos = new Float64Array(count * 2);
    const prev = new Float64Array(count * 2);
    stepRope(pos, prev, 0, count, 12, 0, 0, 0, 0, 4);
    expect(Array.from(pos).every(Number.isFinite)).toBe(true);
  });

  it("works on a slice of a shared buffer without touching its neighbours", () => {
    const r = seeded(0, 0, 200, 0, 0.2);
    const pad = 6;
    const pos = new Float64Array(r.pos.length + pad * 2).fill(-999);
    const prev = new Float64Array(pos.length).fill(-999);
    pos.set(r.pos, pad);
    prev.set(r.prev, pad);
    stepRope(pos, prev, pad, r.count, r.link, 0, 0, 200, 0, 2);
    for (let i = 0; i < pad; i++) expect(pos[i]).toBe(-999);
    for (let i = pad + r.pos.length; i < pos.length; i++) expect(pos[i]).toBe(-999);
  });
});

describe("a stalled tab", () => {
  /** The other half of AC-63. Four substeps is 33ms of simulation, so a rope
   *  that was mid-swing resumes mid-swing rather than somewhere on the far
   *  side of the board. */
  it("resumes without exploding", () => {
    const r = straight(0, 0, 200, 0, 0.3);
    const clock = new FixedStep();
    step(r, clock.advance(1000 / 60));
    step(r, clock.advance(120_000));
    for (const v of r.pos) expect(Number.isFinite(v)).toBe(true);
    // Nothing has been flung off the board: four substeps of gravity cannot
    // carry a particle further than a few board units.
    for (let i = 1; i < r.pos.length; i += 2) expect(r.pos[i]).toBeLessThan(40);
    settle(r);
    for (const len of linkLengths(r)) expect(len / r.link).toBeCloseTo(1, 2);
  });

  /**
   * Framerate independence end to end: the same wall-clock time, delivered in
   * very different sized pieces, settles the same rope to the same shape.
   */
  it("settles to the same shape at 30fps as at 144fps", () => {
    const poses = [1000 / 30, 1000 / 60, 1000 / 144].map((frameMs) => {
      const r = straight(0, 0, 200, 0, 0.3);
      const clock = new FixedStep();
      for (let elapsed = 0; elapsed < 6000; elapsed += frameMs) {
        step(r, clock.advance(frameMs));
      }
      return r.pos;
    });
    // Thousandths of a board unit apart after six seconds of very differently
    // sized frames. Not bit-identical, and it could not be: the accumulator
    // hands out whole steps, so at any given instant two displays are up to
    // one step out of phase with each other.
    for (let i = 0; i < poses[0].length; i++) {
      expect(poses[1][i]).toBeCloseTo(poses[0][i], 2);
      expect(poses[2][i]).toBeCloseTo(poses[0][i], 2);
    }
  });
});
