/**
 * The stroke codec, with nothing else in the room — no document, no scene, no
 * browser. `lib/` is dependency-free and this is the whole of what that buys:
 * every assertion below is about bytes and points.
 *
 * The failures worth catching here are quiet ones. A codec that loses a little
 * precision still produces a stroke, a simplify that drops the wrong points still
 * produces a stroke, and a bbox that is a rounding error too small still culls
 * almost correctly — all three look like a mark somebody drew.
 */

import { describe, expect, it } from "vitest";

import type { InkSample } from "@/lib/ink";
import {
  INK_EPSILON,
  INK_STEPS_PER_UNIT,
  packStroke,
  simplifyStroke,
  unpackStroke,
} from "@/lib/strokepack";

function at(x: number, y: number, pressure = 0.5): InkSample {
  return { x, y, pressure };
}

/** A straight run, evenly spaced, at one constant pressure. */
function straight(count: number, step = 3, pressure = 0.5): InkSample[] {
  const samples: InkSample[] = [];
  for (let i = 0; i < count; i++) samples.push(at(i * step, 0, pressure));
  return samples;
}

/** How far a point is off the segment `a`-`b`. */
function offSegment(a: InkSample, b: InkSample, p: InkSample): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

/** The closest any input segment comes to `p` — how far the packed stroke has
 *  wandered off the path the hand actually drew. */
function offPath(path: readonly InkSample[], p: InkSample): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    best = Math.min(best, offSegment(path[i]!, path[i + 1]!, p));
  }
  return best;
}

describe("the round trip", () => {
  it("brings back a stroke that is still on the path the hand drew", () => {
    // A curve with real detail in it, so the simplify has something to do.
    const drawn: InkSample[] = [];
    for (let i = 0; i <= 200; i++) {
      const t = i / 20;
      drawn.push(at(t * 12, Math.sin(t) * 40, 0.3 + 0.35 * Math.sin(t * 3)));
    }

    const back = unpackStroke(packStroke(drawn).pts);

    // The simplify is allowed to move a point by `epsilon`, and the quantise by
    // half a step on each axis on top of that. Nothing may move further.
    const slack = INK_EPSILON + Math.SQRT2 / (2 * INK_STEPS_PER_UNIT);
    for (const p of back) expect(offPath(drawn, p)).toBeLessThanOrEqual(slack);
    expect(back.length).toBeGreaterThan(4);
    expect(back.length).toBeLessThan(drawn.length);
  });

  it("keeps the two ends exactly, because they are where the mark starts and stops", () => {
    // Both ends chosen on the eighth grid, so the only thing that could move
    // them is the simplify — which is never allowed to drop an endpoint.
    const drawn = [at(-3.5, 12.25, 0.2), ...straight(40), at(400.125, -8.875, 0.9)];
    const back = unpackStroke(packStroke(drawn).pts);
    const last = back[back.length - 1]!;

    expect([back[0]!.x, back[0]!.y]).toEqual([-3.5, 12.25]);
    expect([last.x, last.y]).toEqual([400.125, -8.875]);
    // Pressure is a byte, so it comes back to within half of one — 0.9 is not on
    // the grid and 230/255 is the nearest thing that is.
    expect(last.pressure).toBeCloseTo(0.9, 2);
  });

  it("puts every point on the eighth-of-a-unit grid", () => {
    const back = unpackStroke(packStroke([at(1.03, -2.97, 0.31), at(90.61, 45.19, 0.77)]).pts);
    for (const p of back) {
      expect(Number.isInteger(p.x * INK_STEPS_PER_UNIT)).toBe(true);
      expect(Number.isInteger(p.y * INK_STEPS_PER_UNIT)).toBe(true);
    }
  });

  it("survives coordinates to the left of and above the origin", () => {
    // Board space runs negative in both axes, and zigzag is the whole reason a
    // varint stays one byte there instead of five.
    const drawn = [at(-1200.5, -840.25, 0.1), at(-1195.5, -836.25, 0.9)];
    const back = unpackStroke(packStroke(drawn).pts);
    expect(back[0]!.x).toBeCloseTo(-1200.5, 6);
    expect(back[0]!.y).toBeCloseTo(-840.25, 6);
    expect(back[1]!.x).toBeCloseTo(-1195.5, 6);
  });

  it("survives a board too wide for eighths to fit in an int32", () => {
    // 2^31 eighths is a board about 268 million units across. Nobody will make
    // one — but a shift-based zigzag would wrap silently rather than fail, and
    // the stroke would come back somewhere else entirely.
    const far = 500_000_000;
    const back = unpackStroke(packStroke([at(far, -far, 0.5), at(far + 4, -far + 4, 0.5)]).pts);
    expect(back[0]!.x).toBe(far);
    expect(back[0]!.y).toBe(-far);
    expect(back[1]!.x).toBe(far + 4);
  });

  it("carries pressure back at a resolution finer than the nib can show", () => {
    const drawn = [at(0, 0, 0), at(4, 0, 0.333), at(8, 0, 1)];
    const back = unpackStroke(packStroke(drawn).pts);
    expect(back[0]!.pressure).toBe(0);
    expect(back[back.length - 1]!.pressure).toBe(1);
    for (const p of back) {
      expect(p.pressure).toBeGreaterThanOrEqual(0);
      expect(p.pressure).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * AC-79 — "input points stored, never the generated outline".
 *
 * The test is that what comes back is *on the path*. An outline is the path
 * pushed out by half a nib on either side, so a codec that had stored one would
 * bring back points that miss the path by about three units on a default stroke,
 * and twice as many of them.
 */
describe("what is stored", () => {
  it("is the path, not the shape the path makes", () => {
    const drawn = straight(30, 4, 0.8);
    const packed = packStroke(drawn);
    const back = unpackStroke(packed.pts);

    // Every point on the line the hand drew, not offset from it by a nib.
    for (const p of back) expect(Math.abs(p.y)).toBeLessThanOrEqual(INK_EPSILON);
    // And no more points than the hand delivered. An outline has two per sample
    // plus its caps.
    expect(back.length).toBeLessThanOrEqual(drawn.length);
  });

  it("costs a few bytes a point, which is what the packing is for", () => {
    const drawn: InkSample[] = [];
    for (let i = 0; i < 300; i++) {
      // A wandering path, so almost nothing simplifies away.
      drawn.push(at(i * 2.5, Math.sin(i) * 9, 0.5 + 0.4 * Math.sin(i * 0.7)));
    }
    const packed = packStroke(drawn);
    const back = unpackStroke(packed.pts);

    // > Roughly 3-4 bytes per point against 50-odd for JSON floats.
    // > - DATA-MODEL section 6.1
    expect(packed.pts.length / back.length).toBeLessThan(5);
    expect(packed.pts.length).toBeLessThan(JSON.stringify(drawn).length / 8);
  });
});

/** Invariant 7 — "a stroke's `bbox` always contains its unpacked points". */
describe("the bounding box", () => {
  it("contains every point that comes back out", () => {
    const drawn: InkSample[] = [];
    for (let i = 0; i <= 120; i++) drawn.push(at(Math.cos(i / 9) * 77.3, Math.sin(i / 7) * 41.9));
    const packed = packStroke(drawn);

    for (const p of unpackStroke(packed.pts)) {
      expect(p.x).toBeGreaterThanOrEqual(packed.bbox[0]);
      expect(p.y).toBeGreaterThanOrEqual(packed.bbox[1]);
      expect(p.x).toBeLessThanOrEqual(packed.bbox[2]);
      expect(p.y).toBeLessThanOrEqual(packed.bbox[3]);
    }
  });

  it("is measured after the quantise, not before it", () => {
    // 10.1 quantises *up* to 10.125, which is outside a box measured off the raw
    // samples. A sixteenth of a unit is not visible and is still a broken
    // invariant.
    const packed = packStroke([at(0, 0), at(10.1, 10.1)]);
    const back = unpackStroke(packed.pts);
    const last = back[back.length - 1]!;
    expect(last.x).toBe(10.125);
    expect(last.x).toBeGreaterThan(10.1);
    expect(packed.bbox[2]).toBeGreaterThanOrEqual(last.x);
    expect(packed.bbox[3]).toBeGreaterThanOrEqual(last.y);
  });
});

describe("the simplify", () => {
  it("drops the middle of a straight run drawn at one pressure", () => {
    expect(simplifyStroke(straight(50))).toHaveLength(2);
  });

  /**
   * The failure that geometry alone cannot see. Every point of this stroke is
   * exactly on the chord, so plain RDP keeps two of them and the bulge where the
   * hand slowed goes with the rest — a stroke that came back as a tapered
   * rectangle.
   */
  it("keeps the bulge in a straight stroke that changed width", () => {
    const drawn: InkSample[] = [];
    for (let i = 0; i <= 40; i++) drawn.push(at(i * 4, 0, 0.15 + 0.8 * Math.sin((i / 40) * Math.PI)));
    const kept = simplifyStroke(drawn);

    expect(kept.length).toBeGreaterThan(4);
    expect(Math.max(...kept.map((p) => p.pressure))).toBeGreaterThan(0.9);
  });

  it("ignores a pressure wobble too small to move the edge of the mark", () => {
    const drawn: InkSample[] = [];
    for (let i = 0; i <= 40; i++) drawn.push(at(i * 4, 0, 0.5 + 0.002 * Math.sin(i)));
    expect(simplifyStroke(drawn)).toHaveLength(2);
  });

  it("keeps a corner, which is the point of the whole exercise", () => {
    const kept = simplifyStroke([...straight(20), ...straight(20).map((p) => at(57, p.x))]);
    expect(kept.length).toBeGreaterThanOrEqual(3);
  });

  it("does not blow the stack on a stroke where every point survives", () => {
    // A staircase: nothing is collinear with anything, so the recursion the
    // textbook version does would go one frame per point.
    const drawn: InkSample[] = [];
    for (let i = 0; i < 6000; i++) drawn.push(at(i * 2, i % 2 === 0 ? 0 : 9));
    expect(() => simplifyStroke(drawn)).not.toThrow();
    expect(simplifyStroke(drawn).length).toBeGreaterThan(1000);
  });

  /**
   * A hand on a 1000 Hz mouse delivers the same path as a hand on a 125 Hz one,
   * sampled harder. The simplify has to be indifferent to that, or the size of a
   * stroke on disk would depend on the pointing device that drew it.
   *
   * Measured on a real stroke off the running board: resampling it from 34
   * samples to 1131 along its own segments produced byte-identical output.
   */
  it("is indifferent to how hard the path was sampled", () => {
    const sparse: InkSample[] = [];
    for (let i = 0; i <= 30; i++) sparse.push(at(i * 9, Math.sin(i / 4) * 30, 0.4 + i / 100));

    const dense: InkSample[] = [];
    for (let i = 0; i + 1 < sparse.length; i++) {
      const a = sparse[i]!;
      const b = sparse[i + 1]!;
      for (let k = 0; k < 12; k++) {
        const t = k / 12;
        dense.push(
          at(
            a.x + (b.x - a.x) * t,
            a.y + (b.y - a.y) * t,
            a.pressure + (b.pressure - a.pressure) * t,
          ),
        );
      }
    }
    dense.push(sparse[sparse.length - 1]!);

    expect(Array.from(packStroke(dense).pts)).toEqual(Array.from(packStroke(sparse).pts));
  });

  it("leaves a stroke with nothing between its ends alone", () => {
    expect(simplifyStroke([])).toEqual([]);
    expect(simplifyStroke([at(1, 2)])).toEqual([at(1, 2)]);
    expect(simplifyStroke([at(1, 2), at(3, 4)])).toEqual([at(1, 2), at(3, 4)]);
  });

  it("does not hand back the caller's array", () => {
    const drawn = [at(1, 2), at(3, 4)];
    expect(simplifyStroke(drawn)).not.toBe(drawn);
  });
});

describe("the awkward inputs", () => {
  it("packs a gesture that produced nothing into nothing", () => {
    const packed = packStroke([]);
    expect(packed.pts).toHaveLength(0);
    expect(packed.bbox).toEqual([0, 0, 0, 0]);
    expect(unpackStroke(packed.pts)).toEqual([]);
  });

  it("packs a dot, because a press that never moved is still a mark", () => {
    const packed = packStroke([at(12.5, -4.25, 0.6)]);
    const back = unpackStroke(packed.pts);
    expect(back).toHaveLength(1);
    expect(back[0]!.x).toBe(12.5);
    expect(back[0]!.y).toBe(-4.25);
    expect(packed.bbox).toEqual([12.5, -4.25, 12.5, -4.25]);
  });

  it("returns what it can from a buffer that stops mid-point", () => {
    const full = packStroke([at(0, 0), at(40, 0), at(80, 40)]).pts;
    const torn = full.slice(0, full.length - 1);

    // A repaired log tail or a peer on another version of this file. A stroke one
    // point short is a mark that ends early; an exception in phase 6 is a board
    // that will not draw at all.
    expect(() => unpackStroke(torn)).not.toThrow();
    expect(unpackStroke(torn).length).toBeLessThan(3);
  });

  it("clamps a pressure reading that was never in range", () => {
    const back = unpackStroke(packStroke([at(0, 0, -2), at(9, 0, 4)]).pts);
    expect(back[0]!.pressure).toBe(0);
    expect(back[1]!.pressure).toBe(1);
  });
});
