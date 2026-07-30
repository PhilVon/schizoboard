/**
 * Paper curl at unpinned corners.
 *
 * > Paper curls very slightly at unpinned corners — implemented as a gradient
 * > and a shadow, not geometry — which is why a one-pin note looks like it's
 * > hanging and a four-pin note looks flat. — DESIGN section 4.4
 *
 * The second half of that sentence is the whole feature. Nothing here is
 * decoration: it is the one place the *physics* of a sheet of paper is legible
 * without moving it. A note held at the top centre — which is what a paste makes
 * (DESIGN section 3.1) — has two corners a long way from anything holding them,
 * and it should look like it. A note with a pin in each corner should look
 * nailed down. The board already knows both facts and has never shown either.
 *
 * ## Which corners count as held
 *
 * "Unpinned" is not a property a corner has; it is a distance. So the curl of a
 * corner is a falloff on how far the nearest pin *through this sheet* is —
 * `Scene.pinsOf`, which since T-176 is the geometric set rather than the
 * parented one, so a pin somebody dragged onto a note holds it exactly as much
 * as the one it was created with.
 *
 * Board units and not a fraction of the sheet, because paper stiffness is
 * physical: a pin flattens about so much paper around it whether the sheet is a
 * scrap or a poster. That is also what makes the four-pin case fall out — pins
 * at the corners are inside [`HOLD_NEAR`] of them at any sheet size.
 *
 * ## Why all of it sits on the paper
 *
 * A corner lifting off the cork does two things. Its face bends, which is a
 * gradient *on* the sheet. And it casts a shadow, which lands on the cork when
 * the corner is on the far side of the light and **on the sheet itself** when it
 * is on the near side — the shadow of a lifted top-left corner falls down and to
 * the right, which is onto the paper.
 *
 * That second half had a layer of its own for two versions, a sibling over the
 * surface and unclipped, so that it could darken the cork as well as the sheet.
 * It is gone, and `items.css` argues the case at length. In one line: an
 * unclipped layer has to draw its own boundary, a cast shadow's boundary is the
 * paper's edge slid along the light, and every cheap way to draw that leaves a
 * hard edge — which lands on flat paper at three corners out of four and reads
 * as a rectangle laid over the sheet. Clipped by the silhouette, the sheet's own
 * outline is the only boundary, and there is nothing left to give the trick
 * away. The price is the shadow a corner would throw onto a *neighbouring* note,
 * which the item's nine-slice already half carries.
 *
 * What is left here is one number per corner and its sign: [`cornerFace`] says
 * how far into or away from the light each flap has tipped, and the stylesheet
 * reads the two signs as two different things — a highlight and a shading on the
 * away side, a cast shadow on the near one. The light does not rotate with the
 * sheet, which is why that number is computed per frame from the drawn rotation
 * rather than baked per item.
 */

import type { Point } from "@/lib/rotate";
import { counterRotate, LIGHT_DX, LIGHT_DY } from "@/render/items/shadow";
import type { Scene } from "@/state/scene";

/**
 * The four corners, clockwise from the top left — the same order `edge.ts`
 * walks the silhouette in, and the order of the custom properties below.
 */
export const CURL_PROPS = ["--curl-tl", "--curl-tr", "--curl-br", "--curl-bl"] as const;

/**
 * And how much each corner's flap turns *toward* the board's one light, times
 * how curled it is: `+1` full in the light, `-1` full away from it, 0 flat.
 *
 * Signed, and one property rather than two, because a negative alpha clamps to
 * zero rather than invalidating the declaration — so `calc(0.4 * var(--face-tl))`
 * paints a highlight only on the corners facing the light and `calc(-0.3 *
 * var(--face-tl))` paints the shading only on the ones facing away, off the same
 * number. Checked in the running webview before it was relied on: a `-0.35`
 * comes back out of `getComputedStyle` as `0`, with the layer intact.
 *
 * The whole reason this exists is that the first version was direction-blind.
 * Every corner got the same bright tip whichever way it was pointing, and Phil
 * called it on sight: a curl that does not know where the light is reads as a
 * smudge, and DESIGN 4.1 says nothing breaks the sense of a real surface faster
 * than one element lit from the wrong side.
 */
export const FACE_PROPS = ["--face-tl", "--face-tr", "--face-br", "--face-bl"] as const;

/**
 * Corner directions in the sheet's own frame, clockwise from the top left, as
 * unit vectors. Which way a flap at that corner tips as it lifts.
 */
const DIAGONAL = Math.SQRT1_2;
const CORNER_DX = [-DIAGONAL, DIAGONAL, DIAGONAL, -DIAGONAL];
const CORNER_DY = [-DIAGONAL, -DIAGONAL, DIAGONAL, DIAGONAL];

/**
 * How lit each corner's flap is, into `out`, given the sheet's drawn rotation
 * and how curled each corner is.
 *
 * The light is counter-rotated into the sheet's frame rather than the corners
 * being rotated out of it — one rotation instead of four, and it is the same
 * move `shadow.ts` makes with the shadow's displacement, for the same reason: a
 * sheet turned on its side must not be lit from its own private direction.
 */
export function cornerFace(rot: number, curl: Float32Array, out: Float32Array): void {
  // Toward the shadow, in the sheet's frame. `LIGHT_DX`/`DY` is already a unit
  // vector and a rotation keeps it one.
  const light = counterRotate(LIGHT_DX, LIGHT_DY, rot);
  for (let c = 0; c < CORNER_DX.length; c++) {
    // Minus, because the light vector points the way the *shadow* goes: a flap
    // tipping into that direction is tipping away from the light.
    const facing = -(CORNER_DX[c]! * light.x + CORNER_DY[c]! * light.y);
    out[c] = (curl[c] ?? 0) * facing;
  }
}

/**
 * How near a pin has to be to hold a corner completely flat, in board units.
 *
 * Not zero. A pin has a head and paper has stiffness, so a pin *at* a corner and
 * a pin an inch in from it hold that corner equally — and the four-pin case
 * depends on this, because nobody puts a pin exactly on a corner.
 */
const HOLD_NEAR = 44;

/**
 * And how far before it stops helping at all.
 *
 * Set against the one case the board makes by itself. A pasted note is pinned at
 * the top centre, which on a sheet of ordinary proportions puts its top corners
 * about 120 units from the pin and its bottom corners about 215 — so the number
 * that matters is the one that separates those two, and 210 leaves the top
 * corners a third curled and the bottom pair fully. That is the shape of a real
 * sheet hanging off one pin: it is not flat at the top either, it is just much
 * flatter than it is at the bottom.
 */
const HOLD_FAR = 210;

/** How curled a corner whose nearest pin is `gap` away is, in [0, 1]. */
export function curlAt(gap: number): number {
  if (gap <= HOLD_NEAR) return 0;
  if (!(gap < HOLD_FAR)) return 1;
  const t = (gap - HOLD_NEAR) / (HOLD_FAR - HOLD_NEAR);
  // Smoothstep, so a pin dragged slowly across a sheet does not switch a corner
  // on and off at two hard thresholds.
  return t * t * (3 - 2 * t);
}

/** Scratch for the pin position, so asking this question allocates nothing. */
const at: Point = { x: 0, y: 0 };

/**
 * How curled each of an item's four corners is, into `out`.
 *
 * `out` is four long and is overwritten. An item with no pins through it curls
 * at every corner, which is right and is also what the loop below does by
 * itself: a loose sheet lying on the cork is exactly the thing that lifts.
 */
export function cornerCurl(
  scene: Scene,
  id: string,
  slot: number,
  taped: number,
  folded: number,
  out: Float32Array,
): void {
  const hw = scene.w[slot]! / 2;
  const hh = scene.h[slot]! / 2;
  let gapTL = Infinity;
  let gapTR = Infinity;
  let gapBR = Infinity;
  let gapBL = Infinity;

  for (const pinId of scene.pinsOf(id)) {
    if (scene.pinPivot(pinId, slot, at) === null) continue;
    const left = (at.x + hw) ** 2;
    const right = (at.x - hw) ** 2;
    const top = (at.y + hh) ** 2;
    const bottom = (at.y - hh) ** 2;
    // Squared while comparing; one square root each at the end rather than four
    // per pin. The DOM phase walks the whole viewport.
    if (left + top < gapTL) gapTL = left + top;
    if (right + top < gapTR) gapTR = right + top;
    if (right + bottom < gapBR) gapBR = right + bottom;
    if (left + bottom < gapBL) gapBL = left + bottom;
  }

  out[0] = curlAt(Math.sqrt(gapTL));
  out[1] = curlAt(Math.sqrt(gapTR));
  out[2] = curlAt(Math.sqrt(gapBR));
  out[3] = curlAt(Math.sqrt(gapBL));

  // And a corner with tape across it is held by the tape (`tape.ts`). Tape is
  // one of the two things on this board that hold a sheet down, so leaving it
  // out would draw a corner visibly lifting off the cork from underneath the
  // strip stuck over it.
  //
  // Handed in rather than derived here, because whether an item is taped at all
  // depends on whether it is pinned, and that is a question about the scene at
  // this moment rather than about the seed. The caller asks it once and both
  // this and the strips themselves are drawn off the one answer.
  for (let c = 0; c < out.length; c++) if (taped & (1 << c)) out[c] = 0;

  // And a corner that has been folded over does not curl either (`wear.ts`,
  // T-190). Not because something is holding it down — nothing is — but because
  // the flap is already lying flat on the sheet, and the paper that would have
  // lifted has been cut out of the silhouette by `edge.ts`. A curl there would be
  // shading a corner the sheet no longer has, with a highlight running off into
  // the cork past the fold line.
  //
  // The two marks therefore never disagree about a corner: the fold wins, and it
  // wins at the one place they could both have an opinion.
  if (folded >= 0 && folded < out.length) out[folded] = 0;
}
