/**
 * Every physics constant, in one place.
 *
 * > All physics constants live in one module with a debug panel bound to them.
 * > Feel is found by fiddling, not by derivation, and the fiddling needs to be
 * > fast. — DESIGN section 5.8
 *
 * The panel is `ui/tuning.ts` and it binds to [`TUNABLES`] at the bottom of
 * this file — one list, in this module, so that a value and the range it is
 * sensible over are written down in the same place (T-232).
 *
 * ## Why these are `let`
 *
 * Every value below is a live ESM binding rather than a constant, and the panel
 * writes them through [`setTuning`]. Nothing in `sim/` changes, imports
 * nothing new and knows nothing about a panel: an ES module export is a
 * *binding*, not a copy, so `verlet.ts` reading `ROPE_DAMPING` on the next
 * substep reads whatever this module last put there.
 *
 * That is the whole mechanism, and it is why the alternative — a `TUNING`
 * object every consumer dots into — was not built. It would have put a
 * property load in three hot loops to buy nothing this does not already do.
 *
 * A production build never calls the setter: the panel is behind
 * `import.meta.env.DEV` and is eliminated with the rest of the dev block. So if
 * a bundler decides to inline one of these, the result is the value that is
 * written here, which is the value production has always had.
 *
 * **Nothing derives from these at module load.** A constant computed once from
 * one of them is a value that silently stops agreeing with its own source the
 * first time the panel is touched; `sim/ropes.ts` had exactly one and it is now
 * a function.
 *
 * Units are board units, seconds and radians throughout — never screen pixels
 * and never milliseconds, because the simulation must not change with the zoom
 * or with the frame rate.
 *
 * `SIM_MARGIN` is the one exception and says so in its own comment.
 */

/**
 * The fixed timestep, and the cap on how many of them one frame may run.
 *
 * > Fixed timestep of 1/120 s with an accumulator and a cap of four substeps
 * > per frame, so behaviour doesn't change with frame rate and a stalled tab
 * > doesn't explode on resume. — DESIGN section 5.2
 */
export let SIM_STEP_MS = 1000 / 120;
export let SIM_MAX_SUBSTEPS = 4;

/**
 * Gravity, board units per second squared.
 *
 * Not 9.81 converted. An item arrives about 250 board units across for what is
 * a 130 mm print, so a board unit is about half a millimetre and true gravity
 * would be near 19,000 — which gives a swing period around 0.6 s. That reads as
 * a twitch rather than as weight. This is tuned by feel, as section 5.8 says it
 * should be, to a period a little under a second.
 */
export let GRAVITY = 12000;

/**
 * Damping ratio of the item swing.
 *
 * > Drop the item and it swings, twice or three times, and settles.
 * > — DESIGN section 5.5
 *
 * Which is what this number *is*: `exp(-zeta * pi)` is how much of the swing
 * survives each half-cycle, and at 0.26 that is 0.44 — so the third swing back
 * is under a tenth of the first and there is no fourth worth watching. Under
 * about 0.1 it rings for ten seconds; over about 0.4 it slumps into place with
 * one lean and never really swings.
 */
export let SWING_DAMPING = 0.26;

/**
 * Ceiling on the swing's natural frequency, radians per second.
 *
 * A pin pushed through the very corner of a small scrap is a short, stiff
 * pendulum, and nothing stops a peer writing a pin position that makes it
 * shorter still. Past about 14 rad/s a swing stops reading as a swing and
 * starts reading as a flicker, and it is also where a 120 Hz integrator starts
 * to lose accuracy.
 */
export let SWING_MAX_RATE = 14;

/**
 * When a swing is over.
 *
 * > Sleep when the largest particle movement stays under about 0.05 px for 12
 * > consecutive frames. — DESIGN section 5.3
 *
 * The same shape of rule, in the units this has: an angle nobody could see on
 * the corner of the largest item, an angular rate to match, and twelve
 * consecutive **substeps** — a tenth of a second at the fixed timestep.
 */
export let SWING_SLEEP_ANGLE = 3e-4;
export let SWING_SLEEP_RATE = 4e-3;
export let SWING_SLEEP_STEPS = 12;

/**
 * How far apart rope particles sit, board units.
 *
 * > Working numbers, to be tuned: particles spaced 10-14 board units, so
 * > 12-20 per segment. — DESIGN section 5.2
 *
 * It is a target rather than a rule: a segment gets a whole number of links,
 * so the real spacing lands wherever dividing the rest length by the nearest
 * count puts it. Raising this is the first thing to reach for if ropes ever
 * cost too much, and the last thing to reach for if a fold looks blocky —
 * a rope cannot turn tighter than one link.
 */
export let ROPE_SPACING = 12;

/**
 * How much of a rope particle's velocity survives each 1/120 s step.
 *
 * > damping around 0.98 — DESIGN section 5.2
 *
 * A half-life of about three hundredths of a second: a disturbed string rings
 * a few times and stops. This is the whole of the rope's energy loss — no air
 * drag term and no per-constraint damping, because at 120 Hz this one number
 * already does the job both of them would.
 *
 * Quoted per fixed step and not per micro-step, so that it stays a statement
 * about *time* if `ROPE_SUBSTEPS` is ever retuned. `sim/verlet.ts` takes the
 * appropriate root.
 */
export let ROPE_DAMPING = 0.98;

/**
 * How the rope solver spends its budget: micro-steps inside each fixed 1/120 s
 * step, and constraint passes inside each of those.
 *
 * DESIGN section 5.2 offers "6 constraint iterations" as a working number, and
 * measured against `catenary.ts` it is nowhere near enough — a rope settles
 * **23% longer than its own rest length** and hangs 19 board units below where
 * the analytic pose says it should. That is not a transient: position-based
 * dynamics holds a load by holding a violation, so the stretch is permanent
 * and 6 passes are simply too soft to carry a chain's weight to its anchors.
 *
 * Iterating harder is the obvious fix and the wrong one. Measured on a level
 * span at equal cost — the product of the two numbers below:
 *
 * | micro-steps | passes | residual stretch |
 * |---|---|---|
 * | 1 | 24 | 5.9% |
 * | 4 | 6 | 1.8% |
 * | 12 | 2 | 0.63% |
 * | 24 | 1 | 0.17% |
 *
 * Thirty-five times better for the same arithmetic, which is the standard
 * result: substepping beats iterating for stiff systems, because halving the
 * step quarters the violation the passes have to clear.
 *
 * 16 and 2 is where that lands, and it is a budget decision rather than a
 * quality one. The residual is 0.35% on a short rope and 0.6% on the longest
 * ones — under a tenth of a board unit per link, with the rope as a whole
 * hanging within one board unit of the analytic pose, which is invisible.
 * Doubling to 32 would quarter that, but a hundred awake ropes already cost
 * **5.8 ms a frame** here.
 *
 * So this is the dial, in both directions: cost is linear in the product,
 * error falls with the square of the first number. The normal case — DESIGN
 * section 5.3's "between zero and four awake at any moment" — costs a quarter
 * of a millisecond, so the headroom that matters is all at the far end.
 *
 * ## What `ROPE_ITERATIONS` counts now (T-147)
 *
 * Newton steps on the chain's tridiagonal constraint system, not Gauss-Seidel
 * passes over the links. The table above was measured against the relaxation
 * that used to be here and the *shape* of its argument still holds — the
 * substep count is the dial worth turning — but the residuals in it are long
 * gone: a direct solve leaves the settled rope within a part in eight thousand
 * of the analytic pose instead of a part in seventy-four, on the longest ropes
 * a real board has. `stretch.test.ts` is the current measurement.
 *
 * Two rather than one because the distance constraint is non-linear — the link
 * directions move as the solve corrects them — so the second step cleans up
 * what the first one's linearisation left. A third changes nothing measurable.
 */
export let ROPE_SUBSTEPS = 16;
export let ROPE_ITERATIONS = 2;

/**
 * When a rope is finished moving.
 *
 * > Sleep when the largest particle movement stays under about 0.05 px for 12
 * > consecutive frames. Cache the pose and stop stepping.
 * > — DESIGN section 5.3
 *
 * Board units, not screen pixels — the same value at every zoom, because a
 * simulation that slept differently depending on the camera would settle
 * ropes at different shapes depending on how far you happened to be zoomed
 * in. The two are the same thing at 100%, which is what DESIGN is quoting.
 */
export let ROPE_SLEEP_MOVE = 0.05;
export let ROPE_SLEEP_STEPS = 12;

/**
 * How fast a string turns into a different material, in sag-multiplier units
 * per second.
 *
 * This constant exists because of what position-based dynamics *is*. The solver
 * does not push a particle toward where it should be, it moves it there — so
 * shortening a rope's rest length by two thirds and letting the constraint
 * passes see it snaps the belly up in a single frame. Measured before this was
 * here: 87 board units in one frame, on a rope that had been asleep. That is
 * not a stiff string, it is a cut, and it is the exact failure AC-269 names.
 *
 * A slack change gets away without one only because the gesture behind it is a
 * wheel, which arrives in small increments; picking *Wire* off a menu delivers
 * the whole change at once and has to be paced by the simulation instead.
 *
 * The number is measured rather than chosen, because the rope's answer to a
 * shrinking rest length is not linear in it — the belly comes up slowly and
 * then all at once, so the *peak* frame is what matters and the average says
 * nothing about it. Measuring the largest single-frame share of the whole
 * excursion, across the five transitions that differ most:
 *
 * | rate | worst frame, as a share of the move | slowest transition |
 * |---|---|---|
 * | no ease | ~100% | one frame |
 * | 4.6 | 22% | 0.25 s |
 * | 2.6 | 17% | 0.44 s |
 * | 1.8 | 12% | 0.64 s |
 * | 1.2 | 14% | 0.96 s |
 *
 * 1.8 is the knee: below it the curve stops paying and the wait starts being
 * one. So the worst frame of the worst transition carries an eighth of the
 * move, string→wire takes about a third of a second, and only wire→yarn — the
 * two far ends of `lib/material.ts`'s 0.35 to 1.5 — takes two thirds.
 *
 * Linear rather than exponential precisely because it *finishes*: an asymptote
 * would leave the rope a hair off its material forever, awake and never
 * sleeping, which is the one thing DESIGN section 5.3 will not have.
 */
export let MATERIAL_EASE = 1.8;

/**
 * How far past the edge of the screen the simulation keeps running, as a
 * fraction of the viewport.
 *
 * > SIM — step awake ropes and swings within the viewport margin; sleep checks
 * > — DESIGN section 6.3, phase 3
 *
 * The one dimensionless number in this file, and it is here rather than beside
 * the camera because it is a *simulation* policy — how much work to do — and
 * section 5.8 wants every such dial in one place. The rect itself is the
 * caller's to compute; `sim/` is handed a board-space box and never learns
 * what a camera is.
 *
 * 0.2 is the number `render/cull.ts` already uses for mounting (DESIGN section
 * 9.1's "viewport expanded by 20%"), and matching it is the point: a rope
 * cannot be drawn by an item that is not mounted, so simulating out to exactly
 * the mount margin means nothing visible is ever frozen. It also buys the case
 * that actually matters — a rope disturbed just off the edge has a fifth of a
 * screen of panning to settle in before you can see it.
 */
export let SIM_MARGIN = 0.2;

/**
 * The ceiling on rope particles stepped in one frame.
 *
 * > A global cap on awake particles, prioritised by on-screen area, means a
 * > pathological board degrades gracefully instead of dropping frames.
 * > — DESIGN section 9.2
 *
 * Derived rather than chosen: section 9's budget is "60 fps with 300 visible
 * items and 100 awake ropes", `ROPE_SPACING` puts about twenty particles on a
 * rope of ordinary length, and `ROPE_SUBSTEPS` above records that hundred
 * costing 5.8 ms a frame. So this is the budget's own figure, in the unit the
 * solver's cost is actually linear in — a hundred long ropes and three hundred
 * short ones are not the same work, and counting ropes would call them equal.
 *
 * Nothing normal comes near it. DESIGN section 5.3's "between zero and four
 * awake at any moment" is under a hundred particles; this is the backstop for
 * the board that has gone wrong, not a limit anyone should meet.
 */
export let MAX_AWAKE_PARTICLES = 2000;

// --- the panel's half ------------------------------------------------------

/**
 * One dial: what it is called, what it may be set to, and the two closures
 * that reach the binding above.
 *
 * `read`/`write` rather than a key into an object, because the values *are*
 * module bindings and there is no object to index. That is the trade the file
 * header describes, and this is where it is paid — seventeen pairs of closures
 * in one table, against a property load in the solver's inner loop.
 */
export interface Knob {
  /** The exported name, which is also what the panel labels it with. */
  readonly key: string;
  /** What it does, in the fewest words that are still true. */
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /**
   * What changing it will *not* do, for the dials whose effect is not
   * immediate. Shown under the row, because a knob that appears to do nothing
   * is worse than one that is not there.
   */
  readonly lag?: string;
  read(): number;
  write(value: number): void;
}

function knob(
  key: string,
  label: string,
  range: { min: number; max: number; step: number; lag?: string },
  read: () => number,
  write: (value: number) => void,
): Knob {
  return { key, label, ...range, read, write };
}

/**
 * Every dial in this file, in the order the simulation uses them: the clock,
 * the swing, the rope, then the two policies about how much work to do.
 *
 * The ranges are not guesses. Each one spans the territory the comment above
 * the value argues over — `SWING_DAMPING` stops at 0.8 because past 0.4 it
 * "slumps into place with one lean", `ROPE_SUBSTEPS` reaches 32 because the
 * table above says doubling to it is the next rung — so the ends of a slider
 * are the ends of the useful range rather than the ends of the number line.
 */
export const TUNABLES: readonly Knob[] = [
  knob(
    "SIM_STEP_MS",
    "fixed timestep",
    { min: 1000 / 240, max: 1000 / 45, step: 0.05, lag: "ropes already asleep keep their old pose" },
    () => SIM_STEP_MS,
    (v) => (SIM_STEP_MS = v),
  ),
  knob("SIM_MAX_SUBSTEPS", "substep cap per frame", { min: 1, max: 8, step: 1 },
    () => SIM_MAX_SUBSTEPS, (v) => (SIM_MAX_SUBSTEPS = v)),
  knob("GRAVITY", "gravity", { min: 0, max: 40000, step: 250 },
    () => GRAVITY, (v) => (GRAVITY = v)),
  knob("SWING_DAMPING", "swing damping ratio", { min: 0.02, max: 0.8, step: 0.01 },
    () => SWING_DAMPING, (v) => (SWING_DAMPING = v)),
  knob("SWING_MAX_RATE", "swing rate ceiling", { min: 2, max: 30, step: 0.5 },
    () => SWING_MAX_RATE, (v) => (SWING_MAX_RATE = v)),
  knob("SWING_SLEEP_ANGLE", "swing sleep angle", { min: 1e-5, max: 3e-3, step: 1e-5 },
    () => SWING_SLEEP_ANGLE, (v) => (SWING_SLEEP_ANGLE = v)),
  knob("SWING_SLEEP_RATE", "swing sleep rate", { min: 1e-4, max: 3e-2, step: 1e-4 },
    () => SWING_SLEEP_RATE, (v) => (SWING_SLEEP_RATE = v)),
  knob("SWING_SLEEP_STEPS", "swing sleep substeps", { min: 1, max: 60, step: 1 },
    () => SWING_SLEEP_STEPS, (v) => (SWING_SLEEP_STEPS = v)),
  knob(
    "ROPE_SPACING",
    "particle spacing",
    { min: 4, max: 40, step: 1, lag: "a rope keeps the particle count it was seeded with" },
    () => ROPE_SPACING,
    (v) => (ROPE_SPACING = v),
  ),
  knob("ROPE_DAMPING", "rope damping per step", { min: 0.8, max: 1, step: 0.001 },
    () => ROPE_DAMPING, (v) => (ROPE_DAMPING = v)),
  knob("ROPE_SUBSTEPS", "rope micro-steps", { min: 1, max: 32, step: 1 },
    () => ROPE_SUBSTEPS, (v) => (ROPE_SUBSTEPS = v)),
  knob("ROPE_ITERATIONS", "Newton steps per micro-step", { min: 1, max: 8, step: 1 },
    () => ROPE_ITERATIONS, (v) => (ROPE_ITERATIONS = v)),
  knob("ROPE_SLEEP_MOVE", "rope sleep movement", { min: 0.005, max: 0.5, step: 0.005 },
    () => ROPE_SLEEP_MOVE, (v) => (ROPE_SLEEP_MOVE = v)),
  knob("ROPE_SLEEP_STEPS", "rope sleep steps", { min: 1, max: 60, step: 1 },
    () => ROPE_SLEEP_STEPS, (v) => (ROPE_SLEEP_STEPS = v)),
  knob("MATERIAL_EASE", "material change rate", { min: 0.2, max: 8, step: 0.1 },
    () => MATERIAL_EASE, (v) => (MATERIAL_EASE = v)),
  knob("SIM_MARGIN", "simulated margin, viewports", { min: 0, max: 1, step: 0.05 },
    () => SIM_MARGIN, (v) => (SIM_MARGIN = v)),
  knob("MAX_AWAKE_PARTICLES", "awake particle cap", { min: 100, max: 20000, step: 100 },
    () => MAX_AWAKE_PARTICLES, (v) => (MAX_AWAKE_PARTICLES = v)),
];

/**
 * What every dial was set to when this module loaded — the numbers argued for
 * in the comments above, and the only place they are recorded once the panel
 * has been touched.
 *
 * Captured here rather than written out a second time, so a value and its
 * default cannot drift apart.
 */
const DEFAULTS: ReadonlyMap<string, number> = new Map(TUNABLES.map((k) => [k.key, k.read()]));

/**
 * Set one dial, clamped to its own range and quantised to its own step.
 *
 * Clamped rather than rejected: this is reached from a slider, and a slider
 * cannot ask for anything outside its range in the first place. The clamp is
 * for the other caller — a test, or a console — and for the day a range is
 * narrowed under a value somebody already had. Returns what was actually
 * written, which is what the panel puts in its readout.
 *
 * A step of `1e-5` and a value of `3e-4` do not divide cleanly in binary, so
 * the quantised result is rounded back to the step's own precision. Without
 * that, a slider at the default shows `0.00030000000000000003`.
 */
export function setTuning(key: string, value: number): number {
  const dial = TUNABLES.find((k) => k.key === key);
  if (dial === undefined) throw new Error(`no such tuning value: ${key}`);
  if (!Number.isFinite(value)) return dial.read();
  const clamped = Math.min(dial.max, Math.max(dial.min, value));
  const stepped = Math.round(clamped / dial.step) * dial.step;
  const decimals = Math.max(0, Math.ceil(-Math.log10(dial.step)));
  const exact = Number(stepped.toFixed(decimals));
  dial.write(exact);
  return exact;
}

/** Put every dial back to the value its own comment argues for. */
export function resetTuning(): void {
  for (const dial of TUNABLES) dial.write(DEFAULTS.get(dial.key)!);
}

/** Whether anything has been moved off its default — the panel's reset row. */
export function tuningChanged(): boolean {
  return TUNABLES.some((dial) => dial.read() !== DEFAULTS.get(dial.key));
}
