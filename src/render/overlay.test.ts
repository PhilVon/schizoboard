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

interface Calls {
  clearRect: number;
  fillRect: [number, number, number, number][];
  strokeRect: [number, number, number, number][];
}

let calls: Calls;
let camera: Camera;
let overlay: Overlay;

function stubCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 800;
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    clearRect: () => {
      calls.clearRect++;
    },
    fillRect: (...args: [number, number, number, number]) => calls.fillRect.push(args),
    strokeRect: (...args: [number, number, number, number]) => calls.strokeRect.push(args),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
  };
  canvas.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
  return canvas;
}

beforeEach(() => {
  calls = { clearRect: 0, fillRect: [], strokeRect: [] };
  camera = new Camera();
  camera.resize(1000, 800);
  overlay = new Overlay(stubCanvas());
});

describe("Overlay", () => {
  it("costs nothing on a frame with nothing to draw", () => {
    overlay.draw(camera, null);
    overlay.draw(camera, null);
    expect(calls.clearRect).toBe(0);
  });

  it("draws the marquee through the camera, in screen space", () => {
    camera.zoomTo(2, 0, 0);
    overlay.draw(camera, { minX: 10, minY: 20, maxX: 110, maxY: 70 });
    expect(calls.fillRect).toEqual([[20, 40, 200, 100]]);
    expect(calls.strokeRect).toHaveLength(1);
  });

  it("clears the frame after the marquee goes, and then stops", () => {
    overlay.draw(camera, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(calls.clearRect).toBe(1);

    // One clear to take the marquee away...
    overlay.draw(camera, null);
    expect(calls.clearRect).toBe(2);
    // ...and none at all after that.
    overlay.draw(camera, null);
    expect(calls.clearRect).toBe(2);
  });
});
