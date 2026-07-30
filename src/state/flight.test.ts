/**
 * Carrying the camera — Q-150, T-85.
 *
 * Two properties carry most of the weight. It has to *land exactly*, because a
 * flight that stops a rounding error short leaves the camera on a value nobody
 * chose and the next `Ctrl+0` then reports a move that is really this one's
 * residue. And it has to get out of the way the instant a hand touches the
 * camera, because a flight that fights you is worse than no flight at all.
 */

import { describe, expect, it } from "vitest";

import { Camera, type Bounds } from "@/state/camera";
import { Flight, FLIGHT_MS } from "@/state/flight";

/** A viewport 1000x800, so a board unit is a screen pixel and every number
 *  below can be read directly. */
function camera(): Camera {
  const c = new Camera();
  c.resize(1000, 800);
  c.setView(0, 0, 1);
  return c;
}

function box(minX: number, minY: number, maxX: number, maxY: number): Bounds {
  return { minX, minY, maxX, maxY };
}

/** Where the camera is looking, which is what a flight is expressed in. */
function centre(c: Camera): { x: number; y: number } {
  return { x: c.x + c.width / (2 * c.zoom), y: c.y + c.height / (2 * c.zoom) };
}

/** Fly to the end, one 16ms frame at a time, and count them. */
function run(f: Flight, c: Camera, dt = 16): number {
  let frames = 0;
  while (f.active && frames < 500) {
    f.step(c, dt);
    frames++;
  }
  return frames;
}

describe("Flight", () => {
  it("does nothing until it is given somewhere to go", () => {
    const c = camera();
    const f = new Flight();
    const before = c.version;
    expect(f.active).toBe(false);
    expect(f.step(c, 16)).toBe(false);
    // Not merely "the camera did not move": an idle flight must not `touch()`
    // either, or the DOM phase re-reads the world transform on every frame of a
    // board nobody is doing anything to.
    expect(c.version).toBe(before);
  });

  it("lands exactly on the target", () => {
    const c = camera();
    const f = new Flight();
    f.to(c, 4000, -2500, 1);
    run(f, c);
    expect(f.active).toBe(false);
    expect(centre(c).x).toBeCloseTo(4000, 9);
    expect(centre(c).y).toBeCloseTo(-2500, 9);
    expect(c.zoom).toBeCloseTo(1, 9);
  });

  it("takes about the time it says it does", () => {
    const c = camera();
    const f = new Flight();
    f.to(c, 4000, 0, 1);
    // 300ms at 16ms a frame is nineteen frames; the twentieth is the one that
    // crosses the line and lands.
    expect(run(f, c, 16)).toBe(Math.ceil(FLIGHT_MS / 16));
  });

  it("does not overshoot or double back", () => {
    // A camera that sails past its target and comes back is the classic failure
    // of an eased move, and it is invisible in a screenshot of the end state.
    const c = camera();
    const f = new Flight();
    f.to(c, 1000, 0, 1);
    let last = centre(c).x;
    while (f.active) {
      f.step(c, 16);
      const now = centre(c).x;
      expect(now).toBeGreaterThanOrEqual(last);
      expect(now).toBeLessThanOrEqual(1000);
      last = now;
    }
  });

  it("starts and ends at rest", () => {
    // Smoothstep rather than a linear ramp: a camera that begins at full speed
    // and stops dead reads as a cut with a smear in the middle rather than as
    // being carried.
    const c = camera();
    const f = new Flight();
    f.to(c, 1600, 0, 1);
    const steps: number[] = [];
    let last = centre(c).x;
    while (f.active) {
      f.step(c, 16);
      const now = centre(c).x;
      steps.push(now - last);
      last = now;
    }
    const mid = steps[Math.floor(steps.length / 2)]!;
    expect(steps[0]!).toBeLessThan(mid / 2);
    expect(steps.at(-1)!).toBeLessThan(mid / 2);
  });

  it("travels the zoom in logs, so every slice is the same ratio", () => {
    // Lerped linearly, 0.25 to 4 would pass 2.1 at the halfway mark — the first
    // half covering a factor of eight and the second a factor of two. The
    // geometric mean is 1.
    const c = camera();
    c.setView(0, 0, 0.25);
    const f = new Flight();
    f.to(c, 0, 0, 4);
    const half = FLIGHT_MS / 2;
    let t = 0;
    while (f.active && t < half) {
      f.step(c, 1);
      t++;
    }
    expect(c.zoom).toBeCloseTo(1, 2);
  });

  it("gives way the moment a hand touches the camera", () => {
    const c = camera();
    const f = new Flight();
    f.to(c, 4000, 0, 1);
    f.step(c, 16);
    const partway = centre(c).x;
    expect(partway).toBeGreaterThan(0);

    // A pan, a wheel, a Ctrl+0, an undo restoring its view — any of them, and
    // the flight is watching `camera.version` rather than any one of them.
    c.panByBoard(50, 0);
    expect(f.step(c, 16)).toBe(false);
    expect(f.active).toBe(false);
    // And it left the camera where the hand put it, not where it was going.
    expect(centre(c).x).toBeCloseTo(partway + 50, 6);
  });

  it("is cancelled by a zoom as well as by a pan", () => {
    const c = camera();
    const f = new Flight();
    f.to(c, 4000, 0, 1);
    f.step(c, 16);
    c.zoomTo(2, 500, 400);
    expect(f.step(c, 16)).toBe(false);
    expect(c.zoom).toBe(2);
  });

  it("puts a target already under the cursor there without a flight", () => {
    // A match a few pixels away should not slide a hand's width and settle;
    // that reads as the board twitching rather than as being taken anywhere.
    const c = camera();
    const f = new Flight();
    f.to(c, 504, 402, 1);
    expect(f.active).toBe(false);
    expect(centre(c).x).toBeCloseTo(504, 6);
    expect(centre(c).y).toBeCloseTo(402, 6);
  });

  it("still flies for a zoom that changes in place", () => {
    // Nothing moves across the board, but the zoom does — and a jump between two
    // zooms is exactly the kind of cut this exists to avoid.
    const c = camera();
    const f = new Flight();
    f.to(c, 500, 400, 3);
    expect(f.active).toBe(true);
    run(f, c);
    expect(c.zoom).toBeCloseTo(3, 9);
  });

  it("refuses a target it cannot fly to", () => {
    const c = camera();
    const f = new Flight();
    f.to(c, Number.NaN, 0, 1);
    expect(f.active).toBe(false);
    f.to(c, 0, 0, 0);
    expect(f.active).toBe(false);
    // Invariant 1's shape, at the one seam that writes the camera every frame: a
    // single NaN here makes the world transform undroppable and the board stops
    // responding with nothing in the console.
    expect(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.zoom)).toBe(true);
  });

  it("cancel leaves the camera alone and stops the flight", () => {
    const c = camera();
    const f = new Flight();
    f.to(c, 4000, 0, 1);
    f.step(c, 16);
    const where = centre(c).x;
    f.cancel();
    expect(f.active).toBe(false);
    expect(f.step(c, 16)).toBe(false);
    expect(centre(c).x).toBeCloseTo(where, 9);
    // Idempotent — a second cancel from a different route must not throw.
    f.cancel();
  });

  it("survives a frame longer than the whole flight", () => {
    // A backgrounded window hands the loop one enormous dt. It has to land, not
    // sail past and come back.
    const c = camera();
    const f = new Flight();
    f.to(c, 4000, 0, 1);
    expect(f.step(c, 5000)).toBe(true);
    expect(f.active).toBe(false);
    expect(centre(c).x).toBeCloseTo(4000, 9);
  });

  describe("toBox", () => {
    it("centres a box that fits, keeping the zoom you chose", () => {
      // Zoom is a thing the person picked and a search is not a reason to
      // overrule it — `reveal.ts` makes the same call for the same reason.
      const c = camera();
      c.setView(0, 0, 2);
      const f = new Flight();
      f.toBox(c, box(3000, 3000, 3100, 3080));
      run(f, c);
      expect(c.zoom).toBe(2);
      expect(centre(c).x).toBeCloseTo(3050, 6);
      expect(centre(c).y).toBeCloseTo(3040, 6);
    });

    it("fits a box too big for the current zoom, and agrees with Ctrl+0", () => {
      const c = camera();
      const b = box(0, 0, 5000, 4000);
      const f = new Flight();
      f.toBox(c, b);
      run(f, c);

      const shortcut = camera();
      shortcut.fit(b);
      expect(c.zoom).toBeCloseTo(shortcut.zoom, 9);
      expect(centre(c).x).toBeCloseTo(centre(shortcut).x, 6);
      expect(centre(c).y).toBeCloseTo(centre(shortcut).y, 6);
    });

    it("moves for a match already on screen, unlike reveal", () => {
      // The one place this deliberately disagrees with `reveal`: "next match"
      // that sometimes does nothing reads as the key having missed.
      const c = camera();
      const f = new Flight();
      f.toBox(c, box(800, 600, 900, 700));
      expect(f.active).toBe(true);
      run(f, c);
      expect(centre(c).x).toBeCloseTo(850, 6);
      expect(centre(c).y).toBeCloseTo(650, 6);
    });

    // --- the floor under the landing zoom, Q-153 ---------------------------

    it("lifts the zoom to the floor when you searched from further out than that", () => {
      // The case Q-153 is about: from a fitted board every sheet is a flat card
      // (T-198), so arriving at the zoom you were at means arriving at a
      // rectangle with no writing on it.
      const c = camera();
      c.setView(0, 0, 0.16);
      const f = new Flight();
      f.toBox(c, box(3000, 3000, 3300, 3300), undefined, 0.55);
      run(f, c);
      expect(c.zoom).toBeCloseTo(0.55, 9);
      expect(centre(c).x).toBeCloseTo(3150, 6);
    });

    it("is a floor and not a target — a zoom already above it is left alone", () => {
      // Searching from 100% must not zoom you *out* to a reading minimum. You
      // could already read it; the zoom is yours.
      const c = camera();
      c.setView(0, 0, 1);
      const f = new Flight();
      f.toBox(c, box(3000, 3000, 3300, 3300), undefined, 0.55);
      run(f, c);
      expect(c.zoom).toBe(1);
    });

    it("changes no zoom at all when no floor is asked for", () => {
      const c = camera();
      c.setView(0, 0, 0.16);
      const f = new Flight();
      f.toBox(c, box(3000, 3000, 3300, 3300));
      run(f, c);
      expect(c.zoom).toBeCloseTo(0.16, 9);
    });

    it("lets a fit win over the floor, so the two rules cannot undo each other", () => {
      // A match too large to fit at the reading zoom. Honouring the floor would
      // push its edges off screen; honouring the fit shows the whole of it. If
      // the floor were re-applied after the fit the camera would be asked for
      // two different zooms by two rules, each correct on its own terms.
      const c = camera();
      c.setView(0, 0, 0.16);
      const b = box(0, 0, 20000, 16000);
      const f = new Flight();
      f.toBox(c, b, undefined, 0.55);
      run(f, c);
      expect(c.zoom).toBeLessThan(0.55);

      const shortcut = camera();
      shortcut.fit(b);
      expect(c.zoom).toBeCloseTo(shortcut.zoom, 9);
    });

    it("asks whether it fits at the zoom it is going to, not the one it is at", () => {
      // The boundary the whole rule turns on, and the one an obvious build gets
      // wrong: this box fits comfortably at 0.16 and does not fit at 0.55. Ask
      // the question at the old zoom and the answer is "it fits", so the floor
      // is honoured and the match lands with its edges off screen — which is
      // the failure the fit branch exists to prevent, reached by the door the
      // floor opened.
      const c = camera();
      c.setView(0, 0, 0.16);
      const b = box(0, 0, 2000, 1600);
      expect(2000 * 0.16).toBeLessThan(c.width);
      expect(2000 * 0.55).toBeGreaterThan(c.width);

      const f = new Flight();
      f.toBox(c, b, undefined, 0.55);
      run(f, c);
      expect(c.zoom).toBeLessThan(0.55);
      expect(2000 * c.zoom).toBeLessThanOrEqual(c.width);

      const shortcut = camera();
      shortcut.fit(b);
      expect(c.zoom).toBeCloseTo(shortcut.zoom, 9);
    });

    it("still eases into the new zoom rather than snapping to it", () => {
      // The zoom is the interesting half of the journey when the floor lifts
      // it, and it must travel the same way the centre does.
      const c = camera();
      c.setView(0, 0, 0.16);
      const f = new Flight();
      f.toBox(c, box(3000, 3000, 3300, 3300), undefined, 0.55);
      f.step(c, 16);
      expect(c.zoom).toBeGreaterThan(0.16);
      expect(c.zoom).toBeLessThan(0.55);
      // And in logs, not linearly: at the midpoint a linear ramp would be at
      // 0.355 and the geometric mean of 0.16 and 0.55 is 0.297.
      f.step(c, FLIGHT_MS / 2 - 16);
      expect(c.zoom).toBeLessThan(0.34);
    });
  });
});
