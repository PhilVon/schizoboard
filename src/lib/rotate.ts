/**
 * Rotation about a point, once, for everybody.
 *
 * This kernel had grown six copies across `crdt/`, `state/` and `render/`, and
 * the sign convention was written down in exactly one of them. That is a bug
 * waiting for the afternoon somebody adds a seventh from memory: a flipped sine
 * is not a crash, it is a photograph that turns the wrong way under one gesture
 * and the right way under every other, which is the kind of thing that gets
 * found by hand months later.
 *
 * `lib/` because it is needed on both sides of the one-way data flow — the ops
 * that un-parent a pin, the scene that lays pins out, the renderer that hit
 * tests, the tools that turn and stretch things — and neither side may import
 * the other.
 *
 * ## The convention, stated once
 *
 * Board and screen space are both **y-down**, so a positive angle turns
 * **clockwise** on screen (DESIGN section 2.5). An item's local frame has its
 * origin at the item's centre and is un-rotated, which is what lets a pin travel
 * and turn with the photograph it is pushed through for free.
 *
 *     out = ( lx·cos − ly·sin ,  lx·sin + ly·cos )
 *
 * ## One pair of trig values, both directions
 *
 * Both functions take `cos` and `sin` of the **same** positive angle. The
 * inverse is not a second rotation by `−angle`; it is the transpose, and doing
 * it that way is what removes the whole class of bug where one caller writes
 * `Math.cos(-rot)` and the next writes `Math.cos(rot)` and only one of them is
 * right. Callers hoist the two trig calls out of their own loops — rotating
 * forty selected items about one pivot should cost two calls to `Math.cos`, not
 * forty.
 *
 * ## Allocation
 *
 * `out` is filled and returned. Every per-frame and per-candidate caller passes
 * a reused object, because `layoutPins` runs over every pin on the board on
 * every frame that anything moved, and `hitTest` runs down the paint order on
 * every pointer move. Callers that run once per gesture let it default.
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * A point in a frame centred on `(cx, cy)` and turned by the angle whose cosine
 * and sine these are, expressed in the outer space.
 *
 * Item-local to board, for a pin. Board to screen is *not* this — that is a
 * scale and a translation with no rotation in it, and it belongs to the camera.
 */
export function rotateOut(
  lx: number,
  ly: number,
  cx: number,
  cy: number,
  cos: number,
  sin: number,
  out: Point = { x: 0, y: 0 },
): Point {
  out.x = cx + lx * cos - ly * sin;
  out.y = cy + lx * sin + ly * cos;
  return out;
}

/**
 * The inverse: an outer-space point expressed in the frame centred on
 * `(cx, cy)`. Same `cos` and `sin` as [`rotateOut`] — see the file header.
 */
export function rotateIn(
  x: number,
  y: number,
  cx: number,
  cy: number,
  cos: number,
  sin: number,
  out: Point = { x: 0, y: 0 },
): Point {
  const dx = x - cx;
  const dy = y - cy;
  out.x = dx * cos + dy * sin;
  out.y = -dx * sin + dy * cos;
  return out;
}
