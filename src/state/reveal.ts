/**
 * Taking the camera to something it cannot see.
 *
 * > It can still surprise: if someone moved an item after you did, your undo
 * > restores your earlier value and their move is lost. … The mitigation is to
 * > flash-highlight what changed so it's never silent.
 * > — docs/DESIGN.md section 7.6
 *
 * `state/flash.ts` is that mitigation, and it has a hole: a mark drawn where
 * nobody is looking is as silent as no mark at all. This closes it (Q-79).
 *
 * ## It is a no-op almost every time, and that is the design
 *
 * An undo entry carries the camera it was made at (`crdt/undo.ts`), and the
 * thing you edited was on screen when you edited it — so restoring that view
 * usually puts the change in front of you before this is asked. The case it
 * exists for is the one where those two facts come apart: an undo whose target
 * is positioned *relative* to something a collaborator has since moved. A pin's
 * local coordinates go back to what you set, and the photograph they are local
 * to is now on the far side of the board; the same for a string's slack when
 * somebody has dragged the pins it hangs between. The value is restored exactly
 * where you left it and the pixels are a thousand units away.
 *
 * So: check, and move only if it is genuinely out of sight. A camera that moves
 * when it did not need to is a much worse fault than one that does not move when
 * it might have — the board is somewhere you are working, and having it slide
 * out from under a Ctrl+Z you knew the result of is the kind of help nobody asks
 * for twice.
 */

import type { Bounds, Camera } from "@/state/camera";

/**
 * How much of the viewport must hold the change for it to count as seen.
 *
 * Not zero. A box that overlaps the viewport by one unit at the very edge is
 * technically visible and is, in practice, off screen — so the test is against
 * a viewport shrunk by a margin, and something clipping the edge is treated as
 * hidden and centred.
 */
const EDGE_MARGIN = 0.08;

/** Does any of `box` land inside the viewport, allowing for the edge margin? */
export function isVisible(camera: Camera, box: Bounds, out?: Bounds): boolean {
  const view = camera.visibleBounds(-EDGE_MARGIN, out);
  return box.minX < view.maxX && box.maxX > view.minX && box.minY < view.maxY && box.maxY > view.minY;
}

/**
 * Put `box` in front of the person, if it is not already.
 *
 * Returns whether the camera moved, so a caller can tell "there was nothing to
 * do" from "the board just jumped" — which is the difference the tests care
 * about.
 *
 * Centred at the current zoom rather than fitted, when it will fit. Zoom is a
 * thing the person chose and an undo is not a reason to overrule it; a change
 * too big for the current zoom is the one case where keeping it would show a
 * corner of the answer and call it done.
 */
export function reveal(camera: Camera, box: Bounds | null): boolean {
  if (box === null) return false;
  if (isVisible(camera, box)) return false;

  const w = (box.maxX - box.minX) * camera.zoom;
  const h = (box.maxY - box.minY) * camera.zoom;
  if (w > camera.width || h > camera.height) {
    camera.fit(box);
    return true;
  }
  camera.centreOn((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2);
  return true;
}

/** Grow `out` to hold `box` as well, or seed it if this is the first one. */
export function widen(out: Bounds, box: Bounds, seeded: boolean): void {
  if (!seeded) {
    out.minX = box.minX;
    out.minY = box.minY;
    out.maxX = box.maxX;
    out.maxY = box.maxY;
    return;
  }
  if (box.minX < out.minX) out.minX = box.minX;
  if (box.minY < out.minY) out.minY = box.minY;
  if (box.maxX > out.maxX) out.maxX = box.maxX;
  if (box.maxY > out.maxY) out.maxY = box.maxY;
}
