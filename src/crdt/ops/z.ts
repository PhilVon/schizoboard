/**
 * Z-order operations. Key generation lives in `crdt/zindex.ts`.
 */

import type { BoardDoc } from "@/crdt/doc";
import { mutate } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";
import { keyAbove, keyBelow } from "@/crdt/zindex";

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

export function bringToFront(board: BoardDoc, itemIds: readonly string[]): void {
  if (itemIds.length === 0) return;
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
  if (itemIds.length === 0) return;
  mutate(board, Origin.LOCAL_USER, () => {
    let below = lowestZ(board);
    // Reversed so the first id ends up on top of the others it was sent back
    // with, matching bringToFront's relative-order guarantee.
    for (let i = itemIds.length - 1; i >= 0; i--) {
      const item = board.items.get(itemIds[i]!);
      if (!item) continue;
      below = keyBelow(below);
      item.set("z", below);
    }
  });
}
