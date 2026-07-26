/**
 * Cascades.
 *
 * > **Every cascade runs in a single transaction, or undo is not atomic.**
 * > — docs/DATA-MODEL.md section 8
 *
 * Nothing in here opens a transaction of its own. Each function is a *step*,
 * called from inside an op's `mutate()`, so that deleting an item and healing
 * the strings that ran through its pins is one entry in the undo stack and one
 * update on the wire. Half a cascade is worse than none: undo would restore
 * half a board.
 */

import type * as Y from "yjs";

import type { BoardDoc } from "@/crdt/doc";
import { readStringNodes, type YMap } from "@/crdt/schema";
import { rotateIn, rotateOut } from "@/lib/rotate";

/**
 * Remove every node referencing one of `pinIds` from every string, and delete
 * any string that drops below two nodes.
 *
 * DATA-MODEL section 5.3 also requires that when a *middle* node is removed
 * the neighbouring segments merge with their rest lengths summed, so total sag
 * is preserved. That is geometry — it needs the pins' world positions, which
 * needs item transforms — and it lands with T-47. Until then the surviving
 * slack values are simply left alone, which is visible only once strings exist
 * at all (phase 3).
 */
export function removePinsFromStrings(board: BoardDoc, pinIds: ReadonlySet<string>): void {
  if (pinIds.size === 0) return;

  const doomed: string[] = [];

  for (const [stringId, stringMap] of board.strings) {
    const nodes = stringMap.get("nodes");
    if (!nodes || typeof (nodes as Y.Array<YMap>).length !== "number") continue;
    const array = nodes as Y.Array<YMap>;

    // Walk backwards: deleting by index while iterating forwards renumbers
    // everything after the deletion.
    for (let i = array.length - 1; i >= 0; i--) {
      const pin = array.get(i)?.get("pin");
      if (typeof pin === "string" && pinIds.has(pin)) array.delete(i, 1);
    }

    // "A string left with fewer than two valid nodes deletes itself."
    if (readStringNodes(array).length < 2) doomed.push(stringId);
  }

  for (const id of doomed) board.strings.delete(id);
}

/** Every pin currently parented to one of these items. */
export function pinsOfItems(board: BoardDoc, itemIds: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const [pinId, pin] of board.pins) {
    const parent = pin.get("parent");
    if (typeof parent === "string" && itemIds.has(parent)) out.add(pinId);
  }
  return out;
}

/**
 * Rotate a point out of an item's local frame into board coordinates.
 *
 * Pins parented to an item store un-rotated local coordinates, which is what
 * makes rotating an item transport its pins for free. Un-parenting has to
 * undo that.
 *
 * The arithmetic is `lib/rotate.ts`, which is where the sign convention lives;
 * these two are the ops-shaped door onto it — they take an angle rather than
 * its trig, and they hand back the field names their callers store.
 */
export function localToBoard(
  lx: number,
  ly: number,
  itemX: number,
  itemY: number,
  itemRot: number,
): { x: number; y: number } {
  return rotateOut(lx, ly, itemX, itemY, Math.cos(itemRot), Math.sin(itemRot));
}

export function boardToLocal(
  x: number,
  y: number,
  itemX: number,
  itemY: number,
  itemRot: number,
): { lx: number; ly: number } {
  const local = rotateIn(x, y, itemX, itemY, Math.cos(itemRot), Math.sin(itemRot));
  return { lx: local.x, ly: local.y };
}
