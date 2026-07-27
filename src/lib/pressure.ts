/**
 * How hard the nib is pressed, for the devices that cannot say.
 *
 * > Pressure branches on pointer type: a real pen reports real pressure, while a
 * > mouse always reports exactly 0.5, so mouse and touch use velocity-derived
 * > simulated pressure instead. Getting this wrong produces dead, uniform lines
 * > and is a very common mistake. — DESIGN section 6.5
 *
 * The trap is worth spelling out, because the wrong version of this *works*. A
 * mouse does report a `pressure`, and it is a number, and feeding it to the
 * stroke geometry produces a perfectly good-looking line — one whose width never
 * changes, because the number is `0.5` on every sample the device will ever
 * deliver. Nothing errors and nothing looks broken; the ink just reads as vector
 * art rather than as a marker, and it does so subtly enough that the cause is not
 * obvious from the picture.
 *
 * ## Why not `perfect-freehand`'s own simulation
 *
 * It has one, and it is off because it is **distance-based**: it derives the
 * width from the gap between consecutive input points and never looks at time.
 * That is the same thing as speed only if the samples arrive at a fixed rate,
 * and on this board they emphatically do not — `getCoalescedEvents` recovers
 * every sample the OS delivered, so a fast hand on a high-polling-rate mouse
 * hands over a dozen closely-spaced points per frame and a slow one hands over
 * two. Distance between samples would call the fast hand *slow*, which is exactly
 * backwards.
 *
 * It also cannot survive the commit. A stored stroke is simplified before it is
 * packed (DATA-MODEL section 6.1), which changes the gaps between its points — so
 * a distance-derived width would come back from the document different from the
 * one that was drawn. Pressure computed here is a property of the gesture,
 * carried on the sample and stored with it, and a re-raster reproduces the mark.
 *
 * ## The curve
 *
 * Speed maps to pressure through `1 / (1 + speed / HALF_SPEED)` — a hyperbola,
 * deliberately, rather than a ramp between a "slow" and a "fast" threshold. A
 * ramp has a dead zone at each end, and both ends are places people draw: below
 * the slow threshold every careful annotation is one flat width, and above the
 * fast one every gesture is another. A hyperbola has no thresholds to get wrong.
 * It keeps responding at any speed, and the single constant it does need means
 * something you can hold in your head — the speed at which the nib is half
 * pressed.
 */

/**
 * What a device with no pressure sensor reports, and what the Pointer Events
 * spec says a mouse must report for as long as a button is down.
 *
 * Exported because it is the *value* the branch exists to avoid trusting, and
 * naming it is what keeps a future reader from seeing a bare `0.5` and assuming
 * it is a taste call.
 */
export const PRESSURE_NEUTRAL = 0.5;

/** Screen pixels per millisecond at which the nib is at half pressure. Roughly
 *  a comfortable writing speed; slower swells, faster thins. */
const HALF_SPEED = 0.7;

/**
 * Below this the mark would be a hairline, and a hairline reads as the ink having
 * run out rather than as a fast stroke. It also protects the geometry: an outline
 * built at zero width has no area to fill.
 */
const MIN_PRESSURE = 0.1;

/**
 * The smoothing time constant, in milliseconds.
 *
 * In *time* rather than in samples, which is the whole point of it. An average
 * over the last N samples smooths over 16 ms on a 60 Hz mouse and over 2 ms on a
 * 1000 Hz one, so the same hand would produce a different mark on two machines.
 * An exponential decay keyed to elapsed time does not care how often it is asked.
 *
 * 30 ms is short enough that a deliberate flick still thins within its own
 * length, and long enough that the jitter between two adjacent samples — which at
 * 1000 Hz is mostly quantisation of a one-pixel step — does not become texture.
 */
const TAU_MS = 30;

/**
 * What to assume when the timestamps are unusable.
 *
 * Some engines stamp every event in a coalesced batch identically, which makes
 * the interval zero. Falling back to *no change* would be the quiet failure this
 * whole module exists to avoid: the speed would freeze at whatever it was and the
 * line would go flat with nothing to show why. So an unusable interval is treated
 * as one nominal sample period, which leaves the distance between the samples
 * still doing the work — degraded to `perfect-freehand`'s own heuristic rather
 * than to a straight line.
 */
const NOMINAL_DT_MS = 4;

/** Does this device measure how hard it is being pressed? `pointerType` is the
 *  only honest signal — see [`VelocityPressure`] for what a pen that lies about
 *  it costs. */
export function reportsRealPressure(pointerType: string | undefined): boolean {
  return pointerType === "pen";
}

/**
 * Pressure from how fast the hand is moving.
 *
 * Stateful, and causal: each sample is answered from the samples before it and
 * never revised. That is not a simplification — the answers are pushed onto a
 * stroke the renderer is already drawing (`state/tools/marker.ts`), so a model
 * that wanted to look ahead would have to rewrite points that are on screen, and
 * the width of the ink behind the nib would shift as the hand moved.
 *
 * One instance per stroke, or one reset per stroke. A stroke that inherited the
 * previous one's speed would start at whatever width the last one finished at.
 */
export class VelocityPressure {
  private lastX = 0;
  private lastY = 0;
  private lastTime = 0;
  private speed = 0;
  private started = false;

  /** Forget the previous stroke. Cheaper than allocating a model per stroke, and
   *  the marker tool has exactly one gesture at a time. */
  reset(): void {
    this.started = false;
    this.speed = 0;
  }

  /**
   * The pressure for a sample at a screen position and a time in milliseconds.
   *
   * **Screen** pixels, not board units, and that is a deliberate choice rather
   * than an oversight about the zoom. The number being modelled is how fast the
   * *hand* moved, and the hand moves across a screen — the same gesture at 25%
   * zoom covers four times the board and is not four times faster. A stroke drawn
   * zoomed out would otherwise come out uniformly thin for no reason the person
   * drawing it could see.
   */
  next(x: number, y: number, time: number): number {
    if (!this.started) {
      this.started = true;
      this.lastX = x;
      this.lastY = y;
      this.lastTime = time;
      // A stroke begins from rest, so it begins at full width — which is also
      // what a marker does as it is set down.
      return 1;
    }

    const dt = time > this.lastTime && Number.isFinite(time - this.lastTime)
      ? time - this.lastTime
      : NOMINAL_DT_MS;
    const instant = Math.hypot(x - this.lastX, y - this.lastY) / dt;
    // Rate-independent exponential smoothing: the weight of the new reading is
    // how much of the time constant has elapsed, so ten samples in 1 ms move the
    // average as far as one sample in 1 ms would.
    const alpha = 1 - Math.exp(-dt / TAU_MS);
    this.speed += (instant - this.speed) * alpha;
    this.lastX = x;
    this.lastY = y;
    this.lastTime = time;

    return pressureForSpeed(this.speed);
  }
}

/**
 * The curve itself, separated out because it is the part worth reading and the
 * part worth testing without a stroke around it.
 */
export function pressureForSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 1;
  return Math.max(MIN_PRESSURE, 1 / (1 + speed / HALF_SPEED));
}
