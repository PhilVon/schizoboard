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
 * How much of a particle's speed a contact takes away, per micro-step.
 *
 * String on paper does not slide freely, and until this existed the simulation
 * said it did — a contact moved `prev` with `pos` so that the correction added
 * no velocity, which avoids a bounce and also removes nothing. That is only
 * half a contact model, and the missing half is what let ropes run forever:
 * position-based projection puts energy *in* every step (it moves `pos` and not
 * `prev`, so the correction becomes velocity on the next one), a frictionless
 * contact takes none *out*, and a rope pressed against an edge by its own
 * tension churns there for good. It never falls under `ROPE_SLEEP_MOVE`, so it
 * never sleeps, and a permanently awake rope is the one thing DESIGN section
 * 5.3 will not have.
 *
 * Measured, not chosen. Ten geometries with an item planted between a string's
 * two pins — chord through the middle, tall item, wide item, tilted, clipped
 * corner, and so on — counting how many never settle and how long the slowest
 * of the rest takes:
 *
 * | friction | never settle | slowest to settle |
 * |---|---|---|
 * | 0 | **6 of 10** | — |
 * | 0.01 | 2 of 10 | 267 frames |
 * | 0.02 | 0 of 10 | 485 frames |
 * | 0.05 | 0 of 10 | **167 frames** |
 * | 0.1 | 0 of 10 | 180 frames |
 *
 * So 0.05 is the knee: 0.02 clears the board but leaves an eight-second tail,
 * which is too close to the edge to trust, and past 0.05 the string only gets
 * stickier for nothing. Six failures in ten is the number worth keeping in
 * mind — this was not an edge case, it was most of them.
 *
 * Applied per micro-step and only while a particle is actually inside a
 * silhouette, so a rope in free air is untouched and `ROPE_DAMPING` remains the
 * whole of its energy loss. Sixteen micro-steps make a fixed step, so a
 * particle in sustained contact keeps `0.95^16`, a little under half its speed,
 * across one.
 *
 * Isotropic rather than tangential-only, which is a stylisation: real friction
 * acts along the surface and leaves the normal component to the constraint.
 * Splitting the velocity into components costs a dot product and a projection
 * per contact per micro-step, and at these speeds the normal component has
 * already been largely cancelled by the push-out that precedes it.
 */
export const CONTACT_FRICTION = 0.05;

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

/**
 * A pluck: how hard, and how much of the rope feels it.
 *
 * > | Pluck | Click and release without dragging, on a taut string | A
 * > travelling wave runs down it and damps out. Purely for joy
 * > — DESIGN section 3.4
 *
 * Board units per second, like everything else here. A board unit is about
 * half a millimetre (see `GRAVITY`), so 1600 is roughly 0.8 m/s — the speed a
 * real string leaves your fingertip at, which is the number worth starting
 * from even though the only thing that settles it is watching one.
 *
 * The reach is why it is a wave and not a spike. Kicking a single particle
 * gives the solver a kink it clears in one pass, and nothing visible happens;
 * kicking a few either side with a linear falloff gives it a *bump*, which is
 * what propagates. Three either side is about a third of the particles on a
 * short segment and a tenth of a long one, which is the right shape both ways:
 * a pluck is a local event on a long rope and most of a short one.
 */
export const PLUCK_SPEED = 1600;
export const PLUCK_REACH = 3;

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
export const MATERIAL_EASE = 1.8;
