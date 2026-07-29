import { describe, expect, it } from "vitest";

import { wear } from "@/lib/seed";
import { LIGHT_DX, LIGHT_DY } from "@/render/items/shadow";
import { creaseFace, creaseOf, stainOf, wearFilter } from "@/render/items/wear";

/** A wear a board that has been lived with for the best part of a year sits at. */
const OLD = 0.6;

/** Enough seeds for a fraction to mean something. */
const SEEDS = 4000;

describe("creaseOf", () => {
  it("is the same crease every time it is asked", () => {
    expect(creaseOf(7, OLD)).toEqual(creaseOf(7, OLD));
    expect(creaseOf(7, OLD)).not.toEqual(creaseOf(8, OLD));
  });

  it("gives a new sheet no crease at all", () => {
    for (let seed = 1; seed < 200; seed++) {
      expect(creaseOf(seed, 0).amount).toBe(0);
    }
  });

  it("only ever deepens", () => {
    let previous = -1;
    for (const w of [0, 0.1, 0.2, 0.4, 0.6, 0.8, 1]) {
      const now = creaseOf(11, w).amount;
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
    expect(previous).toBeGreaterThan(0);
  });

  it("puts the fold somewhere on the sheet rather than along its edge", () => {
    for (let seed = 1; seed < 500; seed++) {
      const crease = creaseOf(seed, 1);
      expect(crease.at).toBeGreaterThanOrEqual(28);
      expect(crease.at).toBeLessThanOrEqual(72);
      expect(crease.rot).toBeGreaterThanOrEqual(0);
      expect(crease.rot).toBeLessThan(180);
    }
  });

  /**
   * The point of a per-sheet threshold. A board where every sheet creases at
   * once is a board with a pattern on it, which is what all of `seed.ts` exists
   * to avoid — and one where none of them ever do has not built the feature.
   */
  it("creases a board a few sheets at a time", () => {
    let creased = 0;
    for (let seed = 1; seed <= SEEDS; seed++) if (creaseOf(seed, 0.35).amount > 0) creased++;
    const fraction = creased / SEEDS;
    expect(fraction).toBeGreaterThan(0.15);
    expect(fraction).toBeLessThan(0.6);
  });
});

describe("creaseFace", () => {
  it("never claims more than a full turn into the light", () => {
    for (let seed = 1; seed < 300; seed++) {
      const face = creaseFace((seed % 100) / 8, creaseOf(seed, 1).rot);
      expect(Math.abs(face)).toBeLessThanOrEqual(1.0000001);
    }
  });

  /**
   * The failure this exists to catch. A crease drawn with a fixed bright side
   * is lit from the sheet's own private direction, which DESIGN 4.1 says is the
   * fastest way to break the sense of a real surface — so turning the sheet over
   * has to swap which flank catches the light.
   */
  it("swaps sides when the sheet is turned over", () => {
    for (const creaseRot of [0, 23, 61, 90, 145]) {
      const upright = creaseFace(0, creaseRot);
      expect(creaseFace(Math.PI, creaseRot)).toBeCloseTo(-upright, 10);
      // And the same fold described the other way round is the same fold seen
      // from the other side.
      expect(creaseFace(0, creaseRot + 180)).toBeCloseTo(-upright, 10);
    }
  });

  /**
   * The convention, pinned. `--crease-rot` goes straight into a CSS gradient and
   * is therefore measured clockwise from *to top*, so the fold's normal is
   * `(sin, -cos)`. Read as a maths angle it comes out at right angles and
   * negated — the whole board lit from the wrong side, with nothing in any
   * number to show for it.
   */
  it("is full where the fold faces the light and flat where it faces across it", () => {
    // The crease angle whose far flank points straight down-light — that is, at
    // the far flank turned as far from the light as it can be.
    const facingAway = (Math.atan2(LIGHT_DX, -LIGHT_DY) * 180) / Math.PI;
    expect(creaseFace(0, facingAway)).toBeCloseTo(-1, 6);
    expect(creaseFace(0, facingAway + 180)).toBeCloseTo(1, 6);
    // And side on: neither flank is turned toward or away.
    expect(creaseFace(0, facingAway + 90)).toBeCloseTo(0, 6);
  });
});

describe("stainOf", () => {
  it("is the same ring every time it is asked", () => {
    expect(stainOf(7, 1)).toEqual(stainOf(7, 1));
  });

  it("gives a new sheet nothing", () => {
    for (let seed = 1; seed < 200; seed++) expect(stainOf(seed, 0).amount).toBe(0);
  });

  it("draws a mug rather than a fraction of the sheet", () => {
    for (let seed = 1; seed < 500; seed++) {
      const stain = stainOf(seed, 1);
      expect(stain.r).toBeGreaterThanOrEqual(32);
      expect(stain.r).toBeLessThanOrEqual(48);
      // Allowed to hang off the sheet, because most real rings are partial.
      expect(stain.x).toBeGreaterThanOrEqual(-10);
      expect(stain.x).toBeLessThanOrEqual(110);
    }
  });

  /**
   * "occasional coffee rings" (DESIGN 4.7), as a number.
   *
   * Measured at the wear a board that has been lived with sits at, not at 1 —
   * `wear` is asymptotic and no real sheet ever reaches the top of the range, so
   * a threshold band that stops at 1 would mark most of the board.
   */
  it("marks a minority of a well-used board and nothing on a young one", () => {
    let ringed = 0;
    for (let seed = 1; seed <= SEEDS; seed++) if (stainOf(seed, OLD).amount > 0) ringed++;
    const fraction = ringed / SEEDS;
    expect(fraction).toBeGreaterThan(0.08);
    expect(fraction).toBeLessThan(0.32);

    for (let seed = 1; seed <= SEEDS; seed++) expect(stainOf(seed, 0.2).amount).toBe(0);
  });

  /**
   * The rule `seed.ts`'s header sets for every stream on this board: how
   * yellowed a sheet is must not predict what has been spilled on it, or the
   * board acquires a pattern nobody can name.
   */
  it("does not decide the ring off the same coin as the crease", () => {
    let both = 0;
    let creased = 0;
    let ringed = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const c = creaseOf(seed, OLD).amount > 0;
      const s = stainOf(seed, OLD).amount > 0;
      if (c) creased++;
      if (s) ringed++;
      if (c && s) both++;
    }
    const independent = (creased / SEEDS) * (ringed / SEEDS);
    expect(both / SEEDS).toBeGreaterThan(independent * 0.7);
    expect(both / SEEDS).toBeLessThan(independent * 1.4);
  });
});

describe("wearFilter", () => {
  it("costs nothing on a board with nothing old on it", () => {
    expect(wearFilter(0)).toBe("");
    expect(wearFilter(-1)).toBe("");
  });

  it("takes colour and contrast out rather than putting a wash on", () => {
    const filter = wearFilter(1);
    const term = (name: string): number =>
      Number(new RegExp(`${name}\\(([-\\d.]+)\\)`).exec(filter)?.[1]);
    expect(term("saturate")).toBeLessThan(1);
    expect(term("contrast")).toBeLessThan(1);
    expect(term("sepia")).toBeGreaterThan(0);
    // The blacks lift; the print does not get brighter overall in any way worth
    // noticing, and a print that visibly brightened with age would read as a
    // rendering bug rather than as a fade.
    expect(term("brightness")).toBeGreaterThan(1);
    expect(term("brightness")).toBeLessThan(1.06);
  });

  it("is monotone, so a print never un-fades", () => {
    const saturation = (w: number): number =>
      Number(/saturate\(([-\d.]+)\)/.exec(wearFilter(w))?.[1]);
    expect(saturation(1)).toBeLessThan(saturation(0.5));
    expect(saturation(0.5)).toBeLessThan(1);
  });
});

/**
 * The one assertion about the *clock*, which Q-105 settled as wall-clock: a
 * board has to be old in real months before any of the above is on the screen at
 * all. That is DESIGN 4.7's "subtle enough that nobody consciously notices"
 * expressed as the only thing about it that can be measured — a sheet written
 * this morning is untouched, and one from last year is not.
 */
describe("the pace of it", () => {
  it("leaves a week-old board alone and a year-old one visibly older", () => {
    for (let seed = 1; seed < 400; seed++) {
      expect(wear(seed, 7)).toBeLessThan(0.05);
      expect(creaseOf(seed, wear(seed, 7)).amount).toBe(0);
      expect(stainOf(seed, wear(seed, 30)).amount).toBe(0);
    }
    let old = 0;
    for (let seed = 1; seed < 400; seed++) if (wear(seed, 365) > 0.4) old++;
    expect(old).toBeGreaterThan(200);
  });
});
