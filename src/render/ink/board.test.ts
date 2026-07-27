/**
 * @vitest-environment happy-dom
 *
 * The board-ink layer: what is mounted, what is evicted, and how much of it is
 * allowed to happen in one frame.
 *
 * happy-dom returns null from `getContext("2d")`, so nothing here rasterises —
 * which is the point. The part of this file that can be wrong by a rectangle and
 * still look right is the culling, and that is exactly the part that survives
 * without a canvas: the element is created, sized and placed either way.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { BoardInkLayer } from "@/render/ink/board";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene, type SceneStroke } from "@/state/scene";

let host: HTMLDivElement;
let scene: Scene;
let dirty: DirtySets;
let camera: Camera;
let layer: BoardInkLayer;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  scene = new Scene();
  dirty = new DirtySets();
  camera = new Camera();
  // A 1000x800 viewport at 100%, so the enter rectangle round the origin runs
  // -200..1200 by -160..960 and the numbers below are readable.
  camera.resize(1000, 800);
  layer = new BoardInkLayer(host);
});

/** One short stroke, at `(cx, cy)`, put straight into the mirror. The document
 *  half is `crdt/ink.binding.test.ts`; this file starts from the scene. */
function ink(key: string, cx: number, cy: number, count = 1): void {
  const strokes: SceneStroke[] = [];
  for (let i = 0; i < count; i++) {
    strokes.push({
      id: `${key}-${i}`,
      tool: "marker",
      color: "#000",
      size: 6,
      opacity: 1,
      seed: 1,
      z: `a${i}`,
      bbox: [cx - 20, cy - 20, cx + 20, cy + 20],
      samples: [
        { x: cx - 20, y: cy - 20, pressure: 0.5 },
        { x: cx + 20, y: cy + 20, pressure: 0.5 },
      ],
    });
  }
  scene.putBoardStrokes(key, strokes);
  dirty.boardInkFor(key);
}

describe("what is mounted", () => {
  it("gives a canvas to a tile on screen and nothing to one that is not", () => {
    ink("0,0", 500, 400);
    ink("4,4", 9000, 9000);
    layer.paint(scene, dirty, camera);

    expect(layer.mounted).toBe(1);
    expect(host.children.length).toBe(1);
    expect((host.children[0] as HTMLElement).className).toBe("board-ink");
  });

  it("does nothing at all when nothing moved and nothing was drawn", () => {
    ink("0,0", 500, 400);
    layer.paint(scene, dirty, camera);
    dirty.clear();

    // The tile leaves the scene, but no flag says so. An idle board must not be
    // re-culled on the off chance.
    scene.putBoardStrokes("0,0", []);
    layer.paint(scene, dirty, camera);
    expect(layer.mounted).toBe(1);

    dirty.camera = true;
    layer.paint(scene, dirty, camera);
    expect(layer.mounted).toBe(0);
  });

  it("mounts a tile that comes into view when the camera moves", () => {
    ink("1,1", 3000, 3000);
    layer.paint(scene, dirty, camera);
    expect(layer.mounted).toBe(0);
    dirty.clear();

    camera.x = 2800;
    camera.y = 2800;
    dirty.camera = true;
    layer.paint(scene, dirty, camera);
    expect(layer.mounted).toBe(1);
  });

  /**
   * The hysteresis band, and it is the reason the two margins exist: a tile
   * sitting on the boundary would otherwise mount and unmount on alternate
   * frames, and a mount here is an allocation plus a full repaint.
   */
  it("keeps a tile mounted past the edge it mounted at", () => {
    ink("0,0", 500, 400);
    layer.paint(scene, dirty, camera);
    expect(layer.mounted).toBe(1);
    dirty.clear();

    // Far enough that the tile is outside the 20% enter rectangle — it would
    // not mount from here — but still inside the 30% leave one.
    camera.x = -800;
    dirty.camera = true;
    layer.paint(scene, dirty, camera);
    expect(layer.mounted).toBe(1);

    // And now past the leave edge as well.
    camera.x = -900;
    dirty.camera = true;
    layer.paint(scene, dirty, camera);
    expect(layer.mounted).toBe(0);
    expect(host.children.length).toBe(0);
  });

  /**
   * A stroke is filed by its bounding-box *centre*, so a long one hangs outside
   * the cell it is filed under. Culling by the cell would drop it early; the
   * tile's own ink box is the honest rectangle.
   */
  it("culls by the tile's ink, not by its cell", () => {
    // Filed under cell (1,1) — centre (3000, 3000) — but the ink itself reaches
    // back into the viewport at the origin.
    scene.putBoardStrokes("1,1", [
      {
        id: "long",
        tool: "marker",
        color: "#000",
        size: 6,
        opacity: 1,
        seed: 1,
        z: "a0",
        bbox: [500, 500, 5500, 5500],
        samples: [
          { x: 500, y: 500, pressure: 0.5 },
          { x: 5500, y: 5500, pressure: 0.5 },
        ],
      },
    ]);
    dirty.boardInkFor("1,1");
    layer.paint(scene, dirty, camera);
    expect(layer.mounted).toBe(1);
  });

  it("drops a tile whose last stroke was undone, wherever the camera is", () => {
    ink("0,0", 500, 400);
    layer.paint(scene, dirty, camera);
    dirty.clear();

    scene.putBoardStrokes("0,0", []);
    dirty.boardInkFor("0,0");
    layer.paint(scene, dirty, camera);
    expect(layer.mounted).toBe(0);
    expect(host.children.length).toBe(0);
  });
});

describe("the raster budget", () => {
  /**
   * `world.onRasterize` raises `dirty.all`, so without a cap one zoom-end
   * repaints every canvas on screen inside a single frame — the shape of the
   * 777 ms frame D-12 measured.
   */
  it("re-rasters at most three tiles in a frame and finishes on later ones", () => {
    for (let i = 0; i < 5; i++) ink(`0,${i}`, 100 + i * 40, 400);
    layer.paint(scene, dirty, camera);
    expect(layer.mounted).toBe(5);
    // Five mounted, three rastered — two are still waiting.
    expect([0, 1, 2, 3, 4].filter((i) => layer.awaitingTile(`0,${i}`))).toHaveLength(2);

    // The queue is this layer's and survives the frame that raised it, so the
    // next frame finishes the job without anything having to say so again.
    dirty.clear();
    layer.paint(scene, dirty, camera);
    expect([0, 1, 2, 3, 4].filter((i) => layer.awaitingTile(`0,${i}`))).toHaveLength(0);
  });

  it("does not claim to be waiting for a tile that is not mounted", () => {
    ink("4,4", 9000, 9000);
    layer.paint(scene, dirty, camera);
    // Drawn off screen: no canvas was ever created, so nothing is coming and the
    // wet copy of the stroke must not be held up waiting for it.
    expect(layer.awaitingTile("4,4")).toBe(false);
  });
});

/**
 * A smudge is filed by its own bounding-box centre like every other stroke, so
 * the bucket it lands in is not necessarily the bucket holding the ink it takes
 * away. `destination-out` only removes what is on the *same* canvas, so a hole
 * painted on the wrong bitmap is no hole at all — and the failure is silent: the
 * mark is still there and the rubber was plainly on top of it.
 */
describe("a smudge that lands in a different tile from the ink it rubs", () => {
  /** A run along y = 0, of whichever tool the caller wants. */
  function run(id: string, tool: string, x0: number, x1: number): SceneStroke {
    return {
      id,
      tool,
      color: "#000",
      size: 6,
      opacity: 1,
      seed: 1,
      z: tool === "erase" ? "a9" : "a0",
      bbox: [x0, 0, x1, 0],
      samples: [
        { x: x0, y: 0, pressure: 0.5 },
        { x: x1, y: 0, pressure: 0.5 },
      ],
    };
  }

  const smudge = (id: string, x0: number, x1: number): SceneStroke => run(id, "erase", x0, x1);
  const mark = (x0: number, x1: number): SceneStroke => run("m", "marker", x0, x1);

  function widthOfFirstTile(): number {
    return (host.children[0] as HTMLCanvasElement).width;
  }

  it("paints the foreign smudge onto the tile whose ink it overlaps", () => {
    scene.putBoardStrokes("0,0", [mark(100, 140)]);
    dirty.boardInkFor("0,0");
    layer.setRasterScale(1);
    layer.paint(scene, dirty, camera);
    const alone = widthOfFirstTile();

    // A rub filed in the next cell along, reaching back across this tile's ink.
    scene.putBoardStrokes("1,0", [smudge("rub", 120, 900)]);
    dirty.clear();
    dirty.boardInkFor("1,0");
    layer.paint(scene, dirty, camera);

    // The tile's canvas grew to hold a stroke that is not filed in it, which is
    // only possible if the smudge reached its paint list.
    expect(widthOfFirstTile()).toBeGreaterThan(alone);
  });

  it("ignores a smudge that reaches nowhere near", () => {
    scene.putBoardStrokes("0,0", [mark(100, 140)]);
    dirty.boardInkFor("0,0");
    layer.setRasterScale(1);
    layer.paint(scene, dirty, camera);
    const alone = widthOfFirstTile();

    scene.putBoardStrokes("1,0", [smudge("far", 600, 900)]);
    dirty.clear();
    dirty.boardInkFor("1,0");
    layer.paint(scene, dirty, camera);

    expect(widthOfFirstTile()).toBe(alone);
  });

  /** Which is why a change to *any* tile re-rasters every mounted one: the tile
   *  that has to change is not the tile whose key is in the dirty set. */
  it("queues every mounted tile when any one of them changed", () => {
    for (let i = 0; i < 4; i++) ink(`0,${i}`, 100 + i * 60, 400);
    // Drain the mount queue: four tiles, three per frame.
    layer.paint(scene, dirty, camera);
    dirty.clear();
    layer.paint(scene, dirty, camera);
    expect([0, 1, 2, 3].filter((i) => layer.awaitingTile(`0,${i}`))).toHaveLength(0);

    // One tile named. Queue only that one and the budget of three covers it;
    // queue all four and one is left over — which is what says all four went in.
    dirty.boardInkFor("0,0");
    layer.paint(scene, dirty, camera);
    expect([0, 1, 2, 3].filter((i) => layer.awaitingTile(`0,${i}`))).toHaveLength(1);
  });
});

describe("the backing store", () => {
  it("is sized to the ink and not to the 2048-unit cell", () => {
    ink("0,0", 500, 400);
    layer.setRasterScale(1);
    layer.paint(scene, dirty, camera);

    const canvas = host.children[0] as HTMLCanvasElement;
    // 40 units of ink plus a nib either side, rounded to a power of two — a
    // canvas sized to the tile would be 2048.
    expect(canvas.width).toBeLessThanOrEqual(128);
    expect(canvas.width).toBeGreaterThan(0);
    expect(layer.pixels).toBe(canvas.width * canvas.height);
  });

  it("places the canvas in board coordinates, not tile-relative ones", () => {
    ink("0,0", 500, 400);
    layer.setRasterScale(1);
    layer.paint(scene, dirty, camera);

    const canvas = host.children[0] as HTMLCanvasElement;
    // The host carries the camera transform and its origin is the board's, so
    // the margins are board units straight through.
    expect(parseFloat(canvas.style.marginLeft)).toBeGreaterThan(440);
    expect(parseFloat(canvas.style.marginLeft)).toBeLessThan(490);
    expect(parseFloat(canvas.style.marginTop)).toBeGreaterThan(340);
    expect(parseFloat(canvas.style.marginTop)).toBeLessThan(390);
  });

  it("spends more pixels on the same ink at a higher raster scale", () => {
    ink("0,0", 500, 400);
    layer.setRasterScale(1);
    layer.paint(scene, dirty, camera);
    const before = layer.pixels;

    layer.setRasterScale(4);
    dirty.clear();
    dirty.all = true;
    layer.paint(scene, dirty, camera);
    expect(layer.pixels).toBeGreaterThan(before);
  });
});
