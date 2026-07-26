/**
 * The proportions of a polaroid.
 *
 * Shared, because two places need to agree about them and they are not near
 * each other: `render/items/dom.ts` draws the frame, and paste decides how big
 * an item to make for a given photograph. If those two disagree the photograph
 * is quietly cropped — `object-fit: cover` means a mismatch never looks like a
 * bug, it just looks like a badly framed picture, which is far worse.
 *
 * `lib/` rather than `render/` for the same reason `seed.ts` is here: both
 * sides of the one-way data flow need it and neither may import the other.
 */

/**
 * The classic frame, as fractions of the photograph's *width*: a thin border on
 * three sides and a thick one at the bottom (DESIGN section 4.3).
 */
export const FRAME_SIDE = 0.045;
export const FRAME_BOTTOM = 0.17;

/**
 * "Polaroid at the paste point, at natural aspect ratio, capped to a
 * comfortable size" (DESIGN section 3.1).
 *
 * A cap and a floor, both on the photograph's longest edge. The cap is what
 * stops a 40-megapixel photograph arriving as a wall; the floor is what stops a
 * favicon arriving as something too small to pin, string or annotate — and an
 * item you cannot get hold of is worse than one that is bigger than its source.
 * A real board holds prints of roughly one size, which is the same argument.
 */
export const PHOTO_MAX_EDGE = 300;
export const PHOTO_MIN_EDGE = 170;

/**
 * The item box for a photograph of these pixel dimensions.
 *
 * Works outward from the *photograph*: fit the picture into a comfortable box,
 * then add the frame around it. Going the other way — picking an item size and
 * fitting the picture inside — is what produces the crop, because the bottom
 * band is not symmetric and the arithmetic quietly stops being reversible.
 */
export function polaroidFor(imageW: number, imageH: number): { w: number; h: number } {
  const valid = imageW > 0 && imageH > 0;
  const longest = valid ? Math.max(imageW, imageH) : PHOTO_MIN_EDGE;
  const edge = Math.min(PHOTO_MAX_EDGE, Math.max(PHOTO_MIN_EDGE, longest));

  // Dimensions this peer does not know yet render square, which is the shape
  // a polaroid is anyway. Nothing reflows when the bytes arrive, because the
  // document already carries w and h — this is only the case where it does not.
  const aspect = valid ? imageW / imageH : 1;
  const photoW = aspect >= 1 ? edge : edge * aspect;
  const photoH = aspect >= 1 ? edge / aspect : edge;

  const w = photoW / (1 - 2 * FRAME_SIDE);
  return { w, h: photoH + w * (FRAME_SIDE + FRAME_BOTTOM) };
}
