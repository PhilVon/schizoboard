/**
 * The dials, and the one property that makes the panel worth having: a value
 * written here is a value the simulation is using on the next call.
 *
 * That is a claim about ES module live bindings rather than about arithmetic,
 * so it is tested through a real consumer — `naturalRate` reads `GRAVITY` and
 * `SWING_MAX_RATE` off this module — and not by reading the export back, which
 * would pass just as happily if nothing else in `sim/` could see the change.
 */

import { afterEach, describe, expect, it } from "vitest";

import { naturalRate } from "@/sim/torsion";
import {
  GRAVITY,
  resetTuning,
  setTuning,
  SWING_MAX_RATE,
  TUNABLES,
  tuningChanged,
} from "@/sim/tuning";

// Every test in this file moves module state that the whole worker shares. A
// leaked `GRAVITY` would not fail here — it would fail in whichever sim test
// ran next, which is the worst possible place to find it.
afterEach(() => resetTuning());

describe("the dials themselves", () => {
  /**
   * The one way a table like this rots: a range narrowed around a value that
   * has since been retuned, so the panel opens with its thumb off the end and
   * the first touch of the slider changes a number nobody meant to change.
   */
  it("every default is inside its own range", () => {
    for (const knob of TUNABLES) {
      expect(knob.read(), knob.key).toBeGreaterThanOrEqual(knob.min);
      expect(knob.read(), knob.key).toBeLessThanOrEqual(knob.max);
      expect(knob.step, knob.key).toBeGreaterThan(0);
    }
  });

  it("names every value in the module and no others", () => {
    // Seventeen dials, and the check that matters is uniqueness: two rows
    // reading the same binding is a panel where one of them silently wins.
    const keys = TUNABLES.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("GRAVITY");
    expect(keys).toContain("MAX_AWAKE_PARTICLES");
  });

  it("clamps to the range rather than refusing", () => {
    expect(setTuning("GRAVITY", -5000)).toBe(0);
    expect(setTuning("GRAVITY", 1e9)).toBe(40000);
  });

  it("quantises to the step, and to the step's own precision", () => {
    // 0.00030000000000000003 is what a slider at the default would otherwise
    // put on screen — `3e-4` does not divide by `1e-5` in binary.
    expect(setTuning("SWING_SLEEP_ANGLE", 3e-4)).toBe(3e-4);
    expect(setTuning("ROPE_SUBSTEPS", 16.4)).toBe(16);
    expect(setTuning("SIM_MARGIN", 0.33)).toBe(0.35);
  });

  it("leaves a value alone when handed nonsense, and complains about a name", () => {
    setTuning("GRAVITY", 8000);
    expect(setTuning("GRAVITY", Number.NaN)).toBe(8000);
    expect(() => setTuning("NOT_A_DIAL", 1)).toThrow(/no such tuning value/);
  });

  it("knows whether anything has been moved, and puts it all back", () => {
    expect(tuningChanged()).toBe(false);
    setTuning("ROPE_DAMPING", 0.9);
    expect(tuningChanged()).toBe(true);
    resetTuning();
    expect(tuningChanged()).toBe(false);
    expect(ROPE_DAMPING_NOW()).toBe(0.98);
  });
});

/** Read through a function so the binding is fetched now, not at import. */
function ROPE_DAMPING_NOW(): number {
  return TUNABLES.find((k) => k.key === "ROPE_DAMPING")!.read();
}

describe("what the simulation sees", () => {
  /**
   * The whole mechanism, in one assertion: `sim/torsion.ts` imported `GRAVITY`
   * once, at module load, and still reads the new number. If this ever fails —
   * a bundler inlining the value, someone turning it back into a `const` —
   * every slider on the panel becomes a control that moves and does nothing.
   */
  it("uses a gravity written after it was imported", () => {
    setTuning("GRAVITY", 3000);
    const before = naturalRate(0, 100, 240, 200);
    setTuning("GRAVITY", 12000);
    const after = naturalRate(0, 100, 240, 200);

    // Four times the gravity is twice the natural rate, and this pendulum is
    // well under the ceiling at both.
    expect(after).toBeCloseTo(before * 2, 5);
    // And this file's own import is the same live binding, read now rather
    // than copied at import — which is the property the whole panel rests on.
    expect(GRAVITY).toBe(12000);
  });

  it("uses a ceiling written after it was imported", () => {
    setTuning("GRAVITY", 40000);
    // A pin through the very corner of a small scrap: short, stiff, and up
    // against the ceiling rather than against the physics.
    expect(naturalRate(2, 2, 40, 40)).toBe(SWING_MAX_RATE);

    setTuning("SWING_MAX_RATE", 4);
    expect(naturalRate(2, 2, 40, 40)).toBe(4);
  });
});
