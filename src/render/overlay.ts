/**
 * The overlay canvas — phase 8.
 *
 * > 8. OVERLAY   remote cursors, ghosts, wet ink, selection chrome
 * > — docs/ARCHITECTURE.md section 3
 *
 * Everything drawn here is transient: it belongs to a gesture or to a
 * collaborator, never to the document. The canvas is cleared and redrawn whole
 * on the frames it has anything to change, which is affordable precisely because
 * most frames have nothing — and free on those, because a frame that would
 * redraw the same picture does not touch the canvas at all.
 *
 * Screen space, like the rope canvases: points are converted through the camera
 * at draw time rather than the canvas being transformed. That is what keeps a
 * one-pixel line one pixel wide at 400% zoom.
 *
 * ## Selection chrome is here, and that is the point
 *
 * It used to be a CSS `outline` on each item's own frame, which put its width in
 * *board* units: legible at 54% zoom, a hairline at 20%, and gone by 15% — while
 * thickening into a slab at 400%. Chrome is not part of the photograph. Drawing
 * it here costs the rotation the CSS outline got for free, and buys exact screen
 * widths, no per-item DOM bookkeeping, and chrome that is not painted over by
 * whatever item happens to stack above the selected one.
 */

import { CARRY_SCALE } from "@/render/items/view";
import type { Bounds, Camera, Vec2 } from "@/state/camera";
import type { DirtySets } from "@/state/dirty";
import type { Scene } from "@/state/scene";
import type { Selection } from "@/state/selection";

/** Warm, like everything else on this board; matches the item outline. */
const MARQUEE_FILL = "rgba(255, 244, 214, 0.10)";
const MARQUEE_STROKE = "rgba(255, 244, 214, 0.85)";

/**
 * Dark rather than light, and that is not a taste call: a pale line is invisible
 * against a polaroid's own off-white frame, which is most of what anyone selects.
 * A dark warm line is the only one legible against both the cork and the paper,
 * and it reads as something drawn round the photograph rather than as a UI
 * rectangle floating over it.
 */
const SELECT_STROKE = "rgba(34, 21, 10, 0.8)";
const SELECT_WIDTH = 1.5;
/**
 * Gap between the paper's edge and the inside of the line, then half the line —
 * so this is the distance out to its centre, which is what a stroke is measured
 * from. Both halves are CSS pixels and stay CSS pixels at every zoom, which is
 * the whole of AC-140.
 */
const SELECT_PAD = 2.5 + SELECT_WIDTH / 2;

export class Overlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  /** Did the previous frame leave anything behind that needs clearing? */
  private inked = false;
  /** Reused; `boardToScreen` allocates otherwise, and this runs per frame. */
  private readonly a: Vec2 = { x: 0, y: 0 };
  private readonly b: Vec2 = { x: 0, y: 0 };

  /**
   * What the picture currently on the canvas was drawn from. An idle board must
   * cost nothing (`state/selection.ts`), and a selection is the first thing this
   * canvas holds that *persists* — the marquee only existed mid-drag, so until
   * now "nothing to draw" and "nothing changed" were the same frame. They are
   * not any more: a board sitting still with three photographs selected would
   * otherwise clear and restroke a full-viewport canvas sixty times a second to
   * arrive at the identical image.
   */
  private cameraVersion = -1;
  private selectionVersion = -1;
  private hadMarquee = false;
  /** Reset at the top of every `draw` — see [`Overlay.clear`]. */
  private cleared = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
  }

  /**
   * OVERLAY phase.
   *
   * `marquee` is in board coordinates so it stays pinned to the cork if the
   * camera moves while it is being dragged out.
   *
   * `dirty` is read only to answer one question — did anything *selected* move
   * this frame — because a selected photograph being dragged changes this picture
   * without changing the camera or the membership.
   */
  draw(
    camera: Camera,
    scene: Scene,
    selection: Selection,
    marquee: Bounds | null,
    dirty: DirtySets,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const wantsMarquee = marquee !== null;
    const stale =
      wantsMarquee ||
      // It was there last frame and is not now, so the canvas is wrong even if
      // nothing else changed — dragging a marquee across empty cork and letting
      // go never touches the selection.
      this.hadMarquee ||
      camera.version !== this.cameraVersion ||
      selection.version !== this.selectionVersion ||
      this.selectedMoved(selection, dirty);
    this.hadMarquee = wantsMarquee;
    this.cameraVersion = camera.version;
    this.selectionVersion = selection.version;
    if (!stale) return;

    // The clear is deferred rather than done up front, so that a frame which
    // turns out to draw nothing does not touch the canvas at all. That is not a
    // theoretical case: a selection whose items are all off screen is stale on
    // every frame of a pan and draws nothing on any of them, and clearing a
    // blank canvas to arrive at a blank canvas is the cost this module exists
    // to not pay.
    this.cleared = false;
    let drew = this.drawSelection(ctx, camera, scene, selection);
    if (marquee) {
      this.drawMarquee(ctx, camera, marquee);
      drew = true;
    }
    // Nothing to draw, but last frame there was — so the clear is the work.
    if (!drew && this.inked) this.clear(ctx);
    this.inked = drew;
  }

  /**
   * At most once per frame, and only from something about to draw.
   *
   * The context is pre-scaled by devicePixelRatio (`world.resizeCanvases`), so
   * every other coordinate in this file is in CSS pixels — the clear is taken
   * back to the identity so it covers the backing store exactly rather than
   * relying on this module knowing what the scale was.
   */
  private clear(ctx: CanvasRenderingContext2D): void {
    if (this.cleared) return;
    this.cleared = true;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
  }

  /**
   * Did anything in the selection move, resize or turn this frame?
   *
   * Walks the dirty set rather than the selection because the dirty set is the
   * short one — one item under a drag, against a marquee that may hold every
   * photograph on the board.
   */
  private selectedMoved(selection: Selection, dirty: DirtySets): boolean {
    if (selection.isEmpty) return false;
    if (dirty.all) return true;
    for (const id of dirty.items) if (selection.has(id)) return true;
    return false;
  }

  /** True if it put anything on the canvas. */
  private drawSelection(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    scene: Scene,
    selection: Selection,
  ): boolean {
    if (selection.isEmpty) return false;
    let drew = false;

    for (const id of selection.members) {
      const slot = scene.slotOf(id);
      // A selection can name an item a collaborator has just deleted;
      // `Selection.prune` clears that up, but not before this frame draws.
      if (slot === undefined) continue;

      // The item's own box, which is exactly what `.pol-frame` and
      // `.paper-surface` occupy — both are `inset: 0` — so the line lands on the
      // paper's edge rather than on the item's bounding box.
      const scale = 1 + scene.lift[slot]! * CARRY_SCALE;
      const hw = (scene.w[slot]! * camera.zoom * scale) / 2 + SELECT_PAD;
      const hh = (scene.h[slot]! * camera.zoom * scale) / 2 + SELECT_PAD;
      const centre = camera.boardToScreen(scene.x[slot]!, scene.y[slot]!, this.a);
      const cx = centre.x;
      const cy = centre.y;

      // Circle-against-viewport reject. Culling (T-27) has already unmounted the
      // item's node, but the selection is not culled and does not need to be —
      // the far side of a marquee that took in the whole board is a few
      // multiplications, not a DOM node.
      const reach = Math.hypot(hw, hh);
      if (cx + reach < 0 || cx - reach > camera.width) continue;
      if (cy + reach < 0 || cy - reach > camera.height) continue;

      // The rendered angle, `rot + swing`, so the chrome rides a photograph that
      // is still settling on its pin rather than sitting where it came to rest.
      // No half-pixel snapping: it only sharpens an axis-aligned line, and an
      // item that is exactly straight is the rare one on a board whose whole
      // aesthetic is that nothing is.
      this.clear(ctx);
      if (!drew) {
        // Set once for the whole selection, not per item.
        ctx.strokeStyle = SELECT_STROKE;
        ctx.lineWidth = SELECT_WIDTH;
        drew = true;
      }
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(scene.rot[slot]! + scene.swing[slot]!);
      ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
      ctx.restore();
    }
    return drew;
  }

  private drawMarquee(ctx: CanvasRenderingContext2D, camera: Camera, marquee: Bounds): void {
    this.clear(ctx);
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
  }
}
