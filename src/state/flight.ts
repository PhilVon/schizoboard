/**
 * Carrying the camera somewhere, rather than putting it there.
 *
 * > Search · `Ctrl+F` — **flies** the camera to a match. Never filters or hides.
 * > — DESIGN section 3.7
 *
 * Nothing else on this board animates a camera. `centreOn`, `fit` and `setView`
 * assign and `touch()`, and `state/reveal.ts` — the only thing that moves the
 * view on your behalf today — jumps. So "flies" is either a figure of speech or
 * the one place that gets easing built for it, and Q-150 settled that it is the
 * second.
 *
 * ## Why a search is the case that earns it, when an undo is not
 *
 * DESIGN 2.3 asks that "you must always be looking at the whole mess". That is a
 * claim about spatial memory: the board earns its keep because you know roughly
 * where a thing is, having put it there. A teleport spends that — you arrive
 * somewhere and have to work out where you are — and stepping through six
 * matches spends it six times.
 *
 * `reveal` is rightly a jump and this is not a disagreement with it. It moves
 * only when the thing is *already* off screen and its job is to show you a
 * change you have just made; there is no journey to preserve because you were
 * never going anywhere. A search is the opposite: you asked to be taken.
 *
 * ## It is stepped by `dt`, never by CSS and never by a timer
 *
 * ARCHITECTURE 3, and the same rule `state/flash.ts` keeps. A transition driven
 * by the clock rather than by the frame is one the loop cannot see, cannot
 * pause and cannot make deterministic in a test — and this one writes the
 * *camera*, which every phase after INPUT reads. It also has to be written from
 * the INPUT phase for the reason `navigation.ts`'s header gives: nothing outside
 * the loop may move the camera, or the DOM phase can no longer trust its
 * version check.
 *
 * ## Cancelling is one comparison, and that is the whole point of doing it here
 *
 * A flight that fights the hand is worse than no flight. The obvious build is to
 * call `cancel()` from every input path that touches the camera — the pan
 * listener, the wheel, `Ctrl+0`, `F`, the undo restore — which is five places to
 * remember and a sixth to forget.
 *
 * Instead this watches `camera.version`, which every mutator already bumps. If
 * the number is not the one this left behind, *somebody else moved the camera*
 * and the flight is off. That covers every route in and every route added later,
 * including ones that have nothing to do with input.
 */

import type { Bounds, Camera } from "@/state/camera";

/**
 * How long a flight takes, milliseconds — Q-150's "about 300ms".
 *
 * Fixed rather than scaled by distance. A duration that grows with the journey
 * is the more obviously correct thing and it is wrong here: stepping through
 * matches, two hits in the same corner would snap and two across the board would
 * take a second and a half, so the same keystroke would have two different
 * characters. A constant makes `Enter` feel like one gesture wherever it lands.
 */
export const FLIGHT_MS = 300;

/**
 * Below this the flight is not worth having, in screen pixels of travel.
 *
 * A match already under the cursor should not slide a hand's width and settle;
 * that reads as the board twitching rather than as being taken anywhere. The
 * camera is put there and the flight never starts.
 */
const WORTH_FLYING_PX = 12;

/** Enough of a zoom change to be worth easing even when nothing has moved. */
const WORTH_ZOOMING = 0.02;

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

export class Flight {
  private flying = false;
  /** Elapsed, milliseconds. */
  private elapsed = 0;
  private fromX = 0;
  private fromY = 0;
  /** Log zoom — see [`to`]. */
  private fromZ = 0;
  private toX = 0;
  private toY = 0;
  private toZ = 0;
  /**
   * The `camera.version` this flight last left behind, or -1 while idle.
   *
   * The cancel test, and the reason it is a number rather than a set of
   * listeners. See the header.
   */
  private seen = -1;

  get active(): boolean {
    return this.flying;
  }

  /**
   * Take the camera to a board point at a zoom, over [`FLIGHT_MS`].
   *
   * ## Zoom travels in logs, and the centre travels in board units
   *
   * A zoom lerped linearly spends most of its time near the far end: going from
   * 0.2 to 2 passes 1.1 at the halfway mark, so the first half of the journey
   * covers a factor of five and the second a factor of two. Zoom is
   * multiplicative and the eye reads it that way, so the interpolation is on its
   * logarithm, which makes every equal slice of the flight the same *ratio*.
   *
   * The centre is a plain lerp in board space, and there is a well-known better
   * answer — van Wijk and Nuij's smooth zoom-and-pan, which solves for a path
   * that keeps the apparent speed constant. It is deliberately not here. It
   * earns its keep when the pan and the zoom are both large, and the flights
   * this exists for are `reveal`'s rule with easing on it: centre at the zoom
   * you already chose, and only fit when the target genuinely will not fit. In
   * the common case the zoom does not change at all and the two agree exactly.
   */
  to(camera: Camera, bx: number, by: number, zoom: number): void {
    if (!Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(zoom) || zoom <= 0) {
      return;
    }
    // The centre the camera is at now, not its corner: the corner moves with the
    // zoom, so a flight expressed in corners drifts sideways whenever the zoom
    // changes and does so more the further from the origin you are.
    const fromX = camera.x + camera.width / (2 * camera.zoom);
    const fromY = camera.y + camera.height / (2 * camera.zoom);

    // Worth it, in the units the eye actually judges: how far this will carry
    // the board across the screen, at the zoom it will be seen at.
    const travel = Math.hypot(bx - fromX, by - fromY) * Math.min(camera.zoom, zoom);
    const ratio = Math.abs(Math.log(zoom / camera.zoom));
    if (travel < WORTH_FLYING_PX && ratio < WORTH_ZOOMING) {
      this.cancel();
      camera.zoomTo(zoom, camera.width / 2, camera.height / 2);
      camera.centreOn(bx, by);
      return;
    }

    this.flying = true;
    this.elapsed = 0;
    this.fromX = fromX;
    this.fromY = fromY;
    this.fromZ = Math.log(camera.zoom);
    this.toX = bx;
    this.toY = by;
    this.toZ = Math.log(zoom);
    this.seen = camera.version;
  }

  /**
   * Take the camera to a box — `reveal`'s rule, with the journey kept.
   *
   * Centred at the current zoom when it will fit, and fitted when it will not.
   * Unlike `reveal` this does **not** decline to move for something already on
   * screen: a search that found a note among forty has to put it in the middle
   * whether or not a corner of it was showing, or "next match" sometimes does
   * nothing at all and reads as the key having missed.
   *
   * ## `minZoom` — the floor under where this lands
   *
   * Zero by default, which is the rule above unchanged. A search passes
   * `READING_ZOOM` (Q-153): carrying you to a note you cannot read is close to
   * not having arrived, and from a fitted board every sheet is a flat card by
   * design. It is a **floor and not a target** — search from 100% and nothing
   * about the zoom changes, because you were already able to read it.
   *
   * A fit still wins over the floor. If the match is so large that honouring
   * the floor would push its edges off screen, the whole of it at a smaller
   * scale beats a legible corner of it: an item that fills the viewport is one
   * whose *place* you can no longer be in any doubt about, which is what a
   * search was for. That case needs an item some nine thousand board units
   * across on this viewport and has never yet occurred; it is here so that the
   * two rules cannot deadlock, each undoing the other's zoom.
   */
  toBox(camera: Camera, box: Bounds, marginPx?: number, minZoom = 0): void {
    const bw = Math.max(1e-6, box.maxX - box.minX);
    const bh = Math.max(1e-6, box.maxY - box.minY);
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    const wanted = Math.max(camera.zoom, minZoom);
    if (bw * wanted <= camera.width && bh * wanted <= camera.height) {
      this.to(camera, cx, cy, wanted);
      return;
    }
    // Asked of a copy of the camera rather than reimplemented: `fit`'s margin
    // and its clamping are T-135's business and there must not be a second
    // opinion about them here.
    const zoom = camera.zoomToFit(box, marginPx);
    this.to(camera, cx, cy, zoom);
  }

  /** Stop, wherever the camera has got to. Idempotent. */
  cancel(): void {
    this.flying = false;
    this.elapsed = 0;
    this.seen = -1;
  }

  /**
   * Advance one frame and write the camera. Returns whether it moved.
   *
   * Called from the INPUT phase, after `navigation.flush()` — so a hand on the
   * mouse this frame has already had its say, and the version check below sees
   * it rather than overwriting it.
   */
  step(camera: Camera, dt: number): boolean {
    if (!this.flying) return false;
    // Somebody else moved the camera since the last frame: a pan, a wheel, a
    // Ctrl+0, an undo restoring its stashed view. Whatever it was, it was a
    // person, and a person outranks a flight.
    if (camera.version !== this.seen) {
      this.cancel();
      return false;
    }
    this.elapsed += Math.max(0, dt);
    const t = this.elapsed >= FLIGHT_MS ? 1 : this.elapsed / FLIGHT_MS;
    const e = smoothstep(t);
    // Landed exactly, rather than within a rounding error of the target. A
    // flight that stops a third of a unit short leaves the camera on a value
    // nobody chose, and `Ctrl+0` afterwards then reports a move that is really
    // this one's residue.
    const zoom = t === 1 ? Math.exp(this.toZ) : Math.exp(this.fromZ + (this.toZ - this.fromZ) * e);
    const cx = t === 1 ? this.toX : this.fromX + (this.toX - this.fromX) * e;
    const cy = t === 1 ? this.toY : this.fromY + (this.toY - this.fromY) * e;
    camera.setView(cx - camera.width / (2 * zoom), cy - camera.height / (2 * zoom), zoom);
    if (t === 1) {
      this.flying = false;
      this.elapsed = 0;
      this.seen = -1;
      return true;
    }
    this.seen = camera.version;
    return true;
  }
}
