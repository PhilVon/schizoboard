/**
 * The rope solver: one segment of string, between two pins, for one frame.
 *
 * > Verlet integration with position-based constraint projection. Each segment
 * > between adjacent pins is an independent chain of particles. Per frame, at
 * > a fixed timestep:
 * >
 * > 1. Integrate: `next = pos + (pos - prev) x damping + gravity x dt^2`
 * > 2. Project distance constraints between neighbours, several iterations,
 * >    each pass moving both particles halfway to satisfaction.
 * > 3. Re-pin the endpoints to their pins' current world positions.
 * > 4. Resolve item collisions if the string is on the `over` layer.
 * > — DESIGN section 5.2
 *
 * Step 4 is draping, and it arrives as a `RopeDrape` this module calls and does
 * not otherwise know anything about — `sim/collide.ts` is the one that has
 * heard of an item.
 *
 * This module owns no state but the clock. It is handed a slice of somebody
 * else's particle buffer and the two anchor positions, and it moves the
 * particles — so `sim/ropes.ts` can keep every rope on the board in two flat
 * arrays and step them through this without a single object per rope. The
 * scene is not imported, the document certainly is not, and nothing here
 * knows what a string id is.
 *
 * ## Fixed timestep, and AC-63
 *
 * > Fixed timestep of 1/120 s with an accumulator and a cap of four substeps
 * > per frame, so behaviour doesn't change with frame rate and a stalled tab
 * > doesn't explode on resume. — DESIGN section 5.2
 *
 * `FixedStep` is that sentence, and it is the whole of the framerate
 * contract: it converts however long a frame happened to take into a whole
 * number of identical 1/120 s steps, and the solver below never sees a `dt`
 * that came from a clock. The cap is the important half and it is a cap on
 * *time*, not on iterations — a tab backgrounded for a minute comes back with
 * a minute in the accumulator, and paying that back honestly would take a
 * minute of frames. Discarding the excess resumes a third of a second stale,
 * which nobody can tell, instead of freezing.
 *
 * ## Why the endpoints are pinned before the projection, not after
 *
 * DESIGN lists re-pinning third, after the constraint passes. Done literally
 * that undoes the last pass at both ends — the endpoint jumps back to its pin
 * and the link next to it is left stretched by however far the pin moved,
 * every frame, which reads as a rope that never quite attaches.
 *
 * The equivalent that does not do that is the standard one: the endpoints are
 * *infinite mass*. They are placed on their pins before the passes and never
 * integrated, and each pass gives the whole of a link's correction to whichever
 * end of it can move. The endpoints are then on their pins at the end of the
 * step as well, which is what step 3 was asking for.
 *
 * ## Why the passes alternate direction
 *
 * A hanging chain carries its weight to the anchors. Gravity displaces every
 * particle equally, which violates nothing in the middle — a uniform shift
 * leaves interior link lengths untouched — and violates exactly the two links
 * next to the fixed ends. The correction has to travel from there inward.
 *
 * Gauss-Seidel in place is good at that in *one* direction: a forward sweep
 * corrects link 0, which moves particle 1, which is what link 1 then sees, so
 * a single pass carries one anchor's pull the length of the rope. Backwards it
 * carries nothing. A rope has an anchor at each end, so the passes alternate,
 * and `ROPE_ITERATIONS` is 2 because two is one round trip.
 *
 * ## Why there are micro-steps inside the fixed step
 *
 * This is the part that took measuring, and the number it produced is the
 * difference between rope and elastic. Position-based dynamics holds a load by
 * holding a *violation* — the stretch is what generates the restoring
 * correction — so a chain under gravity settles permanently longer than its
 * rest length, by however much the solver is too soft to prevent. At DESIGN's
 * suggested six passes that came out at 23%, with the rope hanging 19 board
 * units below the analytic pose in `catenary.ts`. Elastic.
 *
 * Iterating harder barely helps: the error falls only as fast as the pass
 * count rises, and 200 passes to reach half a percent is not a budget that
 * survives a hundred awake ropes. Halving the timestep instead *quarters* the
 * violation, because gravity's contribution goes as `h^2`. Sixteen micro-steps
 * of two passes costs a third of what twenty-four passes of one step costs and
 * is seventeen times more accurate. `tuning.ts` has the table.
 *
 * The fixed step stays 1/120 s regardless, because that is the number AC-63 is
 * about and the one `FixedStep` and the sleep manager count in. How finely the
 * solver chooses to integrate inside one is its own business.
 */

import {
  GRAVITY,
  ROPE_DAMPING,
  ROPE_ITERATIONS,
  ROPE_SUBSTEPS,
  SIM_MAX_SUBSTEPS,
  SIM_STEP_MS,
} from "@/sim/tuning";

/**
 * Where the particles were when the current fixed step started, so the step's
 * displacement can be measured against it.
 *
 * Module-level and grown on demand: one buffer serves every rope on the board,
 * because a rope is stepped to completion before the next one starts.
 */
let mark = new Float64Array(0);

/** The fixed timestep in seconds — the only `dt` anything here ever sees. */
const H = SIM_STEP_MS / 1000;

/** The micro-step the solver actually integrates at, and the two constants
 *  that follow from it. Damping is quoted per fixed step, hence the root. */
const MICRO_H = H / ROPE_SUBSTEPS;
const MICRO_GRAVITY = GRAVITY * MICRO_H * MICRO_H;
const MICRO_DAMPING = Math.pow(ROPE_DAMPING, 1 / ROPE_SUBSTEPS);

/**
 * Whatever is going to keep this rope out of the things it crosses.
 *
 * An interface rather than the class itself, and declared here rather than
 * imported, because the solver's contract is "something moves the particles
 * after each projection pass" and that is the whole of what it needs to know. A
 * rope on the `under` layer, and every rope with nothing near it, is handed
 * `null` and pays a branch per micro-step — see `sim/ropes.ts`, which decides.
 */
export interface RopeDrape {
  resolve(pos: Float64Array, prev: Float64Array, at: number, count: number): void;
}

/**
 * The accumulator that makes the simulation framerate-independent (AC-63).
 *
 * One of these for the whole board, not one per rope: every rope has to step
 * the same number of times on the same frame, or two strings tied to the same
 * pin would disagree about what time it is.
 */
export class FixedStep {
  private accumulator = 0;

  /**
   * Fold a frame's elapsed time in and return how many fixed steps to run.
   *
   * The clamp is applied to the accumulator rather than to `dtMs`, so time
   * that arrives in one enormous lump and time that arrives as a slow drift
   * are both capped at the same place — the four steps DESIGN allows.
   * Whatever is left over stays in the accumulator for next frame, which is
   * what stops a 60 Hz display and a 144 Hz one from drifting apart.
   */
  advance(dtMs: number): number {
    if (dtMs > 0) this.accumulator += dtMs;
    const cap = SIM_STEP_MS * SIM_MAX_SUBSTEPS;
    if (this.accumulator > cap) this.accumulator = cap;
    const steps = Math.floor(this.accumulator / SIM_STEP_MS);
    this.accumulator -= steps * SIM_STEP_MS;
    return steps;
  }

  /** Milliseconds carried over, for the dev HUD and for tests. */
  get pending(): number {
    return this.accumulator;
  }

  /** Forget the carried time. For teardown, and for a document swap — there
   *  is nothing on the new board that the old board's leftover applies to. */
  reset(): void {
    this.accumulator = 0;
  }
}

/**
 * Step one rope segment through `steps` fixed steps, and report how far the
 * busiest particle travelled.
 *
 * `pos` and `prev` are interleaved `x, y`, sharing a layout, so a rope's
 * particles occupy `at .. at + count * 2`. `link` is the rest length of every
 * link, which `sampleChain` seeded them at — see D-16; deriving it per link
 * from the seeded pose instead would freeze whatever shape the rope was
 * created in.
 *
 * `ax, ay` and `bx, by` are where the two end pins are *now*. Moving them
 * between frames is how a dragged photograph drags its string: the endpoints
 * walk from wherever they were to wherever the pins went, one micro-step at a
 * time, and the projection carries that inward. Walking rather than jumping
 * matters at speed — a pin covering sixteen board units in a frame would
 * otherwise deliver all sixteen to one link at once and crack the rope like a
 * whip.
 *
 * The return value is how far the busiest particle moved in a **fixed step** —
 * the largest such distance over the steps this call ran. `sim/ropes.ts`
 * compares it to `ROPE_SLEEP_MOVE`, and DESIGN section 5.3's sleep rule is
 * quoted in the same units: "the largest particle movement... for 12
 * consecutive frames".
 *
 * Measured per fixed step rather than per micro-step, and that distinction was
 * worth a bug. The first version summed the per-micro-step maxima, on the
 * reasoning that a path length cannot be fooled by a rope vibrating in place.
 * True, but it compares thirty-two samples against a threshold written for
 * one: a rope sitting still with a thousandth of a unit of numerical churn per
 * micro-step reads as three hundredths and hovers just under the line. A rope
 * woken where it already rested took 34 frames to be believed instead of 12,
 * and a dragged one took over four seconds. A fixed step is still short enough
 * — a hundred and twentieth of a second — that nothing which is genuinely
 * moving can hide inside one.
 */
export function stepRope(
  pos: Float64Array,
  prev: Float64Array,
  at: number,
  count: number,
  link: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  steps: number,
  drape: RopeDrape | null = null,
): number {
  const last = at + (count - 1) * 2;

  // Two particles is a segment with no interior at all: both ends are pins,
  // there is nothing to integrate and nothing to project. It still gets its
  // endpoints put where they belong.
  if (count < 3 || steps <= 0) {
    seat(pos, prev, at, ax, ay);
    seat(pos, prev, last, bx, by);
    return 0;
  }

  // Where the ends are coming *from*, so they can be walked rather than
  // teleported. On a freshly seeded rope these already are the anchors, so
  // the walk is a no-op and the first frame stays as still as the seed.
  const fromAx = pos[at]!;
  const fromAy = pos[at + 1]!;
  const fromBx = pos[last]!;
  const fromBy = pos[last + 1]!;

  const span = count * 2;
  if (mark.length < span) mark = new Float64Array(span);

  let worst = 0;
  const micro = steps * ROPE_SUBSTEPS;
  for (let s = 0; s < steps; s++) {
    // Where every particle was when this fixed step began.
    for (let i = 0; i < span; i++) mark[i] = pos[at + i]!;

    for (let k = 1; k <= ROPE_SUBSTEPS; k++) {
      const t = (s * ROPE_SUBSTEPS + k) / micro;
      seat(pos, prev, at, fromAx + (ax - fromAx) * t, fromAy + (ay - fromAy) * t);
      seat(pos, prev, last, fromBx + (bx - fromBx) * t, fromBy + (by - fromBy) * t);
      integrate(pos, prev, at, last);
      project(pos, at, last, link);
      // Step 4, and last of the four so that whatever the frame hands the
      // renderer is a rope that is *outside* the things it crosses. Projection
      // afterwards would put a link's worth of it back inside, one micro-step
      // out of every sixteen, which reads as a rope that flickers through the
      // photograph it is resting on.
      //
      // Every micro-step rather than once per fixed step, which is sixteen
      // times the work and is the difference between resting and vibrating: a
      // fixed step is enough gravity to sink a particle a visible fraction of a
      // unit, and a rope that falls in and is fished out again once a step
      // never stops moving, so it never sleeps.
      if (drape !== null) drape.resolve(pos, prev, at, count);
    }

    for (let i = 2; i < span - 2; i += 2) {
      const dx = pos[at + i]! - mark[i]!;
      const dy = pos[at + i + 1]! - mark[i + 1]!;
      const moved = dx * dx + dy * dy;
      if (moved > worst) worst = moved;
    }
  }
  return Math.sqrt(worst);
}

/** Put one end on its pin, with no velocity of its own — endpoints are
 *  driven, never integrated. */
function seat(
  pos: Float64Array,
  prev: Float64Array,
  i: number,
  x: number,
  y: number,
): void {
  pos[i] = x;
  pos[i + 1] = y;
  prev[i] = x;
  prev[i + 1] = y;
}

/** `next = pos + (pos - prev) * damping + gravity * h^2`, interior only. */
/**
 * Give one particle some velocity, in board units per second.
 *
 * A position-based solver has no velocities to add to — the velocity of a
 * particle *is* `pos - prev`, so an impulse is a displacement of where it came
 * from. Which micro-step that difference is measured over is this module's
 * business and nobody else's, which is why the conversion is here rather than
 * at the call site: `sim/ropes.ts` decides which particles are plucked and
 * which way, and does not need to know the solver substeps sixteen times.
 *
 * Added rather than assigned, because an impulse is an impulse: plucking a
 * ringing string again makes it ring harder, which is what a string does.
 *
 * Only `prev` is touched: the particle stays exactly where it is and merely
 * arrives there travelling.
 */
export function nudge(prev: Float64Array, i: number, vx: number, vy: number): void {
  prev[i] = prev[i]! - vx * MICRO_H;
  prev[i + 1] = prev[i + 1]! - vy * MICRO_H;
}

function integrate(pos: Float64Array, prev: Float64Array, at: number, last: number): void {
  for (let i = at + 2; i < last; i += 2) {
    const x = pos[i]!;
    const y = pos[i + 1]!;
    pos[i] = x + (x - prev[i]!) * MICRO_DAMPING;
    pos[i + 1] = y + (y - prev[i + 1]!) * MICRO_DAMPING + MICRO_GRAVITY;
    prev[i] = x;
    prev[i + 1] = y;
  }
}

/**
 * Project every link back to its rest length, alternating sweep direction so
 * both anchors get their pull carried the length of the rope.
 *
 * A link with a fixed end gives that end's half of the correction to the other
 * one, which is what "infinite mass" means in a solver that only has
 * positions. Both ends fixed — a two-particle rope — never reaches here.
 */
function project(pos: Float64Array, at: number, last: number, link: number): void {
  for (let iter = 0; iter < ROPE_ITERATIONS; iter++) {
    if (iter % 2 === 0) {
      for (let i = at; i < last; i += 2) relax(pos, i, at, last, link);
    } else {
      for (let i = last - 2; i >= at; i -= 2) relax(pos, i, at, last, link);
    }
  }
}

function relax(pos: Float64Array, i: number, at: number, last: number, link: number): void {
  const j = i + 2;
  const dx = pos[j]! - pos[i]!;
  const dy = pos[j + 1]! - pos[i + 1]!;
  const d = Math.hypot(dx, dy);
  // Two particles exactly on top of each other have no direction to be pushed
  // apart along. It takes a pathological drag to arrange and the next
  // micro-step of gravity separates them, so leaving the link alone for one
  // pass is cheaper and steadier than inventing an axis.
  if (d === 0) return;

  const scale = (d - link) / d;
  const headFixed = i === at;
  const tailFixed = j === last;
  const wHead = headFixed ? 0 : tailFixed ? 1 : 0.5;
  const wTail = tailFixed ? 0 : headFixed ? 1 : 0.5;

  if (wHead !== 0) {
    pos[i] = pos[i]! + dx * scale * wHead;
    pos[i + 1] = pos[i + 1]! + dy * scale * wHead;
  }
  if (wTail !== 0) {
    pos[j] = pos[j]! - dx * scale * wTail;
    pos[j + 1] = pos[j + 1]! - dy * scale * wTail;
  }
}
