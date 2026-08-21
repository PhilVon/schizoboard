/**
 * The board's clock against this machine's — T-404.
 *
 * Two of these are the bug: a countdown and a stopwatch read through
 * `lib/timer.ts` on a machine whose clock disagrees with the one that pressed
 * start. They are written against the real arithmetic rather than against the
 * conversion alone, because the conversion is obviously right on its own and
 * the thing that was actually broken is what the face said at the end of it.
 *
 * The reading a machine takes of a timer it started itself must not move when
 * it learns an offset. That is the property that makes this safe to land before
 * anything measures one: a board with no wire has nobody to disagree with.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { timerReading, type TimerFields } from "@/lib/timer";
import { SharedClock } from "@/state/clock";

/** An instant with no significance beyond being a plausible one. */
const T0 = 1_700_000_000_000;

let clock: SharedClock;

beforeEach(() => {
  clock = new SharedClock();
});

function countdown(runFrom: number, runsFor = 300_000): TimerFields {
  return { mode: "countdown", runsFor, runFrom, banked: 0, lights: null };
}

function stopwatch(runFrom: number | null): TimerFields {
  return { mode: "stopwatch", runsFor: 0, runFrom, banked: 0, lights: null };
}

describe("SharedClock", () => {
  it("trusts this machine until it is taught otherwise", () => {
    expect(clock.ahead).toBe(0);
    expect(clock.shared(T0)).toBe(T0);
    expect(clock.local(T0)).toBe(T0);
  });

  it("carries an instant both ways", () => {
    clock.learn(90_000);
    expect(clock.shared(T0)).toBe(T0 - 90_000);
    expect(clock.local(T0 - 90_000)).toBe(T0);
  });

  it("refuses an offset it cannot believe, and keeps the last good one", () => {
    expect(clock.learn(4_000)).toBe(true);
    expect(clock.learn(Number.NaN)).toBe(false);
    expect(clock.learn(Number.POSITIVE_INFINITY)).toBe(false);
    // Half a day is not a skew, it is a broken clock — see MAX_SKEW_MS.
    expect(clock.learn(13 * 60 * 60 * 1000)).toBe(false);
    expect(clock.ahead).toBe(4_000);
  });

  it("gives up its offset when the wire goes", () => {
    clock.learn(90_000);
    clock.forget();
    expect(clock.ahead).toBe(0);
  });

  it("spoils nothing further when the instant is already nonsense", () => {
    clock.learn(90_000);
    expect(Number.isNaN(clock.shared(Number.NaN))).toBe(true);
    expect(Number.isNaN(clock.local(Number.NaN))).toBe(true);
  });
});

describe("the reading two machines take of one timer", () => {
  /**
   * The bug, as a table.
   *
   * A starts a timer at its own `T0`. B's wall clock is ninety seconds behind
   * A's, so B's `Date.now()` reads `T0 - 90_000` at the very same moment. Every
   * row below is the two of them reading fifteen seconds later.
   */
  const SKEW = 90_000;
  const started = T0;
  const fifteenLater = T0 + 15_000;

  /**
   * Read the way the application reads, and not the equivalent other way.
   *
   * `app/main.ts` hands the face this machine's **raw** `Date.now()` together
   * with the offset, rather than a pre-converted instant — because a clock face
   * needs the raw one in the same call. So these pass `ahead` through, and a
   * test that converted the instant itself would prove the arithmetic while
   * leaving the shipped path uncovered. It did, briefly, and mutating the
   * correction out of `elapsedOf` left it green.
   */
  const readOn = (fields: TimerFields, localNow: number, ahead: number) =>
    timerReading(fields, localNow, ahead);

  it("was the whole defect, uncorrected", () => {
    const a = readOn(stopwatch(started), fifteenLater, 0);
    // B has learned nothing, so it subtracts A's instant from its own clock.
    const b = readOn(stopwatch(started), fifteenLater - SKEW, 0);
    expect(a.label).toBe("0:15");
    // Not "slightly behind" — stopped dead, which is what the clamp in
    // `elapsedOf` turns a negative elapsed into.
    expect(b.label).toBe("0:00");
  });

  it("agrees on a stopwatch once B knows how far behind it is", () => {
    const b = new SharedClock();
    b.learn(-SKEW);
    const onA = readOn(stopwatch(started), fifteenLater, clock.ahead);
    const onB = readOn(stopwatch(started), fifteenLater - SKEW, b.ahead);
    expect(onA.label).toBe("0:15");
    expect(onB.label).toBe(onA.label);
  });

  it("agrees on a countdown once B knows how far behind it is", () => {
    const b = new SharedClock();
    b.learn(-SKEW);
    const onA = readOn(countdown(started), fifteenLater, clock.ahead);
    const onB = readOn(countdown(started), fifteenLater - SKEW, b.ahead);
    expect(onA.label).toBe("4:45");
    expect(onB.label).toBe(onA.label);
  });

  it("does not fire on a peer whose clock is far ahead of the start", () => {
    // Two hundred seconds ahead against a countdown of sixty: uncorrected, B
    // reads it as expired the instant the start arrives.
    const ahead = 200_000;
    const wrong = readOn(countdown(started, 60_000), T0 + ahead, 0);
    expect(wrong.expired).toBe(true);

    const b = new SharedClock();
    b.learn(ahead);
    const right = readOn(countdown(started, 60_000), T0 + ahead, b.ahead);
    expect(right.expired).toBe(false);
    expect(right.label).toBe("1:00");
  });

  it("leaves a timer this machine started alone", () => {
    // The property that makes the offset safe to carry before anything
    // measures one: this machine writes through `shared` and reads through
    // `ahead`, and the two cancel whatever the offset is.
    const a = new SharedClock();
    a.learn(37_000);
    const startedInBase = a.shared(T0);
    const reading = readOn(stopwatch(startedInBase), T0 + 15_000, a.ahead);
    expect(reading.label).toBe("0:15");
  });

  it("shows this machine's own time on a clock face, offset or not", () => {
    // The exemption, and it is not a detail: a wall clock that disagreed with
    // the taskbar under it would be a second bug wearing the first one's
    // clothes. Ten minutes of skew, and the face still says what the machine
    // it hangs on says.
    const b = new SharedClock();
    b.learn(600_000);
    const face: TimerFields = { ...stopwatch(null), mode: "clock" };
    expect(readOn(face, T0, b.ahead).label).toBe(timerReading(face, T0, 0).label);
  });
});
