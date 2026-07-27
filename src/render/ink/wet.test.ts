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
import { WetInk } from "@/render/ink/wet";
import { Camera } from "@/state/camera";

interface Calls {
  /** Every point the path was told about, control points included. */
  points: Array<[number, number]>;
  fills: number;
  /** Anything that would make this a stroked line rather than a filled shape. */
  forbidden: string[];
  fillStyles: string[];
}

let calls: Calls;
let camera: Camera;
let ink: WetInk;

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
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    fill: () => {
      calls.fills++;
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
  return { tool: "highlighter", color: "#1f1b17", size, samples };
}

function spreadY(): number {
  const ys = calls.points.map((p) => p[1]);
  return Math.max(...ys) - Math.min(...ys);
}

beforeEach(() => {
  calls = { points: [], fills: 0, forbidden: [], fillStyles: [] };
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
