/**
 * How much bigger a carried item is drawn — "it scales up by about 2%", DESIGN
 * section 3.2.
 *
 * In `lib/` because three modules have to agree on it and they sit on different
 * sides of the one-way data flow: `render/items/dom.ts` applies it to the item's
 * transform, `render/overlay.ts` applies it to the chrome stroked round the item,
 * and `state/handles.ts` applies it to the box those handles hang off. A
 * disagreement between any two of them shows up as an outline or a rotation
 * handle sitting 1% inside the paper it belongs to, only while something is being
 * carried, which is exactly when nobody is looking closely.
 *
 * It is presentation, not state — `Scene.lift` is a 0..1 transient and the scene
 * has never heard of how big anything is drawn.
 */
export const CARRY_SCALE = 0.02;

/** The factor an item at this `lift` is drawn at. */
export function carryScale(lift: number): number {
  return 1 + lift * CARRY_SCALE;
}
