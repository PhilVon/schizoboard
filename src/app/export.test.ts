/**
 * What an export contains and how big it comes out.
 *
 * Every case here is a file somebody was handed. So the two that matter most are
 * the ones with no visible symptom: a board quietly cropped to fit a ceiling,
 * and a page whose size disagrees with the camera that drew it — which is how
 * the first PDF this project produced came out with the board in one corner
 * (D-36).
 */

import { describe, expect, it } from "vitest";

import {
  EXPORT_MARGIN,
  MAX_CANVAS_PIXELS,
  MAX_CANVAS_SIDE,
  MAX_PDF_INCHES,
  exportBounds,
  exportPage,
  exportView,
} from "@/app/export";
import type { Bounds } from "@/state/scene";

const board = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({
  minX,
  minY,
  maxX,
  maxY,
});

/** A scene stub with the two calls `F` and `Ctrl+0` already use. */
function scene(all: Bounds | null, picked: Bounds | null = null) {
  return {
    boundsOfMany: (ids: Iterable<string>) => ([...ids].length > 0 ? picked : null),
    contentBounds: () => all,
  };
}

describe("what an export covers", () => {
  it("is the selection when there is one", () => {
    const held = board(0, 0, 100, 100);
    expect(exportBounds(scene(board(-999, -999, 999, 999), held), ["a", "b"])).toEqual(held);
  });

  it("is the whole board when there is not", () => {
    const all = board(-999, -999, 999, 999);
    expect(exportBounds(scene(all, board(0, 0, 1, 1)), [])).toEqual(all);
  });

  it("falls back to the board when the selection frames nothing", () => {
    // Every id in it has gone — a peer deleted them, or the janitor did. An
    // export of nothing would be a blank file, which is worse than the board.
    const all = board(-10, -10, 10, 10);
    expect(exportBounds(scene(all, null), ["gone"])).toEqual(all);
  });

  it("is nothing at all on an empty board, and says so", () => {
    expect(exportBounds(scene(null, null), [])).toBeNull();
  });
});

describe("the page and the camera that fills it", () => {
  it("puts the margin in board units, so the file looks the same at any scale", () => {
    const view = exportView(board(0, 0, 800, 600), { scale: 2 });
    expect(view.bounds).toEqual(board(-EXPORT_MARGIN, -EXPORT_MARGIN, 800 + EXPORT_MARGIN, 600 + EXPORT_MARGIN));
    expect(view.x).toBe(-EXPORT_MARGIN);
    expect(view.y).toBe(-EXPORT_MARGIN);
  });

  it("makes the output exactly the framed board at the asked-for scale", () => {
    const view = exportView(board(0, 0, 800, 600), { scale: 2, margin: 0 });
    expect([view.width, view.height]).toEqual([1600, 1200]);
    expect(view.zoom).toBe(2);
    expect(view.reduced).toBe(false);
  });

  /**
   * The invariant the whole module exists for: whatever the size, the page and
   * the camera agree. If they do not, the board sits in a corner of an empty
   * page and nothing in the file says why.
   */
  it("keeps the camera and the page in step at every size", () => {
    for (const [w, h] of [
      [800, 600],
      [8_720, 3_800],
      [40_000, 900],
      [30_000, 30_000],
      [10, 10],
    ]) {
      const view = exportView(board(0, 0, w, h), { scale: 2, margin: 0 });
      const label = `${w}x${h}`;
      // The board rectangle, drawn at `zoom` from `x,y`, fills the page and does
      // not overrun it. Within a pixel on the second axis, because one zoom
      // cannot hold two axes of whole pixels exactly — and a pixel is four
      // hundred times smaller than the drift this test exists to catch.
      const drawnW = (view.bounds.maxX - view.x) * view.zoom;
      const drawnH = (view.bounds.maxY - view.y) * view.zoom;
      expect(drawnW, label).toBeCloseTo(view.width, 6);
      expect(drawnH, label).toBeGreaterThan(view.height - 1.001);
      expect(drawnH, label).toBeLessThan(view.height + 1.001);
      // And the paper is the same page in inches.
      expect(view.inches.width * 96, label).toBeCloseTo(view.width, 6);
    }
  });

  it("comes down in scale rather than cropping when the area ceiling is in the way", () => {
    // 20,000 x 14,000 units at 2x is 1.1 billion pixels; the canvas ceiling is
    // 268 million and a canvas over it comes back blank rather than throwing.
    const view = exportView(board(0, 0, 20_000, 14_000), { scale: 2, margin: 0 });
    expect(view.reduced).toBe(true);
    expect(view.asked).toBe(2);
    expect(view.width * view.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    // The whole board is still in it — the framing never moves.
    expect(view.bounds).toEqual(board(0, 0, 20_000, 14_000));
    expect(view.zoom).toBeGreaterThan(0);
  });

  it("comes down for a long thin board, which the area ceiling alone would allow", () => {
    // 100,000 x 500 is 50 million square units — inside the area ceiling at 2x,
    // and 200,000 pixels along one side, which is three times the dimension one.
    const view = exportView(board(0, 0, 100_000, 500), { scale: 2, margin: 0 });
    expect(view.width).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
    expect(view.reduced).toBe(true);
  });

  it("never reduces below something that can hold a mark", () => {
    const view = exportView(board(0, 0, 1e9, 1e9), { margin: 0 });
    expect(view.zoom).toBeGreaterThanOrEqual(0.01);
    expect(view.width).toBeGreaterThanOrEqual(1);
  });

  it("survives a board with no area, which one item of no size is", () => {
    const view = exportView(board(5, 5, 5, 5), { scale: 2, margin: 0 });
    expect(Number.isFinite(view.zoom)).toBe(true);
    expect(view.width).toBeGreaterThanOrEqual(1);
    expect(view.height).toBeGreaterThanOrEqual(1);
  });
});

describe("the page, for the route that thinks in paper", () => {
  it("is 1:1 by default, because a PDF's text is vector anyway", () => {
    const view = exportPage(board(0, 0, 960, 480), { margin: 0 });
    expect(view.zoom).toBe(1);
    expect(view.inches).toEqual({ width: 10, height: 5 });
  });

  it("stays inside the 200 inches a PDF page may be", () => {
    // 25,000 units at 1:1 is 260 inches, which the format cannot express.
    const view = exportPage(board(0, 0, 25_000, 1_000), { margin: 0 });
    expect(view.inches.width).toBeLessThanOrEqual(MAX_PDF_INCHES);
    expect(view.reduced).toBe(true);
    expect(view.bounds).toEqual(board(0, 0, 25_000, 1_000));
  });

  it("does not inherit the canvas area ceiling, which is not a paper limit", () => {
    // 19,000 x 13,000 at 1:1 is 247 million pixels — under the canvas ceiling by
    // luck rather than by rule, and either way irrelevant to a page of paper.
    const view = exportPage(board(0, 0, 19_000, 13_000), { margin: 0 });
    expect(view.reduced).toBe(false);
    expect(view.inches.width).toBeCloseTo(19_000 / 96, 6);
  });
});
