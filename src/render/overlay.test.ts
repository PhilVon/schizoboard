/**
 * @vitest-environment happy-dom
 *
 * happy-dom has no 2D context, so one is stubbed. That is not a limitation
 * here: what is worth pinning down is *when* the overlay touches the canvas at
 * all, and the calls it makes when it does — both of which are countable.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { Overlay } from "@/render/overlay";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene, type ItemCold, type ItemPose } from "@/state/scene";
import { Selection } from "@/state/selection";

interface Calls {
  clearRect: number;
  fillRect: [number, number, number, number][];
  strokeRect: [number, number, number, number][];
  rotate: number[];
  translate: [number, number][];
  lineWidths: number[];
}

let calls: Calls;
let camera: Camera;
let scene: Scene;
let selection: Selection;
let dirty: DirtySets;
let overlay: Overlay;

function stubCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 800;
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    translate: (...args: [number, number]) => calls.translate.push(args),
    rotate: (angle: number) => calls.rotate.push(angle),
    clearRect: () => {
      calls.clearRect++;
    },
    fillRect: (...args: [number, number, number, number]) => calls.fillRect.push(args),
    strokeRect: (...args: [number, number, number, number]) => {
      calls.strokeRect.push(args);
      calls.lineWidths.push(ctx.lineWidth);
    },
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
  };
  canvas.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
  return canvas;
}

/** Centred on the origin, so screen coordinates come out of the camera alone. */
function add(id: string, pose: Partial<ItemPose> = {}, cold: Partial<ItemCold> = {}): void {
  scene.putItem(
    {
      id,
      type: "polaroid",
      z: "a0",
      seed: 1,
      assetId: null,
      createdBy: 1,
      createdAt: 0,
      text: "",
      ...cold,
    },
    { x: 0, y: 0, rot: 0, w: 100, h: 100, ...pose },
  );
}

/** One frame of the OVERLAY phase, with the marquee off unless asked for. */
function frame(marquee: Parameters<Overlay["draw"]>[3] = null): void {
  overlay.draw(camera, scene, selection, marquee, dirty);
}

beforeEach(() => {
  calls = { clearRect: 0, fillRect: [], strokeRect: [], rotate: [], translate: [], lineWidths: [] };
  camera = new Camera();
  camera.resize(1000, 800);
  scene = new Scene();
  selection = new Selection();
  dirty = new DirtySets();
  overlay = new Overlay(stubCanvas());
});

describe("Overlay", () => {
  it("costs nothing on a frame with nothing to draw", () => {
    frame();
    frame();
    expect(calls.clearRect).toBe(0);
  });

  it("draws the marquee through the camera, in screen space", () => {
    camera.zoomTo(2, 0, 0);
    frame({ minX: 10, minY: 20, maxX: 110, maxY: 70 });
    expect(calls.fillRect).toEqual([[20, 40, 200, 100]]);
    expect(calls.strokeRect).toHaveLength(1);
  });

  it("clears the frame after the marquee goes, and then stops", () => {
    frame({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(calls.clearRect).toBe(1);

    // One clear to take the marquee away...
    frame();
    expect(calls.clearRect).toBe(2);
    // ...and none at all after that.
    frame();
    expect(calls.clearRect).toBe(2);
  });

  /**
   * AC-140, and the reason the chrome moved off the item's own DOM. As a CSS
   * outline its 1.5px was 1.5 *board* units: 0.075 screen pixels at the 5% floor
   * and 6 at the 400% ceiling.
   */
  it("holds its width and its offset in screen pixels across the whole zoom range", () => {
    add("a");
    selection.add("a");
    camera.centreOn(0, 0);

    const padAt = (zoom: number): number => {
      calls.strokeRect.length = 0;
      calls.lineWidths.length = 0;
      camera.zoomTo(zoom, 500, 400);
      frame();
      const [x, , w] = calls.strokeRect[0]!;
      expect(calls.lineWidths[0]).toBe(1.5);
      // The item is 100 units wide, so whatever the stroke is wider than
      // `100 * zoom` is the offset, in screen pixels, twice over.
      expect(w).toBeCloseTo(-2 * x, 6);
      return (w - 100 * zoom) / 2;
    };

    expect(padAt(0.05)).toBeCloseTo(3.25, 6);
    expect(padAt(1)).toBeCloseTo(3.25, 6);
    expect(padAt(4)).toBeCloseTo(3.25, 6);
  });

  it("rides the angle the item is actually drawn at, swing and all", () => {
    add("a", { rot: 0.2 });
    scene.swing[scene.slotOf("a")!] = 0.05;
    selection.add("a");
    frame();
    // Approximate because the scene stores Float32 — 0.2 + 0.05 comes back as
    // 0.2500000037, which is three billionths of a radian.
    expect(calls.rotate).toHaveLength(1);
    expect(calls.rotate[0]).toBeCloseTo(0.25, 6);
  });

  it("grows with the carry, so a photograph being dragged keeps its outline", () => {
    add("a");
    selection.add("a");
    frame();
    const resting = calls.strokeRect[0]![2];

    calls.strokeRect.length = 0;
    scene.lift[scene.slotOf("a")!] = 1;
    dirty.item("a");
    frame();
    // 2% of 100 units at zoom 1, and the offset is unchanged either side of it.
    expect(calls.strokeRect[0]![2]).toBeCloseTo(resting + 2, 6);
  });

  it("does not redraw an idle board just because something is selected", () => {
    add("a");
    selection.add("a");
    frame();
    expect(calls.clearRect).toBe(1);

    // Nothing has moved, nothing has been selected or deselected, and the camera
    // is where it was. Redrawing would reach the identical picture.
    frame();
    frame();
    expect(calls.clearRect).toBe(1);

    // A selected item under a drag is exactly what makes it stale again.
    dirty.item("a");
    frame();
    expect(calls.clearRect).toBe(2);
    // As is a pan, because the chrome is in screen space.
    dirty.clear();
    camera.panByScreen(10, 0);
    frame();
    expect(calls.clearRect).toBe(3);
  });

  it("ignores an item that moved but is not selected", () => {
    add("a");
    add("b");
    selection.add("a");
    frame();
    dirty.item("b");
    frame();
    expect(calls.clearRect).toBe(1);
  });

  it("leaves nothing behind when the selection is cleared", () => {
    add("a");
    selection.add("a");
    frame();
    expect(calls.strokeRect).toHaveLength(1);

    calls.strokeRect.length = 0;
    selection.clear();
    frame();
    expect(calls.clearRect).toBe(2);
    expect(calls.strokeRect).toHaveLength(0);
  });

  it("does not clear a blank canvas to arrive at a blank canvas", () => {
    // A selection entirely off screen is stale on every frame of a pan and draws
    // nothing on any of them, so the clear has to be deferred until something is
    // actually about to be drawn.
    add("far", { x: 100_000, y: 100_000 });
    selection.add("far");
    camera.centreOn(0, 0);
    frame();
    camera.panByScreen(10, 0);
    frame();
    camera.panByScreen(10, 0);
    frame();
    expect(calls.clearRect).toBe(0);
    expect(calls.strokeRect).toHaveLength(0);
  });

  it("skips a selected item the viewport cannot see", () => {
    // Selection is not culled — a marquee can take in the whole board — so
    // whether an off-screen one costs a stroke is this module's decision.
    add("near");
    add("far", { x: 100_000, y: 100_000 });
    selection.replace(["near", "far"]);
    camera.centreOn(0, 0);
    frame();
    expect(calls.strokeRect).toHaveLength(1);
  });

  it("survives a selection holding an item a collaborator deleted", () => {
    add("a");
    selection.add("a");
    frame();

    scene.removeItem("a");
    dirty.item("a");
    // `Selection.prune` clears the ghost, but not before this frame draws.
    expect(() => frame()).not.toThrow();
    expect(calls.strokeRect).toHaveLength(1);
  });
});
