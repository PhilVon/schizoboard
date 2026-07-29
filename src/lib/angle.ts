/**
 * Angle normalisation, once, for everybody.
 *
 * `lib/` for the same reason as `lib/rotate.ts`: this is needed on both sides
 * of the one-way data flow. `sim/torsion.ts` wants it so a photograph always
 * turns the short way to plumb; `state/scene.ts` wants it so a note laid flat
 * to be written on turns the short way to square. Neither may import the other,
 * and a second copy written from memory is how a sign convention drifts.
 */

const TWO_PI = Math.PI * 2;

/**
 * Into `(-pi, pi]`.
 *
 * The point is not the range, it is the *direction*: an item at 189 degrees is
 * 9 degrees past upside down, and rotating it to plumb should take the 171
 * degrees back the way it came rather than the 189 forwards.
 */
export function shortest(angle: number): number {
  return ((((angle + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}
