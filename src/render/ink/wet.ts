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
  /** Half the item's width and height, in board units — the paper the pen is
   *  allowed to mark. See the clip in [`WetInk.draw`]. */
  hw: number;
  hh: number;
  /**
   * The sheet's silhouette in item-local coordinates, `x, y` pairs, or null for
   * an item that is its own rectangle — a photograph (T-186).
   *
   * Here rather than derived, because the clip below and the boundary the pen
   * tested have to be the same polygon: a wet stroke clipped to the rectangle
   * while the committed one is clipped to the paper would visibly change shape
   * at pen-up, on the one edge where anybody would look.
   */
  points: Float32Array | null;
  /** How many vertices of [`points`] are live. */
  n: number;
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
    // The pen stops at the edge of the paper (T-136), wet as well as dry — a
    // stroke that appeared over the cork while the button was down and then
    // vanished at the release would be a worse lie than either half alone.
    //
    // The paper's four corners rather than an axis-aligned box, because the
    // photograph is drawn at an angle and this clip is in screen space. Same
    // conversion as the samples above and in the same order, so the two cannot
    // disagree about where the paper is.
    if (frame !== null && stroke.item !== null) {
      const paper = new Path2D();
      // The sheet's own outline when it has one, and its four corners when it
      // does not (T-186). Same loop either way: the vertices come out of the
      // item's frame and through the camera exactly as the samples above did,
      // so the two cannot disagree about where the paper is.
      const count = frame.points === null ? 4 : frame.n;
      for (let i = 0; i < count; i++) {
        const lx =
          frame.points === null ? (i === 0 || i === 3 ? -frame.hw : frame.hw) : frame.points[i * 2]!;
        const ly =
          frame.points === null ? (i < 2 ? -frame.hh : frame.hh) : frame.points[i * 2 + 1]!;
        rotateOut(lx, ly, frame.cx, frame.cy, frame.cos, frame.sin, this.board);
        camera.boardToScreen(this.board.x, this.board.y, this.at);
        if (i === 0) paper.moveTo(this.at.x, this.at.y);
        else paper.lineTo(this.at.x, this.at.y);
      }
      paper.closePath();
      ctx.clip(paper);
    }
    ctx.globalAlpha = stroke.opacity;
    ctx.fillStyle = stroke.color;
    // A filled polygon, not a stroked line — the width is in the shape. Nothing
    // here sets `lineWidth`, and nothing should.
    //
    // `multiply` for a highlighter, the same as `render/ink/dry.ts`, so that the
    // mark does not change shade at pen-up.
    //
    // Against an empty canvas the two composite operators agree, and most frames
    // of most strokes that is what this is. Not all of them: wet ink is drawn
    // last, over every piece of chrome `render/overlay.ts` has already put down,
    // so a highlighter dragged across a selection outline blends with it here
    // exactly as it will blend with the ink already on the item's canvas a frame
    // later. The alpha above is the half that always matters.
    ctx.globalCompositeOperation = stroke.tool === "highlighter" ? "multiply" : "source-over";
    ctx.fill(path);
    ctx.restore();
    return true;
  }
}
