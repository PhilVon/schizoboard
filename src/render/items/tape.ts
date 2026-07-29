/**
 * Tape.
 *
 * > Optional tape at one or two corners, slightly translucent, with its own
 * > small shadow and a barely-visible torn edge. — DESIGN section 4.3
 *
 * ## It holds the corner it is on
 *
 * DESIGN puts that sentence under polaroids, and it is here for both archetypes
 * — section 2.1 is explicit that the archetypes "differ only in styling and
 * defaults", a note taped to a board is as ordinary a thing as a photograph
 * taped to one, and DATA-MODEL section 3 hangs `style.tapeStyle` off every item
 * rather than off prints.
 *
 * That is not only tidiness. Tape is not decoration on this board: it is one of
 * the two things that hold a sheet down, so a taped corner does not curl
 * (`curl.ts`). Without that, a note could be taped at a corner that was visibly
 * lifting off the cork underneath the tape, which is the sort of disagreement
 * section 4.4's whole curl exists to avoid.
 *
 * ## Seeded, until there is somewhere to choose it from
 *
 * "Optional" means a style, and `style.tapeStyle` is where that will live. Until
 * the style map exists, the default comes off the seed — the same relationship
 * `defaultStock` already has with `style.paperStock` and `tearEdge` has with
 * `style.torn`. About a third of items, at one corner or two.
 *
 * Not every item, and that matters more than the exact fraction: tape on
 * everything is a pattern, and a board where a third of the things are taped
 * reads as a board somebody has been adding to for a while.
 */

import { edgeProfile, valueAt } from "@/lib/seed";

/** Corner flags, clockwise from the top left — `curl.ts`'s order. */
export const TAPE_TL = 1;
export const TAPE_TR = 2;
export const TAPE_BR = 4;
export const TAPE_BL = 8;

/** How many corners this can ever be on at once, and so how many nodes a view
 *  has to carry. */
export const MAX_TAPES = 2;

/** How much of a board is taped. */
const TAPE_CHANCE = 0.34;

/** Strip length and width, board units. A hand tears about this much off a roll. */
export const TAPE_LENGTH = 56;
export const TAPE_WIDTH = 17;

/**
 * Which way up a strip lies, so that its lit edge faces the light: `1` as
 * drawn, `-1` mirrored across its own length.
 *
 * DESIGN 4.3 asks for tape with "its own small shadow", and the first version of
 * this took that to mean a cast one — the whole silhouette copied, darkened and
 * offset along the light, which is how every other shadow on this board is made.
 * Phil said it did not make sense with how tape works, and it does not: an offset
 * copy is the shadow of something *held above* a surface, and tape is the one
 * object here that is stuck flat to one. It read as a plank lying across the
 * corner.
 *
 * What tape actually has is a cross-section. It is a few hundredths of a
 * millimetre thick, so its shadow is a hairline where that thickness meets the
 * surface on the far side from the light, and the matching brightness is the
 * shine along the near edge. One profile drawn across the width, and the only
 * thing the light decides is which way round it goes — which is what this says.
 *
 * Out of *both* rotations, the strip's and the item's, for the reason
 * `TapeSet.update` gives: a taped photograph lit from one direction with its
 * tape lit from another is exactly the thing DESIGN 4.1 warns about.
 *
 * A sign test on a dot product rather than a threshold on an angle, so a strip
 * turned all the way round changes its mind exactly twice and never stutters.
 */
export function tapeFlip(worldAngle: number, lightX: number, lightY: number): number {
  // The strip's own +y in world space. If it points the way the shadow goes,
  // the profile is already the right way up.
  const nx = -Math.sin(worldAngle);
  const ny = Math.cos(worldAngle);
  return nx * lightX + ny * lightY >= 0 ? 1 : -1;
}

/**
 * Which corners of this item are taped, as a mask of the four flags above.
 *
 * **Nothing pinned is taped.** Phil's, on signing T-80 off, and it is the rule
 * that makes the header above true rather than merely tidy: tape is one of the
 * two things that hold something to this board, and the two are alternatives.
 * Nobody tapes down a photograph they have already put a pin through. It also
 * settles what the strips are *for* — a taped item is one that would otherwise
 * be held by nothing, which is exactly the item whose corners would all be
 * curling (`curl.ts`).
 *
 * The consequence, which is worth knowing rather than fixing: pull the last pin
 * out of an item and its tape appears. That is the same answer the curl gives to
 * the same gesture — the sheet has to be held by *something* — and it arrives at
 * the corners the seed always meant, so putting the pin back takes it away
 * again.
 *
 * Two tapes go on as a pair rather than at two unrelated corners, because that
 * is how a hand does it: across the top, or diagonally opposite. Two adjacent
 * down one side is a thing nobody does and it looks like it.
 */
export function tapedCorners(seed: number, pinCount: number): number {
  if (pinCount > 0) return 0;
  if (valueAt(seed, "tape") >= TAPE_CHANCE) return 0;
  if (valueAt(seed, "tape-pair") < 0.55) {
    const which = valueAt(seed, "tape-which");
    if (which < 0.5) return TAPE_TL | TAPE_TR;
    if (which < 0.75) return TAPE_TL | TAPE_BR;
    return TAPE_TR | TAPE_BL;
  }
  return 1 << Math.floor(valueAt(seed, "tape-one") * 4);
}

/**
 * The angle a strip lies at across `corner`, in radians, relative to the item.
 *
 * Forty-five degrees across the corner, plus a few of wobble off the seed —
 * nothing on this board arrives straight (DESIGN section 3.1), and two tapes
 * exactly parallel is the tell that they came out of a stylesheet.
 *
 * The sign flips per corner so that every strip lies *across* its corner rather
 * than along the diagonal, which would be a strip pointing at the middle of the
 * item and holding nothing.
 */
export function tapeAngle(seed: number, corner: number, index: number): number {
  const lean = corner === TAPE_TL || corner === TAPE_BR ? -1 : 1;
  const wobble = (valueAt(seed, "tape-lean", index) * 2 - 1) * 9;
  return ((lean * 45 + wobble) * Math.PI) / 180;
}

/**
 * A strip's silhouette: crisp along its length, torn across both ends.
 *
 * The long edges are straight because tape is cut to width by the roll's own
 * straight edges, and only what a hand did to it is ragged — that asymmetry is
 * what says "tape" rather than "a piece of paper". Ends are seeded per strip so
 * the two on one item are not the same tear twice.
 */
export function tapeClipPath(seed: number, index: number): string {
  const samples = 5;
  const left = edgeProfile(seed, `tape-l${index}`, samples);
  const right = edgeProfile(seed, `tape-r${index}`, samples);
  /** How far into the strip an end can bite, as a percentage of its length. */
  const bite = 3.4;
  const points: string[] = [];
  for (let i = 0; i < samples; i++) {
    const x = bite + (left[i] ?? 0) * bite;
    points.push(`${x.toFixed(2)}% ${((i / (samples - 1)) * 100).toFixed(1)}%`);
  }
  for (let i = samples - 1; i >= 0; i--) {
    const x = 100 - bite - (right[i] ?? 0) * bite;
    points.push(`${x.toFixed(2)}% ${((i / (samples - 1)) * 100).toFixed(1)}%`);
  }
  return `polygon(${points.join(", ")})`;
}
