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
  CORK_COLORS,
  corkColorOf,
  corkHex,
  customCork,
  DEFAULT_CORK,
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

describe("what a board is made of", () => {
  /** T-408; quieter natural stock approved in D-77 / Q-372. */
  it("keeps the approved quiet natural cork as its default", () => {
    // T-415 retunes the base and grain contrast together. Keep the flat
    // low-zoom fill and the material generators on the same approved colour.
    expect(DEFAULT_CORK.id).toBe("natural");
    expect(DEFAULT_CORK.base).toEqual({ r: 147, g: 126, b: 104 });
  });

  it("answers with the default for anything it does not know", () => {
    // Total on purpose, so no caller has to decide what an unrecognised id
    // means — and so a strip can never be drawn with nothing marked, which
    // would read as a board made of nothing.
    for (const nonsense of [null, undefined, 42, "", "mahogany", {}]) {
      expect(corkColorOf(nonsense).id).toBe(DEFAULT_CORK.id);
    }
  });

  it("gives every colour a distinct id, since the id is what a document holds", () => {
    const ids = CORK_COLORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every one of them a ground rather than a statement", () => {
    // A saturated board competes with the paper on it — DESIGN section 4.1
    // tunes every stock, ink and shadow against the cork, and the surface has
    // to stay the thing they are judged against.
    for (const { id, base } of CORK_COLORS) {
      const max = Math.max(base.r, base.g, base.b);
      const min = Math.min(base.r, base.g, base.b);
      expect(max, `${id} is too bright`).toBeLessThan(200);
      expect(max, `${id} is too dark to pin against`).toBeGreaterThan(80);
      // Chroma, as the plainest possible measure of it.
      expect(max - min, `${id} is too saturated for a ground`).toBeLessThan(100);
    }
  });
});

describe("a colour somebody chose themselves", () => {
  /**
   * Q-369's kickback: the five are a judgement about somebody else's board, and
   * a person is allowed to overrule it. What is still refused is nonsense,
   * which is a different thing from a taste.
   */
  it("reads a six-digit hex as a colour in its own right", () => {
    expect(customCork("#3366ff")).toEqual({ r: 0x33, g: 0x66, b: 0xff });
    expect(corkColorOf("#3366ff").base).toEqual({ r: 0x33, g: 0x66, b: 0xff });
    // Its own id, which is what makes no curated chip mark itself for it.
    expect(corkColorOf("#3366ff").id).toBe("#3366ff");
  });

  it("takes one spelling and not three", () => {
    // A board has no transparency to have, and one canonical form is what lets
    // the stored value be compared rather than parsed to be compared.
    expect(customCork("#36f")).toBeNull();
    expect(customCork("#3366ffcc")).toBeNull();
    expect(customCork("3366ff")).toBeNull();
    expect(customCork("rebeccapurple")).toBeNull();
  });

  it("falls back to the cork we ship for a string that is neither", () => {
    for (const nonsense of ["#zzzzzz", "#", "slat", 7, null]) {
      expect(corkColorOf(nonsense).id).toBe(DEFAULT_CORK.id);
    }
  });

  it("round-trips every curated colour through the input's own spelling", () => {
    // The picker chip shows what the board currently is, so this is the path
    // that puts a named colour into it and reads a hex back out.
    for (const colour of CORK_COLORS) {
      expect(customCork(corkHex(colour.base))).toEqual(colour.base);
    }
  });
});
