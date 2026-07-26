/**
 * Every physics constant, in one place.
 *
 * > All physics constants live in one module with a debug panel bound to them.
 * > Feel is found by fiddling, not by derivation, and the fiddling needs to be
 * > fast. — DESIGN section 5.8
 *
 * The panel is not built yet; the module is, so that when it is there is one
 * object to bind it to rather than a hunt through `sim/`. Ropes (T-38 to T-40)
 * land their constants here too.
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
