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
import type { StringAnchor } from "@/state/tools/tool";

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
  const angle = scene.rot[slot]! + scene.swing[slot]!;
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
