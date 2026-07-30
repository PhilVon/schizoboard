import { describe, expect, it } from "vitest";

import { edgePoints, insideEdge, sheetEdge, tearEdge, type Fold } from "@/render/items/edge";
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

  it("leaves the silhouette alone when the sheet has never been folded", () => {
    // The overwhelmingly common sheet. A fold nobody has made must not cost a
    // single character of difference in the path, because every branch below is
    // guarded on a depth that is zero for three corners out of four and for
    // three sheets in four.
    const plain = edgeClipPath("legal", SEED);
    expect(sheetEdge("legal", SEED, null).path).toBe(plain);
    expect(sheetEdge("legal", SEED, { corner: 0, depth: 0 }).path).toBe(plain);
  });

  it("turns the folded corner into two points and leaves the other three", () => {
    // The whole of AC-462's first clause: a folded corner cuts the silhouette.
    // A corner is the point where neither coordinate is a percentage — so a
    // corner that has been cut off is no longer one of those, and the two points
    // that replace it each sit *along* one of the two edges that met there.
    for (let corner = 0; corner < 4; corner++) {
      const path = sheetEdge("white", SEED, { corner, depth: 7 }).path;
      const square = parse(path).filter(
        (point) => inset(point.x) !== null && inset(point.y) !== null,
      );
      expect(square).toHaveLength(3);
    }
  });

  it("puts the two cut points on the two edges that met at that corner", () => {
    // Not anywhere on the outline: a fold at the top left reaches `depth` down
    // the spine and `depth` along the head, and nowhere else. Getting the pair
    // the wrong way round draws the fold across the sheet instead of across the
    // corner, which is a shape no polygon test would notice.
    const path = sheetEdge("white", SEED, { corner: 0, depth: 6.5 }).path;
    const points = parse(path);
    const onSpine = points.filter((p) => inset(p.x) !== null && p.x.endsWith("px"));
    const onHead = points.filter((p) => inset(p.y) !== null && p.y.endsWith("px"));
    expect(onSpine.some((p) => p.y === "6.5%")).toBe(true);
    expect(onHead.some((p) => p.x === "6.5%")).toBe(true);
  });

  it("measures a fold at the far corners back from the far side", () => {
    // A bottom-right fold is at 100% minus the depth on both axes. Written the
    // other way it would cut the *top left* corner of a sheet whose bottom right
    // was folded, which is a silhouette that disagrees with the flap `items.css`
    // draws off the same `data-ear`.
    const path = sheetEdge("white", SEED, { corner: 2, depth: 8 }).path;
    const points = parse(path);
    expect(points.some((p) => p.y === "92.0%" && p.x.startsWith("calc"))).toBe(true);
    expect(points.some((p) => p.x === "92.0%" && p.y.startsWith("calc"))).toBe(true);
  });

  it("eats the ragged samples the fold has taken the paper from", () => {
    // A vertex left inside the cut is a spur of paper reaching out past the fold
    // line — and under the non-zero winding rule it does not even read as a spur,
    // it is a notch out of the flap at the one place the eye is already looking.
    //
    // Checked on a torn head, which is the tightest case in the file: seventeen
    // samples rather than nine, so the first one can sit as close as 3.9% to the
    // corner and a fold of any realistic depth reaches past it.
    const depth = 9;
    const path = sheetEdge("legal", SEED, { corner: 0, depth }).path;
    for (const point of parse(path)) {
      // Along the head: a bare-px `y` and a percentage `x`, which must be clear
      // of the fold.
      if (point.y.endsWith("px") && point.x.endsWith("%")) {
        expect(Number.parseFloat(point.x)).toBeGreaterThanOrEqual(depth);
      }
      // And down the spine, which is the same test on the other axis.
      if (point.x.endsWith("px") && point.y.endsWith("%")) {
        expect(Number.parseFloat(point.y)).toBeGreaterThanOrEqual(depth);
      }
    }
  });

  it("costs the outline two points and then only gives them back", () => {
    // A fold is bounded: it replaces one corner with two and takes samples away
    // as it deepens, so the path can never be more than a point longer than the
    // sheet's own and it shrinks from there. A growing fold that grew the polygon
    // would put the cost of ageing on the frame that draws it.
    for (const stock of ["white", "cream", "legal", "graph", "index"] as PaperStock[]) {
      const plain = parse(edgeClipPath(stock, SEED)).length;
      let last = Infinity;
      for (const depth of [1, 3, 5, 7, 9, 11]) {
        const n = parse(sheetEdge(stock, SEED, { corner: 0, depth }).path).length;
        expect(n).toBeLessThanOrEqual(plain + 1);
        expect(n).toBeLessThanOrEqual(last);
        last = n;
      }
    }
    // And there really is something to give back. On the head of a legal pad —
    // seventeen samples rather than nine, so they crowd toward the corner — the
    // unfolded outline has a vertex inside where a fold of 9% would reach, and
    // the folded one does not. Without both halves this says nothing: a fold that
    // ate no samples would satisfy the second on its own.
    const inside = (path: string): number =>
      parse(path).filter(
        (p) => p.x.endsWith("%") && p.y.endsWith("px") && Number.parseFloat(p.x) < 9,
      ).length;
    expect(inside(edgeClipPath("legal", SEED))).toBeGreaterThan(0);
    // The one at exactly 9% is the fold's own vertex, which is why this is `< 9`
    // and not `<= 9`.
    expect(inside(sheetEdge("legal", SEED, { corner: 0, depth: 9 }).path)).toBe(0);
  });

  it("folds only the corner it was given", () => {
    // Four folds, four different silhouettes, and none of them the unfolded one.
    const seen = new Set<string>([edgeClipPath("white", SEED)]);
    for (let corner = 0; corner < 4; corner++) {
      const fold: Fold = { corner, depth: 7 };
      seen.add(sheetEdge("white", SEED, fold).path);
    }
    expect(seen.size).toBe(5);
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

/**
 * The silhouette as numbers — T-186.
 *
 * The whole point of the numeric form is that there is now only **one**
 * polygon, and the CSS is a rendering of it. So the assertion that matters most
 * is not that the numbers are right in isolation; it is that resolving them and
 * parsing the stylesheet give the same shape. Two walks emitting the same
 * polygon in two formats is how the paint and the ink come to disagree about
 * where a torn edge is, by a few units, on the one edge where it shows.
 */
describe("the outline behind the clip path", () => {
  const W = 400;
  const H = 300;

  /** `edgePoints` for a sheet, plus the vertex count. */
  function resolved(stock: PaperStock, seed: number, fold: Fold | null = null) {
    const edge = sheetEdge(stock, seed, fold);
    const n = edge.outline.length / 4;
    const points = edgePoints(edge.outline, W, H, new Float32Array(n * 2));
    return { edge, n, points };
  }

  it("carries four numbers per vertex, one vertex per point in the path", () => {
    const { edge, n } = resolved("cream", SEED);
    expect(edge.outline.length % 4).toBe(0);
    expect(n).toBe(parse(edge.path).length);
  });

  it("resolves to the same shape the stylesheet describes", () => {
    // Every coordinate the CSS can hold, resolved by hand the way a browser
    // would, against the same w and h — and then compared with what
    // `edgePoints` produced. If these ever drift, a stroke stops at a different
    // place from the paper it is drawn on.
    const { edge, points } = resolved("legal", SEED, { corner: 1, depth: 12 });
    const css = (coord: string, size: number): number => {
      const bare = /^(-?[\d.]+)px$/.exec(coord);
      if (bare) return Number(bare[1]);
      const back = /^calc\(100% - (-?[\d.]+)px\)$/.exec(coord);
      if (back) return size - Number(back[1]);
      return (Number(/^([\d.]+)%$/.exec(coord)![1]) / 100) * size;
    };
    const written = parse(edge.path);
    expect(written.length).toBeGreaterThan(8);
    /**
     * A quarter of a board unit, and the slack is *the stylesheet's*.
     *
     * The numbers are the polygon; the string is a rendering of it, rounded to
     * two decimals of a length and one of a percentage. On a 400-unit sheet
     * that last digit of a percentage is 0.2 units — so the painted edge is up
     * to a fifth of a unit from the exact one, and the ink gets the exact one.
     * At 100% zoom that is a fifth of a pixel, which is the right way round:
     * the lossy copy is the one that only has to look like paper.
     */
    const ROUNDING = 0.25;
    written.forEach((point, i) => {
      // Minus a half-extent, because the stylesheet measures from the corner
      // and everything else on this board measures from the middle.
      expect(Math.abs(points[i * 2]! - (css(point.x, W) - W / 2))).toBeLessThan(ROUNDING);
      expect(Math.abs(points[i * 2 + 1]! - (css(point.y, H) - H / 2))).toBeLessThan(ROUNDING);
    });
  });

  it("is measured about the centre, so it lands where the ink and the hit test look", () => {
    const { points, n } = resolved("index", SEED);
    // An index card barely wanders, so every vertex is within a whisker of the
    // rectangle's own edge — and the rectangle runs -200..200 by -150..150.
    for (let i = 0; i < n; i++) {
      expect(Math.abs(points[i * 2]!)).toBeLessThanOrEqual(W / 2);
      expect(Math.abs(points[i * 2 + 1]!)).toBeLessThanOrEqual(H / 2);
    }
    expect(Math.max(...Array.from({ length: n }, (_, i) => points[i * 2]!))).toBeGreaterThan(190);
    expect(Math.min(...Array.from({ length: n }, (_, i) => points[i * 2]!))).toBeLessThan(-190);
  });

  it("never grows past the item's own rectangle, whatever the stock", () => {
    // The rectangle is what the culler, the selection chrome and the hit test
    // all agree the item occupies. A silhouette that grew would put paper
    // outside it — which is the assumption the whole render stack shares.
    for (const stock of ["white", "cream", "legal", "graph", "index"] as PaperStock[]) {
      const { points, n } = resolved(stock, SEED);
      for (let i = 0; i < n; i++) {
        expect(Math.abs(points[i * 2]!)).toBeLessThanOrEqual(W / 2 + 1e-4);
        expect(Math.abs(points[i * 2 + 1]!)).toBeLessThanOrEqual(H / 2 + 1e-4);
      }
    }
  });
});

describe("insideEdge", () => {
  const W = 400;
  const H = 300;
  function sheet(stock: PaperStock, seed: number, fold: Fold | null = null) {
    const edge = sheetEdge(stock, seed, fold);
    const n = edge.outline.length / 4;
    return { points: edgePoints(edge.outline, W, H, new Float32Array(n * 2)), n };
  }

  it("says yes in the middle of the paper", () => {
    const { points, n } = sheet("cream", SEED);
    expect(insideEdge(points, n, 0, 0)).toBe(true);
  });

  it("says no well outside the rectangle", () => {
    const { points, n } = sheet("cream", SEED);
    expect(insideEdge(points, n, 500, 0)).toBe(false);
    expect(insideEdge(points, n, 0, -400)).toBe(false);
    expect(insideEdge(points, n, -1e6, 1e6)).toBe(false);
  });

  it("says no in the strip a tear gave up — which is the whole of T-186", () => {
    // A legal pad is torn along its head, up to nine units deep. The rectangle
    // says this point is on the item; the paper is not there.
    const { points, n } = sheet("legal", SEED);
    // The deepest point of the tear, found rather than assumed: the tear is
    // seeded, so which sample is deepest is not a number a test can hardcode.
    let deepest = -Infinity;
    let atX = 0;
    for (let i = 0; i < n; i++) {
      const y = points[i * 2 + 1]!;
      if (y > deepest && y < 0) {
        deepest = y;
        atX = points[i * 2]!;
      }
    }
    expect(deepest).toBeGreaterThan(-H / 2 + 2);
    // Just inside the rectangle's top edge, under the deepest notch.
    expect(insideEdge(points, n, atX, -H / 2 + 0.05)).toBe(false);
    // And a whisker below the notch is paper again.
    expect(insideEdge(points, n, atX, deepest + 1)).toBe(true);
  });

  it("says no inside a folded corner, because the paper is genuinely gone", () => {
    // T-190 put the dog-ear in the silhouette rather than in the paint, so this
    // falls out of the same test rather than needing one of its own.
    const folded = sheet("white", SEED, { corner: 0, depth: 20 });
    const flat = sheet("white", SEED);
    // A point well inside the cut at the top left: 20% of 400 is 80 units in x
    // and 20% of 300 is 60 in y, so the fold line runs between them.
    const x = -W / 2 + 12;
    const y = -H / 2 + 12;
    expect(insideEdge(flat.points, flat.n, x, y)).toBe(true);
    expect(insideEdge(folded.points, folded.n, x, y)).toBe(false);
  });

  it("counts a crossing once on the scanline through a vertex itself", () => {
    // The failure this guards is exact rather than statistical, which is why a
    // sweep at whole-unit steps does not find it. At a y that is *exactly* a
    // vertex's, the two edges meeting there both have an endpoint on the line,
    // and what decides whether the crossing is counted once or twice is that
    // the two ends are compared the *same* way. Either strictly-above rule
    // works; a mixed one counts that vertex for both edges, the parity flips
    // twice, and the middle of the sheet reads as cork — so a pen sample
    // landing on that one line would file its ink on the board.
    for (const stock of ["white", "legal", "graph"] as PaperStock[]) {
      const { points, n } = sheet(stock, SEED);
      for (let i = 0; i < n; i++) {
        const y = points[i * 2 + 1]!;
        // Only the vertices along the sides: a scanline through the head or the
        // tail is genuinely on the boundary and is promised to neither side.
        if (Math.abs(y) > H / 2 - 12) continue;
        expect(insideEdge(points, n, 0, y)).toBe(true);
      }
    }
  });

  it("counts a crossing once, so a vertex's own scanline is not a hole", () => {
    // The classic failure of a crossing-number test is a horizontal edge or a
    // vertex counted twice, which puts a one-line hole through the polygon. A
    // sweep down the middle of the sheet must be inside for every row between
    // the head and the tail.
    const { points, n } = sheet("graph", SEED);
    for (let y = -H / 2 + 12; y < H / 2 - 12; y += 1) {
      expect(insideEdge(points, n, 0, y)).toBe(true);
    }
  });
});
