import { describe, expect, it } from "vitest";

import {
  SCATTER_DEGREES,
  charJitter,
  edgeProfile,
  newSeed,
  scatterAngle,
  streamFor,
  valueAt,
  wear,
} from "@/lib/seed";

const SEED = 0x1234abcd;

describe("seed derivations", () => {
  it("is stable — the whole point", () => {
    // Re-rendering an item must not move a single glyph. DESIGN 3.6: text that
    // shimmers when you scroll past is worse than no jitter at all.
    expect(scatterAngle(SEED)).toBe(scatterAngle(SEED));
    expect(charJitter(SEED, 7)).toEqual(charJitter(SEED, 7));
    expect(valueAt(SEED, "grain", 3)).toBe(valueAt(SEED, "grain", 3));
  });

  it("gives different items different variation", () => {
    const angles = new Set(
      Array.from({ length: 200 }, (_, i) => scatterAngle(SEED + i * 7919)),
    );
    expect(angles.size).toBeGreaterThan(190);
  });

  it("keeps salts uncorrelated, so edge raggedness does not predict ageing", () => {
    const samples = 3000;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < samples; i++) {
      xs.push(valueAt(i, "edge-top", 0));
      ys.push(valueAt(i, "wear", 0));
    }
    const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
    const mx = mean(xs);
    const my = mean(ys);
    let cov = 0;
    let vx = 0;
    let vy = 0;
    for (let i = 0; i < samples; i++) {
      const dx = xs[i]! - mx;
      const dy = ys[i]! - my;
      cov += dx * dy;
      vx += dx * dx;
      vy += dy * dy;
    }
    const r = cov / Math.sqrt(vx * vy);
    expect(Math.abs(r)).toBeLessThan(0.06);
  });

  it("wanders rather than jitters, so neighbouring letters move together", () => {
    // The failure this rules out is white noise. Independent noise per
    // character is invisible at an amplitude that looks natural and reads as a
    // ransom note at any amplitude you can see, because every third letter ends
    // up displaced away from both its neighbours. Two letters side by side must
    // be close; two a couple of syllables apart need not be.
    const n = 4000;
    let near = 0;
    let far = 0;
    for (let i = 0; i < n; i++) {
      const here = charJitter(SEED, i).dy;
      near += Math.abs(charJitter(SEED, i + 1).dy - here);
      far += Math.abs(charJitter(SEED, i + 8).dy - here);
    }
    expect(near).toBeLessThan(far / 2.5);
  });

  it("eases into each control point, so there is no kink every fourth letter", () => {
    // Cosine interpolation flattens where the segments meet; a linear blend
    // makes every step the same size and leaves a corner at every control
    // point, which is a pattern at exactly the scale this is meant to hide.
    const dy = (i: number): number => charJitter(SEED, i).dy;
    let across = 0;
    let middle = 0;
    for (let point = 0; point < 800; point++) {
      const base = point * 4;
      across += Math.abs(dy(base + 1) - dy(base));
      middle += Math.abs(dy(base + 2) - dy(base + 1));
    }
    expect(across).toBeLessThan(middle / 1.5);
  });

  it("gives each letter its own slant, so four in a row do not share an angle", () => {
    // Slant is the part of a hand that genuinely does vary letter to letter,
    // and it is what stops the drift reading as a wave. So rotation must
    // decorrelate between neighbours faster than the baseline does.
    const churn = (pick: (index: number) => number): number => {
      let near = 0;
      let far = 0;
      for (let i = 0; i < 3000; i++) {
        near += Math.abs(pick(i + 1) - pick(i));
        far += Math.abs(pick(i + 8) - pick(i));
      }
      return near / far;
    };
    const rot = churn((i) => charJitter(SEED, i).rot);
    const baseline = churn((i) => charJitter(SEED, i).dy);
    expect(rot).toBeGreaterThan(baseline * 1.5);
  });

  it("keeps every letter on the line it belongs to", () => {
    // The upper bound on "slight". DESIGN 11.2 asks whether per-character
    // jitter holds up at small sizes or turns to mush, and mush is what these
    // numbers growing looks like.
    for (let i = 0; i < 3000; i++) {
      const j = charJitter(SEED ^ (i * 2654435761), i);
      expect(Math.abs(j.dy)).toBeLessThanOrEqual(0.06);
      expect(Math.abs(j.dx)).toBeLessThanOrEqual(0.02);
      expect(Math.abs(j.rot)).toBeLessThanOrEqual((2.5 * Math.PI) / 180);
      expect(Math.abs(j.scale - 1)).toBeLessThanOrEqual(0.035);
    }
  });

  it("indexes jitter by character, so inserting text does not reshuffle it", () => {
    // "hello" -> "Xhello": every original character shifts by one index. What
    // must not happen is every *remaining* character getting new jitter, which
    // is what a sequential generator would do.
    const before = [0, 1, 2, 3, 4].map((i) => charJitter(SEED, i));
    const after = [1, 2, 3, 4, 5].map((i) => charJitter(SEED, i));
    expect(after.slice(0, 4)).toEqual(before.slice(1));
  });

  it("keeps scatter inside the specified few degrees", () => {
    const limit = (SCATTER_DEGREES * Math.PI) / 180;
    for (let i = 0; i < 5000; i++) {
      expect(Math.abs(scatterAngle(i * 2654435761))).toBeLessThanOrEqual(limit);
    }
  });

  it("produces a distinct profile per edge", () => {
    const top = Array.from(edgeProfile(SEED, "top", 16));
    const left = Array.from(edgeProfile(SEED, "left", 16));
    expect(top).not.toEqual(left);
    expect(top).toEqual(Array.from(edgeProfile(SEED, "top", 16)));
    expect(Math.max(...top.map(Math.abs))).toBeLessThanOrEqual(1);
  });

  it("ages monotonically from nothing, and never finishes", () => {
    expect(wear(SEED, 0)).toBe(0);
    expect(wear(SEED, -5)).toBe(0);
    let previous = 0;
    for (const days of [1, 10, 60, 365, 3650]) {
      const now = wear(SEED, days);
      expect(now).toBeGreaterThan(previous);
      expect(now).toBeLessThan(1);
      previous = now;
    }
  });

  it("gives independent streams per salt", () => {
    const a = streamFor(SEED, "one");
    const b = streamFor(SEED, "one");
    const c = streamFor(SEED, "two");
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(streamFor(SEED, "one")()).not.toBe(c());
  });

  it("spreads values across the unit interval", () => {
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 20000; i++) {
      buckets[Math.floor(valueAt(i, "spread") * 10)]! += 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(1600);
      expect(count).toBeLessThan(2400);
    }
  });

  it("mints distinct seeds", () => {
    const seeds = new Set(Array.from({ length: 500 }, newSeed));
    expect(seeds.size).toBe(500);
  });
});
