/**
 * Ageing and wear.
 *
 * > Boards accumulate. Items gain, slowly and subtly, over board time rather
 * > than wall-clock time: paper yellowing at the edges, occasional coffee rings,
 * > dog-eared corners, small creases, faint fading on photographs. Ageing is
 * > deterministic from the item's seed and its age, never random per render, and
 * > it is always subtle enough that nobody consciously notices it — they just
 * > find that an old board feels older. — DESIGN section 4.7
 *
 * `lib/seed.ts` already had [`wear`] — one number in [0, 1] off an item's seed
 * and its age, with a per-item rate so no two sheets yellow in step. This file
 * is everything that number then *means*, and it is deliberately the only place
 * that knows: `dom.ts` writes custom properties and `items.css` paints them, and
 * neither has an opinion about how old anything is.
 *
 * ## Two mechanisms, because there are two kinds of ageing here
 *
 * Paper ages by having things *added* to it — light and air darken the fibres
 * from the edges in, a mug leaves a ring, a hand puts a crease in it. Those are
 * overlays, and they are the sheet's own gradients.
 *
 * A photograph ages by *losing* something. The dyes go, cyan first, so a print
 * warms and its blacks lift; the frame it is glued into goes from white to
 * cream. That is a filter, not an overlay, and trying to paint it as one is how
 * you get a photograph with a beige rectangle over it.
 *
 * ## Continuous and discrete
 *
 * Yellowing accrues; a coffee ring happens. Both have to come out of the same
 * monotone number, so the discrete ones are thresholds — each item carries its
 * own, seeded, and the mark grows in over a short band above it rather than
 * appearing between one frame and the next. A board with a hundred sheets on it
 * therefore acquires rings a few at a time and never all at once, and no sheet
 * ever pops.
 *
 * The thresholds are spread past 1 on purpose, which is the whole reason a
 * minority of sheets are ever marked at all: [`wear`] is asymptotic and a
 * realistic old board sits around 0.6, so a threshold band running to 1.55 is
 * how "occasional" is spelled.
 *
 * ## What is not here
 *
 * Dog-ears. DESIGN 4.7 lists them and they are the one item on that list that is
 * not a gradient: a folded corner cuts the silhouette (`edge.ts`) and draws the
 * back of the sheet over the cut, and it has to negotiate with the curl for the
 * same corner. That is its own task (T-190), not a paragraph in this one.
 */

import { valueAt } from "@/lib/seed";
import { counterRotate, LIGHT_DX, LIGHT_DY } from "@/render/items/shadow";
import type { ItemCold } from "@/state/scene";

/**
 * The one number all of this comes off: how worn an item of this seed and this
 * age is, in [0, 1].
 *
 * Re-exported rather than imported directly by the renderer, because this file
 * is where wear *means* something and `lib/seed.ts` is only where the curve
 * lives — the same relationship `edge.ts` has with `edgeProfile`.
 */
export { wear as wearOf } from "@/lib/seed";

/**
 * How old an item is, in board days — [`wearOf`]'s second argument, and the one
 * thing about ageing this directory declines to have an opinion about.
 *
 * A function rather than a number because "how old" is a question about the
 * *clock*, and the clock is a decision above the renderer: wall-clock since the
 * item was made, the count of days the board has been opened since, or open time
 * accumulated (Q-105). Whichever it turns out to be, this seam is the same
 * shape, and the layer's job is unchanged either way — take a number, turn it
 * into a look.
 *
 * It is also where the global switch lands, because DESIGN 4.7's "ageing can be
 * turned off entirely" and "this board is new" are the same picture, and the
 * renderer has no business being able to tell them apart.
 */
export type AgeClock = (cold: ItemCold) => number;

export const NO_AGEING: AgeClock = () => 0;

const DAY_MS = 86_400_000;

/**
 * The clock, as Q-105 settled it: how long ago the item was made, in real days.
 *
 * DESIGN 4.7 asked for board time and 11.2 asked whether board time was needed;
 * the answer is that it is not. What board time buys is that a board left in a
 * drawer for a year does not lurch when it is opened, and what it costs is a
 * clock *in the document* — a periodic write forever, ticking at double speed
 * with two windows open, on a schema field every peer has to agree about. That
 * is a great deal of machinery standing between a sheet of paper and the fact
 * that it is old, and the lurch it avoids happens once, to a board nobody was
 * looking at, over a change nobody is meant to notice anyway.
 *
 * Per item and not per board, which is the half of this that matters more: an
 * old board is not uniformly old. It has a note pinned up two years ago and one
 * added this morning, and the second one being crisp is what makes the first one
 * read as old rather than making the whole board read as sepia.
 *
 * `Date.now()` per call is affordable because a bind is guarded on the wear it
 * last wrote, quantised to hundredths — and at [`wearOf`]'s pace a hundredth is
 * a couple of days, so a window left open all week repaints none of this.
 */
export const WALL_CLOCK: AgeClock = (cold) => (Date.now() - cold.createdAt) / DAY_MS;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * How far above its own threshold a mark has to be before it is fully there.
 *
 * Short, because this is not the effect — the effect is the mark, and the band
 * only exists so that a sheet crossing its threshold does not acquire a coffee
 * ring in one frame. Wear moves at a fraction of this per board day, so in the
 * running application a mark takes weeks to arrive and is never seen doing it.
 */
const FADE_IN = 0.2;

/**
 * A crease: one fold line across the sheet.
 *
 * `rot` is in the sheet's own frame, so a note that was turned keeps its crease
 * where the paper has it. `at` is how far along the gradient's own axis the line
 * sits, as a percentage, which is what lets it be somewhere other than through
 * the middle of everything.
 */
export interface Crease {
  /** How developed, in [0, 1]. Zero means this sheet has no crease. */
  amount: number;
  /** Degrees, in the sheet's frame, as a CSS gradient angle — see [`creaseFace`]. */
  rot: number;
  /** Percent along the fold's normal. */
  at: number;
}

/**
 * How far off the sheet's own axis a fold may lie, in degrees.
 *
 * Small, because **paper folds along an axis**. A sheet doubled over leaves a
 * line parallel to one of its own edges; nobody folds a note corner to corner.
 * A uniform angle over the half circle is the obvious reading of "a crease" and
 * it was visibly wrong on the first board that had one — a long straight line
 * crossing a note at 37 degrees does not read as a fold at all, it reads as a
 * scratch on the lens.
 *
 * Not zero either. A fold made by hand is a few degrees out, and a run of sheets
 * creased at exactly 0 and exactly 90 is a set of rules printed on them.
 */
const CREASE_WANDER = 7;

export function creaseOf(seed: number, wear: number): Crease {
  // A minority start early and everything creases eventually — paper that has
  // been handled for a year has been folded back at least once, which is not
  // true of coffee.
  const threshold = 0.16 + valueAt(seed, "crease-when") * 0.5;
  const axis = valueAt(seed, "crease-axis") < 0.5 ? 0 : 90;
  return {
    amount: clamp01((wear - threshold) / FADE_IN),
    rot: axis + (valueAt(seed, "crease-rot") * 2 - 1) * CREASE_WANDER,
    // Kept off the edges. A fold within a few percent of the side of the sheet
    // is a line along the edge, which reads as a border rather than as a crease.
    at: 28 + valueAt(seed, "crease-at") * 44,
  };
}

/**
 * How lit the far flank of a crease is, in [-1, 1].
 *
 * A fold is a shallow V, so one flank turns into the light and the other away
 * from it, and which is which is a fact about the board rather than about the
 * sheet: a note turned over has its highlight change sides. This is the same
 * calculation `cornerFace` makes for a curling corner and it is here for the
 * same reason — DESIGN 4.1 says nothing breaks the sense of a real surface
 * faster than one element lit from the wrong direction, and a crease whose
 * bright side never moves is exactly that element.
 *
 * The light is counter-rotated into the sheet's frame rather than the crease
 * being rotated out of it, which is what `cornerFace` and `shadow.ts` both do.
 *
 * ## "Far" is the CSS gradient's own direction, and that is not a maths angle
 *
 * [`Crease.rot`] is written straight into `linear-gradient()`, so it is measured
 * the way CSS measures one: clockwise from *to top*. The line the gradient runs
 * along — which is the fold's normal, since the crease itself is the stripe
 * across it — is therefore `(sin, -cos)` in the sheet's y-down frame, and the
 * far flank is the one at the *larger* stop percentage.
 *
 * Reading that angle as a maths angle instead gets a vector at right angles to
 * the truth and negated, which is a highlight on the wrong side of every fold on
 * the board — a mistake with no symptom in any number, only in the pixels.
 */
export function creaseFace(rot: number, creaseRotDegrees: number): number {
  const light = counterRotate(LIGHT_DX, LIGHT_DY, rot);
  const a = (creaseRotDegrees * Math.PI) / 180;
  const nx = Math.sin(a);
  const ny = -Math.cos(a);
  // Minus, because the light vector points the way a shadow goes: a flank
  // tipping that way is tipping away from the light.
  return -(nx * light.x + ny * light.y);
}

/**
 * A coffee ring.
 *
 * Radius in board units and not as a fraction of the sheet, on the same argument
 * `curl.ts` makes for `HOLD_NEAR`: a mug is a mug. A ring that scaled with the
 * paper would be the one detail on the board that tells you a poster is a
 * photographed Post-it.
 */
export interface Stain {
  /** How developed, in [0, 1]. Zero means this sheet has never had a mug on it. */
  amount: number;
  /** Percent across and down the sheet. May sit outside it. */
  x: number;
  y: number;
  /** Board units. */
  r: number;
}

export function stainOf(seed: number, wear: number): Stain {
  // Running well past 1, so most sheets never reach their own: about a quarter
  // of a board sitting at a realistic 0.6 has a ring, which is what DESIGN 4.7
  // means by "occasional".
  const threshold = 0.45 + valueAt(seed, "stain-when") * 1.1;
  return {
    amount: clamp01((wear - threshold) / FADE_IN),
    // Allowed off the sheet on either side, because most of the rings on a real
    // desk are partial — the mug was mostly on the table.
    x: -10 + valueAt(seed, "stain-x") * 120,
    y: -10 + valueAt(seed, "stain-y") * 120,
    r: 32 + valueAt(seed, "stain-r") * 16,
  };
}

/**
 * The dye loss on a photograph and its frame, as a `filter`.
 *
 * Four terms, and each is one thing that happens to a colour print left in the
 * light. Cyan goes first, so the picture warms and desaturates; the blacks lift,
 * which is a contrast loss rather than a brightening; and the white card around
 * it goes cream, which is what the sepia term is actually for — it is doing more
 * work on the frame than on the picture.
 *
 * A filter and not an overlay because the ageing of a print is subtractive. A
 * warm wash painted over a photograph lands on the shadows as well as the
 * highlights and turns black to brown, which is a coffee stain over the picture
 * rather than a picture that has faded.
 */
export function wearFilter(wear: number): string {
  if (wear <= 0) return "";
  return (
    `saturate(${(1 - 0.22 * wear).toFixed(3)})` +
    ` sepia(${(0.16 * wear).toFixed(3)})` +
    ` contrast(${(1 - 0.09 * wear).toFixed(3)})` +
    ` brightness(${(1 + 0.035 * wear).toFixed(3)})`
  );
}

/**
 * Every custom property this file's numbers are written to, for the release
 * path to strip blindly.
 *
 * One list rather than one per effect, because the only caller that wants them
 * individually is the one that has just computed them and knows their names.
 */
export const WEAR_PROPS = [
  "--age",
  "--crease",
  "--crease-rot",
  "--crease-at",
  "--crease-face",
  "--stain",
  "--stain-x",
  "--stain-y",
  "--stain-r",
] as const;

/** The class an item wears while it has any wear at all — see `items.css`. */
export const IS_AGED = "is-aged";
