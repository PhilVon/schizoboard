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
import type { Scene } from "@/state/scene";

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
