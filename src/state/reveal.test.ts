/**
 * Taking the camera to what an undo moved — Q-79, T-171.
 *
 * The property that matters most here is the negative one: this must do nothing
 * on the frames it is not needed, which is nearly all of them. A camera that
 * moves when it did not need to is a worse fault than one that does not move
 * when it might have.
 */

import { describe, expect, it } from "vitest";

import { Camera, type Bounds } from "@/state/camera";
import { isVisible, reveal, widen } from "@/state/reveal";

/** A viewport 1000x800 with the origin at its top left, so board coordinates
 *  and screen coordinates agree and every box below can be read directly. */
function camera(): Camera {
  const c = new Camera();
  c.resize(1000, 800);
  c.setView(0, 0, 1);
  return c;
}

function box(minX: number, minY: number, maxX: number, maxY: number): Bounds {
  return { minX, minY, maxX, maxY };
}

describe("reveal", () => {
  it("does nothing for a change already in front of you", () => {
    const c = camera();
    expect(reveal(c, box(400, 300, 500, 400))).toBe(false);
    expect(c.x).toBe(0);
    expect(c.y).toBe(0);
  });

  it("does nothing when there was nothing to look at", () => {
    const c = camera();
    expect(reveal(c, null)).toBe(false);
    expect(c.x).toBe(0);
  });

  it("centres on a change that is off the board's edge entirely", () => {
    const c = camera();
    expect(reveal(c, box(4000, 4000, 4100, 4100))).toBe(true);
    // Centred: the box's middle lands in the middle of the viewport.
    const at = c.boardToScreen(4050, 4050, { x: 0, y: 0 });
    expect(at.x).toBeCloseTo(500, 5);
    expect(at.y).toBeCloseTo(400, 5);
  });

  /** Zoom is a thing the person chose, and an undo is not a reason to overrule
   *  it. Only a change too big to show at all gets to. */
  it("keeps the zoom when the change fits at it", () => {
    const c = camera();
    c.zoomTo(2, 500, 400);
    const was = c.zoom;
    reveal(c, box(9000, 9000, 9050, 9050));
    expect(c.zoom).toBe(was);
  });

  it("zooms out only when the change is bigger than the viewport", () => {
    const c = camera();
    expect(reveal(c, box(5000, 5000, 9000, 9000))).toBe(true);
    expect(c.zoom).toBeLessThan(1);
    // And all of it is on screen afterwards.
    expect(isVisible(c, box(5000, 5000, 5010, 5010))).toBe(true);
    expect(isVisible(c, box(8990, 8990, 9000, 9000))).toBe(true);
  });

  /**
   * A box overlapping the viewport by a hair at the very edge is visible by
   * arithmetic and off screen to a person, so the test is against a viewport
   * shrunk by a margin.
   */
  it("treats a change clipping the edge as hidden", () => {
    const c = camera();
    // Well inside: seen, no move.
    expect(reveal(c, box(200, 200, 300, 300))).toBe(false);
    // Poking one unit over the right edge: not seen.
    expect(reveal(camera(), box(999, 400, 1200, 500))).toBe(true);
  });

  it("does not move for a change that spans the whole viewport", () => {
    const c = camera();
    expect(reveal(c, box(-5000, -5000, 5000, 5000))).toBe(false);
  });
});

describe("widen", () => {
  it("seeds from the first box and grows to hold the rest", () => {
    const out = box(0, 0, 0, 0);
    widen(out, box(10, 10, 20, 20), false);
    expect(out).toEqual(box(10, 10, 20, 20));

    widen(out, box(-5, 15, 12, 40), true);
    expect(out).toEqual(box(-5, 10, 20, 40));
  });

  it("ignores a box already inside what it has", () => {
    const out = box(0, 0, 0, 0);
    widen(out, box(0, 0, 100, 100), false);
    widen(out, box(10, 10, 20, 20), true);
    expect(out).toEqual(box(0, 0, 100, 100));
  });
});
