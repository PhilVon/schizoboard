/**
 * @vitest-environment happy-dom
 *
 * The dry painter and the region arithmetic. happy-dom has neither a 2D context
 * nor `Path2D`, so both are stubbed — the same arrangement `render/ink/wet.test.ts`
 * uses, and for the same reason: what is worth pinning down is not the pixels
 * but what calls the painter makes and how big a surface it asks for.
 *
 * The headline test is the last one in "the pad". Everything else here can be
 * wrong by a rounding error and still look right; ink clipped at the edge of its
 * own canvas is a stroke that is *still there and still nearly correct*, which
 * is the way it survives review.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InkSample } from "@/lib/ink";
import {
  clipToPaper,
  inkBounds,
  MAX_INK_PX,
  paintStrokes,
  regionFor,
  type InkBox,
} from "@/render/ink/dry";
import { outlineStroke, strokeOptions, strokeReach } from "@/render/ink/geometry";
import type { SceneStroke } from "@/state/scene";

interface Calls {
  points: Array<[number, number]>;
  fills: number;
  fillStyles: string[];
  alphas: number[];
  clears: number;
  transforms: number[][];
  /** The paper rectangle the painter clipped to, if it did (T-136). */
  clips: Array<[number, number, number, number]>;
  /** The vertices of a *polygon* clip — a sheet's own outline (T-186). Kept
   *  apart from `points`, which is the stroke's shape and is what every
   *  assertion about where the ink went is reading. */
  clipPoly: Array<[number, number]>;
  /** The composite operator each fill went down with — DESIGN 6.5's `multiply`
   *  for the highlighter, and `source-over` for everything else. */
  composites: string[];
  forbidden: string[];
}

let calls: Calls;
let box: InkBox;

class StubPath {
  moveTo(x: number, y: number): void {
    calls.points.push([x, y]);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    calls.points.push([cx, cy], [x, y]);
  }
  closePath(): void {}
}

function stubContext(): CanvasRenderingContext2D {
  let alpha = 1;
  let composite = "source-over";
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      calls.transforms.push([a, b, c, d, e, f]);
    },
    clearRect: () => {
      calls.clears++;
    },
    beginPath: () => {},
    rect: (x: number, y: number, w: number, h: number) => {
      calls.clips.push([x, y, w, h]);
    },
    moveTo: (x: number, y: number) => {
      calls.clipPoly.push([x, y]);
    },
    lineTo: (x: number, y: number) => {
      calls.clipPoly.push([x, y]);
    },
    closePath: () => {},
    clip: () => {},
    fill: () => {
      calls.fills++;
      calls.alphas.push(alpha);
      calls.composites.push(composite);
    },
    stroke: () => {
      calls.forbidden.push("stroke");
    },
    set lineWidth(_: number) {
      calls.forbidden.push("lineWidth");
    },
    set fillStyle(value: string) {
      calls.fillStyles.push(value);
    },
    set globalAlpha(value: number) {
      alpha = value;
    },
    get globalAlpha() {
      return alpha;
    },
    set globalCompositeOperation(value: string) {
      composite = value;
    },
    get globalCompositeOperation() {
      return composite;
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

function samples(pts: Array<[number, number]>, pressure = 0.5): InkSample[] {
  return pts.map(([x, y]) => ({ x, y, pressure }));
}

function stroke(over: Partial<SceneStroke> = {}): SceneStroke {
  const pts = over.samples ?? samples([[0, 0], [30, 0], [60, 0]]);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return {
    id: "s",
    tool: "marker",
    color: "#1f1b17",
    size: 6,
    opacity: 1,
    seed: 1,
    z: "a0",
    bbox: [x0, y0, x1, y1],
    samples: pts,
    page: null,
    ...over,
  };
}

/**
 * A sheet big enough that nothing in these tests reaches its edge — the clip is
 * its own describe below, and every other test here is about the region maths.
 */
function paper(w = 1e6, h = 1e6): InkBox {
  return { minX: -w / 2, minY: -h / 2, maxX: w / 2, maxY: h / 2 };
}

function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

beforeEach(() => {
  calls = {
    points: [],
    fills: 0,
    fillStyles: [],
    alphas: [],
    clears: 0,
    transforms: [],
    clips: [],
    clipPoly: [],
    composites: [],
    forbidden: [],
  };
  (globalThis as { Path2D?: unknown }).Path2D = StubPath;
  box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
});

describe("the box round an item's ink", () => {
  it("is null when the item has none, which is most of them", () => {
    expect(inkBounds([], box)).toBeNull();
  });

  it("pads each stroke by its own nib, not by the widest one on the item", () => {
    const thin = stroke({ id: "a", size: 6, samples: samples([[0, 0], [10, 0]]) });
    const fat = stroke({ id: "b", tool: "highlighter", size: 20, samples: samples([[100, 0], [110, 0]]) });

    const both = inkBounds([thin, fat], { ...box })!;
    // The marker's edge is padded by the marker's reach. One pad for the lot
    // would push it out by the highlighter's, on every axis, forever - the
    // region is grow-only.
    expect(both.minX).toBeCloseTo(0 - strokeReach("marker", 6), 6);
    expect(both.maxX).toBeCloseTo(110 + strokeReach("highlighter", 20), 6);
  });

  it("skips a stroke with no samples rather than counting its box", () => {
    expect(inkBounds([stroke({ samples: [] })], box)).toBeNull();
  });
});

describe("the region", () => {
  it("is a power of two on both axes", () => {
    const region = regionFor({ minX: -13, minY: -7, maxX: 91, maxY: 40 }, 1, null);
    expect(isPow2(region.px)).toBe(true);
    expect(isPow2(region.py)).toBe(true);
    expect(region.px).toBeGreaterThanOrEqual(91 + 13);
  });

  it("covers the whole box at the scale it was asked for", () => {
    const scale = 2.5;
    const region = regionFor({ minX: -13.3, minY: -7.1, maxX: 91.9, maxY: 40.2 }, scale, null);
    expect(region.scale).toBe(scale);
    expect(region.ox).toBeLessThanOrEqual(-13.3);
    expect(region.oy).toBeLessThanOrEqual(-7.1);
    expect(region.ox + region.px / scale).toBeGreaterThanOrEqual(91.9);
    expect(region.oy + region.py / scale).toBeGreaterThanOrEqual(40.2);
  });

  it("hands back the very same object when the ink still fits", () => {
    const first = regionFor({ minX: 0, minY: 0, maxX: 50, maxY: 50 }, 1, null);
    const again = regionFor({ minX: 5, minY: 5, maxX: 40, maxY: 40 }, 1, first);
    // Identity, not equality: `render/ink/canvas.ts` uses `===` to decide
    // whether to write `canvas.width`, and writing it clears the backing store
    // even when the value has not changed.
    expect(again).toBe(first);
  });

  it("grows, and never shrinks, while it survives", () => {
    const first = regionFor({ minX: 0, minY: 0, maxX: 50, maxY: 50 }, 1, null);
    const grown = regionFor({ minX: 0, minY: 0, maxX: 500, maxY: 50 }, 1, first);
    expect(grown).not.toBe(first);
    expect(grown.px).toBeGreaterThan(first.px);

    // Erasing the far stroke does not claw the pixels back — eviction will,
    // the moment the item leaves the viewport.
    const shrunk = regionFor({ minX: 0, minY: 0, maxX: 50, maxY: 50 }, 1, grown);
    expect(shrunk).toBe(grown);
  });

  it("keeps covering ink that is already on the canvas when it grows", () => {
    const first = regionFor({ minX: 0, minY: 0, maxX: 50, maxY: 50 }, 1, null);
    // A new stroke off to the left. The region has to reach both ways, or the
    // ink already drawn falls off the far edge.
    const grown = regionFor({ minX: -300, minY: 0, maxX: -250, maxY: 50 }, 1, first);
    expect(grown.ox).toBeLessThanOrEqual(-300);
    expect(grown.ox + grown.px).toBeGreaterThanOrEqual(50);
  });

  it("starts over when the scale changes, because every pixel is a new one", () => {
    const first = regionFor({ minX: 0, minY: 0, maxX: 50, maxY: 50 }, 1, null);
    const zoomed = regionFor({ minX: 0, minY: 0, maxX: 50, maxY: 50 }, 4, first);
    expect(zoomed).not.toBe(first);
    expect(zoomed.scale).toBe(4);
    expect(zoomed.px).toBeGreaterThan(first.px);
  });

  it("snaps its origin to a whole device pixel", () => {
    const scale = 3;
    const region = regionFor({ minX: -13.31, minY: -7.77, maxX: 20, maxY: 20 }, scale, null);
    expect(Number.isInteger(region.ox * scale)).toBe(true);
    expect(Number.isInteger(region.oy * scale)).toBe(true);
  });

  it("gives up resolution rather than area when the ink is enormous", () => {
    const huge = { minX: 0, minY: 0, maxX: 40_000, maxY: 40_000 };
    const region = regionFor(huge, 4, null);

    expect(region.px).toBeLessThanOrEqual(MAX_INK_PX);
    expect(region.py).toBeLessThanOrEqual(MAX_INK_PX);
    expect(region.scale).toBeLessThan(4);
    // Soft ink beats missing ink: the whole box is still covered.
    expect(region.ox + region.px / region.scale).toBeGreaterThanOrEqual(40_000);
  });
});

describe("painting", () => {
  it("clears first, then fills one shape per stroke, in order", () => {
    const region = regionFor({ minX: -10, minY: -10, maxX: 80, maxY: 20 }, 1, null);
    const drew = paintStrokes(stubContext(),
      [stroke({ id: "a", color: "#111", z: "a0" }), stroke({ id: "b", color: "#222", z: "a1" })], region, paper());

    expect(drew).toBe(true);
    expect(calls.clears).toBe(1);
    expect(calls.fills).toBe(2);
    expect(calls.fillStyles).toEqual(["#111", "#222"]);
    // A filled polygon, never a stroked line - the width is in the shape.
    expect(calls.forbidden).toEqual([]);
  });

  it("puts the item-local origin where the region says it is", () => {
    const region = regionFor({ minX: -100, minY: -50, maxX: 0, maxY: 0 }, 2, null);
    paintStrokes(stubContext(), [stroke()], region, paper());

    // The clear runs under identity; the draw runs under the region's transform.
    expect(calls.transforms[0]).toEqual([1, 0, 0, 1, 0, 0]);
    const draw = calls.transforms[1]!;
    expect(draw[0]).toBe(region.scale);
    expect(draw[4]).toBeCloseTo(-region.ox * region.scale, 6);
    expect(draw[5]).toBeCloseTo(-region.oy * region.scale, 6);
  });

  it("draws a translucent stroke translucently", () => {
    const region = regionFor({ minX: -10, minY: -10, maxX: 80, maxY: 20 }, 1, null);
    paintStrokes(stubContext(), [stroke({ opacity: 0.35 })], region, paper());
    expect(calls.alphas).toEqual([0.35]);
  });

  it("has nothing to draw for an item whose strokes are all empty", () => {
    const region = regionFor({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 1, null);
    expect(paintStrokes(stubContext(), [stroke({ samples: [] })], region, paper())).toBe(false);
    expect(calls.fills).toBe(0);
    // The clear still happened: a canvas whose last stroke was erased has to end
    // up blank rather than keeping the old mark.
    expect(calls.clears).toBe(1);
  });

  /**
   * AC-23, and the whole of DESIGN section 6.5's warning: "each highlighter
   * stroke composites as a unit so that a single stroke crossing itself doesn't
   * darken at the crossing".
   *
   * The unit is the fill. One `multiply` fill of one outline polygon composites
   * every pixel inside it exactly once, whatever the polygon does on its way
   * round — so the assertion that matters is the *count*, and it is one no matter
   * how many times the hand crossed its own line.
   */
  it("lays a highlighter down with multiply, and a marker over the top", () => {
    const region = regionFor({ minX: -10, minY: -10, maxX: 80, maxY: 20 }, 1, null);
    paintStrokes(stubContext(),
      [
        stroke({ id: "a", tool: "highlighter", size: 20, opacity: 0.4, z: "a0" }),
        stroke({ id: "b", z: "a1" }),
      ], region, paper());

    // Per stroke, and reset for the marker: a highlighter passed over first must
    // not turn the ink drawn after it into a blend of the paper.
    expect(calls.composites).toEqual(["multiply", "source-over"]);
  });

  it("fills a self-crossing highlighter stroke exactly once", () => {
    // A loop: out, up, back across itself, and on. Every pixel of the crossing is
    // inside the same outline as the rest, and one fill is what keeps it the same
    // shade as the rest.
    const loop = samples([
      [0, 0],
      [60, 0],
      [60, -40],
      [30, -40],
      [30, 20],
    ]);
    const region = regionFor({ minX: -40, minY: -80, maxX: 100, maxY: 60 }, 1, null);
    paintStrokes(
      stubContext(),
      [stroke({ tool: "highlighter", size: 20, samples: loop })],
      region,
      paper(),
    );

    expect(calls.fills).toBe(1);
    expect(calls.composites).toEqual(["multiply"]);
  });

  /**
   * > The smudge eraser is itself stored as a normal stroke with
   * > `tool: 'erase'`, rendered with `destination-out`. — DATA-MODEL 6.2
   *
   * Which takes away only what is on this canvas. The photograph underneath is a
   * different element and cannot be rubbed out, which is what makes the erase
   * stroke safe to keep as a record at all.
   */
  it("rubs a smudge out of the ink and leaves the marks after it alone", () => {
    const region = regionFor({ minX: -10, minY: -10, maxX: 80, maxY: 20 }, 1, null);
    paintStrokes(
      stubContext(),
      [stroke({ id: "a", z: "a0" }), stroke({ id: "b", tool: "erase", z: "a1" }), stroke({ id: "c", z: "a2" })],
      region,
      paper(),
    );

    // Per stroke, and reset after: a smudge must not turn the ink drawn over it
    // into another hole.
    expect(calls.composites).toEqual(["source-over", "destination-out", "source-over"]);
  });

  it("treats a tool it has never heard of as a marker, so the stroke still shows", () => {
    const region = regionFor({ minX: -10, minY: -10, maxX: 80, maxY: 20 }, 1, null);
    // A peer on a version with a tool this one does not have. Visibly wrong beats
    // invisibly missing: the record is in the document either way.
    expect(paintStrokes(stubContext(), [stroke({ tool: "crayon" })], region, paper())).toBe(true);
    expect(calls.composites).toEqual(["source-over"]);
  });
});

/**
 * The headline test, and the one that catches a wrong pad, a wrong origin and a
 * wrong scale with one assertion.
 *
 * It runs the real `perfect-freehand` rather than a stub, so an upstream change
 * to the radius easing fails here rather than showing up months later as ink
 * with a shaved edge on some strokes.
 */
describe("the pad", () => {
  it("keeps every outline point of a hard-pressed stroke inside the backing store", () => {
    for (const tool of ["marker", "highlighter"] as const) {
      for (const size of [1, 6, 20, 64]) {
        // A stroke pressed as hard as it can be, at the extreme corners of its
        // own box - which is where a pad that is a hair too small shows.
        const pts = samples([[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]], 1);
        const one = stroke({ tool, size, samples: pts });
        const bounds = inkBounds([one], { ...box })!;
        const region = regionFor(bounds, 2, null);

        const outline = outlineStroke(pts, strokeOptions(tool, size, true));
        for (const [x, y] of outline) {
          const px = (x - region.ox) * region.scale;
          const py = (y - region.oy) * region.scale;
          expect(px).toBeGreaterThanOrEqual(0);
          expect(py).toBeGreaterThanOrEqual(0);
          expect(px).toBeLessThanOrEqual(region.px);
          expect(py).toBeLessThanOrEqual(region.py);
        }
      }
    }
  });

  it("keeps a single-sample dot inside too, which the nib width alone does not", () => {
    // `getStrokePoints` extends a one-sample stroke by [1, 1] before outlining
    // it, so a dot reaches a diagonal unit past its own radius. This is the
    // sqrt(2) in `strokeReach`, and without it the corner of a dot is shaved.
    const pts = samples([[0, 0]], 1);
    const one = stroke({ tool: "marker", size: 6, samples: pts });
    const bounds = inkBounds([one], { ...box })!;
    const region = regionFor(bounds, 1, null);

    for (const [x, y] of outlineStroke(pts, strokeOptions("marker", 6, true))) {
      expect((x - region.ox) * region.scale).toBeGreaterThanOrEqual(0);
      expect((y - region.oy) * region.scale).toBeGreaterThanOrEqual(0);
      expect((x - region.ox) * region.scale).toBeLessThanOrEqual(region.px);
      expect((y - region.oy) * region.scale).toBeLessThanOrEqual(region.py);
    }
  });

  it("is wider than half the nominal nib, because a thinned one is", () => {
    // Measured: 0.775 * size for the marker at full pressure. A `size / 2` pad
    // clips every hard-pressed stroke by a quarter of its width.
    expect(strokeReach("marker", 6)).toBeGreaterThan(6 * 0.775);
    expect(strokeReach("highlighter", 20)).toBeGreaterThan(20 * 0.53);
  });
});

/**
 * T-136. The pen stops at the edge of the paper.
 *
 * Ink used to be drawn in full wherever the samples went, so a stroke that ran
 * off the side of a photograph hung over the cork and travelled with the paper —
 * a mark stuck to the air. Two guards, and they are not the same guard: the
 * canvas is sized to the overlap so the pixels are not spent, and the painter
 * clips so that the ones that exist are not filled.
 */
describe("the edge of the paper", () => {
  it("clips every stroke to the item's own box", () => {
    const region = regionFor({ minX: -10, minY: -10, maxX: 80, maxY: 20 }, 1, null);
    paintStrokes(stubContext(), [stroke()], region, paper(100, 60));

    // Half-extents about the item's centre, which is where its local origin is.
    expect(calls.clips).toEqual([[-50, -30, 100, 60]]);
  });

  /**
   * T-186, AC-543. A sheet is not its rectangle, and committed ink stops at the
   * paper — the same polygon the pen tested (`state/tools/marker.ts`) and the
   * wet stroke was clipped to (`render/ink/wet.ts`).
   *
   * The rectangle does not stop being useful: it is still what sizes the
   * backing store, because a bounding box is the right shape for "how many
   * pixels" and the wrong shape for "where does the paper end". T-186 moved
   * only the second of those.
   */
  it("clips to the sheet's outline when it has one, not to its box", () => {
    const region = regionFor({ minX: -10, minY: -10, maxX: 80, maxY: 20 }, 1, null);
    // A 100x60 sheet whose head has been torn away by ten units.
    const outline = new Float32Array([-50, -20, 50, -20, 50, 30, -50, 30]);
    paintStrokes(stubContext(), [stroke()], region, paper(100, 60), { points: outline, n: 4 });

    // No rectangle at all: the polygon replaced it rather than joining it. Two
    // clips would intersect, which happens to give the same picture here and
    // would not on a sheet whose outline reaches its box on one side.
    expect(calls.clips).toEqual([]);
    expect(calls.clipPoly).toEqual([
      [-50, -20],
      [50, -20],
      [50, 30],
      [-50, 30],
    ]);
  });

  it("falls back to the box for an item with no outline, which is a photograph", () => {
    const region = regionFor({ minX: -10, minY: -10, maxX: 80, maxY: 20 }, 1, null);
    paintStrokes(stubContext(), [stroke()], region, paper(100, 60), null);
    expect(calls.clips).toEqual([[-50, -30, 100, 60]]);
    expect(calls.clipPoly).toEqual([]);
  });

  it("falls back to the box for an outline too short to be a polygon", () => {
    // Not a shape the renderer produces, and the guard is cheap: two vertices
    // clipped as a path is an empty region, and an empty clip is an item whose
    // ink silently vanishes.
    const region = regionFor({ minX: -10, minY: -10, maxX: 80, maxY: 20 }, 1, null);
    paintStrokes(stubContext(), [stroke()], region, paper(100, 60), {
      points: new Float32Array([0, 0, 1, 1]),
      n: 2,
    });
    expect(calls.clips).toEqual([[-50, -30, 100, 60]]);
  });

  it("uses every vertex of the outline, not just the first few", () => {
    const region = regionFor({ minX: -10, minY: -10, maxX: 80, maxY: 20 }, 1, null);
    const many = new Float32Array(
      Array.from({ length: 17 }, (_, i) => {
        const a = (i / 17) * Math.PI * 2;
        return [Math.cos(a) * 50, Math.sin(a) * 30];
      }).flat(),
    );
    paintStrokes(stubContext(), [stroke()], region, paper(100, 60), { points: many, n: 17 });
    // Seventeen is a torn edge's sample count. A clip built from four of them
    // would cut the corners off every sheet on the board.
    expect(calls.clipPoly).toHaveLength(17);
  });

  it("clips once for the item, not once per stroke", () => {
    const region = regionFor({ minX: -10, minY: -10, maxX: 80, maxY: 20 }, 1, null);
    paintStrokes(
      stubContext(),
      [stroke({ id: "a" }), stroke({ id: "b" }), stroke({ id: "c" })],
      region,
      paper(100, 60),
    );
    expect(calls.clips).toHaveLength(1);
    expect(calls.fills).toBe(3);
  });

  it("keeps the part of the ink that is on the paper, and drops the rest", () => {
    // A stroke that starts on a 100-unit sheet and runs 400 units off it.
    const ink = inkBounds([stroke({ samples: samples([[0, 0], [400, 0]]) })], box)!;
    const kept = clipToPaper({ ...ink }, paper(100, 100))!;

    expect(kept.maxX).toBe(50);
    // And the near end is untouched: this is a clip, not a shrink to the paper.
    expect(kept.minX).toBeCloseTo(ink.minX, 6);
  });

  it("has nothing to keep for a stroke entirely off the paper", () => {
    const ink = inkBounds([stroke({ samples: samples([[400, 0], [500, 0]]) })], box)!;
    // Which is an undo of a resize away: shrink the sheet under ink drawn near
    // its old edge and every stroke is off it. The canvas should go rather than
    // stay alive and blank.
    expect(clipToPaper({ ...ink }, paper(100, 100))).toBeNull();
  });

  /**
   * Board ink (T-61) has no edge to stop at. The tile it is filed under is a
   * bucket rather than a frame — a stroke goes in by its bbox centre and may
   * hang half its length outside — so a clip here would chop long marks on an
   * invisible 2048-unit lattice.
   */
  it("does not clip at all when there is no paper", () => {
    const region = regionFor({ minX: -10, minY: -10, maxX: 80, maxY: 20 }, 1, null);
    expect(paintStrokes(stubContext(), [stroke()], region, null)).toBe(true);
    expect(calls.clips).toHaveLength(0);
    expect(calls.fills).toBe(1);
  });
});
