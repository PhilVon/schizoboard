/**
 * Every physics constant, in one place.
 *
 * > All physics constants live in one module with a debug panel bound to them.
 * > Feel is found by fiddling, not by derivation, and the fiddling needs to be
 * > fast. — DESIGN section 5.8
 *
 * The panel is not built yet; the module is, so that when it is there is one
 * object to bind it to rather than a hunt through `sim/`.
 *
 * Units are board units, seconds and radians throughout — never screen pixels
 * and never milliseconds, because the simulation must not change with the zoom
 * or with the frame rate.
 */

/**
 * The fixed timestep, and the cap on how many of them one frame may run.
 *
 * > Fixed timestep of 1/120 s with an accumulator and a cap of four substeps
 * > per frame, so behaviour doesn't change with frame rate and a stalled tab
 * > doesn't explode on resume. — DESIGN section 5.2
 */
export const SIM_STEP_MS = 1000 / 120;
export const SIM_MAX_SUBSTEPS = 4;

/**
 * Gravity, board units per second squared.
 *
 * Not 9.81 converted. An item arrives about 250 board units across for what is
 * a 130 mm print, so a board unit is about half a millimetre and true gravity
 * would be near 19,000 — which gives a swing period around 0.6 s. That reads as
 * a twitch rather than as weight. This is tuned by feel, as section 5.8 says it
 * should be, to a period a little under a second.
 */
export const GRAVITY = 12000;

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
export const SWING_DAMPING = 0.26;

/**
 * Ceiling on the swing's natural frequency, radians per second.
 *
 * A pin pushed through the very corner of a small scrap is a short, stiff
 * pendulum, and nothing stops a peer writing a pin position that makes it
 * shorter still. Past about 14 rad/s a swing stops reading as a swing and
 * starts reading as a flicker, and it is also where a 120 Hz integrator starts
 * to lose accuracy.
 */
export const SWING_MAX_RATE = 14;

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
export const SWING_SLEEP_ANGLE = 3e-4;
export const SWING_SLEEP_RATE = 4e-3;
export const SWING_SLEEP_STEPS = 12;

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
export const ROPE_SPACING = 12;

/**
 * How much of a rope particle's velocity survives each 1/120 s step.
 *
 * > damping around 0.98 — DESIGN section 5.2
 *
 * A half-life of about three hundredths of a second: a plucked string rings a
 * few times and stops. This is the whole of the rope's energy loss — no air
 * drag term and no per-constraint damping, because at 120 Hz this one number
 * already does the job both of them would.
 *
 * Quoted per fixed step and not per micro-step, so that it stays a statement
 * about *time* if `ROPE_SUBSTEPS` is ever retuned. `sim/verlet.ts` takes the
 * appropriate root.
 */
export const ROPE_DAMPING = 0.98;

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
 * **5.8 ms a frame** here, and T-67 has to fit collision into the same budget.
 * Two passes rather than one because they alternate direction and a rope has
 * an anchor at each end (see `sim/verlet.ts`).
 *
 * So this is the dial, in both directions: cost is linear in the product,
 * error falls with the square of the first number. The normal case — DESIGN
 * section 5.3's "between zero and four awake at any moment" — costs a quarter
 * of a millisecond, so the headroom that matters is all at the far end.
 */
export const ROPE_SUBSTEPS = 16;
export const ROPE_ITERATIONS = 2;

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
export const ROPE_SLEEP_MOVE = 0.05;
export const ROPE_SLEEP_STEPS = 12;
