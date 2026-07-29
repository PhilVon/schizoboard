/**
 * A board point, in an item's own frame — the conversion every tool that puts
 * something *on* an item has to do.
 *
 * ## The rendered pose, not the stored one
 *
 * An item hanging from a single pin is drawn at `rot + swing`, about a centre
 * shifted by `drift` so that the pin it turns about stays still
 * (`sim/torsion.ts`). Neither of those is in the document, and neither can be —
 * the swing is local and transient by rule (DESIGN section 5.1).
 *
 * So the conversion has to use the pose the item is actually *drawn* at, and
 * the coordinates that come out are what gets written down. They are the same
 * frame either way — the item's local frame is defined by its centre and its
 * un-rotated axes, and all that differs is where in the world that frame
 * currently sits. Converting through the stored pose instead would put a pin
 * where the paper would have been if it were not hanging, which is exactly as
 * far from the cursor as the swing has taken it.
 */

import { rotateIn, type Point } from "@/lib/rotate";
import type { Camera } from "@/state/camera";
import type { Scene } from "@/state/scene";
import type { StringAnchor, StringHit, WritePose } from "@/state/tools/tool";

/** Null when the item is not on the board. */
export function itemLocal(
  scene: Scene,
  itemId: string,
  boardX: number,
  boardY: number,
  out?: Point,
): Point | null {
  const slot = scene.slotOf(itemId);
  if (slot === undefined) return null;
  const angle = scene.renderRot(slot);
  return rotateIn(
    boardX,
    boardY,
    scene.renderX(slot),
    scene.renderY(slot),
    Math.cos(angle),
    Math.sin(angle),
    out,
  );
}

/**
 * The pose an item is **drawn** at, as something the document can hold.
 *
 * An item hanging on one pin is drawn at `rot + swing` about a centre shifted
 * by `drift`, and neither transient is in the document by rule. Write this and
 * the stored pose becomes the drawn one, which is how a gesture leaves paper
 * exactly where it looks at the moment those transients stop applying.
 *
 * The **settled** pose, deliberately, and not `renderRot` — the one transient
 * this must not see is the editor's lay-flat (T-178). The swing is a real
 * settling that stays where it lands, so baking it is the point; the lay-flat
 * is a lie held for as long as someone is typing and taken back on blur, so
 * baking it would leave a note that was pinned mid-sentence permanently square
 * to the screen. What this writes is where the paper will be once the editor
 * closes, which is the same thing it means for the swing.
 *
 * Null when the item is not on the board.
 */
export function drawnPose(scene: Scene, itemId: string): WritePose | null {
  const slot = scene.slotOf(itemId);
  if (slot === undefined) return null;
  return {
    x: scene.settledX(slot),
    y: scene.settledY(slot),
    rot: scene.settledRot(slot),
  };
}

/**
 * The pose to write for an item that goes on hanging from the same pin after
 * that pin has been dragged to a new place *within* it.
 *
 * The third member of the family above, and the one that is not a flatten. An
 * item on one pin is drawn at `rot + swing` about a centre shifted by `drift`,
 * and `drift` is a pure function of the pivot — "put the pivot back where it
 * was". Move the pin and the pivot is a different local point, so the same
 * `rot` and the same `swing` now draw the item somewhere else. Nothing in the
 * gesture asked for that: the paper did not move, the pin did.
 *
 * `sim/torsion.ts` holds the paper still for the duration by freezing the pivot
 * it took hold of (`state/tools/pindrag.ts` hands it the pre-gesture one), and
 * the whole of that lie comes due at the release, when it stops freezing and
 * starts deriving the pivot from the pin again. This is what settles it: the
 * centre that draws the item exactly where it is now, given the pivot the pin
 * has ended up at. The item then swings to its new equilibrium from where it
 * stands, which is motion, rather than from somewhere it was never drawn.
 *
 * `rot` is deliberately absent — "leave it alone". The swing is not over and
 * the angle has not changed; only the point it is measured about has, and this
 * is the translation that costs.
 *
 * Null when the item is not on the board.
 */
export function repivotedPose(
  scene: Scene,
  itemId: string,
  lx: number,
  ly: number,
): WritePose | null {
  const slot = scene.slotOf(itemId);
  if (slot === undefined) return null;
  const rot = scene.rot[slot]!;
  // Settled, not rendered, for the reason `drawnPose` gives: this is a write.
  const swung = scene.settledRot(slot);
  const c0 = Math.cos(rot);
  const s0 = Math.sin(rot);
  const c1 = Math.cos(swung);
  const s1 = Math.sin(swung);
  // The drift the new pivot will produce, by the same arithmetic that produces
  // it over in `sim/torsion.ts` — subtracted from where the item is drawn now.
  return {
    x: scene.settledX(slot) - (lx * (c0 - c1) - ly * (s0 - s1)),
    y: scene.settledY(slot) - (lx * (s0 - s1) + ly * (c0 - c1)),
  };
}

/**
 * The poses to write for items about to be handed a pin — empty when none of
 * them is about to change how it hangs.
 *
 * One pin hangs and two are rigid (DESIGN section 5.5), so the pin that makes
 * two is the pin that ends the swing — and `sim/torsion.ts` ends it by zeroing
 * both transients outright, which puts the paper back at an authored rotation
 * that has been invisible ever since it started hanging. That alone would be a
 * paper that jumps. Worse, a pin being pushed into that paper is placed against
 * the pose it is *drawn* at, because that is the only pose a cursor can aim at
 * — so the jump takes the new pin, and anything strung through it, along.
 *
 * Writing the drawn pose in the same transaction as the pin makes the stored
 * and the rendered pose the same pose at the instant the transients stop
 * mattering. Nothing moves.
 *
 * Only the *second* pin, which is what the count of one tests for. Nought to
 * one starts an item hanging, which is a swing from where it already is rather
 * than a jump; two to three is rigid either way and has nothing to settle.
 *
 * Counted **before** the write, so every caller here is a tool holding an
 * unwritten intention. `state/tools/pindrag.ts` is the exception and does not
 * use this: it re-parents the scene as you drag, so by the time it commits the
 * counts have already moved.
 */
export function settleOnPin(
  scene: Scene,
  items: Iterable<string | null>,
): ReadonlyMap<string, WritePose> {
  const settle = new Map<string, WritePose>();
  for (const id of items) {
    if (id === null || settle.has(id)) continue;
    if (scene.pinCount(id) !== 1) continue;
    const pose = drawnPose(scene, id);
    if (pose) settle.set(id, pose);
  }
  return settle;
}

/**
 * The mirror of `settleOnPin`: the poses to write for items about to *lose* a
 * pin — empty when none of them was hanging by it.
 *
 * Same argument, run backwards. An item on its last pin is drawn at `rot +
 * swing` about a centre shifted by `drift`, and when the pin goes so do both
 * transients — so the paper snaps back to an authored rotation that has been
 * invisible for as long as it has been hanging. Writing the drawn pose in the
 * same transaction as the removal is what leaves it where it looks. Q-11
 * settled that this is the one physics-derived rotation the document is allowed
 * to hold, because a user action causes it rather than the simulation ticking.
 *
 * `pinCount(parent) !== 1` is the whole test, and it is enough even when
 * several pins go at once: an item losing its only pin was hanging, and an item
 * losing two of two was rigid and had no transient to lose. Counted **before**
 * the write, like `settleOnPin` — every caller is holding an unwritten
 * intention.
 */
export function settleOnUnpin(
  scene: Scene,
  pins: Iterable<string>,
): ReadonlyMap<string, WritePose> {
  const settle = new Map<string, WritePose>();
  for (const pinId of pins) {
    const parent = scene.pins.get(pinId)?.parent ?? null;
    if (parent === null || settle.has(parent)) continue;
    if (scene.pinCount(parent) !== 1) continue;
    const pose = drawnPose(scene, parent);
    if (pose) settle.set(parent, pose);
  }
  return settle;
}

/** The item an anchor will push a new pin into, or null — an anchor naming a
 *  pin that already exists changes nobody's count. */
export function anchorParent(anchor: StringAnchor): string | null {
  return "pin" in anchor ? null : anchor.parent;
}

/**
 * What a click at a screen point should anchor a string to: the pin under it,
 * a new pin in the item under it, or a new pin in the bare cork.
 *
 * > The "click an item and it makes its own pin" path is the fast path and it
 * > must exist. — DESIGN section 3.4
 *
 * Shared by the string tool and by `Alt`+drag in the select tool, because it
 * is the same rule reached by two routes and a second copy would be a second
 * chance to get the ordering wrong. The pin is asked for first and in *screen*
 * space, because a pin's grab radius has a floor in screen pixels; everything
 * after it is a question about board coordinates.
 *
 * Returns the anchor and where it is in board space, since every caller wants
 * to draw the run as well as write it.
 */
export function anchorAt(
  scene: Scene,
  camera: Camera,
  hitTest: (boardX: number, boardY: number) => string | null,
  hitPin: (screenX: number, screenY: number) => string | null,
  screenX: number,
  screenY: number,
): { anchor: StringAnchor; x: number; y: number } {
  const pinId = hitPin(screenX, screenY);
  if (pinId !== null) {
    const pin = scene.pins.get(pinId);
    if (pin) return { anchor: { pin: pinId }, x: pin.wx, y: pin.wy };
  }

  const board = camera.screenToBoard(screenX, screenY);
  const itemId = hitTest(board.x, board.y);
  if (itemId !== null) {
    // Through the item's *rendered* pose, which is the only conversion that
    // puts the pin where the paper looked: an item hanging on one pin is drawn
    // at an angle and about a centre that are both transient, and neither of
    // which is in the document.
    const local = itemLocal(scene, itemId, board.x, board.y);
    if (local) return { anchor: { parent: itemId, lx: local.x, ly: local.y }, x: board.x, y: board.y };
  }

  return { anchor: { parent: null, lx: board.x, ly: board.y }, x: board.x, y: board.y };
}

/**
 * How far either side of a string, in screen pixels, the cursor still counts as
 * being on it.
 *
 * Screen rather than board, like a pin's grab radius and for the same reason: a
 * default string is three pixels wide at every zoom (`render/ropes/paint.ts`),
 * so a tolerance in board units would be unusably tight zoomed out and a slab
 * zoomed in. Generous, because the point of the gesture is that you grab the
 * string without aiming at it.
 */
export const STRING_GRAB_PX = 8;

/**
 * The string under a screen point, or null.
 *
 * > Hover a string. The nearest point on the rope highlights, tracking your
 * > cursor along the curve. — DESIGN section 3.4
 *
 * Shared by the hover — asked once a frame by `app/main.ts`, because a tool is
 * only handed pointer moves while a gesture has capture and this is what is
 * drawn *between* gestures — and by the press in `state/tools/select.ts`. One
 * function, because a highlight that appears where a press does nothing is
 * worse than no highlight at all.
 *
 * Two things beat the string, and both because they are physically on top of
 * it: a pin, which is what a press on one means; and, for a string tucked
 * *behind* items (DESIGN section 6.2), the item it is passing under — what you
 * cannot see you cannot grab.
 */
export function stringAt(
  scene: Scene,
  camera: Camera,
  hitTest: (boardX: number, boardY: number) => string | null,
  hitPin: (screenX: number, screenY: number) => string | null,
  hitString: (boardX: number, boardY: number, reach: number) => StringHit | null,
  screenX: number,
  screenY: number,
): StringHit | null {
  if (hitPin(screenX, screenY) !== null) return null;
  const board = camera.screenToBoard(screenX, screenY);
  const hit = hitString(board.x, board.y, STRING_GRAB_PX / camera.zoom);
  if (hit === null) return null;
  if (scene.strings.get(hit.string)?.layer === "under" && hitTest(board.x, board.y) !== null) {
    return null;
  }
  return hit;
}
