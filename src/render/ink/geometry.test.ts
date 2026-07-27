/**
 * The stroke's shape.
 *
 * No canvas and no `Path2D` here, and none needed: `traceOutline` writes into a
 * `PathSink`, so the property AC-76 is about — *curves, not lines* — is a thing a
 * recorder can check. That is the whole reason the sink exists.
 */

import { describe, expect, it } from "vitest";

import type { InkSample } from "@/lib/ink";
import {
  outlineStroke,
  strokeOptions,
  traceOutline,
  type OutlinePoint,
  type PathSink,
} from "@/render/ink/geometry";

interface Move {
  readonly to: OutlinePoint;
}
interface Curve {
  readonly control: OutlinePoint;
  readonly to: OutlinePoint;
}

class Recorder implements PathSink {
  readonly moves: Move[] = [];
  readonly curves: Curve[] = [];
  closes = 0;
  /** Nothing in this module may call it — a filled outline is not a stroked
   *  line, and a `lineTo` in here is the facetting AC-76 forbids. */
  readonly lines: OutlinePoint[] = [];

  moveTo(x: number, y: number): void {
    this.moves.push({ to: [x, y] });
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.curves.push({ control: [cx, cy], to: [x, y] });
  }
  lineTo(x: number, y: number): void {
    this.lines.push([x, y]);
  }
  closePath(): void {
    this.closes++;
  }
}

/** A square, which has the sharpest corners a polygon can have and is therefore
 *  the clearest place to see whether they were rounded. */
const SQUARE: readonly OutlinePoint[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

function midpoint(a: OutlinePoint, b: OutlinePoint): OutlinePoint {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** Where a quadratic actually is, halfway along. */
function quadraticAt(from: OutlinePoint, curve: Curve, t: number): OutlinePoint {
  const u = 1 - t;
  return [
    u * u * from[0] + 2 * u * t * curve.control[0] + t * t * curve.to[0],
    u * u * from[1] + 2 * u * t * curve.control[1] + t * t * curve.to[1],
  ];
}

/** A stroke drawn fast: four samples, tens of units apart, along an arc. This is
 *  the input AC-76 is about — a slow stroke has enough samples to look smooth
 *  however it is traced. */
function fastArc(): InkSample[] {
  return [
    { x: 0, y: 0, pressure: 0.5 },
    { x: 60, y: 30, pressure: 0.5 },
    { x: 120, y: 30, pressure: 0.5 },
    { x: 180, y: 0, pressure: 0.5 },
  ];
}

describe("traceOutline", () => {
  it("lays a curve along every edge and never a line", () => {
    const sink = new Recorder();
    expect(traceOutline(SQUARE, sink)).toBe(true);

    expect(sink.lines).toEqual([]);
    // Exactly one per vertex: the first vertex is the control point of the last
    // curve rather than of the first, which is how the path gets back to where
    // `moveTo` started.
    expect(sink.curves).toHaveLength(SQUARE.length);
    expect(sink.moves).toHaveLength(1);
    expect(sink.closes).toBe(1);
  });

  it("rounds the polygon's corners off rather than passing through them", () => {
    const sink = new Recorder();
    traceOutline(SQUARE, sink);

    // Each vertex is a *control* point, so the path bends toward it without
    // reaching it — which is what stops a coarse outline reading as faceted.
    for (const [i, curve] of sink.curves.entries()) {
      expect(curve.control).toEqual(SQUARE[(i + 1) % SQUARE.length]);
    }
    const corner = SQUARE[1]!;
    const onCurve = [sink.moves[0]!.to, ...sink.curves.map((c) => c.to)];
    for (const point of onCurve) expect(point).not.toEqual(corner);

    // And concretely: halfway along the curve whose control point is that
    // corner, the path is a good distance inside it.
    const halfway = quadraticAt(sink.moves[0]!.to, sink.curves[0]!, 0.5);
    const inset = Math.hypot(halfway[0] - corner[0], halfway[1] - corner[1]);
    // A quarter of the 10-unit edge, which for a right-angled corner is as much
    // rounding as midpoint smoothing can give and plenty to see.
    expect(inset).toBeCloseTo(1.77, 2);
  });

  it("closes the loop with a curve, so the seam is not the one flat edge", () => {
    const sink = new Recorder();
    traceOutline(SQUARE, sink);

    // The last curve has to land back exactly where `moveTo` started, or
    // `closePath` joins the gap with a straight line — at the start of the
    // stroke, which is the end most likely to be under the cursor.
    const last = sink.curves[sink.curves.length - 1]!;
    expect(last.to).toEqual(sink.moves[0]!.to);
    expect(last.to).toEqual(midpoint(SQUARE[0]!, SQUARE[1]!));
  });

  it("draws nothing for an outline too small to be a polygon", () => {
    for (const degenerate of [[], [[0, 0]], [[0, 0], [1, 1]]] as OutlinePoint[][]) {
      const sink = new Recorder();
      expect(traceOutline(degenerate, sink)).toBe(false);
      expect(sink.moves).toEqual([]);
      expect(sink.closes).toBe(0);
    }
  });
});

describe("outlineStroke", () => {
  it("wraps the samples in a polygon that has area", () => {
    const outline = outlineStroke(fastArc(), strokeOptions("marker", 8, true));
    expect(outline.length).toBeGreaterThan(8);

    // Every vertex is within a nib's reach of the path the hand took, which is
    // the sanity check that these are an outline and not something else.
    const xs = outline.map((p) => p[0]);
    const ys = outline.map((p) => p[1]);
    expect(Math.min(...xs)).toBeGreaterThan(-20);
    expect(Math.max(...xs)).toBeLessThan(200);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(8);
  });

  it("has nothing to say about no samples at all", () => {
    expect(outlineStroke([], strokeOptions("marker", 8, false))).toEqual([]);
  });

  it("gets wider with the size it is given, which is how zoom reaches it", () => {
    const straight: InkSample[] = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 100, y: 0, pressure: 0.5 },
    ];
    const spread = (size: number): number => {
      const ys = outlineStroke(straight, strokeOptions("highlighter", size, true)).map((p) => p[1]);
      return Math.max(...ys) - Math.min(...ys);
    };
    // `render/ink/wet.ts` multiplies the board width by the zoom on the way in,
    // because ink is a mark on the paper and gets bigger as you lean in.
    expect(spread(24)).toBeGreaterThan(spread(6) * 2);
  });
});

describe("strokeOptions", () => {
  it("varies a marker's width with pressure and holds a highlighter's steady", () => {
    // > **Marker** — opaque, pressure and velocity varying width [...]
    // > **Highlighter** — translucent, flat cap, near-constant width.
    // > — DESIGN section 2.4
    const marker = strokeOptions("marker", 6, true);
    const highlighter = strokeOptions("highlighter", 6, true);
    expect(marker.thinning!).toBeGreaterThan(0.4);
    expect(highlighter.thinning!).toBeLessThan(0.1);
    // Not *zero*, though: a perfectly constant width reads as a UI element.
    expect(highlighter.thinning!).toBeGreaterThan(0);
  });

  it("tapers a marker's ends and leaves a highlighter's flat", () => {
    expect(strokeOptions("marker", 6, true).end!.taper).toBeGreaterThan(0);
    const flat = strokeOptions("highlighter", 6, true);
    expect(flat.start!.cap).toBe(false);
    expect(flat.end!.cap).toBe(false);
    expect(flat.end!.taper).toBe(0);
  });

  it("passes the size and the finished flag through untouched", () => {
    expect(strokeOptions("marker", 11.5, false)).toMatchObject({ size: 11.5, last: false });
    expect(strokeOptions("marker", 11.5, true)).toMatchObject({ last: true });
  });

  it("never lets perfect-freehand simulate the pressure itself", () => {
    // Left on, it overrides the pressure on every sample — throwing away a pen's
    // real reading and replacing it with a guess derived from the gaps between
    // points, which on a board that keeps every coalesced sample reads a fast
    // hand as a slow one. `lib/pressure.ts` does this properly.
    expect(strokeOptions("marker", 6, true).simulatePressure).toBe(false);
    expect(strokeOptions("highlighter", 6, true).simulatePressure).toBe(false);
  });
});

/**
 * The measurement AC-76 is actually about: how far the drawn edge strays from the
 * straight line between the same two points.
 *
 * A traced quadratic bows away from its chord; a `lineTo` between the same
 * endpoints *is* the chord. So the maximum deviation over the outline is a number
 * that separates a smooth fill from a faceted one, and on a fast stroke — few
 * samples, far apart — it is a distance you can see rather than a rounding error.
 */
describe("a fast stroke, measured", () => {
  it("bows away from the polygon it would otherwise be", () => {
    const outline = outlineStroke(fastArc(), strokeOptions("marker", 10, true));
    const sink = new Recorder();
    expect(traceOutline(outline, sink)).toBe(true);

    let worst = 0;
    let from = sink.moves[0]!.to;
    for (const curve of sink.curves) {
      const mid = quadraticAt(from, curve, 0.5);
      const chord = midpoint(from, curve.to);
      worst = Math.max(worst, Math.hypot(mid[0] - chord[0], mid[1] - chord[1]));
      from = curve.to;
    }
    // Sub-pixel would mean the curves are cosmetic and the fill is a polygon in
    // all but name.
    expect(worst).toBeGreaterThan(1);
  });
});
