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
