/**
 * The rotation kernel.
 *
 * These are the tests that used to be spread across six callers as "and the item
 * ends up here" — worth stating directly, because the thing most likely to go
 * wrong is a sign, and a sign is invisible until something on screen turns the
 * wrong way.
 */

import { describe, expect, it } from "vitest";

import { rotateIn, rotateOut, type Point } from "@/lib/rotate";

function out(angle: number): { cos: number; sin: number } {
  return { cos: Math.cos(angle), sin: Math.sin(angle) };
}

describe("rotateOut", () => {
  it("turns clockwise on screen, because both spaces are y-down", () => {
    const { cos, sin } = out(Math.PI / 2);
    // Straight up out of an item at the origin, turned a quarter turn: on a
    // y-down surface that points due east, not west.
    const p = rotateOut(0, -10, 0, 0, cos, sin);
    expect(p.x).toBeCloseTo(10, 9);
    expect(p.y).toBeCloseTo(0, 9);
  });

  it("leaves the centre of rotation exactly where it is", () => {
    const { cos, sin } = out(1.234);
    const p = rotateOut(0, 0, 37, -12, cos, sin);
    expect(p.x).toBe(37);
    expect(p.y).toBe(-12);
  });

  it("carries the centre's offset without turning it", () => {
    const { cos, sin } = out(Math.PI);
    const p = rotateOut(4, 0, 100, 100, cos, sin);
    expect(p.x).toBeCloseTo(96, 9);
    expect(p.y).toBeCloseTo(100, 9);
  });
});

describe("rotateIn", () => {
  it("undoes rotateOut given the same cosine and sine, not the negated angle", () => {
    // The whole point of the shared pair: a caller never writes Math.cos(-rot),
    // so a caller can never disagree with another one about which sign it takes.
    const { cos, sin } = out(0.7);
    const there = rotateOut(13, -5, 200, 300, cos, sin);
    const back = rotateIn(there.x, there.y, 200, 300, cos, sin);
    expect(back.x).toBeCloseTo(13, 9);
    expect(back.y).toBeCloseTo(-5, 9);
  });

  it("puts a point due east of a quarter-turned item at its own local north", () => {
    const { cos, sin } = out(Math.PI / 2);
    const local = rotateIn(10, 0, 0, 0, cos, sin);
    expect(local.x).toBeCloseTo(0, 9);
    expect(local.y).toBeCloseTo(-10, 9);
  });

  it("round-trips through a full turn's worth of angles", () => {
    for (let a = -Math.PI; a <= Math.PI; a += Math.PI / 8) {
      const { cos, sin } = out(a);
      const there = rotateOut(9, 4, -50, 25, cos, sin);
      const back = rotateIn(there.x, there.y, -50, 25, cos, sin);
      expect(back.x).toBeCloseTo(9, 9);
      expect(back.y).toBeCloseTo(4, 9);
    }
  });
});

describe("the out parameter", () => {
  it("fills and returns the object it was given, and mints nothing", () => {
    const scratch: Point = { x: 0, y: 0 };
    const { cos, sin } = out(0.3);
    expect(rotateOut(1, 2, 3, 4, cos, sin, scratch)).toBe(scratch);
    expect(rotateIn(1, 2, 3, 4, cos, sin, scratch)).toBe(scratch);
  });
});
