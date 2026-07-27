/**
 * A finished stroke, on its way into the document — and back out again.
 *
 * > On pen-up, in one transaction:
 * >
 * > 1. Simplify with Ramer-Douglas-Peucker, epsilon around 0.4 units at 100% zoom.
 * > 2. Quantise to eighths of a unit.
 * > 3. Delta-encode `(dx, dy, dPressure)`.
 * > 4. Varint-pack into a `Uint8Array`.
 * >
 * > Roughly 3-4 bytes per point against 50-odd for JSON floats.
 * > — DATA-MODEL section 6.1
 *
 * Four steps, and each one is doing a different job. The simplify throws away
 * points a person cannot see; the quantise throws away precision a person cannot
 * see; the delta makes the remaining numbers small; the varint is what turns
 * small numbers into few bytes. Skip any one and the last one stops paying: a
 * varint over absolute board coordinates costs three bytes a point rather than
 * one, and a varint over unquantised floats cannot be written at all.
 *
 * ## Input points, never the outline
 *
 * > **Store input points, never the generated outline.** The outline is about ten
 * > times the data and can't be re-tuned if stroke parameters change later.
 * > — DATA-MODEL section 6.1
 *
 * That is AC-79, and the reason it is an acceptance criterion rather than an
 * optimisation is the second clause. `render/ink/geometry.ts` holds a table of
 * taper, thinning and smoothing numbers that are taste calls, and taste calls
 * get revisited. A board that stored outlines would have every stroke ever drawn
 * frozen at the settings that were current the afternoon it was drawn, and no way
 * back — the outline does not contain the path that produced it.
 *
 * ## `lib/`, because both sides need it
 *
 * The op that writes a stroke and the renderer that rasters one are on opposite
 * sides of the one-way data flow and may not import each other. This is the shape
 * they agree on, in the one place both can reach — the same argument `lib/ink.ts`
 * makes for `InkSample`, and `lib/slack.ts` for the slack arithmetic.
 */

import { DEFAULT_INK_SIZE, type InkSample } from "@/lib/ink";

/**
 * How far, in stroke units, a simplified path may stray from the one the hand
 * actually drew.
 *
 * > epsilon around 0.4 units at 100% zoom — DATA-MODEL section 6.1
 *
 * A stroke's units are board units at 100% zoom by construction (`lib/ink.ts`),
 * so this needs no conversion — which is the second reason the samples are not
 * screen pixels. Four tenths of a unit is under half a pixel at 100%; a person
 * looking at a mark drawn a moment ago cannot find the difference, and at three
 * or four times the zoom it is a pixel and a half on a line that is six units
 * thick.
 */
export const INK_EPSILON = 0.4;

/** Eighths of a unit — the grid a packed point sits on. */
export const INK_STEPS_PER_UNIT = 8;

/**
 * Pressure resolution: one part in 255, which is a byte and is far finer than a
 * nib six units across can show.
 */
export const PRESSURE_STEPS = 255;

/**
 * What a unit of pressure error is worth, measured in units of position error —
 * the exchange rate the simplify needs, and the one number here that is a
 * judgement rather than a quantity out of DATA-MODEL.
 *
 * Ramer-Douglas-Peucker on the geometry alone has a failure mode that is easy to
 * miss and impossible to unsee: on a *straight* stroke every interior point is
 * exactly on the chord, so the whole thing collapses to two points and every bit
 * of width variation between them goes with it. A hand that slowed in the middle
 * of a straight line drew a stroke that bulges there, and that stroke would come
 * back out of the document as a tapered rectangle.
 *
 * So the error a point is judged on is the *larger* of how far it is off the
 * chord and how far its pressure is off the chord's, the latter converted into
 * position units by this. Width goes roughly as `size * pressure`, so one full
 * unit of pressure is worth about a nib width — near enough that a pressure
 * wobble which would move the edge of the mark by less than `INK_EPSILON` is
 * dropped, and one that would move it further is kept.
 */
export const PRESSURE_REACH = DEFAULT_INK_SIZE;

/**
 * A stroke as the document holds it.
 *
 * `bbox` comes back with the bytes rather than being the caller's to compute,
 * and that is what makes invariant 7 — "a stroke's `bbox` always contains its
 * unpacked points" (DATA-MODEL section 12) — true by construction instead of by
 * agreement. Measured *after* the simplify and the quantise, because those are
 * what decide where the points finally are; a box measured off the raw samples
 * can be a sixteenth of a unit too small on every side, and an invariant that
 * holds to within a rounding error is not an invariant.
 *
 * It is the box round the *points*, not round the ink. A nib has width and the
 * mark spills `size / 2` past the path on every side, so anything culling or
 * hit-testing against this has to pad it — the padding belongs to the reader,
 * which is the only one that knows whether it is asking about the path or the
 * paint.
 */
export interface PackedStroke {
  readonly pts: Uint8Array;
  /** `[x0, y0, x1, y1]` in the stroke's own space. */
  readonly bbox: readonly [number, number, number, number];
}

/**
 * The whole of DATA-MODEL section 6.1, in order.
 *
 * An empty input packs to no bytes and a degenerate box. That is not an error to
 * throw on — a gesture that produced nothing is a click, and deciding a click is
 * not worth committing belongs to the caller holding the pointer, not to the
 * codec.
 */
export function packStroke(
  samples: readonly InkSample[],
  epsilon = INK_EPSILON,
): PackedStroke {
  const kept = simplifyStroke(samples, epsilon);
  if (kept.length === 0) return { pts: new Uint8Array(0), bbox: [0, 0, 0, 0] };

  const out: number[] = [];
  let px = 0;
  let py = 0;
  let pp = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;

  for (const sample of kept) {
    const qx = Math.round(sample.x * INK_STEPS_PER_UNIT);
    const qy = Math.round(sample.y * INK_STEPS_PER_UNIT);
    const qp = Math.round(clamp01(sample.pressure) * PRESSURE_STEPS);
    // The first point deltas against the origin rather than being written as a
    // special absolute header. It costs two or three bytes once and buys a
    // decoder with no first-iteration branch in it.
    writeVarint(out, zigzag(qx - px));
    writeVarint(out, zigzag(qy - py));
    writeVarint(out, zigzag(qp - pp));
    px = qx;
    py = qy;
    pp = qp;
    // Off the quantised value, which is where the point will actually be when
    // somebody unpacks it — see [`PackedStroke.bbox`].
    const ux = qx / INK_STEPS_PER_UNIT;
    const uy = qy / INK_STEPS_PER_UNIT;
    if (ux < x0) x0 = ux;
    if (uy < y0) y0 = uy;
    if (ux > x1) x1 = ux;
    if (uy > y1) y1 = uy;
  }

  return { pts: Uint8Array.from(out), bbox: [x0, y0, x1, y1] };
}

/**
 * The bytes back into points, on the grid `packStroke` put them on.
 *
 * **Lenient about a short buffer.** Bytes that stop mid-point are dropped and
 * what came before them is returned. A stroke record arrives from a peer, from a
 * repaired log tail (`docstore.rs`), or from a version of this file that is not
 * this one, and none of those is a reason for the frame loop to throw — a stroke
 * one point shorter than it should be is a mark with a slightly early end, and
 * an exception in phase 6 is a board that will not draw at all.
 */
export function unpackStroke(pts: Uint8Array): InkSample[] {
  const samples: InkSample[] = [];
  let x = 0;
  let y = 0;
  let p = 0;
  let i = 0;

  while (i < pts.length) {
    const dx = readVarint(pts, i);
    if (dx === null) break;
    const dy = readVarint(pts, dx.next);
    if (dy === null) break;
    const dp = readVarint(pts, dy.next);
    if (dp === null) break;
    i = dp.next;
    x += unzigzag(dx.value);
    y += unzigzag(dy.value);
    p += unzigzag(dp.value);
    samples.push({
      x: x / INK_STEPS_PER_UNIT,
      y: y / INK_STEPS_PER_UNIT,
      pressure: clamp01(p / PRESSURE_STEPS),
    });
  }

  return samples;
}

/**
 * Ramer-Douglas-Peucker, with pressure counted as a fourth dimension of the
 * error — see [`PRESSURE_REACH`] for why it has to be.
 *
 * **Iterative, not recursive.** The textbook version recurses once per kept
 * point, and the worst case for that is a path where every point survives — a
 * staircase, or a stroke drawn slowly enough that no two samples are collinear,
 * which is a great many of them. A thousand-sample stroke is a thousand frames
 * deep, and the failure is a `RangeError` thrown out of a pen-up in the middle
 * of somebody's board.
 *
 * The ends are always kept. So is a stroke of one or two points, which has
 * nothing between its ends to drop.
 */
export function simplifyStroke(
  samples: readonly InkSample[],
  epsilon = INK_EPSILON,
): InkSample[] {
  if (samples.length <= 2) return samples.slice();

  const keep = new Uint8Array(samples.length);
  keep[0] = 1;
  keep[samples.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, samples.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    if (to - from < 2) continue;

    let worst = -1;
    let at = -1;
    for (let i = from + 1; i < to; i++) {
      const error = chordError(samples[from]!, samples[to]!, samples[i]!);
      if (error > worst) {
        worst = error;
        at = i;
      }
    }
    if (worst <= epsilon || at < 0) continue;

    keep[at] = 1;
    stack.push([from, at], [at, to]);
  }

  const kept: InkSample[] = [];
  for (let i = 0; i < samples.length; i++) if (keep[i] === 1) kept.push(samples[i]!);
  return kept;
}

/**
 * How wrong dropping `point` would be: the further of how far it lies off the
 * chord `from`-`to`, and how far its pressure lies off the pressure that chord
 * would interpolate.
 *
 * The larger of the two rather than their sum or their hypotenuse, so that
 * `epsilon` keeps meaning "no part of the mark moves by more than this". A sum
 * would reject points on the strength of two errors that are each individually
 * invisible.
 */
function chordError(from: InkSample, to: InkSample, point: InkSample): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len2 = dx * dx + dy * dy;
  // A degenerate chord — the hand came back to where it started — has no
  // perpendicular to measure against, so the distance to the point itself is the
  // honest answer.
  const t = len2 === 0 ? 0 : clamp01(((point.x - from.x) * dx + (point.y - from.y) * dy) / len2);
  const ex = from.x + t * dx - point.x;
  const ey = from.y + t * dy - point.y;
  const geometry = Math.hypot(ex, ey);
  const pressure =
    Math.abs(from.pressure + t * (to.pressure - from.pressure) - point.pressure) *
    PRESSURE_REACH;
  return Math.max(geometry, pressure);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Signed to unsigned without losing the small-is-cheap property a varint is
 * bought for: -1 becomes 1 rather than a number with every high bit set.
 *
 * Arithmetic rather than the usual `(n << 1) ^ (n >> 31)`, because a board
 * coordinate has no bound in the schema and those shifts silently truncate to 32
 * bits. Eighths of a unit runs out of `int32` at a board about 268 million units
 * across, which is a board nobody will make — but the failure if one did would be
 * a stroke landing somewhere else entirely rather than an error, and the
 * arithmetic form costs nothing on the deltas that make up all but the first
 * point.
 */
function zigzag(n: number): number {
  return n >= 0 ? n * 2 : n * -2 - 1;
}

function unzigzag(n: number): number {
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

/** LEB128, seven bits a byte, high bit set on every byte but the last. */
function writeVarint(out: number[], value: number): void {
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) + 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
}

/** Null when the buffer ends before the varint does — see [`unpackStroke`]. */
function readVarint(pts: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0;
  let scale = 1;
  let i = at;
  for (;;) {
    if (i >= pts.length) return null;
    const byte = pts[i]!;
    i++;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return { value, next: i };
    scale *= 0x80;
  }
}
