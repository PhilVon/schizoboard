/**
 * The two `PinKind` unions, held together.
 *
 * `crdt/schema.ts` declares what a pin may be and `render/pins/sprite.ts`
 * declares what a pin may be *drawn as*, and they are two separate declarations
 * on purpose: `render/` does not import from `crdt/`, which is the seam that
 * keeps the renderer off the document.
 *
 * The cost of that seam is that adding a kind to one and not the other fails
 * **silently**, and it did: `tape` was added to the schema, `PinLayer` casts on
 * the way in (`pin.kind as PinKind`), and the new kind reached `HEAD_RADIUS` as
 * an undefined lookup — a sprite baked at `NaN` pixels, which throws nothing,
 * logs nothing, and draws nothing. A pin that is simply not there is very hard
 * to read as a missing table entry.
 *
 * So this is the test that makes the duplication safe rather than merely
 * documented.
 */

import { describe, expect, it } from "vitest";

import { PIN_KIND_NAMES } from "../src/crdt/schema";
import { HEAD_FRACTION, HEAD_RADIUS_BY_KIND, PIN_SPRITE_KINDS } from "../src/render/pins/sprite";

describe("every pin kind the document allows can be drawn", () => {
  it("names the same kinds on both sides of the seam", () => {
    expect([...PIN_SPRITE_KINDS].sort()).toEqual([...PIN_KIND_NAMES].sort());
  });

  it("gives every kind a head size, so none bakes at NaN", () => {
    // The failure this file exists for. `Record<PinKind, number>` only checks
    // the *sprite* module's own union, so it cannot catch a kind the schema
    // grew and the sprite did not.
    for (const kind of PIN_KIND_NAMES) {
      expect(Number.isFinite(headRadiusOf(kind)), `${kind} has a head size`).toBe(true);
      expect(headRadiusOf(kind)).toBeGreaterThan(0);
    }
  });

  it("keeps the grab radius the widest head and no wider", () => {
    // `HEAD_FRACTION` is the hit radius for *every* pin, so a new kind that
    // wanted a bigger target would quietly widen the aim for nails too.
    const widest = Math.max(...PIN_KIND_NAMES.map(headRadiusOf));
    expect(HEAD_FRACTION).toBeCloseTo(widest, 12);
    expect(HEAD_FRACTION).toBeLessThanOrEqual(0.3);
  });
});

/** The shipped table, never a copy of it kept here — a copy would agree with
 *  itself while the real one was wrong. */
function headRadiusOf(kind: string): number {
  return HEAD_RADIUS_BY_KIND[kind] ?? Number.NaN;
}
