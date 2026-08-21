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
  return { mode: "countdown", runsFor, runFrom, runBy: null, banked: 0, lights: null };
}

function stopwatch(runFrom: number | null): TimerFields {
  return { mode: "stopwatch", runsFor: 0, runFrom, runBy: null, banked: 0, lights: null };
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

describe("a peer's own clock, heard over awareness", () => {
  /**
   * T-410. A discovered-peer mesh has no single base to be ahead of, and does
   * not need one: every peer holds a direct link to every other, so each timer
   * can be read in the frame its own writer keeps.
   */
  const PEER = 4242;

  it("measures how far this machine is ahead of a peer", () => {
    // The peer says 90s ago by our clock, and the message took nothing.
    clock.hear(PEER, T0 - 90_000, T0);
    expect(clock.aheadOf(PEER)).toBe(90_000);
  });

  it("keeps the smallest reading, because delay is never negative", () => {
    // Every sample is the true offset plus a delay, so the minimum is the one
    // with the least delay in it. An average would be biased by the mean
    // latency and would get worse on a busy network rather than better.
    clock.hear(PEER, T0 - 90_000, T0 + 400);
    expect(clock.aheadOf(PEER)).toBe(90_400);
    clock.hear(PEER, T0 - 90_000, T0 + 12);
    expect(clock.aheadOf(PEER)).toBe(90_012);
    // And a slower one after it does not spoil what was measured.
    clock.hear(PEER, T0 - 90_000, T0 + 900);
    expect(clock.aheadOf(PEER)).toBe(90_012);
  });

  it("believes a clock that has actually moved", () => {
    // A minimum that could only fall would pin the estimate for the session,
    // and a machine that slept for an hour would never be believed again. Past
    // PEER_RESET_MS no plausible delay explains the gap.
    clock.hear(PEER, T0, T0);
    expect(clock.aheadOf(PEER)).toBe(0);
    clock.hear(PEER, T0 - 3_600_000, T0);
    expect(clock.aheadOf(PEER)).toBe(3_600_000);
  });

  it("falls back to this machine's base for a peer it has not heard", () => {
    // Which is the whole of how the two topologies live together: a mesh has
    // the writer's offset, and the relay topology has one base for everybody
    // and an empty table.
    clock.learn(5_000);
    expect(clock.aheadOf(PEER)).toBe(5_000);
    expect(clock.aheadOf(null)).toBe(5_000);
  });

  it("lets a peer's offset go when the peer does", () => {
    // The next client to take that id is a different machine.
    clock.hear(PEER, T0 - 90_000, T0);
    expect(clock.heard).toBe(1);
    clock.lost(PEER);
    expect(clock.heard).toBe(0);
    expect(clock.aheadOf(PEER)).toBe(0);
  });

  it("refuses a stamp it cannot believe", () => {
    clock.hear(PEER, Number.NaN, T0);
    clock.hear(PEER, 0, T0);
    clock.hear(PEER, T0 - 20 * 60 * 60 * 1000, T0);
    expect(clock.heard).toBe(0);
  });

  it("reads two peers' timers each in its own frame", () => {
    // The case a single base cannot serve: two machines, each wrong in a
    // different direction, and a timer from each.
    const A = 11;
    const B = 22;
    clock.hear(A, T0 - 90_000, T0);
    clock.hear(B, T0 + 30_000, T0);

    const fromA: TimerFields = { ...stopwatch(T0 - 90_000), runBy: A };
    const fromB: TimerFields = { ...stopwatch(T0 + 30_000), runBy: B };
    // Both were started at the same real moment, so fifteen seconds later both
    // must read the same thing on this machine.
    const at = T0 + 15_000;
    expect(timerReading(fromA, at, clock.aheadOf(fromA.runBy)).label).toBe("0:15");
    expect(timerReading(fromB, at, clock.aheadOf(fromB.runBy)).label).toBe("0:15");
  });
});
