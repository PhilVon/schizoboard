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
 * Step 2 is no longer iterative relaxation and step 4 no longer exists. The
 * chain's constraints form a tridiagonal system, which is solved directly —
 * see "Why the constraints are solved rather than relaxed" below, and T-147
 * for the bug that forced it.
 *
 * Step 4 is not here, and is not anywhere: draping was built and then scrapped
 * (D-22). An `over` string draws above the item layer and passes over whatever
 * it crosses, so the solver has three steps and no seam for a fourth.
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
 * ## Why the constraints are solved rather than relaxed
 *
 * A hanging chain carries its weight to the anchors. Gravity displaces every
 * particle equally, which violates nothing in the middle — a uniform shift
 * leaves interior link lengths untouched — and violates exactly the two links
 * next to the fixed ends. The correction has to travel from there inward.
 *
 * Relaxation carries it slowly. A Gauss-Seidel sweep moves an anchor's pull
 * along by one link per pass, so on a long rope the middle does not hear about
 * the ends within a micro-step, and the pose it settles in hangs below the one
 * `catenary.ts` predicts by an amount that grows with the particle count —
 * roughly with its square, since the tension a link carries is the weight of
 * everything below it. That was T-147, and on a real board it was a string
 * that visibly jumped whenever a zoom re-seeded it.
 *
 * But a chain is a *tridiagonal* system: constraint `k` touches particles `k`
 * and `k+1`, so it shares a variable only with its two neighbours. That has an
 * exact O(N) solution, and `project` below takes it — one forward pass and one
 * backward one, tension carried the whole length of the rope, for about what
 * two relaxation sweeps used to cost. `ROPE_ITERATIONS` is now how many Newton
 * steps that solve takes, and 2 is enough because the constraint is only
 * mildly non-linear at a micro-step's worth of motion.
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
 * Put every link back on its rest length by solving the whole chain at once.
 *
 * ## Why this is not a relaxation sweep any more (T-147)
 *
 * It was, for four phases: two Gauss-Seidel passes, alternating direction so
 * each anchor's pull was carried the length of the rope. That leaves a rope
 * hanging *below* the pose `catenary.ts` predicts, because position-based
 * dynamics holds a load by holding a violation — and the size of it turned out
 * to scale with how many particles the rope is carrying, roughly with the
 * square. The tension a link has to hold is the weight of everything below it,
 * so it grows with the count; a sweep carries an anchor's pull two links, so
 * on a hundred-particle rope the middle never hears about the ends within a
 * micro-step at all. A part in four hundred at 41 particles, a part in
 * seventy-four at 151, and visible on a real board as a string that jumped
 * whenever the camera re-rastered and re-seeded it. `stretch.test.ts` is the
 * measurement; D-23 is the hunt.
 *
 * Iterating harder fixes it — 24 passes instead of 2 — and costs twelve times
 * the solve on exactly the ropes that are already the dearest. Three cheaper
 * stiffenings were measured and every one of them bought this number by
 * breaking one somebody had already chosen: a long-range attachment flattens
 * the pluck and the moved-pin walk, over-relaxation overshoots links so the rope
 * comes out *shorter* than its rest length, and more micro-steps disturb the
 * sleep constants tuned around them. (The pluck itself is gone as of T-148;
 * the measurement stands, and it is why this is a direct solve.)
 *
 * ## A chain is a tridiagonal system, so solve it as one
 *
 * Constraint `k` is `|p(k+1) - p(k)| - L`. It touches two particles, so
 * constraints `k` and `k+1` share exactly one and constraints further apart
 * share none — which means the system matrix `A = J W J^T` has a diagonal, one
 * band either side of it, and nothing else. That is a shape with an exact O(N)
 * solution, the Thomas algorithm, and it costs about what two sweeps cost.
 *
 *     A[k][k]   = w(k) + w(k+1)
 *     A[k][k+1] = -w(k+1) * (n(k) . n(k+1))
 *     A lambda  = -C,   then  dp(i) = w(i) * (lambda(i-1) n(i-1) - lambda(i) n(i))
 *
 * So the anchors' pull reaches the middle of the rope in one forward and one
 * backward pass rather than two links at a time. It is the same Lagrange
 * system the relaxation was approximating; it is only that a chain is one of
 * the few shapes where you can just *solve* it.
 *
 * `w` is the inverse mass, which is 1 for an interior particle and 0 for an
 * endpoint — the same "infinite mass" the sweep expressed by giving a fixed
 * end's share of a correction to the other end. The actual mass cancels: scale
 * every `w` and `lambda` scales inversely, leaving `dp` where it was.
 *
 * ## Which is XPBD, arrived at from the other side
 *
 * `EPSILON` on the diagonal is exactly XPBD's `alpha / h^2`, and this routine
 * is the XPBD system solved directly instead of by relaxation. XPBD's own
 * update is what you get by doing one Gauss-Seidel step on this matrix, which
 * is why adopting it alone changed nothing measurable: at zero compliance it is
 * algebraically the sweep that was already here. The win was never the
 * formulation, it was refusing to iterate on a system this well-shaped.
 *
 * The regularisation is not optional. A perfectly straight chain makes
 * neighbouring constraint gradients parallel, the band terms reach the
 * diagonal, and the matrix goes singular — a taut rope is exactly the pose
 * where the solve would divide by nothing. A hair of compliance keeps it
 * definite and is a rope that is very slightly stretchy, which is what a rope
 * is.
 */
function project(pos: Float64Array, at: number, last: number, link: number): void {
  const count = (last - at) / 2 + 1;
  const links = count - 1;
  if (links < 1) return;
  grow(links);

  for (let pass = 0; pass < ROPE_ITERATIONS; pass++) {
    if (!build(pos, at, links, link)) return;
    thomas(links);
    apply(pos, at, links);
  }
}

/**
 * The chain's normals, its violations, and the band of the matrix, for the
 * positions as they stand right now.
 *
 * Returns false if any link has collapsed to a point: there is no direction to
 * push along, the next micro-step of gravity separates them, and inventing an
 * axis is worse than leaving the whole solve for one step. It takes a
 * pathological drag to arrange at all.
 */
function build(pos: Float64Array, at: number, links: number, link: number): boolean {
  for (let k = 0; k < links; k++) {
    const i = at + k * 2;
    const dx = pos[i + 2]! - pos[i]!;
    const dy = pos[i + 3]! - pos[i + 1]!;
    const d = Math.hypot(dx, dy);
    if (d === 0) return false;
    nx[k] = dx / d;
    ny[k] = dy / d;
    // The right-hand side is -C: how far this link is from its rest length,
    // negated, because the correction has to cancel the violation.
    rhs[k] = link - d;
  }

  for (let k = 0; k < links; k++) {
    // Inverse mass of the two particles this link joins. The first and last
    // particle of the rope are pinned, so they take none of the correction.
    const wHead = k === 0 ? 0 : 1;
    const wTail = k === links - 1 ? 0 : 1;
    diag[k] = wHead + wTail + EPSILON;
    // Coupling to the next constraint, through the particle they share.
    if (k < links - 1) band[k] = -wTail * (nx[k]! * nx[k + 1]! + ny[k]! * ny[k + 1]!);
  }
  return true;
}

/**
 * Thomas: forward elimination then back substitution, on a symmetric
 * tridiagonal system. `scratch` carries the modified band, `mult` the modified
 * right-hand side, and `lambda` comes back holding the multipliers.
 */
function thomas(links: number): void {
  let denominator = diag[0]!;
  scratch[0] = (band[0] ?? 0) / denominator;
  mult[0] = rhs[0]! / denominator;
  for (let k = 1; k < links; k++) {
    const above = band[k - 1]!;
    denominator = diag[k]! - above * scratch[k - 1]!;
    scratch[k] = (band[k] ?? 0) / denominator;
    mult[k] = (rhs[k]! - above * mult[k - 1]!) / denominator;
  }
  lambda[links - 1] = mult[links - 1]!;
  for (let k = links - 2; k >= 0; k--) lambda[k] = mult[k]! - scratch[k]! * lambda[k + 1]!;
}

/**
 * `dp(i) = w(i) * (lambda(i-1) n(i-1) - lambda(i) n(i))` — each particle takes
 * the pull of the link behind it and the push of the one in front.
 *
 * Interior particles only. The endpoints are seated on their pins every
 * micro-step and carry zero inverse mass, so their correction is zero by
 * construction and writing it would only cost the multiply.
 */
function apply(pos: Float64Array, at: number, links: number): void {
  for (let k = 1; k < links; k++) {
    const i = at + k * 2;
    const behind = lambda[k - 1]!;
    const ahead = lambda[k]!;
    pos[i] = pos[i]! + behind * nx[k - 1]! - ahead * nx[k]!;
    pos[i + 1] = pos[i + 1]! + behind * ny[k - 1]! - ahead * ny[k]!;
  }
}

/**
 * A hair of compliance on the diagonal.
 *
 * Small enough that a rope's stretch stays far under the part in three hundred
 * `stretch.test.ts` asks for, large enough that a taut chain — where
 * neighbouring gradients line up and the band terms reach the diagonal — stays
 * a matrix that can be solved rather than one that divides by nothing.
 */
const EPSILON = 1e-6;

/**
 * The solver's working set: one chain's worth, module-level and grown on
 * demand, exactly like `mark` above and for the same reason — a rope is solved
 * to completion before the next one starts, so one set serves the board and
 * nothing allocates per rope per frame.
 */
let nx = new Float64Array(0);
let ny = new Float64Array(0);
let rhs = new Float64Array(0);
let diag = new Float64Array(0);
let band = new Float64Array(0);
let scratch = new Float64Array(0);
let mult = new Float64Array(0);
let lambda = new Float64Array(0);

function grow(links: number): void {
  if (nx.length >= links) return;
  nx = new Float64Array(links);
  ny = new Float64Array(links);
  rhs = new Float64Array(links);
  diag = new Float64Array(links);
  band = new Float64Array(links);
  scratch = new Float64Array(links);
  mult = new Float64Array(links);
  lambda = new Float64Array(links);
}
