/**
 * Where a string hangs when nothing has touched it.
 *
 * > **Ropes are seeded analytically, not simulated into place.** On load or
 * > creation, solve the catenary for the segment's chord and rest length,
 * > evaluate it at the particle positions, and mark the rope **asleep
 * > immediately**. A board opens perfectly still. Simulating from a straight
 * > line instead produces a whip-crack across every string every time the file
 * > opens, which looks like a bug and takes half a second to settle.
 * > — DESIGN section 5.3
 *
 * That is AC-62, and this module is the whole of it. It is pure geometry: two
 * endpoints and a rest length in, particle positions out. No scene, no
 * document, no state of its own — so `sim/verlet.ts` can call it to seed a new
 * rope, `sim/ropes.ts` can call it again when a slack change invalidates a
 * pose, and neither has to care that the other did.
 *
 * ## Equal arc length, not equal x
 *
 * The one thing that would quietly break AC-62 is sampling the curve at evenly
 * spaced *x*. The solver in `verlet.ts` holds neighbouring particles a fixed
 * distance apart, so a seed whose spacing is uneven is a seed that violates
 * every distance constraint on frame one — the rope would twitch into shape
 * the moment anything woke it, which is the whip-crack with extra steps. So
 * the sampling here is by **arc length**, and the catenary is one of the very
 * few curves where that costs nothing: parameterised by arc length `s` from
 * its own lowest point it is exactly
 *
 * ```
 *   x(s) = x0 + a * asinh(s / a)
 *   y(s) = y0 + sqrt(a*a + s*s)          // up-positive
 * ```
 *
 * — no integral to invert, no re-parameterisation pass, and `y` does not even
 * need a `cosh`.
 *
 * ## The curve is not the chain — `sampleChain` is what ropes get seeded from
 *
 * A chord is shorter than the arc it spans, by about `l^3 / 24 R^2`. So a
 * polyline sampled at equal arc length has links *shorter* than the rest
 * length the solver holds them at, and once the curve turns tightly relative
 * to the particle spacing that stops being a rounding error. Measured, with
 * particles 12 board units apart: five thousandths of a unit on a lazy span,
 * but **0.7 of a unit** between two pins a couple of inches apart with a good
 * drape in the string, and **1.25** on a steep run. Those are ordinary things
 * to make, and they are twenty times the movement that counts as awake. Seed
 * a rope like that and the solver's first act on waking is to pull every link
 * straight — the whip-crack AC-62 exists to prevent, arriving late rather
 * than on load.
 *
 * So the smooth curve seeds a second, discrete solve. A chain of equal links
 * hanging under gravity has an exact rest pose of its own, and it takes the
 * catenary's shape for the catenary's reason: horizontal tension is constant
 * along it and vertical tension steps by one link's weight at every joint, so
 * link `i` points along `(H, V0 - i)` for just two unknowns. Two endpoint
 * conditions, two unknowns, a symmetric Jacobian, and the continuous solution
 * one paragraph up as the seed. It converges in a handful of iterations onto
 * a pose whose links are the rest length to within a part in a trillion.
 *
 * ## The one shape that has no chain
 *
 * When the curve folds through a radius much under half a link — two pins
 * almost directly above one another, with slack — there is no such chain at
 * all, and no amount of solver is going to find one. A fold costs a link's
 * worth of sideways room to turn around in, a chain in tension can only ever
 * travel one way horizontally, and if the pins are four units apart the room
 * is not there. The `sinh` solve still describes it perfectly, because a
 * curve can turn in zero width; twelve-unit rods cannot.
 *
 * That case falls back to `sampleCatenary`, which draws exactly the right
 * picture and hands the solver a pose it will adjust the first time anything
 * wakes it. Detecting it by letting the solve fail is deliberate: the
 * condition is "no chain closes on both pins", and the honest test for that
 * is trying.
 *
 * `sampleCatenary` is public in its own right too, for anything that wants
 * the smooth curve at arbitrary resolution rather than the chain — a tool
 * preview, a bounds estimate, the reference the chain is tested against.
 *
 * ## Units and orientation
 *
 * Board units throughout, and board space is **y-down**, so gravity is `+y`
 * and "the string sags" means y increases. Everything internal works in an
 * up-positive local frame with the start point at the origin, because that is
 * the frame the textbook catenary is written in; the two flips happen at the
 * edges of `solveCatenary` and `sampleCatenary`.
 */

/**
 * A solved rest pose. Cheap to hold on to and cheap to sample; `sim/ropes.ts`
 * keeps one per segment so a sleeping rope can be re-evaluated at a different
 * particle count without solving again.
 */
export interface Catenary {
  /** Start point, board units. */
  readonly ax: number;
  readonly ay: number;
  /** End point, board units. */
  readonly bx: number;
  readonly by: number;
  /**
   * The arc length the curve actually spans: the rest length, or the chord
   * when the pins have been dragged further apart than that.
   */
  readonly length: number;
  /**
   * The catenary parameter, board units — the radius of curvature at the
   * lowest point. Large is a flat, taut-looking span; small is a deep hang.
   *
   * Two values are sentinels for the degenerate shapes, and both are genuine
   * limits of the same formula rather than special cases bolted on:
   * `Infinity` is a string pulled straight (there is no curve left), and `0`
   * is one whose endpoints are vertically stacked, which hangs as a fold.
   */
  readonly a: number;
  /** Horizontal direction from the start to the end point: `+1` or `-1`. */
  readonly dir: number;
  /**
   * Arc-length coordinate of the start point, measured from the lowest point
   * of the curve — negative when the low point falls between the two ends,
   * which is the usual case. Sampling walks `s` from here to `s0 + length`.
   */
  readonly s0: number;
  /** `asinh(s0 / a)`, kept because sampling needs it on every point. */
  readonly u0: number;
}

/**
 * Below this the series expansion in `invSinhc` is a better seed than any
 * table lookup, and the table starts here rather than at zero — where
 * `z ~ sqrt(6u)` has an infinite slope and no interpolation behaves.
 */
const SERIES_Q = 0.04;

/**
 * The table covers `ln(r)` out to here, which is a chord-to-length ratio of
 * about 1 in 160,000 — far past anything a board can produce that is not
 * already the vertical fold below. Past it, the large-`z` asymptote seeds
 * Newton directly.
 */
const LUT_Q_MAX = 12;

/**
 * The table is keyed on `sqrt(ln r)`, not on `ln r`.
 *
 * The reason is worth the line: near the taut end `z` goes as `sqrt(6 ln r)`
 * and at the deep end it goes as `ln r`, so a table uniform in `ln r` is
 * near-vertical at its left edge and wastes resolution at its right. Keyed on
 * the square root, the same curve is a straight line at the left edge and a
 * gentle parabola at the right — linear interpolation lands within a percent
 * or so across the whole range, which is one Newton step from exact.
 */
const LUT_N = 64;
const LUT_K0 = Math.sqrt(SERIES_Q);
const LUT_K1 = Math.sqrt(LUT_Q_MAX);
const LUT_STEP = (LUT_K1 - LUT_K0) / (LUT_N - 1);

/**
 * Newton stops here. This is a numerical-method constant, not a feel knob, so
 * it stays in this file rather than in `tuning.ts` — nobody is ever going to
 * bind it to the debug panel and drag it.
 */
const NEWTON_TOL = 1e-13;
const NEWTON_MAX = 24;
const CLIMB_MAX = 80;

/**
 * When the endpoints count as vertically stacked, as a fraction of the rest
 * length. At this ratio the true curve is narrower than a thousandth of a
 * board unit on any string a person could make, so the fold below is not an
 * approximation anyone can see — and it keeps `r` bounded, which keeps
 * `sinh` a long way from overflowing.
 */
const FOLD_RATIO = 1e-7;

/**
 * Invert `sinhc`: given `r = sinh(z)/z` with `r >= 1`, return `z >= 0`.
 *
 * This is the only hard part of a catenary and the reason the module has a
 * table at all. There is no closed form, so: seed from the series near the
 * taut end, from the table across the working range, from the large-`z`
 * asymptote past it, then let Newton finish.
 *
 * Newton is safe here for a reason worth writing down. `f(z) = sinh z - r z`
 * has `f(0) = 0`, `f'(0) = 1 - r <= 0` and `f'' = sinh z > 0`, so on `z > 0`
 * it is strictly convex with exactly one root. From any point to the *right*
 * of that root, a convex function's Newton iteration decreases monotonically
 * onto it and cannot overshoot. From the left it can step through zero and
 * away. So the loop below climbs to the right side first and only then
 * iterates — which costs nothing from a good seed and cannot diverge from a
 * bad one.
 */
export function invSinhc(r: number): number {
  const u = r - 1;
  if (!(u > 0)) return 0;

  let z: number;
  const q = Math.log(r);
  if (q <= SERIES_Q) {
    z = seriesSeed(u);
  } else {
    const k = Math.sqrt(q);
    if (k >= LUT_K1) {
      z = asymptoticSeed(r);
    } else {
      const f = (k - LUT_K0) / LUT_STEP;
      const j = Math.min(LUT_N - 2, Math.floor(f));
      z = LUT[j] + (LUT[j + 1] - LUT[j]) * (f - j);
    }
  }
  return refine(r, z);
}

/**
 * `z` near the taut end, by inverting the series for `sinhc`.
 *
 * `sinh(z)/z = 1 + z^2/6 + z^4/120 + z^6/5040`, and inverting that in `z^2`
 * gives `z^2 = 6u - (9/5)u^2 + 0.822857 u^3`. At the `SERIES_Q` cutoff this is
 * good to about five parts in a million, which is already better than the
 * table manages and costs a single square root.
 */
function seriesSeed(u: number): number {
  return Math.sqrt(6 * u * (1 - 0.3 * u + 0.13714285714285715 * u * u));
}

/**
 * `z` at the deep end, where `sinh z` is `e^z / 2` and the equation collapses
 * to `z = ln(2 r z)`. That fixed point converges logarithmically fast from
 * almost anywhere; three passes is plenty for a seed.
 */
function asymptoticSeed(r: number): number {
  let z = Math.log(2 * r) + 1;
  for (let i = 0; i < 3; i++) z = Math.log(2 * r * z);
  return z;
}

/** Climb onto the convex side of the root, then Newton down onto it. */
function refine(r: number, seed: number): number {
  let z = Math.max(seed, 1e-9);
  for (let i = 0; i < CLIMB_MAX && Math.sinh(z) - r * z <= 0; i++) z *= 1.5;
  for (let i = 0; i < NEWTON_MAX; i++) {
    const d = Math.cosh(z) - r;
    if (!(d > 0)) break;
    const step = (Math.sinh(z) - r * z) / d;
    z -= step;
    if (step <= NEWTON_TOL * Math.max(1, z)) break;
  }
  return z;
}

/**
 * Built once at module load, by the same Newton this file ships — so the
 * numbers cannot drift out of agreement with the function they approximate,
 * which a hand-pasted table of sixty-four magic constants eventually would.
 * Sixty-four solves at import is a few microseconds.
 */
const LUT: Float64Array = (() => {
  const table = new Float64Array(LUT_N);
  for (let j = 0; j < LUT_N; j++) {
    const k = LUT_K0 + j * LUT_STEP;
    const r = Math.exp(k * k);
    table[j] = refine(r, k <= LUT_K0 ? seriesSeed(r - 1) : asymptoticSeed(r));
  }
  return table;
})();

/**
 * Solve the rest pose of one segment: a string of `restLength` hung between
 * two pins.
 *
 * Always returns a shape. A string dragged further apart than its rest length
 * is not an error — DESIGN section 5.4 says "don't let the solver fight it",
 * so it comes back taut (`a === Infinity`) and samples as a straight line.
 */
export function solveCatenary(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  restLength: number,
): Catenary {
  const dx = bx - ax;
  const dy = by - ay;
  const chord = Math.hypot(dx, dy);
  const length = restLength;

  if (!(length > chord) || !Number.isFinite(length)) {
    return { ax, ay, bx, by, length: chord, a: Infinity, dir: dx < 0 ? -1 : 1, s0: 0, u0: 0 };
  }

  const d = Math.abs(dx);
  // Up-positive rise from the start point to the end point. `length > chord`
  // above guarantees `length > |rise|`, which is what both branches need.
  const rise = -dy;

  if (d <= length * FOLD_RATIO) {
    // Vertically stacked: the string drops from the upper end and comes back
    // up to the lower one. This is the `a -> 0` limit of the general case and
    // the sampler treats it as exactly that, so only `s0` is needed here —
    // the depth of the fold below the start point.
    return { ax, ay, bx, by, length, a: 0, dir: dx < 0 ? -1 : 1, s0: -(length - rise) / 2, u0: 0 };
  }

  // With half-span `z = d / 2a` and midpoint parameter `m`, the two endpoint
  // conditions separate exactly: `tanh m = rise / length` fixes where along
  // the curve the span sits, and `sinh(z)/z = sqrt(length^2 - rise^2) / d`
  // fixes how deeply it sags. Only the second one needs solving.
  const z = invSinhc(Math.sqrt(length * length - rise * rise) / d);
  if (!(z > 0)) {
    return { ax, ay, bx, by, length: chord, a: Infinity, dir: dx < 0 ? -1 : 1, s0: 0, u0: 0 };
  }

  const a = d / (2 * z);
  const u0 = Math.atanh(rise / length) - z;
  return { ax, ay, bx, by, length, a, dir: dx < 0 ? -1 : 1, s0: a * Math.sinh(u0), u0 };
}

/**
 * Write `count` particle positions along the curve, evenly spaced by **arc
 * length**, as interleaved `x, y` pairs starting at `offset`.
 *
 * The first and last are written from the endpoints directly rather than
 * evaluated, so a seeded rope's ends sit exactly on their pins and the
 * solver's re-pin step has nothing to correct. `count` must be at least 2.
 */
export function sampleCatenary(
  c: Catenary,
  out: Float64Array | Float32Array | number[],
  count: number,
  offset = 0,
): void {
  if (count < 2) throw new RangeError("a rope segment needs at least two particles");

  const { ax, ay, bx, by, a, dir, s0, u0, length } = c;
  const dx = bx - ax;
  const dy = by - ay;
  const last = count - 1;

  if (a === Infinity) {
    // Pulled straight: nothing to solve and nothing to sag.
    for (let i = 1; i < last; i++) {
      const t = i / last;
      out[offset + i * 2] = ax + dx * t;
      out[offset + i * 2 + 1] = ay + dy * t;
    }
  } else if (a === 0) {
    // The fold. `x` still ramps across the (sub-thousandth of a unit) gap so
    // the ends land on their pins; `y` is the `a -> 0` limit of the general
    // case below, where `sqrt(a*a + s*s)` becomes `|s|`.
    const base = Math.abs(s0);
    for (let i = 1; i < last; i++) {
      const t = i / last;
      out[offset + i * 2] = ax + dx * t;
      out[offset + i * 2 + 1] = ay - (Math.abs(s0 + length * t) - base);
    }
  } else {
    const base = Math.hypot(a, s0);
    for (let i = 1; i < last; i++) {
      const s = s0 + (length * i) / last;
      out[offset + i * 2] = ax + dir * a * (Math.asinh(s / a) - u0);
      out[offset + i * 2 + 1] = ay - (Math.hypot(a, s) - base);
    }
  }

  out[offset] = ax;
  out[offset + 1] = ay;
  out[offset + last * 2] = bx;
  out[offset + last * 2 + 1] = by;
}

/**
 * The chain solve stops when both endpoint residuals are inside this fraction
 * of the string's length, or when it has had this many tries and clearly is
 * not going to. Numerical-method constants, not feel — same reasoning as
 * `NEWTON_TOL`.
 */
const CHAIN_TOL = 1e-13;
const CHAIN_MAX = 40;
const CHAIN_BACKTRACK = 40;

/**
 * How far the chain's far end lands from the pin it should, squared — the
 * merit the line search below drives down.
 *
 * The obvious thing to minimise instead is the chain's potential energy,
 * `l * sum(q_i) - h*span - v0*drop`, which is convex and whose gradient is
 * exactly this residual. It was the first thing tried here and it does not
 * work: that number is the length of the whole string, and near the answer
 * it stops falling in double precision long before the residual does, so the
 * search declares itself stuck a ten-thousandth of a board unit out. The
 * residual has no such floor — it converges to zero — and the Newton
 * direction descends on it for the same reason, the Jacobian being symmetric.
 */
function chainMiss(
  h: number,
  v0: number,
  n: number,
  l: number,
  span: number,
  drop: number,
): number {
  let fx = 0;
  let fy = 0;
  for (let i = 0; i < n; i++) {
    const t = v0 - i;
    const q = Math.hypot(h, t);
    fx += h / q;
    fy += t / q;
  }
  fx = l * fx - span;
  fy = l * fy - drop;
  return fx * fx + fy * fy;
}

/**
 * Write `count` particle positions at the rest pose of the **chain** — every
 * link exactly `length / (count - 1)` long, which is exactly what the solver
 * in `verlet.ts` will hold them at. This is the seed AC-62 is about; see the
 * module comment for why it is not just `sampleCatenary`.
 *
 * Falls back to the smooth curve for the shapes that have no chain to find: a
 * string pulled straight, a two-particle segment (one link, which cannot
 * express slack at all), a perfectly vertical fold, and the near-vertical
 * folds described in the module comment — where the turn is tighter than a
 * link can manage and the solve says so by failing to converge.
 */
export function sampleChain(
  c: Catenary,
  out: Float64Array | Float32Array | number[],
  count: number,
  offset = 0,
): void {
  if (count < 2) throw new RangeError("a rope segment needs at least two particles");

  const n = count - 1;
  if (n < 2 || c.a === Infinity || c.a === 0) {
    sampleCatenary(c, out, count, offset);
    return;
  }

  const l = c.length / n;
  const span = Math.abs(c.bx - c.ax);
  const drop = c.by - c.ay;

  // The continuous curve, read as a chain: link `i` covers the arc from
  // `s0 + i*l` to `s0 + (i+1)*l`, so it points along the tangent at that
  // arc's midpoint — which in board space, y-down, is `(a, -s_mid)`.
  let h = c.a / l;
  let v0 = -c.s0 / l - 0.5;

  let solved = false;
  let miss = chainMiss(h, v0, n, l, span, drop);
  for (let iter = 0; iter < CHAIN_MAX && !solved; iter++) {
    let fx = 0;
    let fy = 0;
    let jxx = 0;
    let jxy = 0;
    let jyy = 0;
    for (let i = 0; i < n; i++) {
      const t = v0 - i;
      const q = Math.hypot(h, t);
      const ux = h / q;
      const uy = t / q;
      fx += ux;
      fy += uy;
      jxx += (uy * uy) / q;
      jxy -= (ux * uy) / q;
      jyy += (ux * ux) / q;
    }
    fx = l * fx - span;
    fy = l * fy - drop;
    if (Math.abs(fx) <= CHAIN_TOL * c.length && Math.abs(fy) <= CHAIN_TOL * c.length) {
      solved = true;
      break;
    }
    const det = jxx * jyy - jxy * jxy;
    if (!(det > 0)) break;
    const dh = (jyy * fx - jxy * fy) / (l * det);
    const dv = (jxx * fy - jxy * fx) / (l * det);

    // Backtrack until the far end actually lands closer. Horizontal tension
    // is rejected at or below zero in the same loop — that is the chain
    // turning itself inside out, which is outside the domain rather than
    // merely a bad step.
    let scale = 1;
    let moved = false;
    for (let k = 0; k < CHAIN_BACKTRACK; k++, scale /= 2) {
      const nh = h - scale * dh;
      if (!(nh > 0)) continue;
      const nv = v0 - scale * dv;
      const next = chainMiss(nh, nv, n, l, span, drop);
      if (next < miss) {
        h = nh;
        v0 = nv;
        miss = next;
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }

  if (!solved) {
    sampleCatenary(c, out, count, offset);
    return;
  }

  const dir = c.bx < c.ax ? -1 : 1;
  let x = c.ax;
  let y = c.ay;
  out[offset] = x;
  out[offset + 1] = y;
  for (let i = 0; i < n; i++) {
    const t = v0 - i;
    const q = Math.hypot(h, t);
    x += (dir * l * h) / q;
    y += (l * t) / q;
    out[offset + (i + 1) * 2] = x;
    out[offset + (i + 1) * 2 + 1] = y;
  }
  // The residual is a part in a trillion of the string's length; the pins are
  // where the rope is actually anchored, so they win.
  out[offset + n * 2] = c.bx;
  out[offset + n * 2 + 1] = c.by;
}

/**
 * The largest board `y` the curve reaches — the bottom of it, board space
 * being y-down.
 *
 * `sim/ropes.ts` needs this for the bounds index, and it is worth having in
 * closed form: a segment's bounding box is otherwise only as tight as the
 * particle sampling happens to be, and the sag is exactly the part that hangs
 * outside the box the two endpoints make.
 */
export function catenaryLowestY(c: Catenary): number {
  const ends = Math.max(c.ay, c.by);
  // The lowest point of the curve is only *on* the segment when the span
  // straddles it. A short steep run between two pins can be entirely on one
  // rising flank, and then the lower endpoint is the lowest thing there is.
  if (c.s0 >= 0 || c.s0 + c.length <= 0) return ends;
  return Math.max(ends, c.ay + Math.hypot(c.a, c.s0) - c.a);
}
