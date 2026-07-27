/**
 * The split and the merge, which have one job between them: the string must
 * not flinch.
 *
 * AC-73 is "child rest lengths sum to the parent's", and almost every test
 * here is that same sentence asked of a different geometry — because the
 * failure it guards against is not subtle arithmetic drift, it is a visible
 * jump at the exact instant the user's gesture succeeds, which reads as the
 * feature being broken rather than as a rounding error.
 */

import { describe, expect, it } from "vitest";

import {
  clamp,
  DEFAULT_SLACK,
  MAX_PRESET_SLACK,
  mergeSlack,
  MIN_SLACK,
  presetSlack,
  splitSlack,
  toggleTaut,
} from "@/lib/slack";

/** How much string there is between two pins. */
const rest = (chord: number, slack: number): number => chord * (1 + slack);

/**
 * How far off the chord a new pin can be pulled at arc fraction `t` and still
 * be reachable.
 *
 * Not a detail of the test — it is the constraint the gesture lives under. A
 * split hands `t` of the string to the near half, and no chord can be longer
 * than the string spanning it, so the drop is bounded by
 * `t * sqrt(rest^2 - chord^2)` on one side and the mirror of it on the other.
 * Ask for more and the answer is not a worse split, it is no split at all —
 * which is what the clamp is for and what the suite below tests separately.
 */
function reachableDrop(chord: number, slack: number, t: number): number {
  const rest = chord * (1 + slack);
  const spare = Math.sqrt(Math.max(0, rest * rest - chord * chord));
  return 0.5 * Math.min(t, 1 - t) * spare;
}

/** A new pin dropped off the chord at fraction `t`, as far as it can reach. */
function pinAt(chord: number, slack: number, t: number) {
  const drop = reachableDrop(chord, slack, t);
  return {
    first: Math.hypot(chord * t, drop),
    second: Math.hypot(chord * (1 - t), drop),
  };
}

/** A split at `t` of a segment, with the new pin placed somewhere. */
function split(chord: number, slack: number, first: number, second: number, t: number) {
  const [a, b] = splitSlack(chord, slack, first, second, t);
  return { a, b, total: rest(first, a) + rest(second, b), parent: rest(chord, slack) };
}

describe("the split conserves rest length (AC-73)", () => {
  /**
   * The headline case: a pin pulled straight out of the middle of a level
   * span. Both halves are shorter than the parent chord, so both end up
   * slacker than the parent ratio — and together they hold exactly as much
   * string as before.
   */
  it("splits a level span pulled out at its midpoint", () => {
    // 200 across with 20% slack is 240 of string. Pulled 60 below the middle,
    // each half spans hypot(100, 60).
    const half = Math.hypot(100, 60);
    const { total, parent } = split(200, 0.2, half, half, 0.5);
    expect(total).toBeCloseTo(parent, 9);
  });

  /** Off-centre, where the two children are nothing like each other. */
  it("splits away from the middle", () => {
    const { first, second } = pinAt(200, 0.25, 0.2);
    const { a, b, total, parent } = split(200, 0.25, first, second, 0.2);
    expect(total).toBeCloseTo(parent, 9);
    /**
     * The two halves come out with different slack, and which way round is
     * worth stating because it is the opposite of the obvious guess. Pulling
     * the pin off the chord lengthens both new chords, but it lengthens the
     * *short* one proportionally far more — fifteen units of drop is most of a
     * forty-unit chord and nothing at all on a hundred-and-sixty-unit one. So
     * the near half, which got a fifth of the string, spends most of it
     * reaching its pin and ends up the tauter of the two.
     */
    expect(b).toBeGreaterThan(a);
  });

  it.each([
    ["a taut-ish span", 300, 0.04, 0.5],
    ["a heavy drape", 180, 0.9, 0.5],
    ["a short run", 26, 0.3, 0.35],
    ["a long run", 4200, 0.12, 0.8],
    ["hard against the near pin", 200, 0.2, 0.02],
    ["hard against the far pin", 200, 0.2, 0.98],
  ] as Array<[string, number, number, number]>)(
    "conserves it — %s",
    (_name, chord, slack, t) => {
      const { first, second } = pinAt(chord, slack, t);
      const { total, parent } = split(chord, slack, first, second, t);
      expect(total).toBeCloseTo(parent, 6);
    },
  );

  /** The sag is what conservation is *for*, so it gets asserted directly:
   *  the same amount of string over the same two pins hangs the same. */
  it("leaves the string with the same amount of itself", () => {
    const parent = rest(200, 0.2);
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const { first, second } = pinAt(200, 0.2, t);
      expect(split(200, 0.2, first, second, t).total).toBeCloseTo(parent, 6);
    }
  });
});

describe("slack stays strictly positive (AC-74)", () => {
  /** > `slackAfter` must be strictly greater than zero, clamped to a small
   *  > minimum. At rest length equal to the chord the solver has no slack to
   *  > absorb error and the rope jitters visibly. — DATA-MODEL section 5.2 */
  it("clamps at the minimum rather than at zero", () => {
    expect(clamp(0)).toBe(MIN_SLACK);
    expect(clamp(-1)).toBe(MIN_SLACK);
    expect(clamp(MIN_SLACK)).toBe(MIN_SLACK);
    expect(clamp(MIN_SLACK / 2)).toBe(MIN_SLACK);
    expect(clamp(0.3)).toBe(0.3);
  });

  it("keeps NaN and infinity out", () => {
    expect(clamp(Number.NaN)).toBe(MIN_SLACK);
    expect(clamp(Infinity)).toBe(MIN_SLACK);
  });

  /**
   * The one case where conservation has to give way, and it gives way in the
   * safe direction. Dragging the new pin further out than the string can reach
   * would need a *negative* slack on both halves; the clamp lengthens the
   * string instead of handing the solver a segment it cannot hold.
   */
  it("lengthens the string rather than asking for a segment shorter than its chord", () => {
    // 240 of string, and the new pin dragged 400 out to one side of it.
    const first = Math.hypot(100, 400);
    const second = Math.hypot(100, 400);
    const { a, b, total, parent } = split(200, 0.2, first, second, 0.5);
    expect(a).toBe(MIN_SLACK);
    expect(b).toBe(MIN_SLACK);
    expect(total).toBeGreaterThan(parent);
  });

  it("never returns something the schema would reject", () => {
    for (const t of [0, 0.5, 1]) {
      for (const chord of [0, 1e-9, 30, 5000]) {
        for (const slack of [0, 0.01, 0.5, 4]) {
          const [a, b] = splitSlack(chord, slack, chord * t, chord * (1 - t), t);
          for (const value of [a, b]) {
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(MIN_SLACK);
          }
        }
      }
    }
  });

  // The cross-check against `crdt/schema.ts`'s own `MIN_SLACK` lives in
  // `crdt/ops/strings.test.ts`, not here: `lib/` may not import `crdt/`, and
  // the lint rule catches a test that tries just as readily as it catches a
  // module. It has to be asserted from the side that is allowed to look both
  // ways.
});

describe("the merge puts it back", () => {
  /** > the neighbouring segments merge, with rest lengths summed and converted
   *  > back to a ratio against the new chord — DATA-MODEL section 5.3 */
  it("sums the rest lengths of the two it replaces", () => {
    const merged = mergeSlack(120, 0.3, 90, 0.5, 200);
    expect(rest(200, merged)).toBeCloseTo(rest(120, 0.3) + rest(90, 0.5), 9);
  });

  /**
   * Split then merge is the identity, which is the property a user actually
   * experiences: pull a pin out of a string, change your mind, remove it, and
   * the string is exactly the string you had.
   */
  it("undoes a split exactly", () => {
    const chord = 260;
    const slack = 0.22;
    for (const t of [0.15, 0.4, 0.5, 0.85]) {
      const { first, second } = pinAt(chord, slack, t);
      const [a, b] = splitSlack(chord, slack, first, second, t);
      expect(mergeSlack(first, a, second, b, chord)).toBeCloseTo(slack, 9);
    }
  });

  it("survives a degenerate chord rather than dividing by it", () => {
    expect(mergeSlack(100, 0.2, 100, 0.2, 0)).toBe(MIN_SLACK);
    expect(Number.isFinite(mergeSlack(0, 0.2, 0, 0.2, 100))).toBe(true);
  });

  /** Merging two nearly-taut segments across a chord that is now longer than
   *  both of them together still cannot produce a taut result. */
  it("clamps when the pins have been dragged apart since", () => {
    expect(mergeSlack(100, 0.01, 100, 0.01, 900)).toBe(MIN_SLACK);
  });
});

/**
 * The `1`-`9` ladder.
 *
 * > | Slack presets | `1`-`9` with a string selected | Taut through to heavily
 * > draped | — DESIGN section 3.4
 *
 * What is being tested is not the arithmetic — it is one exponential — but the
 * shape: that the nine steps are *perceptually* even, which for a ratio means
 * geometrically even, and that the two ends are the two things the design names.
 */
describe("the slack presets", () => {
  it("puts taut at 1 and a heavy drape at 9", () => {
    expect(presetSlack(1)).toBe(MIN_SLACK);
    expect(presetSlack(9)).toBeCloseTo(MAX_PRESET_SLACK, 12);
  });

  /**
   * The property that matters, and the one a linear ladder fails: every step is
   * the same multiple, so the difference between `2` and `3` reads as the same
   * amount of extra drape as the difference between `7` and `8`. Linear steps
   * from 0.01 to 1 would put `2` at 0.13 — already past the default — and spend
   * the remaining seven presets in territory nobody can tell apart.
   */
  it("steps by a constant ratio rather than a constant amount", () => {
    const ratio = presetSlack(2) / presetSlack(1);
    for (let n = 2; n < 9; n++) {
      expect(presetSlack(n + 1) / presetSlack(n)).toBeCloseTo(ratio, 9);
    }
    expect(ratio).toBeGreaterThan(1);
  });

  /**
   * Not arranged, and worth pinning down because it is what makes the ladder
   * usable rather than merely even: anchoring the ends at the minimum and at a
   * doubled-back loop happens to land `5` on the default, and puts `4`, `5` and
   * `6` inside DATA-MODEL section 5.2's "typical range is 0.05 to 0.3" with `7`
   * a hair past the top of it. Three presets for the range most string lives in
   * and six for the extremes either side is the right way round: the wheel is
   * the fine control, and the presets exist to get you out of the middle.
   */
  it("lands the middle on the default and the typical range in the middle", () => {
    expect(presetSlack(5)).toBeCloseTo(DEFAULT_SLACK, 1);
    expect(presetSlack(3)).toBeLessThan(0.05);
    for (const n of [4, 5, 6]) {
      expect(presetSlack(n)).toBeGreaterThanOrEqual(0.05);
      expect(presetSlack(n)).toBeLessThanOrEqual(0.3);
    }
    expect(presetSlack(7)).toBeGreaterThan(0.3);
  });

  it("clamps into the ladder rather than extrapolating off the end of it", () => {
    expect(presetSlack(0)).toBe(presetSlack(1));
    expect(presetSlack(-4)).toBe(presetSlack(1));
    expect(presetSlack(20)).toBe(presetSlack(9));
    expect(presetSlack(Number.NaN)).toBe(DEFAULT_SLACK);
  });

  it("never returns something the schema would reject", () => {
    for (let n = -2; n <= 12; n++) {
      expect(presetSlack(n)).toBeGreaterThanOrEqual(MIN_SLACK);
      expect(Number.isFinite(presetSlack(n))).toBe(true);
    }
  });
});

/**
 * > | Toggle taut | Double-click a segment | Snaps between taut and default
 * > slack | — DESIGN section 3.4
 */
describe("the taut toggle", () => {
  it("goes both ways", () => {
    expect(toggleTaut(MIN_SLACK)).toBe(DEFAULT_SLACK);
    expect(toggleTaut(DEFAULT_SLACK)).toBe(MIN_SLACK);
    expect(toggleTaut(toggleTaut(DEFAULT_SLACK))).toBe(DEFAULT_SLACK);
  });

  /**
   * The wheel can leave a segment a hair above the floor, and a double-click
   * there that pulled it *tighter* by half a percent and called that a toggle
   * would read as the gesture having failed. Anything the eye would call taut
   * goes back to the default.
   */
  it("treats nearly taut as taut", () => {
    expect(toggleTaut(MIN_SLACK * 1.4)).toBe(DEFAULT_SLACK);
    expect(toggleTaut(0)).toBe(DEFAULT_SLACK);
    expect(toggleTaut(Number.NaN)).toBe(DEFAULT_SLACK);
  });

  it("treats anything visibly slack as slack, including a heavy drape", () => {
    expect(toggleTaut(0.05)).toBe(MIN_SLACK);
    expect(toggleTaut(MAX_PRESET_SLACK)).toBe(MIN_SLACK);
    expect(toggleTaut(4)).toBe(MIN_SLACK);
  });

  it("agrees with preset 1 about what taut means", () => {
    expect(toggleTaut(DEFAULT_SLACK)).toBe(presetSlack(1));
  });
});
