/**
 * Wet ink — the stroke that is still being drawn.
 *
 * > **Wet and dry.** The in-progress stroke draws to a screen-resolution overlay
 * > so that latency is as low as the platform allows; the committed strokes
 * > underneath aren't touched. On pen-up the stroke is committed and the item's
 * > own canvas re-rasters once. — DESIGN section 6.5
 *
 * This is the wet half, and it is on the overlay canvas because that is where the
 * layer stack puts it — "overlay canvas (cursors, ghosts, wet ink)", DESIGN
 * section 6.2. Everything on that canvas belongs to a gesture and none of it is
 * in the document, which is exactly what a stroke before pen-up is.
 *
 * ## Screen space, from board coordinates
 *
 * The samples arrive in board units and are converted here, per point, per frame
 * — the same arrangement `render/ropes/paint.ts` uses and for one of the same
 * reasons: the stroke has to stay on the cork if the camera moves under it, and
 * the wheel still zooms while a pointer is down.
 *
 * The width does *not* follow that precedent. A rope's `lineWidth` is a fixed
 * number of screen pixels at every zoom, because a string is an object in front
 * of the board. Ink is a mark on the paper, so its width is in board units and is
 * multiplied by the zoom on the way in — lean in and the mark gets thicker along
 * with the photograph it is drawn on. Getting this backwards would be invisible
 * at 100% and obvious nowhere else.
 *
 * ## One allocation per stroke, not per frame
 *
 * The converted points go into a buffer that grows and is reused. A long stroke
 * redrawn every frame would otherwise allocate its whole length sixty times a
 * second, in the middle of the one gesture on this board with a hard latency
 * budget.
 */

import type { WetStroke } from "@/lib/ink";
import { outlineStroke, strokeOptions, traceOutline } from "@/render/ink/geometry";
import type { Camera, Vec2 } from "@/state/camera";

/** A mutable sample; the geometry's `InkSample` is readonly and these are
 *  rewritten in place every frame. */
interface ScreenSample {
  x: number;
  y: number;
  pressure: number;
}

export class WetInk {
  /** Screen-space samples, reused across frames — see the note above. Only the
   *  first `count` entries of a draw are meaningful. */
  private readonly buffer: ScreenSample[] = [];
  /** Reused, because `boardToScreen` allocates otherwise. */
  private readonly at: Vec2 = { x: 0, y: 0 };

  /**
   * Fill the stroke onto a context already in CSS-pixel coordinates.
   *
   * Returns false when there was nothing to draw, so the overlay can decide
   * whether the canvas ended up with anything on it — the same contract every
   * other `draw*` method on `render/overlay.ts` has, and what lets a frame that
   * draws nothing avoid touching the canvas at all.
   *
   * `last: false` on the way to `strokeOptions`, always. The stroke is by
   * definition unfinished here, and telling `perfect-freehand` otherwise makes it
   * commit to an end cap that then moves as each new sample lands — a tip that
   * shivers ahead of the cursor.
   */
  draw(ctx: CanvasRenderingContext2D, camera: Camera, stroke: WetStroke): boolean {
    const samples = stroke.samples;
    if (samples.length < 2) return false;

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i]!;
      camera.boardToScreen(sample.x, sample.y, this.at);
      const slot = this.buffer[i];
      if (slot) {
        slot.x = this.at.x;
        slot.y = this.at.y;
        slot.pressure = sample.pressure;
      } else {
        this.buffer.push({ x: this.at.x, y: this.at.y, pressure: sample.pressure });
      }
    }
    // Truncated rather than sliced. The buffer outlives the stroke, so after a
    // long one its tail is the *previous* stroke's points — passing the whole
    // array would draw a stroke that reached back to wherever the last one ended.
    // Dropping the refs costs a re-push on the stroke that grows past here again,
    // which is cheaper than a copy on every frame of every stroke.
    this.buffer.length = samples.length;

    const outline = outlineStroke(
      this.buffer,
      strokeOptions(stroke.tool, stroke.size * camera.zoom, false),
    );
    const path = new Path2D();
    if (!traceOutline(outline, path)) return false;

    ctx.save();
    ctx.fillStyle = stroke.color;
    // A filled polygon, not a stroked line — the width is in the shape. Nothing
    // here sets `lineWidth`, and nothing should.
    //
    // The highlighter's `multiply` compositing is deliberately not here: it needs
    // each stroke drawn to its own buffer and composited once, or a stroke
    // crossing itself darkens at the crossing (DESIGN section 2.4). That is a
    // second surface and its own decision — T-60.
    ctx.fill(path);
    ctx.restore();
    return true;
  }
}
