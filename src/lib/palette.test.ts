/**
 * The palette on its own terms.
 *
 * `lib/` may not import `crdt/`, so the schema's fallback colour and this
 * file's default are two literals that have to agree — and the test holding
 * them together is in `crdt/ops/strings.test.ts`, on the side of the seam that
 * is allowed to see both. A duplicated constant is fine; a duplicated constant
 * nobody is checking is a bug waiting for the afternoon somebody adjusts one.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_STRING_COLOR,
  DEFAULT_STRING_THICKNESS,
  STRING_COLORS,
  STRING_THICKNESSES,
} from "@/lib/palette";

describe("the string palette", () => {
  /** > Colour (red is default — also blue, green, yellow, black, white)
   *  > — DESIGN section 3.4 */
  it("is DESIGN 3.4's six, red first", () => {
    expect(STRING_COLORS.map((c) => c.label)).toEqual([
      "Red",
      "Blue",
      "Green",
      "Yellow",
      "Black",
      "White",
    ]);
    expect(DEFAULT_STRING_COLOR).toBe(STRING_COLORS[0]!.hex);
  });

  /**
   * Every one is a six-digit hex, because `render/ropes/paint.ts`'s `lighten`
   * silently returns anything else unchanged — which draws the highlight in the
   * body colour and flattens the string, with no error anywhere.
   */
  it("is all six-digit hex, which is the only thing the highlight can lighten", () => {
    for (const c of STRING_COLORS) expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  /**
   * "Slightly desaturated, slightly dark" (DESIGN section 4.6) as something
   * checkable: nothing on this palette is a fully saturated hue, and nothing is
   * a true black or a true white — the board is a warm brown surface and a
   * pure value on it separates from the cork rather than lying on it.
   */
  it("holds nothing fully saturated, and no true black or white", () => {
    const loud = STRING_COLORS.filter(({ hex }) => {
      const v = Number.parseInt(hex.slice(1), 16);
      const channels = [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
      const max = Math.max(...channels);
      const min = Math.min(...channels);
      // Saturation as HSV means it, plus a value that is neither pinned to the
      // top of the range nor to the bottom of it.
      return (max - min) / max > 0.82 || max > 245 || max < 24;
    });
    expect(loud.map((c) => c.label)).toEqual([]);
  });

  it("has a default thickness on its own ladder", () => {
    expect(STRING_THICKNESSES).toContain(DEFAULT_STRING_THICKNESS);
    // Ascending, because the menu draws them in order as bars of increasing
    // weight and a ladder out of order would read as a bug in the drawing.
    expect([...STRING_THICKNESSES].sort((a, b) => a - b)).toEqual([...STRING_THICKNESSES]);
    // > a highlight thinner than about 1.25 px rasterises to a smear
    // > — `render/ropes/paint.ts`
    expect(Math.min(...STRING_THICKNESSES)).toBeGreaterThanOrEqual(2);
  });

  // The cross-check against `crdt/schema.ts`'s own fallbacks lives in
  // `crdt/ops/strings.test.ts`, not here: `lib/` may not import `crdt/`, and a
  // test that reached across the seam would be the one import that made the
  // rule a suggestion. `lib/slack.test.ts` says the same about `MIN_SLACK`.
});
