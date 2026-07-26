/**
 * The overlay canvas — phase 8.
 *
 * > 8. OVERLAY   remote cursors, ghosts, wet ink, selection chrome
 * > — docs/ARCHITECTURE.md section 3
 *
 * Everything drawn here is transient: it belongs to a gesture or to a
 * collaborator, never to the document. The canvas is cleared and redrawn whole
 * each frame it has anything on it, which is affordable precisely because it is
 * empty almost all of the time — and free when it is, because a frame with
 * nothing to draw and nothing left over from last frame does not touch it.
 *
 * Screen space, like the rope canvases: points are converted through the camera
 * at draw time rather than the canvas being transformed. That is what keeps a
 * one-pixel line one pixel wide at 400% zoom.
 *
 * Selection *chrome on items* is not here — an outline that has to rotate with
 * a tilted polaroid belongs to the item's own node, and `ItemLayer.setSelected`
 * puts it there. What is here is the chrome that belongs to no item: the
 * marquee.
 */

import type { Bounds, Camera, Vec2 } from "@/state/camera";

/** Warm, like everything else on this board; matches the item outline. */
const MARQUEE_FILL = "rgba(255, 244, 214, 0.10)";
const MARQUEE_STROKE = "rgba(255, 244, 214, 0.85)";

export class Overlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  /** Did the previous frame leave anything behind that needs clearing? */
  private inked = false;
  /** Reused; `boardToScreen` allocates otherwise, and this runs per frame. */
  private readonly a: Vec2 = { x: 0, y: 0 };
  private readonly b: Vec2 = { x: 0, y: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
  }

  /**
   * OVERLAY phase. `marquee` is in board coordinates so it stays pinned to the
   * cork if the camera moves while it is being dragged out.
   */
  draw(camera: Camera, marquee: Bounds | null): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!marquee && !this.inked) return;

    // The context is pre-scaled by devicePixelRatio (world.resizeCanvases), so
    // every coordinate below is in CSS pixels — except the clear, which is
    // taken back to the identity so it covers the backing store exactly rather
    // than relying on this module knowing what the scale was.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    this.inked = false;
    if (!marquee) return;

    const a = camera.boardToScreen(marquee.minX, marquee.minY, this.a);
    const b = camera.boardToScreen(marquee.maxX, marquee.maxY, this.b);
    const x0 = a.x;
    const y0 = a.y;
    const w = b.x - x0;
    const h = b.y - y0;

    ctx.fillStyle = MARQUEE_FILL;
    ctx.fillRect(x0, y0, w, h);
    ctx.strokeStyle = MARQUEE_STROKE;
    ctx.lineWidth = 1;
    // Half-pixel offset, or a one-pixel line straddles two rows and renders as
    // a soft two-pixel one.
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(w), Math.round(h));
    this.inked = true;
  }
}
