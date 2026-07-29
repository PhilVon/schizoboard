/**
 * Z-order operations. Key generation lives in `crdt/zindex.ts`.
 */

import type { BoardDoc } from "@/crdt/doc";
import { mutate } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";
import { compareOrder, keyAbove, keyBelow, type Ordered } from "@/crdt/zindex";

/**
 * Scans every item. That is fine: this runs when something is created or
 * raised, never per frame, and the board is designed for "hundreds to a few
 * thousand items" (DESIGN section 1.4). Caching it would mean keeping a
 * derived index in sync with a CRDT for no measured gain.
 */
export function highestZ(board: BoardDoc): string | null {
  let highest: string | null = null;
  for (const [, item] of board.items) {
    const z = item.get("z");
    if (typeof z !== "string") continue;
    if (highest === null || z > highest) highest = z;
  }
  return highest;
}

export function lowestZ(board: BoardDoc): string | null {
  let lowest: string | null = null;
  for (const [, item] of board.items) {
    const z = item.get("z");
    if (typeof z !== "string") continue;
    if (lowest === null || z < lowest) lowest = z;
  }
  return lowest;
}

/**
 * The board's items in paint order, bottom to top — the total order of
 * DATA-MODEL section 7, not `z` alone.
 *
 * A sort of the whole board, and affordable for the same reason the two scans
 * above are: this runs on a menu click, never on a frame.
 */
function paintOrder(board: BoardDoc): Ordered[] {
  const all: Ordered[] = [];
  for (const [id, item] of board.items) {
    const z = item.get("z");
    const clientId = item.get("createdBy");
    if (typeof z !== "string" || typeof clientId !== "number") continue;
    all.push({ z, clientId, id });
  }
  return all.sort(compareOrder);
}

/**
 * Are these items already exactly the run at that end of the stack, in this
 * order — so that raising or lowering them would move nothing?
 *
 * Asked because the write is not free when the answer is yes. It generates a
 * fresh key per item, which is the growth DATA-MODEL section 7 names as the
 * known hazard of this whole scheme, and it pushes an undo entry — so a person
 * who right-clicks the topmost photograph and picks *Bring to front*, as people
 * do when they are not sure whether it worked, would be handed a `Ctrl`+`Z` that
 * visibly does nothing. Both are avoided by not writing.
 *
 * Both ops leave the run in the order it was given, bottom to top, which is why
 * one comparison serves both ends.
 */
function alreadyStacked(board: BoardDoc, itemIds: readonly string[], end: "front" | "back"): boolean {
  const live = itemIds.filter((id) => board.items.has(id));
  if (live.length === 0) return true;
  const all = paintOrder(board);
  if (live.length > all.length) return false;
  const run = end === "front" ? all.slice(all.length - live.length) : all.slice(0, live.length);
  return run.every((item, i) => item.id === live[i]);
}

export function bringToFront(board: BoardDoc, itemIds: readonly string[]): void {
  if (itemIds.length === 0 || alreadyStacked(board, itemIds, "front")) return;
  mutate(board, Origin.LOCAL_USER, () => {
    let above = highestZ(board);
    for (const id of itemIds) {
      const item = board.items.get(id);
      if (!item) continue;
      // Stack within the selection in the order given, so raising three items
      // keeps their relative order rather than scrambling it.
      above = keyAbove(above);
      item.set("z", above);
    }
  });
}

export function sendToBack(board: BoardDoc, itemIds: readonly string[]): void {
  if (itemIds.length === 0 || alreadyStacked(board, itemIds, "back")) return;
  mutate(board, Origin.LOCAL_USER, () => {
    let below = lowestZ(board);
    // Walked backwards, so the run comes out in the order it was given — the
    // last id on top of the others it went back with, which is the guarantee
    // bringToFront makes going the other way. Sending three photographs to the
    // back must not shuffle them against each other.
    for (let i = itemIds.length - 1; i >= 0; i--) {
      const item = board.items.get(itemIds[i]!);
      if (!item) continue;
      below = keyBelow(below);
      item.set("z", below);
    }
  });
}
