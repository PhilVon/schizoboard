/**
 * Is the cursor on this stroke?
 *
 * The question the stroke eraser asks and nothing else on the board has ever
 * asked. Items are hit-tested by the renderer against their DOM nodes, pins by
 * a screen-space radius, strings against the particles the simulation is holding
 * — and none of the three helps here, because a stroke is a run of points that
 * exists only as an entry in a document and a shape on a bitmap.
 *
 * In `lib/` because both sides of the one-way wall need it: `state/tools/` runs
 * the gesture and may not import `render/`, and the answer must not differ
 * between the tool and anything that later wants to draw what is about to go.
 *
 * ## The reach is generous on purpose
 *
 * `render/ink/geometry.ts` has `strokeReach`, which is the *exact* distance a
 * stroke's paint can travel from its own path, and it is deliberately not used
 * here. That number exists so a canvas can be sized without clipping the ink;
 * this one exists so that a person sweeping a rubber over a line hits it. A
 * rubber that only bites where paint actually landed misses the hairline it is
 * being aimed at, and the miss is invisible — the mark is still there and the
 * hand was in the right place.
 *
 * So: the stroke's own half-width, plus the radius of the rubber, and the two
 * discs overlapping is the hit. That is also the honest physical model, which is
 * why it needs no fudge factor on top.
 */

import type { InkSample } from "@/lib/ink";

/**
 * Half the width a stroke of this nominal size can reach, in the samples' units.
 *
 * `0.75` rather than `0.5` because `perfect-freehand`'s radius is
 * `size * (0.5 - thinning * (0.5 - pressure))`, so a hard-pressed marker is
 * `0.775 * size` wide either side of its path — see `strokeReach`, which
 * measures the same thing to a tighter tolerance for a different purpose.
 */
export function strokeHalfWidth(size: number): number {
  return size * 0.75;
}

/**
 * Does a rubber of `radius` at `(x, y)` touch this stroke?
 *
 * Coordinates are the stroke's own space, which is the caller's job to arrive
 * in: item-local for ink on a photograph, board for ink on the cork. Passing a
 * board point against an item's stroke is the one way to use this wrongly and it
 * cannot be checked here — the numbers look identical.
 *
 * `bbox` is the box the scene measured round the samples, and it is a reject
 * test rather than an approximation: a sweep asks this of every stroke on the
 * surface for every sample in the trail, which at speed is a dozen calls a frame
 * per stroke, and almost all of them are nowhere near.
 */
export function strokeHit(
  samples: readonly InkSample[],
  bbox: readonly [number, number, number, number],
  size: number,
  x: number,
  y: number,
  radius: number,
): boolean {
  if (samples.length === 0) return false;
  const reach = strokeHalfWidth(size) + radius;
  const [x0, y0, x1, y1] = bbox;
  if (x < x0 - reach || x > x1 + reach || y < y0 - reach || y > y1 + reach) return false;

  const limit = reach * reach;
  // A single-sample stroke is a dot, and the loop below would not run for it.
  // Handled by starting from the first point rather than by a special case.
  let px = samples[0]!.x;
  let py = samples[0]!.y;
  if (sq(x - px, y - py) <= limit) return true;

  for (let i = 1; i < samples.length; i++) {
    const qx = samples[i]!.x;
    const qy = samples[i]!.y;
    if (pointToSegment(x, y, px, py, qx, qy) <= limit) return true;
    px = qx;
    py = qy;
  }
  return false;
}

/** Squared distance from a point to a segment. Squared throughout: the caller
 *  compares against a squared reach, and a sweep asks this thousands of times. */
function pointToSegment(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  // A zero-length segment is two coalesced samples at one point, which happens
  // whenever a hand pauses. Its nearest point is the endpoint.
  if (len === 0) return sq(x - ax, y - ay);
  let t = ((x - ax) * dx + (y - ay) * dy) / len;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return sq(x - (ax + t * dx), y - (ay + t * dy));
}

function sq(dx: number, dy: number): number {
  return dx * dx + dy * dy;
}
