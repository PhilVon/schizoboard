import { describe, expect, it } from "vitest";

import { grainLod, pinholeLod, pinholesFor } from "@/render/cork";

describe("grainLod", () => {
  it("hides the grain where its tile period would read as wallpaper", () => {
    expect(grainLod(0.05)).toBe(0);
    expect(grainLod(0.18)).toBe(0);
  });

  it("shows it in full once the board is close enough to resolve it", () => {
    expect(grainLod(0.45)).toBe(1);
    expect(grainLod(4)).toBe(1);
  });

  it("ramps smoothly through the band, with no step at either end", () => {
    expect(grainLod(0.19)).toBeGreaterThan(0);
    expect(grainLod(0.19)).toBeLessThan(0.05);
    expect(grainLod(0.315)).toBeCloseTo(0.5, 6);
    expect(grainLod(0.44)).toBeGreaterThan(0.95);
    expect(grainLod(0.44)).toBeLessThan(1);
  });
});

describe("pinholeLod", () => {
  it("draws nothing at the zoom a board opens at", () => {
    // The boot fit lands around 29% on a board of a dozen items, where a
    // two-unit hole is well under a pixel — a grey smear rather than a mark.
    expect(pinholeLod(0.29)).toBe(0);
    expect(pinholeLod(0.35)).toBe(0);
  });

  it("holds off longer than the grain does, because it is smaller", () => {
    // The bands must not be the same. Grain is out at 0.45; a hole is still
    // arriving there, and that difference is the whole of the reason both
    // functions exist rather than one.
    expect(grainLod(0.45)).toBe(1);
    expect(pinholeLod(0.45)).toBeLessThan(1);
  });

  it("is fully there by the time anybody is reading the board", () => {
    expect(pinholeLod(0.85)).toBe(1);
    expect(pinholeLod(4)).toBe(1);
  });

  it("ramps with no step at either end", () => {
    expect(pinholeLod(0.36)).toBeGreaterThan(0);
    expect(pinholeLod(0.36)).toBeLessThan(0.05);
    expect(pinholeLod(0.6)).toBeCloseTo(0.5, 6);
    expect(pinholeLod(0.84)).toBeGreaterThan(0.95);
    expect(pinholeLod(0.84)).toBeLessThan(1);
  });
});

describe("pinholesFor", () => {
  const SEED = 0x5c1201;

  it("gives the same patch for the same pin every time it is asked", () => {
    // Two peers draw one cork. If this were a live RNG they would not.
    expect(pinholesFor(SEED, "pin-a")).toEqual(pinholesFor(SEED, "pin-a"));
  });

  it("gives a different patch to each pin, and to each board", () => {
    expect(pinholesFor(SEED, "pin-a")).not.toEqual(pinholesFor(SEED, "pin-b"));
    expect(pinholesFor(SEED, "pin-a")).not.toEqual(pinholesFor(SEED + 1, "pin-a"));
  });

  it("keeps every hole in a patch around the pin rather than out on the board", () => {
    for (let i = 0; i < 400; i++) {
      for (const hole of pinholesFor(SEED, `pin-${i}`)) {
        expect(Math.hypot(hole.dx, hole.dy)).toBeLessThanOrEqual(20);
      }
    }
  });

  it("is a patch and not a single mark, and never a crowd", () => {
    const counts = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const holes = pinholesFor(SEED, `pin-${i}`);
      expect(holes.length).toBeGreaterThanOrEqual(2);
      expect(holes.length).toBeLessThanOrEqual(5);
      counts.add(holes.length);
    }
    // All four counts should turn up over four hundred pins; a generator stuck
    // on one of them would still pass every assertion above.
    expect(counts.size).toBe(4);
  });

  it("does not pile the holes up against the pin", () => {
    // Radius is square-rooted so the patch is evenly covered. Uniform radius
    // would put half of them inside half the spread; even coverage puts a
    // quarter there. This fails on the un-rooted version.
    const radii: number[] = [];
    for (let i = 0; i < 400; i++) {
      for (const hole of pinholesFor(SEED, `pin-${i}`)) radii.push(Math.hypot(hole.dx, hole.dy));
    }
    const inner = radii.filter((r) => r <= 10).length / radii.length;
    expect(inner).toBeGreaterThan(0.15);
    expect(inner).toBeLessThan(0.35);
  });

  it("reaches every baked sprite, so a patch does not read as stamped", () => {
    const variants = new Set<number>();
    for (let i = 0; i < 200; i++) {
      for (const hole of pinholesFor(SEED, `pin-${i}`)) variants.add(hole.variant);
    }
    expect([...variants].sort()).toEqual([0, 1, 2, 3]);
  });
});
