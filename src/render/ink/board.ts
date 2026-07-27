/**
 * Ink on the bare cork — one canvas per 2048-unit tile, under everything.
 *
 * > **`boardInk` is tiled** into 2048-unit cells... Tiles give culling, observer
 * > granularity and future lazy loading a natural unit. — DATA-MODEL section 2
 *
 * This is the culling half of that sentence, and it is the reason board ink is
 * not simply one enormous canvas: a board has no edges, so there is no "whole"
 * to allocate. What there is instead is a handful of buckets somebody has drawn
 * in, of which the ones on screen get a bitmap and the rest get nothing.
 *
 * ## A tile is a canvas in the world, not a screen-space layer
 *
 * It follows `render/ink/canvas.ts`, not `render/ropes/paint.ts`. The host div
 * carries the camera transform, so a tile's canvas is placed once in board
 * coordinates and then panned and zoomed by the browser — no per-point camera
 * arithmetic, and nothing to redraw when the camera moves. A screen-space canvas
 * redrawn every frame would be simpler today and would throw the tiling away:
 * there would be no unit left to mount, evict or lazily load.
 *
 * The cost is the one every DOM-scaled surface on this board pays — a promoted
 * layer rasterises at its pre-scale resolution — and it is paid the same way, by
 * `render/world.ts` dropping `will-change` on a debounced gesture end and
 * telling everything holding a bitmap to re-raster at `devicePixelRatio * zoom`.
 *
 * ## What is mounted is a question about ink, not about the lattice
 *
 * The obvious implementation walks the viewport corners, turns them into tile
 * keys and mounts that rectangle of cells. This walks the tiles that *have ink*
 * instead and tests each one's own box. Two reasons, and the second is the real
 * one:
 *
 * - The lattice is unbounded and mostly empty. At the zoom floor the viewport
 *   spans a couple of hundred cells, essentially all of which are blank.
 * - A stroke is filed by its bounding-box **centre**, so it can hang up to half
 *   its own length outside the cell it is filed under. Culling by the cell would
 *   drop a long stroke a moment before it left the screen, and — worse — mount a
 *   cell whose ink is nowhere near the viewport. The tile's ink box is the
 *   honest rectangle and `state/scene.ts` already measures it.
 *
 * So there is no spatial index here and there should not be one. `render/cull.ts`
 * has a grid because items are numerous and move; a bucket of dried ink is
 * neither.
 */

import { ENTER_MARGIN, LEAVE_MARGIN } from "@/render/cull";
import { InkCanvas } from "@/render/ink/canvas";
import type { Bounds, Camera } from "@/state/camera";
import type { DirtySets } from "@/state/dirty";
import type { BoardInkTile, Scene } from "@/state/scene";

/**
 * Tiles rastered per frame, and it is the same number and the same argument as
 * `render/items/dom.ts`'s: a debounced gesture end raises `dirty.all`, and
 * without a cap one zoom-end reallocates and repaints every canvas on screen
 * inside a single frame. The tiles not reached keep the bitmap they have and it
 * stretches, which is what DESIGN section 9.3 asks for in the interim.
 *
 * Lower than the items' three would be defensible — a tile is up to 2048 units
 * across and its repaint is the largest single raster on the board — but the
 * region is sized to the ink rather than to the cell, so the typical tile is far
 * smaller than that and the two are the same kind of work.
 */
const MAX_RASTERS_PER_FRAME = 3;

export class BoardInkLayer {
  private readonly host: HTMLElement;
  private readonly tiles = new Map<string, InkCanvas>();
  /**
   * Tiles whose bitmap is behind their strokes, waiting for the INK phase.
   *
   * This layer's, not the dirty sets': `dirty.boardInk` is cleared at the end of
   * every frame and a re-raster deliberately may not finish in one — see
   * [`MAX_RASTERS_PER_FRAME`].
   */
  private readonly pending = new Set<string>();
  /** `devicePixelRatio * zoom`, from `World.onRasterize`. 1 until told, which is
   *  wrong in the cheap direction — see `render/items/dom.ts`. */
  private rasterScale = 1;
  /** Reused across frames: two rectangles asked for once per call. */
  private readonly enter: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly leave: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  constructor(host: HTMLElement) {
    this.host = host;
  }

  /** Live bitmaps, for the dev HUD — the same number `DomItemLayer.inked` is,
   *  and counted for the same reason: eviction made watchable. */
  get mounted(): number {
    return this.tiles.size;
  }

  /** Device pixels currently held by board ink. */
  get pixels(): number {
    let n = 0;
    for (const canvas of this.tiles.values()) n += canvas.pixels;
    return n;
  }

  /**
   * Is this tile's canvas still behind its strokes?
   *
   * The cork's half of `DomItemLayer.awaitingInk`, and it answers the same
   * question for the same caller: the marker goes on drawing a committed stroke
   * on the overlay until the bitmap it landed in has caught up, and a pen-up
   * that stopped before then would blink.
   *
   * False for a tile that is not mounted — nothing is going to appear where it
   * is, so nothing is worth waiting for. That is a real case here in a way it
   * barely is for items: draw on the cork, pan the mark off screen inside a
   * frame or two, and the canvas is never created at all.
   */
  awaitingTile(key: string): boolean {
    return this.pending.has(key) && this.tiles.has(key);
  }

  /** Arrives from `World.onRasterize` on the debounced gesture end. */
  setRasterScale(scale: number): void {
    if (Number.isFinite(scale) && scale > 0) this.rasterScale = scale;
  }

  /**
   * INK phase (6). Mount what is on screen, evict what is not, and re-raster a
   * few of what changed.
   *
   * Mounting and rastering in one call rather than split across the CULL and INK
   * phases the way items are. An item's mount is a DOM node with a transform
   * that the DOM phase has to write; a tile's is a canvas that is already in
   * board coordinates and needs nothing written to it, so there is no second
   * phase for it to be waiting on and splitting would buy an ordering hazard.
   */
  paint(scene: Scene, dirty: DirtySets, camera: Camera): void {
    // Nothing moved and nothing was drawn: the mounted set cannot have changed
    // and neither can any bitmap. This is what keeps an idle board free.
    if (dirty.camera || dirty.all || dirty.boardInk.size > 0) {
      this.remount(scene, camera);
    }

    if (dirty.all) {
      for (const key of this.tiles.keys()) this.pending.add(key);
    } else {
      for (const key of dirty.boardInk) if (this.tiles.has(key)) this.pending.add(key);
    }
    if (this.pending.size === 0) return;

    let budget = MAX_RASTERS_PER_FRAME;
    for (const key of this.pending) {
      if (budget === 0) break;
      this.pending.delete(key);
      const canvas = this.tiles.get(key);
      const tile = scene.boardInkTile(key);
      if (!canvas || !tile) continue;
      // Null paper: the cork has no edge for a pen to stop at, and a tile is a
      // bucket rather than a frame — see `paintStrokes`.
      canvas.update(tile.strokes, this.rasterScale, null);
      budget--;
    }
  }

  /**
   * Bring the mounted set in line with the viewport.
   *
   * Hysteresis, exactly as `render/cull.ts` does it and for the same reason: a
   * tile sitting on the boundary would otherwise mount and unmount on alternate
   * frames, and a mount here is a canvas allocation and a full repaint — the
   * cost this whole file exists to avoid paying twice.
   */
  private remount(scene: Scene, camera: Camera): void {
    camera.visibleBounds(ENTER_MARGIN, this.enter);
    camera.visibleBounds(LEAVE_MARGIN, this.leave);

    for (const [key, canvas] of this.tiles) {
      const tile = scene.boardInkTile(key);
      // A tile that has gone is the undo of the last stroke in a cell. It goes
      // now rather than at the edge of the viewport: there is nothing left for
      // the bitmap to be a cache of.
      if (tile && overlaps(tile.bbox, this.leave)) continue;
      canvas.release();
      this.tiles.delete(key);
      this.pending.delete(key);
    }

    for (const tile of scene.boardInkTiles()) {
      if (this.tiles.has(tile.key)) continue;
      if (!overlaps(tile.bbox, this.enter)) continue;
      this.tiles.set(tile.key, new InkCanvas(this.host, "board-ink"));
      this.pending.add(tile.key);
    }
  }

}

/** Does a tile's ink box touch a board rectangle? */
function overlaps(bbox: BoardInkTile["bbox"], rect: Bounds): boolean {
  return (
    bbox[0] <= rect.maxX && bbox[2] >= rect.minX && bbox[1] <= rect.maxY && bbox[3] >= rect.minY
  );
}
