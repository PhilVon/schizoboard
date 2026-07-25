import { describe, expect, it } from "vitest";

import { grainLod } from "@/render/cork";

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
