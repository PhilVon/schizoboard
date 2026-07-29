import { describe, expect, it } from "vitest";

import { sheetEdge, tearEdge } from "@/render/items/edge";
import type { PaperStock } from "@/render/items/paper";

const SEED = 0x51ac7e;

/** The silhouette alone, which is most of what this file is about. */
function edgeClipPath(stock: PaperStock, seed: number): string {
  return sheetEdge(stock, seed).path;
}

interface Point {
  /** The coordinate as written, so a test can tell `4px` from `40%`. */
  x: string;
  y: string;
}

/** Pull `polygon(a b, c d, …)` apart again. */
function parse(path: string): Point[] {
  const inner = /^polygon\((.*)\)$/.exec(path)?.[1];
  expect(inner).toBeDefined();
  return inner!.split(/,\s*(?![^(]*\))/).map((pair) => {
    const [x, y] = pair.trim().split(/\s+(?![^(]*\))/);
    expect(x).toBeDefined();
    expect(y).toBeDefined();
    return { x: x!, y: y! };
  });
}

/**
 * How far in from its own side a coordinate sits, in board units — the number
 * inside a bare `4.2px` or a `calc(100% - 4.2px)`. Null for a position *along*
 * an edge, which is a percentage.
 */
function inset(coord: string): number | null {
  const bare = /^(-?[\d.]+)px$/.exec(coord);
  if (bare) return Number(bare[1]);
  const back = /^calc\(100% - (-?[\d.]+)px\)$/.exec(coord);
  if (back) return Number(back[1]);
  expect(coord).toMatch(/^[\d.]+%$/);
  return null;
}

/** Every inward offset in the path, whichever side it came off. */
function insets(path: string): number[] {
  const out: number[] = [];
  for (const point of parse(path)) {
    for (const coord of [point.x, point.y]) {
      const d = inset(coord);
      if (d !== null) out.push(d);
    }
  }
  return out;
}

describe("edgeClipPath", () => {
  it("is stable for a seed and different between seeds", () => {
    expect(edgeClipPath("white", SEED)).toBe(edgeClipPath("white", SEED));
    expect(edgeClipPath("white", SEED)).not.toBe(edgeClipPath("white", SEED + 1));
  });

  it("says nothing about how big the sheet is", () => {
    // Every coordinate is either a percentage along an edge or a fixed number of
    // board units in from one. Nothing here can be a function of w or h, which is
    // what lets the path be written once per bind and survive a resize.
    for (const point of parse(edgeClipPath("cream", SEED))) {
      expect(() => inset(point.x)).not.toThrow();
      expect(() => inset(point.y)).not.toThrow();
    }
  });

  it("never puts paper outside the item's own rectangle", () => {
    // The hit test, the culler's bounds, the selection chrome and the ink clip
    // are all that rectangle, so an edge that bulged past it would be paper
    // nothing else on the board agrees is there.
    for (const stock of ["white", "cream", "legal", "graph", "index"] as PaperStock[]) {
      for (const d of insets(edgeClipPath(stock, SEED))) {
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(10);
      }
    }
  });

  it("keeps a die-cut card straighter than a loose sheet", () => {
    const card = Math.max(...insets(edgeClipPath("index", SEED)));
    const sheet = Math.max(...insets(edgeClipPath("cream", SEED)));
    expect(card).toBeLessThan(sheet);
    // And not perfectly straight either: a machine-cut rectangle is the thing
    // DESIGN 4.4 says reads as a UI element.
    expect(card).toBeGreaterThan(0);
  });

  it("tears a legal pad along the head and a graph book down the spine", () => {
    expect(tearEdge("legal")).toBe("top");
    expect(tearEdge("graph")).toBe("left");
    expect(tearEdge("white")).toBeNull();
    expect(tearEdge("index")).toBeNull();
  });

  it("wanders further along the torn side than along the other three", () => {
    // Legal tears at the top, so the deep offsets have to be the ones written as
    // a bare `y` — a distance down from the head — and not the ones measured in
    // from the fore-edge or up from the tail.
    const points = parse(edgeClipPath("legal", SEED));
    const head: number[] = [];
    const rest: number[] = [];
    for (const point of points) {
      const y = inset(point.y);
      const x = inset(point.x);
      if (y !== null && /px\)?$/.test(point.y) && !point.y.startsWith("calc")) head.push(y);
      if (x !== null) rest.push(x);
    }
    expect(Math.max(...head)).toBeGreaterThan(2 * Math.max(...rest));
  });

  it("hands out the corners it drew, so a fold can be put on one", () => {
    // Anything drawn *at* a corner needs the corner of the paper rather than the
    // corner of the box, and the two differ by most of a centimetre on a torn
    // head. The pairs must therefore be the same numbers the path was built
    // from — read off the four points where neither coordinate is a percentage.
    const { path, corners } = sheetEdge("legal", SEED);
    const found = parse(path)
      .filter((point) => inset(point.x) !== null && inset(point.y) !== null)
      .map((point) => [inset(point.x)!, inset(point.y)!]);
    expect(found).toHaveLength(4);
    expect(corners).toHaveLength(8);
    for (const [i, pair] of found.entries()) {
      expect(corners[i * 2]).toBeCloseTo(pair[0]!, 2);
      expect(corners[i * 2 + 1]).toBeCloseTo(pair[1]!, 2);
    }
  });

  it("displaces every corner on both axes", () => {
    // A corner that receded on one axis only is a bevel, and a bevel is a thing
    // a machine does. The four corners are the points where neither coordinate
    // is a percentage.
    const corners = parse(edgeClipPath("white", SEED)).filter(
      (point) => inset(point.x) !== null && inset(point.y) !== null,
    );
    expect(corners).toHaveLength(4);
    for (const corner of corners) {
      expect(inset(corner.x)).toBeGreaterThan(0);
      expect(inset(corner.y)).toBeGreaterThan(0);
    }
  });
});
