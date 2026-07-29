/**
 * Deterministic per-item variation.
 *
 * Lives in `lib/` rather than `render/` because both sides of the one-way
 * data flow need it and neither may import the other. `scatterAngle` produces
 * the *authored* rotation stored in `item.rot`, so `crdt/ops/` calls it at
 * creation; everything else here is a render derivation. `lib/` is
 * dependency-free primitives, importable by anyone.
 *
 * docs/DATA-MODEL.md section 3: `item.seed` is "assigned once at creation,
 * never changed", and drives *all* of it — scatter rotation, paper grain
 * offset, edge raggedness, ageing, handwriting jitter.
 *
 * One seed, many independent streams. The trick is the salt: `rng(seed, "edge")`
 * and `rng(seed, "age")` must be uncorrelated, or the raggedness of an item's
 * edge would predict how yellowed it is, and a board would look subtly
 * patterned in a way nobody could name.
 *
 * Everything here is a pure function of `(seed, salt, index)`. Nothing caches,
 * nothing counts calls, nothing depends on render order — because the one
 * requirement that matters is stability:
 *
 * > Jitter is seeded per character index so it's stable across re-renders —
 * > text that shimmers when you scroll past is worse than no jitter at all.
 * > — DESIGN section 3.6
 */

/** Small, fast, and good enough for texture. Not for anything security-ish. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the salt, mixed into the seed. Cheap and well-spread. */
function saltedSeed(seed: number, salt: string): number {
  let h = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < salt.length; i++) {
    h ^= salt.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** An independent random stream for one aspect of one item. */
export function streamFor(seed: number, salt: string): () => number {
  return mulberry32(saltedSeed(seed, salt));
}

/**
 * A single stable value in [0, 1) for `(seed, salt, index)`.
 *
 * Indexed rather than sequential on purpose. A per-character jitter must be
 * addressable by character index, so that inserting a character at the start
 * of a note does not reshuffle every glyph after it.
 */
export function valueAt(seed: number, salt: string, index = 0): number {
  let h = saltedSeed(seed, salt);
  h = (h + Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Symmetric about zero, in [-amount, amount). */
function signed(value: number, amount: number): number {
  return (value * 2 - 1) * amount;
}

export function newSeed(): number {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0]!;
}

// --- the named derivations ------------------------------------------------

/**
 * "a small random rotation — between about −4° and +4°, seeded per item so
 * it's stable. Nothing arrives straight." (DESIGN section 3.1)
 *
 * Radians, because `item.rot` is radians (DATA-MODEL section 3).
 */
export const SCATTER_DEGREES = 4;

export function scatterAngle(seed: number): number {
  return (signed(valueAt(seed, "scatter"), SCATTER_DEGREES) * Math.PI) / 180;
}

/** Where this item's paper texture is sampled from, so no two sheets match. */
export function grainOffset(seed: number): { x: number; y: number } {
  return {
    x: valueAt(seed, "grain", 0) * 512,
    y: valueAt(seed, "grain", 1) * 512,
  };
}

/**
 * Per-character handwriting jitter. "slight per-character baseline and
 * rotation jitter so it doesn't look typeset" (DESIGN section 3.6).
 *
 * ## Why this is not white noise
 *
 * Independent noise per character is the obvious reading of "per-character
 * jitter" and it is wrong, measurably so. At an amplitude small enough to look
 * natural it is invisible; at any amplitude you can actually see, it reads as a
 * ransom note — because the eye is not looking for movement, it is looking for
 * a letter that has moved away from *both* its neighbours, and independent
 * noise produces one of those every third character.
 *
 * A hand wanders. Its baseline drifts over a few letters and comes back, and
 * neighbouring letters therefore move *together*. So the bulk of the amplitude
 * here is a drift — value noise with a control point every [`DRIFT_CHARS`]
 * characters, cosine-interpolated — and only a little of it is independent.
 * That is what buys an amount large enough to notice and still legible.
 *
 * The two were rendered side by side on the same note before this was written.
 */
export interface CharJitter {
  /**
   * Displacement in `em`, so one set of amounts serves every size text is set
   * at. A note's body is 17px in board units and a polaroid caption is a
   * fraction of its frame; the same absolute nudge is a whisper on one and a
   * stagger on the other, and only the relative one is "slight" on both.
   */
  dx: number;
  dy: number;
  /** Radians. */
  rot: number;
  /** Multiplier around 1. */
  scale: number;
}

/**
 * How many characters one drift control point covers.
 *
 * Four: about a syllable, which is roughly the distance over which a real hand
 * gets away from the line and back. Two is close enough to per-character to
 * bring the ransom note back; eight and a whole word rides up together, which
 * reads as a wonky line rather than as writing.
 */
const DRIFT_CHARS = 4;

/**
 * A smooth signed [-1, 1] wander along the string, stable per index.
 *
 * Cosine rather than linear interpolation, because a linear blend leaves a
 * visible corner at every control point — a kink every fourth letter is its own
 * kind of pattern, and patterns are what all of this exists to avoid.
 */
function drift(seed: number, salt: string, index: number): number {
  const point = Math.floor(index / DRIFT_CHARS);
  const t = (index % DRIFT_CHARS) / DRIFT_CHARS;
  const ease = (1 - Math.cos(t * Math.PI)) / 2;
  const from = signed(valueAt(seed, salt, point), 1);
  const to = signed(valueAt(seed, salt, point + 1), 1);
  return from * (1 - ease) + to * ease;
}

export function charJitter(seed: number, index: number): CharJitter {
  // Rotation is the one that carries an independent term as well. A letter's
  // slant is the part of a hand that really does vary letter to letter, and
  // without it four characters share one angle and the drift starts to show as
  // a wave.
  const slant = drift(seed, "char-rot", index) * 1.25 + signed(valueAt(seed, "char-tilt", index), 0.95);
  return {
    dx: drift(seed, "char-dx", index) * 0.012,
    dy: drift(seed, "char-dy", index) * 0.055,
    rot: (slant * Math.PI) / 180,
    scale: 1 + drift(seed, "char-scale", index) * 0.03,
  };
}

/**
 * Raggedness of one edge, as offsets along it. Index the edge by name so the
 * top of a sheet is not correlated with its left.
 */
export function edgeProfile(seed: number, edge: string, samples: number): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = signed(valueAt(seed, `edge-${edge}`, i), 1);
  }
  return out;
}

/**
 * How worn this item looks, in [0, 1].
 *
 * "deterministic from the item's seed and its age, never random per render"
 * (DESIGN section 4.7). Board time, not wall-clock: an item is as old as the
 * board says it is, so a board opened after a year does not visibly lurch.
 */
export function wear(seed: number, ageInBoardDays: number): number {
  if (ageInBoardDays <= 0) return 0;
  // Different items age at different rates, but all of them slowly.
  const rate = 0.6 + valueAt(seed, "wear") * 0.8;
  return 1 - Math.exp((-ageInBoardDays * rate) / 240);
}
