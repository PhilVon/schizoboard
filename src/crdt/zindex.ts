/**
 * Item z-ordering.
 *
 * docs/DATA-MODEL.md section 7: `item.z` is a base-62 fractional index string,
 * and the total order is `(z, clientId, itemId)` so that two peers who
 * concurrently generate the same key still sort identically — invariant 9.
 *
 * The fractional-index generation itself comes from `fractional-indexing`.
 * That is a deliberate dependency: it is about two kilobytes, and the integer-
 * part encoding that makes `generateKeyBetween(null, x)` work without ever
 * running out of room below is genuinely subtle. This is the opposite trade to
 * the one D-3 refuses — a megabyte of physics engine for worse rope.
 *
 * What is ours is the jitter, and the reason it exists:
 *
 * > **The known hazard is key growth.** Two clients repeatedly bringing items
 * > to front generate ever-longer keys, and a rebalance rewrites every item —
 * > a huge update that conflicts with everything in flight.
 *
 * Four random base-62 characters on every generated key means two concurrent
 * `bringToFront`s essentially never produce the same key, so they interleave
 * instead of colliding and growth stays bounded.
 */

import { BASE_62_DIGITS, generateKeyBetween } from "fractional-indexing";

/** DATA-MODEL section 7 — "append four random base-62 characters". */
const JITTER_LENGTH = 4;

function randomDigits(count: number): string {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < count; i++) {
    // The last digit must not be the smallest one. A key ending in the
    // smallest digit has nothing between it and its own prefix, so the
    // algorithm rejects it outright — and a jittered key that tripped that
    // would be fine until the moment someone inserted next to it.
    const alphabet = i === count - 1 ? BASE_62_DIGITS.slice(1) : BASE_62_DIGITS;
    // Modulo bias over 62 of 256 is negligible here: the suffix only has to
    // make collisions unlikely, not be uniformly distributed.
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

/**
 * A key strictly between `before` and `after`, with jitter.
 *
 * Jitter cannot simply be concatenated. `generateKeyBetween` may return a
 * proper prefix of `after` — `generateKeyBetween("a0V", "a0W5")` is `"a0W"` —
 * and `"a0W" + "q3xk"` sorts *after* `"a0W5"`, silently putting the item on
 * the wrong side of its neighbour. So the suffix is added only when the result
 * still lands strictly inside the interval, and the plain key is used
 * otherwise.
 *
 * Falling back costs only this key's collision resistance, and two peers that
 * both fall back produce the same key — which is exactly the case
 * `compareOrder` breaks on client and item id.
 */
export function keyBetween(before: string | null, after: string | null): string {
  const base = generateKeyBetween(before, after);
  const jittered = base + randomDigits(JITTER_LENGTH);
  const fitsBelow = after === null || jittered < after;
  const fitsAbove = before === null || jittered > before;
  return fitsBelow && fitsAbove ? jittered : base;
}

/** A key that sorts above everything currently on the board. */
export function keyAbove(highest: string | null): string {
  return keyBetween(highest, null);
}

/** A key that sorts below everything currently on the board. */
export function keyBelow(lowest: string | null): string {
  return keyBetween(null, lowest);
}

export interface Ordered {
  z: string;
  clientId: number;
  id: string;
}

/**
 * The total order from DATA-MODEL section 7. `z` alone is not a total order —
 * concurrent generation can produce equal keys even with jitter — so client id
 * and item id break the tie. Both peers hold the same values, so both sort the
 * same way, which is what invariant 9 actually asserts.
 */
export function compareOrder(a: Ordered, b: Ordered): number {
  if (a.z !== b.z) return a.z < b.z ? -1 : 1;
  if (a.clientId !== b.clientId) return a.clientId - b.clientId;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}
