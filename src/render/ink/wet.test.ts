/**
 * @vitest-environment happy-dom
 *
 * happy-dom has neither a 2D context nor `Path2D`, so both are stubbed — the
 * same arrangement `render/ropes/paint.test.ts` uses and for the same reason.
 * What is worth pinning down is not the pixels but *what calls the painter
 * makes*: a fill and never a stroke, a width that follows the zoom rather than
 * ignoring it, and nothing at all left over from the stroke before.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InkSample, WetStroke } from "@/lib/ink";
import { type ItemFrame, WetInk } from "@/render/ink/wet";
import { Camera } from "@/state/camera";

interface Calls {
  /** Every point the path was told about, control points included. */
  points: Array<[number, number]>;
  fills: number;
  /** Anything that would make this a stroked line rather than a filled shape. */
  forbidden: string[];
  fillStyles: string[];
  /** The alpha and the composite operator each fill went down with — the two
   *  halves of the highlighter's translucency. */
  alphas: number[];
  composites: string[];
  /** Straight edges, which on this path only ever come from the paper clip. */
  lines: Array<[number, number]>;
  clips: number;
}

let calls: Calls;
let camera: Camera;
let ink: WetInk;

/**
 * Two kinds of path reach this stub and they must not be confused: the stroke's
 * outline, which is curves, and the paper clip, which is four straight corners
 * (T-136). Sorted on `closePath` by whether any straight edge was drawn, so the
 * outline's points stay the thing every assertion about *where the ink went* is
 * measuring.
 */
class StubPath {
  private readonly seen: Array<[number, number]> = [];
  private straight = false;

  moveTo(x: number, y: number): void {
    this.seen.push([x, y]);
  }
  lineTo(x: number, y: number): void {
    this.straight = true;
    this.seen.push([x, y]);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.seen.push([cx, cy], [x, y]);
  }
  closePath(): void {
    if (this.straight) calls.lines.push(...this.seen);
    else calls.points.push(...this.seen);
    this.seen.length = 0;
    this.straight = false;
  }
}

function stubContext(): CanvasRenderingContext2D {
  let alpha = 1;
  let composite = "source-over";
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
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
    clip: () => {
      calls.clips++;
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

/** A straight horizontal stroke, so the spread in `y` *is* the nib width. */
function straight(count: number, step = 20): InkSample[] {
  const samples: InkSample[] = [];
  for (let i = 0; i < count; i++) samples.push({ x: i * step, y: 0, pressure: 0.5 });
  return samples;
}

function stroke(samples: readonly InkSample[], size = 6): WetStroke {
  return { tool: "highlighter", color: "#1f1b17", size, opacity: 1, item: null, samples };
}

/** The same stroke, glued to a photograph — so the samples are that item's local
 *  coordinates and the frame is where it is drawn this frame. */
function glued(samples: readonly InkSample[]): WetStroke {
  return { ...stroke(samples), item: "p" };
}

/** Half-extents big enough that the paper clip is not what these tests are
 *  about; the clip has its own describe below. */
function frame(cx: number, cy: number, angle = 0, hw = 1e6, hh = 1e6): ItemFrame {
  return { cx, cy, cos: Math.cos(angle), sin: Math.sin(angle), hw, hh };
}

function spreadY(): number {
  const ys = calls.points.map((p) => p[1]);
  return Math.max(...ys) - Math.min(...ys);
}

beforeEach(() => {
  calls = {
    points: [],
    fills: 0,
    forbidden: [],
    fillStyles: [],
    alphas: [],
    composites: [],
    lines: [],
    clips: 0,
  };
  (globalThis as { Path2D?: unknown }).Path2D = StubPath;
  camera = new Camera();
  camera.resize(1000, 800);
  ink = new WetInk();
});

describe("drawing the stroke in progress", () => {
  it("fills a shape and never strokes a line", () => {
    expect(ink.draw(stubContext(), camera, stroke(straight(6)))).toBe(true);

    expect(calls.fills).toBe(1);
    // > which turns an input polyline into an *outline polygon* that gets filled
    // > — not a stroked line. — DESIGN section 6.5
    expect(calls.forbidden).toEqual([]);
  });

  it("draws in the stroke's own colour", () => {
    ink.draw(stubContext(), camera, { ...stroke(straight(4)), color: "#c9a227" });
    expect(calls.fillStyles).toEqual(["#c9a227"]);
  });

  /**
   * The wet mark has to be the mark that lands. A highlighter drawn opaque under
   * the pointer and translucent a frame after the release is the same bug as ink
   * that moves at pen-up — it is just a shade instead of a position, and it is
   * only visible on the tool nobody tests first.
   */
  it("lays a highlighter down at its own opacity, with multiply", () => {
    ink.draw(stubContext(), camera, { ...stroke(straight(4)), opacity: 0.4 });

    expect(calls.alphas).toEqual([0.4]);
    expect(calls.composites).toEqual(["multiply"]);
  });

  it("lays a marker down opaque, over whatever the overlay has already drawn", () => {
    ink.draw(stubContext(), camera, { ...stroke(straight(4)), tool: "marker" });

    // Wet ink is drawn over the selection chrome (`render/overlay.ts`), and an
    // opaque mark has to cover it rather than blend with it.
    expect(calls.alphas).toEqual([1]);
    expect(calls.composites).toEqual(["source-over"]);
  });

  it("has nothing to draw from a press that has not moved", () => {
    expect(ink.draw(stubContext(), camera, stroke(straight(1)))).toBe(false);
    expect(calls.fills).toBe(0);
    expect(calls.points).toEqual([]);
  });
});

describe("where the stroke ends up on screen", () => {
  it("follows the camera, because the samples are board coordinates", () => {
    ink.draw(stubContext(), camera, stroke(straight(4)));
    const before = calls.points.map((p) => p[0]);

    calls.points = [];
    camera.panByBoard(500, 0);
    ink.draw(stubContext(), camera, stroke(straight(4)));
    const after = calls.points.map((p) => p[0]);

    // A stroke stored in screen pixels would sit still while the cork moved under
    // it — and the wheel still zooms while a pointer is down (`WetStroke`).
    expect(Math.min(...after)).toBeLessThan(Math.min(...before) - 400);
  });

  it("gets thicker as the board is zoomed in", () => {
    ink.draw(stubContext(), camera, stroke(straight(8)));
    const atActualSize = spreadY();

    calls.points = [];
    camera.setView(0, 0, 3);
    ink.draw(stubContext(), camera, stroke(straight(8)));

    // Ink is a mark *on* the paper, so its width is in board units and follows
    // the zoom. This is the opposite of `render/ropes/paint.ts`, whose widths are
    // a fixed number of screen pixels at every zoom — a string is an object in
    // front of the board rather than a mark on it. Getting the two the wrong way
    // round is invisible at 100% and wrong everywhere else.
    expect(spreadY()).toBeGreaterThan(atActualSize * 2.5);
  });
});

/**
 * AC-22 and AC-78, at the renderer's end of it. The tool stores a glued stroke in
 * the item's own coordinates (`state/tools/marker.ts`); this is the hop back out,
 * and it happens every frame precisely so that the paper moving takes the ink
 * with it.
 */
describe("a stroke glued to a photograph", () => {
  it("is drawn through the frame it is handed, not against the origin", () => {
    ink.draw(stubContext(), camera, stroke(straight(4)));
    const atOrigin = calls.points.map((p) => p[0]);

    calls.points = [];
    ink.draw(stubContext(), camera, glued(straight(4)), frame(600, 0));

    // The same local samples, a photograph 600 units to the right.
    expect(Math.min(...calls.points.map((p) => p[0]))).toBeGreaterThan(
      Math.min(...atOrigin) + 500,
    );
  });

  it("moves with the paper although not one sample changed", () => {
    const samples = straight(4);
    ink.draw(stubContext(), camera, glued(samples), frame(0, 0));
    const before = Math.min(...calls.points.map((p) => p[0]));

    calls.points = [];
    ink.draw(stubContext(), camera, glued(samples), frame(300, 0));

    // Which is the whole of the acceptance criterion: a photograph dragged out
    // from under a wet stroke takes the mark with it.
    expect(Math.min(...calls.points.map((p) => p[0]))).toBeCloseTo(before + 300, 0);
  });

  it("turns with the paper", () => {
    const samples = straight(4);
    // A horizontal stroke on a photograph stood on its end is a vertical one.
    ink.draw(stubContext(), camera, glued(samples), frame(0, 0, Math.PI / 2));

    const xs = calls.points.map((p) => p[0]);
    const ys = calls.points.map((p) => p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(
      Math.max(...xs) - Math.min(...xs),
    );
  });

  it("is not drawn at all when the paper has left the board", () => {
    // Null frame with an item named: the photograph went while the pen was down.
    // An identity transform would put the mark at the board origin, which is a
    // stroke appearing somewhere nobody drew.
    expect(ink.draw(stubContext(), camera, glued(straight(4)), null)).toBe(false);
    expect(calls.fills).toBe(0);
  });
});

describe("the reused screen-space buffer", () => {
  it("does not reach back to where the previous stroke ended", () => {
    // A long stroke fills the buffer out to 1000 board units...
    ink.draw(stubContext(), camera, stroke(straight(50)));
    calls.points = [];
    // ...and a short one after it must not inherit the tail.
    expect(ink.draw(stubContext(), camera, stroke(straight(3)))).toBe(true);

    const far = camera.boardToScreen(1000, 0).x;
    const reach = Math.max(...calls.points.map((p) => p[0]));
    expect(reach).toBeLessThan(far - 500);
  });

  it("grows again for a stroke that outruns the one before it", () => {
    ink.draw(stubContext(), camera, stroke(straight(3)));
    calls.points = [];
    expect(ink.draw(stubContext(), camera, stroke(straight(40)))).toBe(true);

    const far = camera.boardToScreen(39 * 20, 0).x;
    expect(Math.max(...calls.points.map((p) => p[0]))).toBeGreaterThan(far - 40);
  });
});

/**
 * T-136, the wet half. A stroke that appeared over the cork while the button was
 * held and then vanished at the release would be a worse lie than either half
 * alone, so the live stroke is clipped to the same paper the committed one is.
 */
describe("the edge of the paper, while the pen is still down", () => {
  it("clips a glued stroke to the item's four corners", () => {
    camera.setView(0, 0, 1);
    ink.draw(stubContext(), camera, glued(straight(4)), frame(0, 0, 0, 50, 30));

    expect(calls.clips).toBe(1);
    // Four corners of a 100x60 sheet, in screen space, at 1:1 with the camera at
    // the origin — the same conversion the samples went through.
    const xs = calls.lines.map((p) => p[0]);
    const ys = calls.lines.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100, 3);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(60, 3);
  });

  it("turns the clip with the paper", () => {
    camera.setView(0, 0, 1);
    ink.draw(stubContext(), camera, glued(straight(4)), frame(0, 0, Math.PI / 2, 50, 30));

    // A quarter turn swaps the extents. A clip that stayed axis-aligned would
    // cut a turned photograph's ink off along the wrong edges — which looks like
    // ink missing from the middle of the paper rather than like a clip.
    const xs = calls.lines.map((p) => p[0]);
    const ys = calls.lines.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(60, 3);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(100, 3);
  });

  it("grows the clip with the zoom, like everything else on this canvas", () => {
    camera.setView(0, 0, 2);
    ink.draw(stubContext(), camera, glued(straight(4)), frame(0, 0, 0, 50, 30));
    const xs = calls.lines.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(200, 3);
  });

  it("does not clip a board-space stroke, which has no paper to run off", () => {
    ink.draw(stubContext(), camera, stroke(straight(4)));
    // Bare cork is not an item and has no edge. The dry half agrees — a board-ink
    // tile paints with no clip at all (T-61) — so the mark does not change shape
    // at the moment it lands.
    expect(calls.clips).toBe(0);
    expect(calls.lines).toEqual([]);
  });
});
