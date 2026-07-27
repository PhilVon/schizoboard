/**
 * The pressure model.
 *
 * Two properties carry the whole of AC-77, and both are the kind that a plausible
 * wrong implementation satisfies halfway. The width has to *vary* — a constant is
 * the failure DESIGN section 6.5 calls "dead, uniform lines" — and it has to vary
 * with the speed of the hand rather than with the sample rate, because on this
 * board those two are not related: `getCoalescedEvents` hands over as many
 * samples as the OS took.
 */

import { describe, expect, it } from "vitest";

import { PRESSURE_NEUTRAL, pressureForSpeed, reportsRealPressure, VelocityPressure } from "@/lib/pressure";

/** Walk a straight line at a fixed speed, reporting the pressure at each step. */
function trace(
  model: VelocityPressure,
  { pxPerStep, msPerStep, steps }: { pxPerStep: number; msPerStep: number; steps: number },
): number[] {
  const read: number[] = [];
  for (let i = 0; i <= steps; i++) read.push(model.next(i * pxPerStep, 0, i * msPerStep));
  return read;
}

describe("which devices measure pressure", () => {
  it("is the pen, and only the pen", () => {
    expect(reportsRealPressure("pen")).toBe(true);
    for (const type of ["mouse", "touch", "", undefined]) {
      expect(reportsRealPressure(type)).toBe(false);
    }
  });

  it("names the constant a device with no sensor reports", () => {
    // The Pointer Events spec's value for "a button is down and I cannot tell you
    // any more than that". Named so that nobody reads a bare 0.5 as a choice.
    expect(PRESSURE_NEUTRAL).toBe(0.5);
  });
});

describe("the speed curve", () => {
  it("is full pressure at rest and falls away as the hand speeds up", () => {
    expect(pressureForSpeed(0)).toBe(1);
    const ladder = [0.1, 0.35, 0.7, 1.4, 2.8, 5.6].map(pressureForSpeed);
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]!).toBeLessThan(ladder[i - 1]!);
  });

  it("keeps responding at every speed rather than saturating", () => {
    // A ramp between a slow and a fast threshold has a dead zone at each end, and
    // both ends are places people draw. A hyperbola has neither, so a *pair* of
    // speeds is distinguishable however slow or fast both of them are.
    expect(pressureForSpeed(0.02)).toBeGreaterThan(pressureForSpeed(0.05));
    expect(pressureForSpeed(4)).toBeGreaterThan(pressureForSpeed(8));
  });

  it("never thins to nothing", () => {
    // A hairline reads as the ink having run out, and an outline with no width has
    // no area to fill.
    for (const wild of [50, 500, 1e6]) {
      expect(pressureForSpeed(wild)).toBeGreaterThan(0.05);
    }
  });

  it("treats a nonsense speed as at rest rather than as infinitely fast", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(pressureForSpeed(bad)).toBe(1);
    }
  });
});

describe("pressure along a stroke", () => {
  it("starts at full width — a stroke begins from rest", () => {
    expect(new VelocityPressure().next(100, 100, 1000)).toBe(1);
  });

  it("thins as the hand accelerates and swells as it slows", () => {
    const model = new VelocityPressure();
    model.next(0, 0, 0);
    const slow = model.next(2, 0, 10);
    const faster = model.next(40, 0, 20);
    const fastest = model.next(120, 0, 30);
    expect(faster).toBeLessThan(slow);
    expect(fastest).toBeLessThan(faster);
    // Slowing back down recovers, rather than the stroke staying thin because it
    // was once fast.
    expect(model.next(121, 0, 60)).toBeGreaterThan(fastest);
  });

  it("does not mistake a high sample rate for a fast hand", () => {
    // The same hand, at the same speed — 1 px/ms — sampled at 60 Hz and at
    // 1000 Hz. This is the one that catches a distance-based model, which is what
    // `perfect-freehand`'s own simulation is and why it is turned off.
    const coarse = trace(new VelocityPressure(), { pxPerStep: 16, msPerStep: 16, steps: 30 });
    const fine = trace(new VelocityPressure(), { pxPerStep: 1, msPerStep: 1, steps: 480 });
    expect(coarse[coarse.length - 1]!).toBeCloseTo(fine[fine.length - 1]!, 2);
  });

  it("smooths over a span of time rather than a count of samples", () => {
    // Two identical hands sampled at different rates must not only agree at the
    // end but converge at the same *moment* — a model averaging its last N
    // readings would settle 16 times sooner on the finer one.
    const coarse = trace(new VelocityPressure(), { pxPerStep: 16, msPerStep: 16, steps: 8 });
    const fine = trace(new VelocityPressure(), { pxPerStep: 1, msPerStep: 1, steps: 128 });
    // Both after ~128 ms of the same gesture.
    expect(coarse[coarse.length - 1]!).toBeCloseTo(fine[fine.length - 1]!, 2);
  });

  it("holds a steady hand at a steady width", () => {
    const read = trace(new VelocityPressure(), { pxPerStep: 8, msPerStep: 8, steps: 60 });
    const tail = read.slice(-10);
    // Not flat *overall* — it eased in from rest — but flat once it has settled,
    // so a long straight drag does not shimmer.
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(0.01);
  });

  it("forgets the previous stroke on reset", () => {
    const model = new VelocityPressure();
    trace(model, { pxPerStep: 60, msPerStep: 5, steps: 20 });
    model.reset();
    expect(model.next(0, 0, 500)).toBe(1);
  });

  it("keeps varying when every sample carries the same timestamp", () => {
    // The degraded path: an engine that stamps a coalesced batch identically. The
    // distance between samples has to carry it alone, which is worse than real
    // timing but is not a straight line.
    const model = new VelocityPressure();
    model.next(0, 0, 7);
    const near = model.next(2, 0, 7);
    const far = model.next(60, 0, 7);
    expect(far).toBeLessThan(near);
    expect(near).toBeLessThan(1);
  });

  it("does not divide by a zero interval", () => {
    const model = new VelocityPressure();
    model.next(0, 0, 100);
    for (const p of [model.next(10, 0, 100), model.next(20, 0, 99)]) {
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThan(0);
    }
  });
});
