import { describe, expect, it } from "vitest";

import type { InkSample } from "@/lib/ink";
import { strokeHalfWidth, strokeHit } from "@/lib/inkhit";

/** A straight run along y = 0, from x = 0 to x = 100. */
function line(): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i <= 10; i++) out.push({ x: i * 10, y: 0, pressure: 0.5 });
  return out;
}

const LINE_BOX: readonly [number, number, number, number] = [0, 0, 100, 0];

describe("the rubber against a stroke", () => {
  it("hits a point on the line", () => {
    expect(strokeHit(line(), LINE_BOX, 6, 50, 0, 0)).toBe(true);
  });

  /** The two discs overlapping: the stroke's own half-width plus the rubber's
   *  radius, and nothing on top. */
  it("hits exactly as far out as the two half-widths reach", () => {
    const reach = strokeHalfWidth(6) + 5;
    expect(strokeHit(line(), LINE_BOX, 6, 50, reach - 0.01, 5)).toBe(true);
    expect(strokeHit(line(), LINE_BOX, 6, 50, reach + 0.01, 5)).toBe(false);
  });

  it("gives a fat nib a wider reach than a fine one", () => {
    // 12 units off the line: the chisel mark is caught and the hairline is not,
    // from the same cursor with the same rubber.
    expect(strokeHit(line(), LINE_BOX, 22, 50, 12, 0)).toBe(true);
    expect(strokeHit(line(), LINE_BOX, 2, 50, 12, 0)).toBe(false);
  });

  it("misses past the ends of the run rather than off its infinite line", () => {
    // A segment, not a line: 40 units beyond the far end is nowhere near the ink.
    expect(strokeHit(line(), LINE_BOX, 6, 140, 0, 5)).toBe(false);
    // But the cap at the end is reachable.
    expect(strokeHit(line(), LINE_BOX, 6, 102, 0, 5)).toBe(true);
  });

  /**
   * The box is a reject test, and it has to be padded by the reach or the test
   * that matters — a cursor just outside a hairline's box but well within its
   * paint — comes back false before the segments are ever walked.
   */
  it("does not reject a hit that lies outside the bare bounding box", () => {
    expect(strokeHit(line(), LINE_BOX, 22, 50, 15, 4)).toBe(true);
  });

  it("catches the inside of a corner the segments turn through", () => {
    const bent: InkSample[] = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 100, y: 0, pressure: 0.5 },
      { x: 100, y: 100, pressure: 0.5 },
    ];
    const box: readonly [number, number, number, number] = [0, 0, 100, 100];
    // Well inside the box and nowhere near either segment.
    expect(strokeHit(bent, box, 6, 20, 60, 5)).toBe(false);
    // And on the second leg, which a test that only walked the first would miss.
    expect(strokeHit(bent, box, 6, 100, 60, 5)).toBe(true);
  });

  it("hits a dot, which is a stroke with one sample and no segment at all", () => {
    const dot: InkSample[] = [{ x: 10, y: 10, pressure: 0.5 }];
    const box: readonly [number, number, number, number] = [10, 10, 10, 10];
    expect(strokeHit(dot, box, 6, 12, 12, 3)).toBe(true);
    expect(strokeHit(dot, box, 6, 40, 40, 3)).toBe(false);
  });

  it("has nothing to hit on a stroke with no samples", () => {
    expect(strokeHit([], [0, 0, 0, 0], 6, 0, 0, 10)).toBe(false);
  });

  /** Two coalesced samples at one point, which happens whenever a hand pauses.
   *  A zero-length segment must not divide by its own length. */
  it("survives a repeated sample", () => {
    const paused: InkSample[] = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 0, y: 0, pressure: 0.5 },
      { x: 50, y: 0, pressure: 0.5 },
    ];
    expect(strokeHit(paused, [0, 0, 50, 0], 6, 25, 0, 1)).toBe(true);
    expect(strokeHit(paused, [0, 0, 50, 0], 6, 0, 0, 1)).toBe(true);
  });
});
