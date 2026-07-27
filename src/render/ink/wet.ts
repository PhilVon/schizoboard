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
 * ## Screen space, from wherever the samples are
 *
 * The samples arrive in world units and are converted here, per point, per frame
 * — the same arrangement `render/ropes/paint.ts` uses and for one of the same
 * reasons: the stroke has to stay on the cork if the camera moves under it, and
 * the wheel still zooms while a pointer is down.
 *
 * A stroke glued to a photograph (`WetStroke.item`) has one more hop in front of
 * that, out of the item's frame and into board space, and the caller supplies the
 * frame because only it can read the scene. Resolved *this* frame, every frame,
 * which is what AC-22 is: drag the photograph or let it swing on its pin with the
 * pen still down, and the mark goes with the paper instead of hanging in the air
 * where it was drawn.
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
import { rotateOut, type Point } from "@/lib/rotate";
import { outlineStroke, strokeOptions, traceOutline } from "@/render/ink/geometry";
import type { Camera, Vec2 } from "@/state/camera";

/** A mutable sample; the geometry's `InkSample` is readonly and these are
 *  rewritten in place every frame. */
interface ScreenSample {
  x: number;
  y: number;
  pressure: number;
}

/**
 * Where the item a stroke is glued to is drawn, this frame — its rendered
 * centre and the cosine and sine of its rendered angle.
 *
 * Trig hoisted out because the conversion runs over every sample of the stroke
 * on every frame of it, and a long stroke is thousands of points: two calls to
 * `Math.cos`, not two thousand. Same bargain, and the same sign convention, as
 * `lib/rotate.ts` — which is the only place that convention is written down.
 */
export interface ItemFrame {
  cx: number;
  cy: number;
  cos: number;
  sin: number;
}

export class WetInk {
  /** Screen-space samples, reused across frames — see the note above. Only the
   *  first `count` entries of a draw are meaningful. */
  private readonly buffer: ScreenSample[] = [];
  /** Reused, because `boardToScreen` allocates otherwise. */
  private readonly at: Vec2 = { x: 0, y: 0 };
  /** Likewise, for the item-local hop in front of it. */
  private readonly board: Point = { x: 0, y: 0 };

  /**
   * Fill the stroke onto a context already in CSS-pixel coordinates.
   *
   * `frame` is where the item named by `stroke.item` is drawn this frame, and is
   * required exactly when there is one. Null with a glued stroke means the paper
   * has left the board mid-gesture, and there is then nowhere for the ink to be:
   * it is not drawn, rather than being drawn at the origin, which is where an
   * identity transform would put it.
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
  draw(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    stroke: WetStroke,
    frame: ItemFrame | null = null,
  ): boolean {
    const samples = stroke.samples;
    if (samples.length < 2) return false;
    if (stroke.item !== null && frame === null) return false;

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i]!;
      if (frame && stroke.item !== null) {
        rotateOut(sample.x, sample.y, frame.cx, frame.cy, frame.cos, frame.sin, this.board);
        camera.boardToScreen(this.board.x, this.board.y, this.at);
      } else {
        camera.boardToScreen(sample.x, sample.y, this.at);
      }
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
