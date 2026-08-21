/**
 * What a timer reads — `lib/timer.ts`.
 *
 * The whole feature's arithmetic, tested as a table, with no DOM and no
 * document anywhere near it. That is not a convenience: `timerReading` takes
 * `now` as an argument precisely so the rule it exists to enforce — nothing is
 * written per second — is checkable without a clock, a frame or a `Y.Doc`.
 */

import { describe, expect, it } from "vitest";

import { runtimeLabel } from "@/lib/objects";
import {
  clockLabel,
  dialLabel,
  elapsedOf,
  isTimerMode,
  NO_TIMER,
  snapWind,
  stepFor,
  timerFace,
  timerReading,
  TIMER_MODES,
  windOf,
  windTo,
  type TimerFields,
} from "@/lib/timer";

/** An arbitrary instant a run began. Nothing depends on which one. */
const T = 1_770_000_000_000;

/** A timer, said as the difference from an unset one. */
const timer = (patch: Partial<TimerFields>): TimerFields => ({ ...NO_TIMER, ...patch });

describe("the five fields and a now", () => {
  /**
   * The four states of the parent's acceptance criterion, plus the two either
   * side of expiry — which is where the arithmetic has to hold on its own,
   * because nothing is ever written to mark it.
   */
  const table: {
    what: string;
    fields: TimerFields;
    now: number;
    elapsed: number;
    remaining: number;
    running: boolean;
    expired: boolean;
    label: string;
  }[] = [
    {
      what: "a stopwatch that has never been started",
      fields: timer({ mode: "stopwatch" }),
      now: T,
      elapsed: 0,
      remaining: 0,
      running: false,
      expired: false,
      label: "0:00",
    },
    {
      what: "a stopwatch running",
      fields: timer({ mode: "stopwatch", runFrom: T }),
      now: T + 3_000,
      elapsed: 3_000,
      remaining: 0,
      running: true,
      expired: false,
      label: "0:03",
    },
    {
      what: "a stopwatch paused, which is the absence of a runFrom and nothing else",
      fields: timer({ mode: "stopwatch", banked: 3_000 }),
      now: T + 9_999_999,
      elapsed: 3_000,
      remaining: 0,
      running: false,
      expired: false,
      label: "0:03",
    },
    {
      what: "a stopwatch resumed, which is banked plus this run and not either one",
      fields: timer({ mode: "stopwatch", banked: 90_000, runFrom: T }),
      now: T + 7_500,
      elapsed: 97_500,
      remaining: 0,
      running: true,
      expired: false,
      label: "1:37",
    },
    {
      what: "a countdown at the instant it is started",
      fields: timer({ mode: "countdown", runsFor: 300_000, runFrom: T }),
      now: T,
      elapsed: 0,
      remaining: 300_000,
      running: true,
      expired: false,
      label: "5:00",
    },
    {
      what: "a countdown a second in",
      fields: timer({ mode: "countdown", runsFor: 300_000, runFrom: T }),
      now: T + 1_000,
      elapsed: 1_000,
      remaining: 299_000,
      running: true,
      expired: false,
      label: "4:59",
    },
    {
      what: "a countdown paused with two minutes on it",
      fields: timer({ mode: "countdown", runsFor: 300_000, banked: 120_000 }),
      now: T + 9_999_999,
      elapsed: 120_000,
      remaining: 180_000,
      running: false,
      expired: false,
      label: "3:00",
    },
    {
      what: "a countdown at the instant it runs out",
      fields: timer({ mode: "countdown", runsFor: 300_000, runFrom: T }),
      now: T + 300_000,
      elapsed: 300_000,
      remaining: 0,
      running: true,
      expired: true,
      label: "0:00",
    },
    {
      what: "a countdown an hour past running out, still expired and still nothing written",
      fields: timer({ mode: "countdown", runsFor: 300_000, runFrom: T }),
      now: T + 3_900_000,
      elapsed: 3_900_000,
      remaining: 0,
      running: true,
      expired: true,
      label: "0:00",
    },
  ];

  for (const row of table) {
    it(row.what, () => {
      const reading = timerReading(row.fields, row.now);
      expect(reading.elapsed).toBe(row.elapsed);
      expect(reading.remaining).toBe(row.remaining);
      expect(reading.running).toBe(row.running);
      expect(reading.expired).toBe(row.expired);
      expect(reading.label).toBe(row.label);
    });
  }
});

describe("expiry is arithmetic and never a flag", () => {
  /**
   * The reason there is no `fired` field to converge on. Two peers reading the
   * same five values at the same instant must agree without either of them
   * having written anything, and the only thing that differs between them is
   * their own clock.
   */
  it("is a pure function of the fields and the instant", () => {
    const fields = timer({ mode: "countdown", runsFor: 60_000, runFrom: T });
    expect(timerReading(fields, T + 59_999)).toEqual(timerReading(fields, T + 59_999));
    expect(timerReading(fields, T + 59_999).expired).toBe(false);
    expect(timerReading(fields, T + 60_000).expired).toBe(true);
  });

  /**
   * A countdown nobody set is not one that finished instantly. Without this the
   * flash line would go off the moment the mode chip was pressed, for a timer
   * with no length and nothing on it.
   */
  it("does not expire a countdown of no length", () => {
    const unset = timer({ mode: "countdown", runFrom: T });
    expect(timerReading(unset, T + 5_000).expired).toBe(false);
    expect(timerReading(unset, T + 5_000).remaining).toBe(0);
  });

  it("never expires the two modes that have nothing to run out of", () => {
    for (const mode of ["clock", "stopwatch"] as const) {
      const long = timer({ mode, runsFor: 1, runFrom: T });
      expect(timerReading(long, T + 9_999_999).expired).toBe(false);
    }
  });
});

describe("a clock ahead of this one", () => {
  /**
   * Skew is accepted — `wear.ts` already ages every item off each machine's own
   * `Date.now()` with no correction. What is refused is nonsense: a negative
   * elapsed would run a countdown backwards past its own length and light
   * nothing, so a start in the future reads as a start just now.
   */
  it("clamps a runFrom from the future to zero elapsed rather than a negative one", () => {
    const ahead = timer({ mode: "stopwatch", runFrom: T + 4_000 });
    expect(elapsedOf(ahead, T)).toBe(0);
    expect(timerReading(ahead, T).elapsed).toBe(0);
    expect(timerReading(ahead, T).label).toBe("0:00");
  });

  it("keeps what was already banked when the future start contributes nothing", () => {
    const ahead = timer({ mode: "stopwatch", banked: 5_000, runFrom: T + 4_000 });
    expect(elapsedOf(ahead, T)).toBe(5_000);
  });

  it("does not let a skewed start push a countdown past its own length", () => {
    const ahead = timer({ mode: "countdown", runsFor: 60_000, runFrom: T + 4_000 });
    expect(timerReading(ahead, T).remaining).toBe(60_000);
    expect(timerReading(ahead, T).expired).toBe(false);
  });
});

describe("a number a peer put in the map", () => {
  /**
   * `crdt/ops` refuses non-finite numbers at the writer, which is what stops
   * this build writing one — not what stops one arriving. This is the second of
   * the two places, and the face is what would print the `NaN`.
   */
  const junk = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1];

  it("reads a nonsense banked as zero rather than carrying it into the face", () => {
    for (const bad of junk) {
      const broken = timer({ mode: "stopwatch", banked: bad, runFrom: T });
      const reading = timerReading(broken, T + 2_000);
      expect(reading.elapsed).toBe(2_000);
      expect(reading.label).toBe("0:02");
    }
  });

  it("reads a nonsense runsFor as a countdown of no length, which cannot expire", () => {
    for (const bad of junk) {
      const broken = timer({ mode: "countdown", runsFor: bad, runFrom: T });
      const reading = timerReading(broken, T + 2_000);
      expect(reading.remaining).toBe(0);
      expect(reading.expired).toBe(false);
      expect(reading.label).toBe("0:00");
    }
  });

  /**
   * The one that nearly shipped. A nonsense `runFrom` cannot be repaired to
   * zero the way a nonsense duration can: zero is a fine duration and a
   * catastrophic *instant*, and `now - 0` is fifty-six years. It contributes
   * nothing instead, so the face falls back to what was banked.
   */
  it("reads a nonsense runFrom as no run at all, not as a run since the epoch", () => {
    for (const bad of [...junk, 0]) {
      const broken = timer({ mode: "stopwatch", banked: 1_000, runFrom: bad });
      expect(elapsedOf(broken, T)).toBe(1_000);
      expect(timerReading(broken, T).label).toBe("0:01");
    }
  });

  /** The frame clock cannot hand this over, and the face must not print it. */
  it("shows the banked total when now itself is not a number", () => {
    const running = timer({ mode: "stopwatch", banked: 8_000, runFrom: T });
    expect(elapsedOf(running, Number.NaN)).toBe(8_000);
    expect(timerReading(running, Number.NaN).label).toBe("0:08");
    expect(clockLabel(Number.NaN)).toBe("--:--");
  });
});

describe("the second a face claims", () => {
  /**
   * The two corrections are opposite and the principle is one: never claim a
   * moment that has not happened. Rounding — which is what `runtimeLabel` does
   * to its own argument — would do both wrong by half a second.
   */
  it("floors a stopwatch, so half a second in still reads zero", () => {
    const run = timer({ mode: "stopwatch", runFrom: T });
    expect(timerReading(run, T + 500).label).toBe("0:00");
    expect(timerReading(run, T + 999).label).toBe("0:00");
    expect(timerReading(run, T + 1_000).label).toBe("0:01");
  });

  it("ceils a countdown, so it holds the last second until it is actually gone", () => {
    const run = timer({ mode: "countdown", runsFor: 10_000, runFrom: T });
    expect(timerReading(run, T + 9_001).label).toBe("0:01");
    expect(timerReading(run, T + 9_999).label).toBe("0:01");
    expect(timerReading(run, T + 10_000).label).toBe("0:00");
  });
});

describe("which formatter writes which face", () => {
  /**
   * A duration and a time of day look alike and mean nothing like each other,
   * so they do not share a function. `runtimeLabel` drops the leading unit when
   * it is empty, which is right for a spine and wrong for a wall.
   */
  it("gives the stopwatch and the countdown the spine's formatter", () => {
    const watch = timer({ mode: "stopwatch", banked: 97_500 });
    expect(watch.mode).toBe("stopwatch");
    expect(timerReading(watch, T).label).toBe(runtimeLabel(97));

    const down = timer({ mode: "countdown", runsFor: 3_725_000 });
    expect(timerReading(down, T).label).toBe(runtimeLabel(3_725));
  });

  it("pads the clock's hour, which the spine's formatter never would", () => {
    const morning = new Date(2026, 7, 15, 9, 5, 0).getTime();
    expect(clockLabel(morning)).toBe("09:05");
    expect(clockLabel(new Date(2026, 7, 15, 0, 5, 0).getTime())).toBe("00:05");
    expect(clockLabel(new Date(2026, 7, 15, 23, 59, 0).getTime())).toBe("23:59");

    // The same instant put through the other one, to say plainly that they are
    // not interchangeable: nine hours and five minutes as a duration is neither
    // of the two strings above.
    expect(runtimeLabel(9 * 3600 + 5 * 60)).toBe("9:05:00");
  });

  it("gives the clock a face that ignores every field but the instant", () => {
    const noon = new Date(2026, 7, 15, 12, 0, 0).getTime();
    const busy = timer({ mode: "clock", runsFor: 60_000, runFrom: T, banked: 45_000 });
    expect(timerReading(busy, noon).label).toBe("12:00");
    expect(timerReading(busy, noon).remaining).toBe(0);
    expect(timerReading(busy, noon).expired).toBe(false);
  });
});

describe("the mode as a value", () => {
  it("offers three and writes two", () => {
    expect(TIMER_MODES).toEqual(["clock", "countdown", "stopwatch"]);
    expect(NO_TIMER.mode).toBe("clock");
  });

  /** What a later build's fourth mode, and a peer's nonsense, have to read as. */
  it("recognises the three and nothing else", () => {
    for (const mode of TIMER_MODES) expect(isTimerMode(mode)).toBe(true);
    for (const junk of ["alarm", "", 3, null, undefined, {}, ["clock"]]) {
      expect(isTimerMode(junk)).toBe(false);
    }
  });
});

describe("what a dial says past an hour", () => {
  /**
   * T-407. `runtimeLabel` prints a week as `168:00:00` — correct, and useless
   * on a face. Past a day the dial gives up its seconds.
   */
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  it("says days and hours once there is a day on it", () => {
    expect(dialLabel(7 * DAY, HOUR)).toBe("7d 00h");
    expect(dialLabel(6 * DAY + 23 * HOUR, HOUR)).toBe("6d 23h");
    // Two digits on the hours, so the width does not shuffle as it counts down
    // — the same courtesy `tabular-nums` does either side of a colon.
    expect(dialLabel(6 * DAY + 3 * HOUR, HOUR)).toBe("6d 03h");
  });

  it("goes back to a spine's reading under a day", () => {
    expect(dialLabel(23 * HOUR + 59 * 60_000 + 59_000, 1000)).toBe("23:59:59");
    expect(dialLabel(90_000, 1000)).toBe("1:30");
  });

  it("compares a long countdown hourly and a short one by the second", () => {
    // The face changes hourly past a day, so dirtying it once a second would be
    // eighty-six thousand writes for twenty-four changes.
    expect(stepFor(4 * DAY, true)).toBe(HOUR);
    expect(stepFor(23 * HOUR, true)).toBe(1000);
    // And T-405's answer still coarsens a face too small to read, both taken
    // together rather than either winning.
    expect(stepFor(23 * HOUR, false)).toBe(60_000);
    expect(stepFor(4 * DAY, false)).toBe(HOUR);
  });

  it("builds the face's digits out of the very number the tick compared", () => {
    // AC-1167, as a property rather than a promise: whatever the tier and
    // whatever the length, the label is `dialLabel(quantum * step)`.
    for (const runsFor of [90_000, 45 * 60_000, 5 * HOUR, 4 * DAY, 7 * DAY]) {
      for (const detailed of [true, false]) {
        const fields: TimerFields = { ...NO_TIMER, mode: "countdown", runsFor, runFrom: T };
        const at = T + 1234;
        const face = timerFace(fields, at, detailed);
        const step = stepFor(face.remaining, detailed);
        expect(face.label).toBe(dialLabel(face.quantum * step, step));
      }
    }
  });
});

describe("winding the bezel", () => {
  /** T-407, T-411 — one turn is the whole scale, which is what a dial is. */
  const CURVE = 3;
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  it("puts a week at one full turn and nothing at none", () => {
    expect(windTo(0, CURVE)).toBe(0);
    expect(windTo(1, CURVE)).toBe(7 * DAY);
  });

  it("keeps the resolution at the short end, where timers actually live", () => {
    // A linear turn would put five minutes inside the first half-degree.
    expect(windTo(30 / 360, CURVE)).toBe(6 * MIN);
    expect(windTo(60 / 360, CURVE)).toBe(47 * MIN);
    expect(windTo(90 / 360, CURVE)).toBe(2 * HOUR + 40 * MIN);
  });

  it("has a stop at each end, because a dial does", () => {
    // Running off the end of a dial silently is how you set a timer you did not
    // mean. Backwards past nothing is no length, not a negative one.
    expect(windTo(-0.5, CURVE)).toBe(0);
    expect(windTo(3, CURVE)).toBe(7 * DAY);
    expect(snapWind(9 * DAY)).toBe(7 * DAY);
  });

  it("has detents that grow with the reading", () => {
    // Nobody can hold their hand still enough to set four days to the minute,
    // and nobody asked to.
    expect(snapWind(12 * MIN + 20_000)).toBe(12 * MIN);
    expect(snapWind(3 * HOUR + 2 * MIN)).toBe(3 * HOUR);
    expect(snapWind(10 * HOUR + 7 * MIN)).toBe(10 * HOUR);
    expect(snapWind(4 * DAY + 40 * MIN)).toBe(4 * DAY + HOUR);
  });

  it("finds the turn a length is already at, so a wind starts from the dial", () => {
    // Absolute would snap the countdown to wherever the pointer landed the
    // instant the bezel was grabbed.
    for (const turns of [0.1, 0.25, 0.5, 0.75, 1]) {
      const value = windTo(turns, CURVE);
      // Within one detent, which is all a round trip through a snap can promise.
      expect(Math.abs(windTo(windOf(value, CURVE), CURVE) - value)).toBeLessThanOrEqual(HOUR);
    }
  });
});
