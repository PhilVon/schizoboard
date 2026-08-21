/**
 * The tick, before there is anything to look at — T-394.
 *
 * No DOM, no document and no clock: every test here drives `step` with an
 * explicit epoch instant, which is the whole of what makes the dirty rule a
 * table rather than a stopwatch race. `state/timers.ts` imports nothing from
 * `crdt/` or `render/`, and these prove the consequence — a timer fires with no
 * face built, no node mounted and no camera anywhere near it.
 */

import { describe, expect, it, vi } from "vitest";

import { NO_TIMER, type TimerFields } from "@/lib/timer";
import { DirtySets } from "@/state/dirty";
import { Scene, type ItemColdInput, type ItemPose } from "@/state/scene";
import { Timers, type Expiry } from "@/state/timers";

const MINUTE = 60_000;
/** An arbitrary wall-clock instant, and it has to be a real one: `elapsedOf`
 *  refuses a `runFrom` at or below zero as a start it cannot believe. */
const T0 = 1_700_000_000_000;

function pose(over: Partial<ItemPose> = {}): ItemPose {
  return { x: 0, y: 0, rot: 0, w: 90, h: 70, ...over };
}

function cold(id: string, timer: TimerFields | null, text = ""): ItemColdInput {
  return {
    id,
    type: timer === null ? "note" : "timer",
    z: "a0",
    seed: 1,
    assetId: null,
    createdBy: 1,
    createdAt: 0,
    text,
    timer,
  };
}

/**
 * A board with one timer on it, and the three things a frame needs.
 *
 * **Primed with one frame at `primeAt` by default, and that is not setup
 * noise.** The first frame a `Timers` ever sees a given timer on is its first
 * sight, and a countdown already expired on it is recorded silently — so a test
 * that expired a timer on frame one would be testing the first-sight rule while
 * believing it was testing the firing. Pass `null` to test the first-sight rule
 * itself, which is what one test below does.
 */
function board(fields: Partial<TimerFields>, text = "", primeAt: number | null = T0): {
  scene: Scene;
  dirty: DirtySets;
  timers: Timers;
  fired: Expiry[];
  /**
   * One frame at `now`, at the full tier unless told otherwise, and on a
   * machine whose clock agrees with whoever pressed start unless told
   * otherwise (T-404).
   */
  frame: (now: number, detailed?: boolean, ahead?: number) => void;
  set: (next: Partial<TimerFields>) => void;
} {
  const scene = new Scene();
  const dirty = new DirtySets();
  const timers = new Timers();
  const fired: Expiry[] = [];
  timers.onExpire((e) => fired.push(e));
  const set = (next: Partial<TimerFields>): void => {
    scene.putItem(cold("t", { ...NO_TIMER, ...fields, ...next }, text), pose());
  };
  set({});
  const frame = (now: number, detailed = true, ahead = 0): void =>
    timers.step(scene, dirty, now, detailed, ahead);
  if (primeAt !== null) frame(primeAt);
  dirty.clear();
  return { scene, dirty, timers, fired, frame, set };
}

describe("the tick", () => {
  it("says a countdown's caption in the flash line with no face built at all", () => {
    // Nothing here has ever touched a DOM node. That is the criterion: the
    // announcement is a fact about the board, and it must not wait for a
    // renderer to have been built, mounted, or scrolled to.
    const b = board({ mode: "countdown", runsFor: 5_000, runFrom: T0 }, "  tea  ");
    b.frame(T0 + 1_000);
    expect(b.fired).toEqual([]);

    b.frame(T0 + 5_000);
    // Trimmed, and the caption itself rather than a sentence about it: a caption
    // already IS what a timer is for.
    expect(b.fired).toEqual([{ id: "t", caption: "tea", lights: null }]);
  });

  it("hands over the item to light, and lets it dangle", () => {
    const b = board({ mode: "countdown", runsFor: 1_000, runFrom: T0, lights: "gone" });
    b.frame(T0 + 1_000);
    // Never repaired on read (DATA-MODEL 8.1): the id is passed on as it stands
    // and `Flashes.raise` is what guards on the scene holding it. Repairing here
    // would be this module writing to a document it cannot even see.
    expect(b.fired[0]!.lights).toBe("gone");
  });

  it("says it once, however many frames it stays expired for", () => {
    const b = board({ mode: "countdown", runsFor: 1_000, runFrom: T0 });
    for (let i = 0; i < 10; i += 1) b.frame(T0 + 1_000 + i * 16);
    expect(b.fired).toHaveLength(1);
  });

  it("re-arms on a restart, and on a change of length", () => {
    const b = board({ mode: "countdown", runsFor: 1_000, runFrom: T0 });
    b.frame(T0 + 1_000);
    expect(b.fired).toHaveLength(1);

    // A fresh run: same length, later start. A different run signature, and it
    // is allowed to go off again.
    b.set({ runFrom: T0 + 10_000 });
    b.frame(T0 + 10_500);
    b.frame(T0 + 11_000);
    expect(b.fired).toHaveLength(2);

    // And a longer length on the same run un-expires it, then expires again.
    b.set({ runFrom: T0 + 10_000, runsFor: 30_000 });
    b.frame(T0 + 20_000);
    expect(b.fired).toHaveLength(2);
    b.frame(T0 + 40_000);
    expect(b.fired).toHaveLength(3);
  });

  it("gives the edge back when the mode is changed away and back", () => {
    const b = board({ mode: "countdown", runsFor: 1_000, runFrom: T0 });
    b.frame(T0 + 1_000);
    b.set({ mode: "stopwatch" });
    b.frame(T0 + 1_100);
    b.set({ mode: "countdown" });
    b.frame(T0 + 1_200);
    // Two, and not one: turning the dial to stopwatch and back is a person doing
    // something to the device, and the device is at zero again with its length
    // still set. A timer that had silently used up its one announcement would
    // then sit there expired and mute.
    expect(b.fired).toHaveLength(2);
  });

  it("never fires a clock or a stopwatch, however long they run", () => {
    for (const mode of ["clock", "stopwatch"] as const) {
      // `runsFor` set on purpose: a stopwatch left over from a countdown keeps
      // its length (`resetTimer` and `setTimerMode` both say so), so the field
      // is populated and must not be read as something to run out of.
      const b = board({ mode, runsFor: 1_000, runFrom: T0 });
      for (let i = 0; i < 5; i += 1) b.frame(T0 + i * MINUTE);
      expect(b.fired).toEqual([]);
    }
  });

  it("never fires a countdown of no length", () => {
    // Zero is a countdown nobody set, not one that finished instantly. Firing on
    // it would go off the moment the mode chip was pressed.
    //
    // The length is cleared AFTER the timer has been seen, and that detour is
    // the test rather than setup: a countdown born with no length is already
    // expired on its first sight, so the first-sight rule would swallow the
    // announcement and a build with no zero guard at all would pass. Removing
    // the guard is exactly what pressing the countdown chip does before a length
    // is chosen, which is the moment this protects.
    const b = board({ mode: "countdown", runsFor: 5_000, runFrom: T0 });
    b.set({ runsFor: 0 });
    for (let i = 0; i < 5; i += 1) b.frame(T0 + i * 1_000);
    expect(b.fired).toEqual([]);

    // And a length arriving is a countdown that then works normally.
    b.set({ runsFor: 5_000 });
    b.frame(T0 + 5_000);
    expect(b.fired).toHaveLength(1);
  });

  it("says nothing when nobody wrote anything on it", () => {
    const b = board({ mode: "countdown", runsFor: 1_000, runFrom: T0 }, "   ");
    b.frame(T0 + 1_000);
    // Empty, not the three spaces. What to say instead is the caller's, because
    // this module has no copy in it and should not grow any.
    expect(b.fired[0]!.caption).toBe("");
  });
});

describe("the dirty rule", () => {
  it("leaves the dirty sets clean on every one of ten consecutive frames, paused", () => {
    // The load-bearing one. A paused timer is the state most timers on a board
    // are in most of the time, and it must cost exactly nothing.
    const b = board({ mode: "countdown", runsFor: 90_000, banked: 30_000, runFrom: null });
    for (let i = 0; i < 10; i += 1) {
      b.frame(T0 + i * 16);
      expect(b.dirty.items.size).toBe(0);
    }
  });

  it("leaves them clean for a timer nobody has ever set", () => {
    const b = board({});
    for (let i = 0; i < 10; i += 1) {
      b.frame(T0 + i * 16);
      // A clock is the exception and this is not one — an unstarted CLOCK does
      // tick, because a wall clock is not something you start. This is the
      // reset state of a countdown, which is `mode: clock` with nothing set,
      // and the minute is deliberately not crossed inside these ten frames.
      expect(b.dirty.items.size).toBe(0);
    }
  });

  it("dirties a running countdown on the second and on no other frame", () => {
    const b = board({ mode: "countdown", runsFor: 600_000, runFrom: T0 });
    // Seventy frames at 16ms is a shade over a second, so exactly one boundary
    // is crossed - and the assertion is on WHICH frame, not merely on the count.
    let dirtied = 0;
    for (let i = 1; i <= 70; i += 1) {
      b.dirty.clear();
      const now = T0 + i * 16;
      b.frame(now);
      if (b.dirty.items.has("t")) {
        dirtied += 1;
        // The frame the ceiled label goes from 600 to 599: the first one at or
        // past a whole second in.
        expect(now - T0).toBeGreaterThanOrEqual(1_000);
        expect(now - T0).toBeLessThan(1_016);
      }
    }
    expect(dirtied).toBe(1);
  });

  it("dirties a running countdown once a minute below the full tier", () => {
    const b = board({ mode: "countdown", runsFor: 600_000, runFrom: T0 });
    b.frame(T0, false);

    let dirtied = 0;
    // Ten seconds of frames at the card tier. At the full tier this would be ten
    // dirties; here it must be none, because nobody can read a seconds digit at
    // 30% zoom and 500 items dirtied once a second at that zoom is the frame
    // D-33 measured and that must not exist.
    for (let i = 1; i <= 600; i += 1) {
      b.dirty.clear();
      b.frame(T0 + i * 16, false);
      if (b.dirty.items.has("t")) dirtied += 1;
    }
    expect(dirtied).toBe(0);

    // And it does still move, a minute in.
    b.dirty.clear();
    b.frame(T0 + MINUTE, false);
    expect(b.dirty.items.has("t")).toBe(true);
  });

  it("dirties a clock once a minute, at either tier", () => {
    for (const detailed of [true, false]) {
      const b = board({ mode: "clock" });
      // From the top of a minute, so the boundary is where the arithmetic says.
      const start = Math.ceil(T0 / MINUTE) * MINUTE;
      b.frame(start, detailed);

      b.dirty.clear();
      b.frame(start + 59_000, detailed);
      // A clock shows hh:mm and has no sweep hand. Fifty-nine seconds is the
      // same face.
      expect(b.dirty.items.has("t")).toBe(false);

      b.frame(start + MINUTE, detailed);
      expect(b.dirty.items.has("t")).toBe(true);
    }
  });

  it("does not dirty a timer on the first frame it ever sees", () => {
    // The binding has already dirtied it — that is how it got into the scene —
    // so a dirty here would be a second flag for one frame's paint, and it would
    // also make the paused case above fail on its first frame for a reason that
    // has nothing to do with the clock moving.
    const scene = new Scene();
    const dirty = new DirtySets();
    scene.putItem(cold("t", { ...NO_TIMER, mode: "stopwatch", runFrom: T0 }), pose());
    dirty.clear();

    new Timers().step(scene, dirty, T0 + 5_000, true, 0);
    expect(dirty.items.size).toBe(0);
  });

  it("keeps a running stopwatch and a paused one apart on the same board", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    const timers = new Timers();
    scene.putItem(cold("run", { ...NO_TIMER, mode: "stopwatch", runFrom: T0 }), pose());
    scene.putItem(cold("held", { ...NO_TIMER, mode: "stopwatch", banked: 4_000 }), pose());
    timers.step(scene, dirty, T0, true, 0);
    dirty.clear();

    timers.step(scene, dirty, T0 + 1_000, true, 0);
    // Split by id rather than counted: a run that dirtied both, or the wrong
    // one, reports the same total as the right answer.
    expect(dirty.items.has("run")).toBe(true);
    expect(dirty.items.has("held")).toBe(false);
  });
});

describe("what the tick refuses to depend on", () => {
  it("fires a timer that no renderer has ever heard of", () => {
    // The criterion is "panned far enough off screen to be unmounted", and the
    // strongest form of it is this: there is no renderer in this file at all, no
    // camera, and no viewport rectangle in the call. A gate could not be added
    // without changing `step`'s signature, which is the point.
    const b = board({ mode: "countdown", runsFor: 1_000, runFrom: T0 });
    b.frame(T0 + 2_000);
    expect(b.fired).toHaveLength(1);
  });

  it("records a countdown that had already expired as fired, without announcing", () => {
    // It went off while this window was shut, or on somebody else's machine an
    // hour ago. Opening a board must not be a recital of every timer anybody
    // ever set on it.
    const b = board({ mode: "countdown", runsFor: 1_000, runFrom: T0 - MINUTE }, "", null);
    b.frame(T0);
    expect(b.fired).toEqual([]);

    // And it stays quiet, rather than merely being late.
    for (let i = 1; i < 10; i += 1) b.frame(T0 + i * 16);
    expect(b.fired).toEqual([]);

    // Recorded as fired, not merely skipped: restarting it announces again.
    b.set({ runFrom: T0, runsFor: 1_000 });
    b.frame(T0 + 1_000);
    expect(b.fired).toHaveLength(1);
  });

  it("uses no timer of its own, and reads no clock", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const clock = vi.spyOn(Date, "now");
    try {
      // Re-imported behind the spies, and that is the half a spy-and-call test
      // would miss: the module under test was evaluated when this file was
      // loaded, long before any of these existed, so a `setInterval` at module
      // scope would have run unwatched and the test would have passed on it.
      vi.resetModules();
      const fresh = (await import("@/state/timers")) as typeof import("@/state/timers");
      const scene = new Scene();
      const dirty = new DirtySets();
      const fired: Expiry[] = [];
      const timers = new fresh.Timers();
      timers.onExpire((e) => fired.push(e));
      scene.putItem(
        cold("t", { ...NO_TIMER, mode: "countdown", runsFor: 1_000, runFrom: T0 }),
        pose(),
      );

      for (let i = 0; i < 100; i += 1) timers.step(scene, dirty, T0 + i * 16, true, 0);
      expect(fired).toHaveLength(1);
      // ARCHITECTURE section 3: one rAF, and nothing animates on its own. `now`
      // arrives as an argument, which is also the whole reason every assertion
      // in this file is an exact instant rather than a wait.
      expect(interval).not.toHaveBeenCalled();
      expect(timeout).not.toHaveBeenCalled();
      expect(clock).not.toHaveBeenCalled();
    } finally {
      interval.mockRestore();
      timeout.mockRestore();
      clock.mockRestore();
    }
  });

  it("costs one size test on a board with no timer on it", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    scene.putItem(cold("n", null), pose());
    // `cold` is the only way in and would throw on a scene that had been left in
    // a state this could not read, so the assertion is that nothing happens at
    // all - which is what a board with no clock on it should cost.
    const look = vi.spyOn(scene, "cold");
    new Timers().step(scene, dirty, T0, true, 0);
    expect(look).not.toHaveBeenCalled();
    expect(dirty.items.size).toBe(0);
    look.mockRestore();
  });

  it("first-sights a timer that left the board and came back", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    const timers = new Timers();
    const fired: Expiry[] = [];
    timers.onExpire((e) => fired.push(e));

    scene.putItem(cold("t", { ...NO_TIMER, mode: "countdown", runsFor: 1_000, runFrom: T0 }), pose());
    timers.step(scene, dirty, T0, true, 0);
    timers.step(scene, dirty, T0 + 1_000, true, 0);
    expect(fired).toHaveLength(1);

    scene.removeItem("t");
    timers.step(scene, dirty, T0 + 2_000, true, 0);

    // Put back, with the same id and the same run. An id whose fired edge had
    // been kept would sit there expired and silent; an id whose reading had been
    // kept would be first-sighted wrongly. Slots are reused and so are ids after
    // an undo, so this is the ordinary case rather than a contrived one.
    scene.putItem(cold("t", { ...NO_TIMER, mode: "countdown", runsFor: 1_000, runFrom: T0 }), pose());
    timers.step(scene, dirty, T0 + 3_000, true, 0);
    // First sight again: recorded, not announced.
    expect(fired).toHaveLength(1);
  });

  /**
   * Expiry, on a machine whose clock disagrees with the one that pressed start
   * — T-404.
   *
   * The two halves of the tick correct together or not at all. `check` reads
   * the exact elapsed and never the quantised one, so a skew it did not know
   * about would put the going-off up to that skew early or late — which for a
   * countdown shorter than the skew means firing the moment the start arrives,
   * and for the other sign means never firing while somebody watches the face
   * sit still.
   */
  it("goes off at the same moment on a peer whose clock is behind", () => {
    const AHEAD = -90_000;
    const { fired, frame } = board({ mode: "countdown", runsFor: 10_000, runFrom: T0 });
    // This peer's wall clock reads ninety seconds earlier than the machine that
    // started it, so its own `Date.now()` at the ten-second mark is this.
    const localAtExpiry = T0 + 10_000 + AHEAD;
    frame(localAtExpiry - 1_000, true, AHEAD);
    expect(fired).toHaveLength(0);
    frame(localAtExpiry, true, AHEAD);
    expect(fired).toHaveLength(1);
  });

  it("does not go off early on a peer whose clock is ahead", () => {
    // Two hundred seconds ahead against a countdown of sixty. Uncorrected this
    // fires on the frame the start arrives; corrected it has fifty-nine seconds
    // still to run.
    const AHEAD = 200_000;
    const { fired, frame } = board({ mode: "countdown", runsFor: 60_000, runFrom: T0 });
    frame(T0 + AHEAD + 1_000, true, AHEAD);
    expect(fired).toHaveLength(0);
    frame(T0 + AHEAD + 60_000, true, AHEAD);
    expect(fired).toHaveLength(1);
  });

  it("skips an item the index names and the mirror cannot read", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    scene.putItem(cold("t", { ...NO_TIMER, mode: "clock" }), pose());
    // Not a state the mirror can be in through its own doors — the index and the
    // record are written by the same line. Asserted anyway, because the failure
    // mode of the alternative is a thrown error inside the frame loop, which
    // takes the whole board down rather than one clock.
    const look = vi.spyOn(scene, "cold").mockReturnValue(null);
    expect(() => new Timers().step(scene, dirty, T0, true, 0)).not.toThrow();
    look.mockRestore();
  });
});
