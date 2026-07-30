import { describe, expect, it } from "vitest";

import { wear } from "@/lib/seed";
import { LIGHT_DX, LIGHT_DY } from "@/render/items/shadow";
import { creaseFace, creaseOf, dogEarOf, stainOf, wearFilter } from "@/render/items/wear";

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
    }
  });

  /**
   * Nobody folds a note corner to corner. A uniform angle over the half circle
   * is the obvious reading of "a crease" and it read as a scratch on the lens on
   * the first board that had one — so a fold lies along an axis of the sheet,
   * and is a few degrees out because a hand made it.
   */
  it("folds along an axis of the sheet, and never exactly along one", () => {
    let horizontal = 0;
    let exact = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { rot } = creaseOf(seed, 1);
      const off = Math.min(Math.abs(rot), Math.abs(rot - 90));
      expect(off).toBeLessThanOrEqual(7);
      if (Math.abs(rot) <= 7) horizontal++;
      if (off < 0.05) exact++;
    }
    // Both ways up, in roughly equal measure.
    expect(horizontal / SEEDS).toBeGreaterThan(0.4);
    expect(horizontal / SEEDS).toBeLessThan(0.6);
    expect(exact).toBeLessThan(SEEDS / 100);
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

describe("dogEarOf", () => {
  it("is the same fold every time it is asked", () => {
    expect(dogEarOf(7, OLD)).toEqual(dogEarOf(7, OLD));
  });

  it("gives a new sheet no fold and no depth to draw one with", () => {
    // Both halves matter and they are written separately: `edge.ts` cuts on the
    // depth alone, so an amount of zero with a depth left standing would take a
    // corner off every unfolded sheet on the board.
    for (let seed = 1; seed < 500; seed++) {
      expect(dogEarOf(seed, 0).amount).toBe(0);
      expect(dogEarOf(seed, 0).depth).toBe(0);
    }
  });

  it("folds a fraction of the sheet rather than a fixed length", () => {
    // The opposite of the coffee ring directly above, which is a mug and is
    // therefore board units. You take hold of a corner and turn it back toward
    // the middle, so the triangle is a fraction of what you are holding — and a
    // percentage is also the only thing that cannot overrun a small sheet, which
    // is what keeps the silhouette a function of the seed rather than of `w`.
    for (let seed = 1; seed < 500; seed++) {
      const ear = dogEarOf(seed, 1);
      // A fold still growing in is shallower than its own range by design — the
      // range is what it reaches, not where it starts.
      if (ear.amount < 1) continue;
      expect(ear.depth).toBeGreaterThanOrEqual(5);
      expect(ear.depth).toBeLessThanOrEqual(9);
    }
  });

  it("names one of the four corners, and not the same one every time", () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= SEEDS; seed++) {
      const corner = dogEarOf(seed, 1).corner;
      expect(Number.isInteger(corner)).toBe(true);
      expect(corner).toBeGreaterThanOrEqual(0);
      expect(corner).toBeLessThanOrEqual(3);
      seen.add(corner);
    }
    // A real pad is dog-eared where the thumb turns the page, which is the same
    // corner every time. Nothing on a cork board is a pad, and four sheets folded
    // at the identical corner reads as a template rather than as wear.
    expect(seen.size).toBe(4);
  });

  it("turns a corner over on some of a well-used board and none of a young one", () => {
    // Between the crease and the coffee ring, which is where a fold belongs: a
    // sheet handled for a year has been folded back somewhere, but a corner
    // turned over is a specific accident in a way that a crease is not.
    let folded = 0;
    for (let seed = 1; seed <= SEEDS; seed++) if (dogEarOf(seed, OLD).amount > 0) folded++;
    const fraction = folded / SEEDS;
    expect(fraction).toBeGreaterThan(0.2);
    expect(fraction).toBeLessThan(0.5);

    let creased = 0;
    let ringed = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      if (creaseOf(seed, OLD).amount > 0) creased++;
      if (stainOf(seed, OLD).amount > 0) ringed++;
    }
    expect(folded).toBeLessThan(creased);
    expect(folded).toBeGreaterThan(ringed);

    for (let seed = 1; seed <= SEEDS; seed++) expect(dogEarOf(seed, 0.1).amount).toBe(0);
  });

  it("grows the fold in rather than switching it on", () => {
    // The silhouette itself is what grows here, so a sheet crossing its own
    // threshold turns its corner over across a fortnight of board time instead of
    // between two frames. Every other mark in this file fades in; this one has to
    // as well, or the shape of the paper pops.
    const seed = (() => {
      for (let s = 1; s < SEEDS; s++) if (dogEarOf(s, OLD).amount > 0) return s;
      throw new Error("no seed folds");
    })();
    let last = -1;
    let partial = 0;
    for (let wear = 0; wear <= 1.001; wear += 0.01) {
      const ear = dogEarOf(seed, wear);
      expect(ear.depth).toBeGreaterThanOrEqual(last);
      if (ear.amount > 0 && ear.amount < 1) partial++;
      last = ear.depth;
    }
    expect(partial).toBeGreaterThan(4);
  });

  it("does not decide the fold off the same coin as the crease or the ring", () => {
    // `seed.ts`'s rule for every stream on this board: how creased a sheet is
    // must not predict whether its corner is turned over, or the board acquires
    // a pattern nobody can name.
    for (const other of [creaseOf, stainOf]) {
      let both = 0;
      let mine = 0;
      let theirs = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const a = dogEarOf(seed, OLD).amount > 0;
        const b = other(seed, OLD).amount > 0;
        if (a) mine++;
        if (b) theirs++;
        if (a && b) both++;
      }
      const independent = (mine / SEEDS) * (theirs / SEEDS);
      expect(both / SEEDS).toBeGreaterThan(independent * 0.7);
      expect(both / SEEDS).toBeLessThan(independent * 1.4);
    }
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
