/**
 * Stroke geometry — the shape a marker leaves.
 *
 * > Stroke geometry comes from `perfect-freehand`, which turns an input polyline
 * > into an *outline polygon* that gets filled — not a stroked line.
 * > — DESIGN section 6.5
 *
 * That distinction is the whole reason this module exists rather than a
 * `ctx.stroke()` call with a round cap. A stroked polyline has one width for its
 * whole length; ink does not. A marker tapers where it lifts, swells where it
 * slows and thins where it is dragged fast, and none of that is expressible as a
 * line width — it is a *shape*, and the shape is a closed polygon around the
 * path the hand took.
 *
 * ## Why the outline is filled through curves rather than lines
 *
 * `getStroke` returns the polygon as a list of vertices, and the obvious way to
 * fill it is `moveTo` then `lineTo` for each. That is also the thing AC-76 is
 * about: at speed the input is a handful of samples tens of pixels apart, the
 * polygon has correspondingly few vertices, and a straight-edged fill between
 * them reads as a bent tube — visibly faceted, worst exactly where a stroke is
 * fastest and the eye is following it.
 *
 * So [`traceOutline`] walks the vertices in pairs and lays a quadratic through
 * the *midpoints*, using each vertex as its control point. Every edge of the
 * polygon becomes a curve whose tangent is continuous with its neighbours, which
 * is smooth for free and costs the same number of path commands as the lines
 * would have.
 *
 * ## The sink, and why this file never touches a canvas
 *
 * [`traceOutline`] writes into a [`PathSink`] — three methods, which both
 * `Path2D` and `CanvasRenderingContext2D` satisfy structurally. It is a seam for
 * the same reason `render/overlay.ts` takes a `RopeGeometry` shape rather than
 * the simulation: happy-dom has neither of those two objects, so the property
 * worth pinning down — *curves, not lines* — would otherwise only be checkable
 * in a browser, which is to say never.
 */

import { getStroke, type StrokeOptions } from "perfect-freehand";

import type { InkSample, InkTool } from "@/lib/ink";

/**
 * The two option sets, and every number in them is a taste call made once.
 *
 * `thinning` is the headline difference and the one DESIGN section 2.4 names
 * twice: a marker's width is meant to vary with pressure and velocity, and a
 * highlighter's is meant not to. A chisel tip laid on paper puts down a band of
 * one width whatever the hand does, so a highlighter that tapered would read as
 * a felt-tip in the wrong colour.
 *
 * `streamline` is the input filter — how much of the hand's tremor is smoothed
 * out before the outline is built. Higher is smoother and laggier; the marker
 * gets a little because handwriting benefits from it, and the highlighter gets
 * more because nobody is writing with one.
 *
 * The taper is on the start and end of a marker only, and it is small: DESIGN
 * says "slight". A long taper reads as a calligraphy nib.
 */
const OPTIONS: Readonly<Record<InkTool, StrokeOptions>> = {
  marker: {
    thinning: 0.55,
    smoothing: 0.5,
    streamline: 0.42,
    start: { taper: 4, cap: true },
    end: { taper: 12, cap: true },
  },
  highlighter: {
    // Not zero. A perfectly constant width is a rectangle with rounded ends and
    // reads as a UI element; a hair of variation is the ink pooling where the
    // hand slowed, which is what makes it look laid down rather than drawn.
    thinning: 0.06,
    smoothing: 0.62,
    streamline: 0.55,
    // > flat cap — DESIGN section 2.4. `cap: false` with no taper is what
    // perfect-freehand calls a flat end, and it is why two highlighter strokes
    // laid end to end join without a bulge at the seam.
    start: { cap: false, taper: 0 },
    end: { cap: false, taper: 0 },
  },
  // The smudge, and it is the marker's geometry exactly. A rubber under a hand
  // thins and tapers the way a pen does — the difference between the two is
  // entirely in the compositing (`render/ink/dry.ts`), which is what makes one a
  // mark and the other a hole. Written out rather than aliased so that a change
  // to the marker's feel does not silently become a change to the eraser's.
  erase: {
    thinning: 0.55,
    smoothing: 0.5,
    streamline: 0.42,
    start: { taper: 4, cap: true },
    end: { taper: 12, cap: true },
  },
};

/**
 * The options for one stroke.
 *
 * `size` is a diameter in whatever space the samples are in, which is the one
 * place the caller's choice of space reaches this module: a wet stroke passes
 * board width times zoom, because ink is *on the paper* and gets bigger as you
 * lean in. That is the opposite of `render/ropes/paint.ts`, whose widths are
 * fixed in screen pixels at every zoom — and correctly so, because a string is
 * an object in front of the board rather than a mark on it.
 *
 * `last` is false while the stroke is still being drawn and true once the pen is
 * up. It is not cosmetic: with `last: false` perfect-freehand leaves the end of
 * the outline open and unsmoothed, because more points are coming and committing
 * to an end cap would make the tip of a live stroke jitter as each sample lands.
 *
 * `simulatePressure` is **off**, always, and that is the one option here that is
 * a correctness setting rather than a taste call.
 *
 * `perfect-freehand` has a simulation of its own and, left on, it *overrides* the
 * pressure on every sample it is given — so a pen's real reading would be thrown
 * away and replaced by a guess. Worse, the guess is derived from the distance
 * between consecutive points with no reference to time, which on this board is
 * not a measure of speed at all: `getCoalescedEvents` delivers however many
 * samples the OS took, so a fast hand arrives as *closely spaced* points and
 * would be read as slow.
 *
 * Every sample reaching here therefore carries a pressure somebody meant —
 * measured for a pen, derived from real elapsed time for everything else
 * (`lib/pressure.ts`).
 */
export function strokeOptions(tool: InkTool, size: number, last: boolean): StrokeOptions {
  return { ...OPTIONS[tool], size, last, simulatePressure: false };
}

/**
 * How far past its own path a stroke's paint can reach, in the samples' units —
 * the pad a canvas has to add to a stroke's bounding box so the ink is not cut
 * off at the edge.
 *
 * **Not `size / 2`.** `perfect-freehand`'s radius is
 * `size * (0.5 - thinning * (0.5 - pressure))`, so a *thinned* nib is wider than
 * half the nominal size wherever the pressure is above the middle. Measured
 * against the real library at `size` 6, the marker's half-width is 1.350, 3.000
 * and 4.650 at pressure 0, 0.5 and 1 — that last is `0.775 * size`, so a pad of
 * `size / 2` clips every hard-pressed stroke by a quarter of its width. It does
 * it only at the edge of the canvas, which is how it would fail invisibly.
 *
 * The `sqrt(2)` is the degenerate case rather than a fudge. `getStrokePoints`
 * extends a single-sample stroke by `[1, 1]` before outlining it, so a dot
 * reaches a diagonal unit further than its own radius: measured at 6.063 against
 * the 4.650 the formula alone gives.
 *
 * This duplicates a dependency's internals, which is a thing worth not doing —
 * `getStrokeRadius` is not exported, so the alternative was reading it out of
 * the minified bundle at every call site instead of one. `render/ink/dry.test.ts`
 * checks the real outline against this, so an upstream change to the easing
 * fails a test rather than a screenshot.
 */
export function strokeReach(tool: InkTool, size: number): number {
  const thinning = OPTIONS[tool].thinning ?? 0;
  return size * (0.5 + Math.max(0, thinning) / 2) + Math.SQRT2;
}

/** A vertex of the outline polygon, in the samples' own space. */
export type OutlinePoint = readonly [number, number];

/**
 * The outline polygon around a run of samples.
 *
 * Thin on purpose: it exists so that the one call into `perfect-freehand` is in
 * one place, and so the rest of the renderer talks about outlines rather than
 * about a dependency.
 */
export function outlineStroke(
  samples: readonly InkSample[],
  options: StrokeOptions,
): OutlinePoint[] {
  if (samples.length === 0) return [];
  return getStroke(samples as { x: number; y: number; pressure?: number }[], options);
}

/**
 * The three path methods this module needs. `Path2D` and
 * `CanvasRenderingContext2D` both satisfy it; a test recorder does too.
 */
export interface PathSink {
  moveTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  closePath(): void;
}

/**
 * Trace an outline polygon into a path as a closed run of quadratics.
 *
 * Each vertex is the control point of the curve between the midpoints of the two
 * edges it joins, which is the standard midpoint-quadratic smoothing and the
 * reason a four-vertex polygon from a fast flick still reads as a curve. The
 * wrap at the end closes the loop the same way, so the join at the start of the
 * outline is no more visible than any other.
 *
 * Returns false when there was nothing to draw, so a caller can skip the fill
 * rather than fill an empty path — a single sample outlines to a couple of
 * points, and a dot is `outlineStroke`'s business to produce, not a special case
 * here.
 */
export function traceOutline(outline: readonly OutlinePoint[], sink: PathSink): boolean {
  const n = outline.length;
  if (n < 3) return false;

  const first = outline[0]!;
  const second = outline[1]!;
  sink.moveTo((first[0] + second[0]) / 2, (first[1] + second[1]) / 2);
  // `i` runs one past the last vertex so that the final curve is the one back to
  // where `moveTo` started, with vertex 0 as its control point. Stopping at
  // `n - 1` and letting `closePath` join the gap instead leaves exactly one
  // straight edge in the polygon, at the seam — and the seam is at the start of
  // the stroke, which is the end most likely to be under the cursor.
  for (let i = 1; i <= n; i++) {
    const at = outline[i % n]!;
    const next = outline[(i + 1) % n]!;
    sink.quadraticCurveTo(at[0], at[1], (at[0] + next[0]) / 2, (at[1] + next[1]) / 2);
  }
  sink.closePath();
  return true;
}
