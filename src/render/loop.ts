/**
 * THE single requestAnimationFrame.
 *
 * Nothing else in the application animates independently — no CSS transitions
 * on board content, no per-item timers. Everything that moves is stepped from
 * here, in nine fixed phases (docs/ARCHITECTURE.md section 3):
 *
 *   1. INPUT      drain coalesced pointer events -> tool state machine
 *   2. PRESENCE   apply interpolated remote poses at (now - 100ms)
 *   3. SIM        step awake ropes and torsions; sleep checks
 *   4. LAYOUT     recompute world pin positions for dirty items
 *   5. DOM        write transforms for dirty items only        <- WRITE PHASE
 *   6. INK        re-raster items in the dirty-ink set
 *   7. ROPES      clear + draw under canvas, then over canvas
 *   8. OVERLAY    remote cursors, ghosts, wet ink, selection chrome
 *   9. FLUSH      awareness (every 2nd frame), doc ops queued this frame
 *
 * **Strict read-then-write separation.** Phases 1-4 read and compute; phase 5
 * is the only place the DOM is written. No layout reads anywhere in the loop —
 * no getBoundingClientRect, no offsetWidth. Every geometry value comes from the
 * scene mirror. One stray read in phase 5 forces synchronous layout and costs
 * the frame.
 */

export const PHASES = [
  "input",
  "presence",
  "sim",
  "layout",
  "dom",
  "ink",
  "ropes",
  "overlay",
  "flush",
] as const;

export type Phase = (typeof PHASES)[number];

export const PHASE_COUNT = PHASES.length;

/** Longest dt the loop will hand to a phase. A backgrounded tab can produce a
 *  multi-second gap; letting that reach the solver detonates it. */
const MAX_DT_MS = 250;

export interface Frame {
  /** rAF timestamp, ms. */
  readonly now: number;
  /** Milliseconds since the previous frame, clamped to `[0, MAX_DT_MS]`. */
  readonly dt: number;
  /** Monotonic frame counter — phase 9 uses it for "every other frame". */
  readonly index: number;
}

export type PhaseFn = (frame: Frame) => void;

export class FrameLoop {
  /** Milliseconds spent in each phase on the last completed frame, indexed to
   *  PHASES. Read by the dev HUD; never allocate a new array for it. */
  readonly timings = new Float32Array(PHASE_COUNT);

  /** Exponential moving average of whole-frame milliseconds. */
  frameMs = 0;

  private readonly handlers: PhaseFn[][] = PHASES.map(() => []);
  private raf = 0;
  private last = 0;
  private index = 0;
  private readonly frame: { now: number; dt: number; index: number } = {
    now: 0,
    dt: 0,
    index: 0,
  };

  /** Register a phase handler. Returns an unregister function. */
  on(phase: Phase, fn: PhaseFn): () => void {
    const list = this.handlers[PHASES.indexOf(phase)]!;
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  get running(): boolean {
    return this.raf !== 0;
  }

  start(): void {
    if (this.raf !== 0) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.raf === 0) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Run exactly one frame. Tests drive the loop through this. */
  step(now: number): void {
    /**
     * Clamped at **both** ends, and the lower one is not theoretical.
     *
     * Time never runs backwards, but `now` is a parameter rather than a clock:
     * `start()` seeds `last` from `performance.now()` while `tick` is handed the
     * rAF timestamp, which is when the frame *began* — so the first frame of
     * every run can arrive slightly older than the moment the loop was started.
     * And this method is documented as the way to drive the board a frame at a
     * time; anything doing that beside a live rAF interleaves two clocks and
     * the gap between them arrives here as a `now` hundreds of milliseconds
     * behind `last`.
     *
     * A negative dt is not a small error in either case. Everything eased in
     * this application is a first-order filter of the shape
     * `1 - exp(-dt/tau)`, and at `dt` of `-616` against a 70 ms tau that factor
     * is not `0.2` but `-6633`: the value it is easing does not lag, it
     * *multiplies*, by four orders of magnitude per frame. Nine such frames
     * overflow a double to `Infinity`, and the tenth turns `Infinity` into
     * `NaN` — which is how T-194 arrived, as a photograph whose swing, driftX
     * and driftY were all `NaN` while its stored pose was perfectly finite.
     *
     * So the guard is here rather than in each filter. A frame that took no
     * time is the honest reading of a clock that has not moved, and every phase
     * already does nothing with it.
     */
    const dt = Math.min(Math.max(now - this.last, 0), MAX_DT_MS);
    this.last = now;

    const frame = this.frame;
    frame.now = now;
    frame.dt = dt;
    frame.index = this.index++;

    const frameStart = performance.now();
    for (let p = 0; p < PHASE_COUNT; p++) {
      const list = this.handlers[p]!;
      if (list.length === 0) {
        this.timings[p] = 0;
        continue;
      }
      const t0 = performance.now();
      for (let i = 0; i < list.length; i++) list[i]!(frame);
      this.timings[p] = performance.now() - t0;
    }
    const elapsed = performance.now() - frameStart;
    // EMA over ~20 frames — a single hitch should show, not dominate.
    this.frameMs = this.frameMs === 0 ? elapsed : this.frameMs * 0.9 + elapsed * 0.1;
  }

  private readonly tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    this.step(now);
  };
}
