import { describe, expect, it } from "vitest";

import { Camera, MAX_ZOOM, MIN_ZOOM } from "@/state/camera";

function viewport(width = 1440, height = 900): Camera {
  const camera = new Camera();
  camera.resize(width, height);
  return camera;
}

describe("Camera", () => {
  it("round-trips screen and board coordinates at any zoom", () => {
    const camera = viewport();
    for (const zoom of [MIN_ZOOM, 0.37, 1, 2.5, MAX_ZOOM]) {
      camera.zoomTo(zoom, 700, 400);
      for (const [sx, sy] of [
        [0, 0],
        [1, 1],
        [719.5, 449.25],
        [1440, 900],
      ]) {
        const board = camera.screenToBoard(sx!, sy!);
        const back = camera.boardToScreen(board.x, board.y);
        expect(back.x).toBeCloseTo(sx!, 9);
        expect(back.y).toBeCloseTo(sy!, 9);
      }
    }
  });

  it("keeps the board point under the cursor fixed while zooming", () => {
    const camera = viewport();
    camera.panByBoard(137, -412);
    const cursor = { x: 512, y: 331 };
    const before = camera.screenToBoard(cursor.x, cursor.y);
    camera.zoomBy(2.4, cursor.x, cursor.y);
    const after = camera.screenToBoard(cursor.x, cursor.y);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("clamps zoom to the 5%-400% range", () => {
    const camera = viewport();
    camera.zoomTo(1000, 0, 0);
    expect(camera.zoom).toBe(MAX_ZOOM);
    camera.zoomTo(0.00001, 0, 0);
    expect(camera.zoom).toBe(MIN_ZOOM);
  });

  it("does not bump the version when nothing changed", () => {
    const camera = viewport();
    camera.zoomTo(MAX_ZOOM, 0, 0);
    const version = camera.version;
    camera.zoomTo(MAX_ZOOM * 4, 0, 0); // clamps to the value already set
    camera.panByScreen(0, 0);
    camera.resize(1440, 900);
    expect(camera.version).toBe(version);
  });

  it("refuses non-finite input rather than poisoning the transform", () => {
    const camera = viewport();
    const version = camera.version;
    camera.zoomTo(Number.NaN, 10, 10);
    camera.zoomTo(2, Number.NaN, 10);
    camera.zoomTo(Number.POSITIVE_INFINITY, 10, 10);
    camera.panByScreen(Number.NaN, 0);
    camera.panByBoard(0, Number.NaN);
    expect(camera.zoom).toBe(1);
    expect(camera.x).toBe(0);
    expect(camera.y).toBe(0);
    expect(camera.version).toBe(version);
  });

  it("pans the surface with the cursor, so the camera moves the other way", () => {
    const camera = viewport();
    camera.zoomTo(2, 0, 0);
    camera.x = 0;
    camera.y = 0;
    camera.panByScreen(100, 50); // dragged the board right and down
    expect(camera.x).toBe(-50); // 100 screen px at 2x is 50 board units
    expect(camera.y).toBe(-25);
  });

  it("centres and frames", () => {
    const camera = viewport(1000, 500);
    camera.centreOn(300, -200);
    const centre = camera.screenToBoard(500, 250);
    expect(centre.x).toBeCloseTo(300, 9);
    expect(centre.y).toBeCloseTo(-200, 9);

    camera.fit({ minX: 0, minY: 0, maxX: 400, maxY: 400 }, 50);
    // 400 board units into 400 usable screen px (500 - 2*50) => 1x.
    expect(camera.zoom).toBeCloseTo(1, 9);
    const framed = camera.screenToBoard(500, 250);
    expect(framed.x).toBeCloseTo(200, 9);
    expect(framed.y).toBeCloseTo(200, 9);
  });

  it("reports visible bounds with a margin expressed as a fraction", () => {
    const camera = viewport(1000, 500);
    camera.x = 0;
    camera.y = 0;
    camera.zoom = 1;
    expect(camera.visibleBounds()).toEqual({ minX: 0, minY: 0, maxX: 1000, maxY: 500 });
    expect(camera.visibleBounds(0.2)).toEqual({
      minX: -200,
      minY: -100,
      maxX: 1200,
      maxY: 600,
    });
  });
});
