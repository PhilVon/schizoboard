/**
 * Pin operations.
 *
 * > **This is the load-bearing idea of the whole design.** Nearly everything
 * > in the brief resolves through it. — DESIGN section 2.2
 *
 * A pin is parented to an item (storing item-local, **un-rotated**
 * coordinates, so it travels and rotates with the item for free) or free in
 * the cork (storing board coordinates). Which of the two is decided entirely
 * by `parent`, and re-parenting is a two-field write:
 *
 * > That two-field write is the entire "drag a pin onto a note" feature. It
 * > falls out of the representation rather than needing a mechanism.
 */

import * as Y from "yjs";

import { freshId, mutate, type BoardDoc } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";
import { boardToLocal, localToBoard, removePinsFromStrings } from "@/crdt/ops/cascade";
import { readItem, readPin, type PinKind, type YMap } from "@/crdt/schema";

/** Board units in from the top edge, where a default pin goes. */
export const DEFAULT_PIN_INSET = 16;

export interface CreatePinInput {
  /** Item id, or null for a pin pushed straight into the cork. */
  parent: string | null;
  /** Item-local un-rotated when parented; board coordinates when free. */
  lx: number;
  ly: number;
  kind?: PinKind;
  color?: string;
}

/** Builds the map. Caller supplies the transaction — cascades need to compose. */
export function buildPin(board: BoardDoc, input: CreatePinInput): { id: string; map: YMap } {
  const id = freshId(board.pins);
  const map = new Y.Map<unknown>();
  map.set("parent", input.parent);
  map.set("lx", input.lx);
  map.set("ly", input.ly);
  map.set("kind", input.kind ?? "pushpin");
  map.set("color", input.color ?? "#c8352f");
  map.set("createdBy", board.doc.clientID);
  map.set("createdAt", Date.now());
  return { id, map };
}

export function createPin(board: BoardDoc, input: CreatePinInput): string {
  return mutate(board, Origin.LOCAL_USER, () => {
    const { id, map } = buildPin(board, input);
    board.pins.set(id, map);
    return id;
  });
}

/** Move a pin within its current frame. Does not change ownership. */
export function movePin(board: BoardDoc, pinId: string, lx: number, ly: number): void {
  if (!Number.isFinite(lx) || !Number.isFinite(ly)) return;
  mutate(board, Origin.LOCAL_USER, () => {
    const pin = board.pins.get(pinId);
    if (!pin) return;
    pin.set("lx", lx);
    pin.set("ly", ly);
  });
}

/**
 * Re-parent a pin, given where it should end up in **board** coordinates.
 *
 * The caller works in board space because that is where the cursor is; this
 * converts into whichever frame the new parent implies. Both writes happen in
 * one transaction, so no peer ever observes a pin whose `parent` and
 * coordinates disagree.
 */
export function reparentPin(
  board: BoardDoc,
  pinId: string,
  newParent: string | null,
  boardX: number,
  boardY: number,
): void {
  if (!Number.isFinite(boardX) || !Number.isFinite(boardY)) return;
  mutate(board, Origin.LOCAL_USER, () => {
    const pin = board.pins.get(pinId);
    if (!pin) return;

    if (newParent === null) {
      pin.set("parent", null);
      pin.set("lx", boardX);
      pin.set("ly", boardY);
      return;
    }

    const itemMap = board.items.get(newParent);
    const item = itemMap ? readItem(newParent, itemMap) : null;
    // Re-parenting onto an item that just vanished would strand the pin in a
    // frame that does not exist. Leaving it free at the cursor is the same
    // outcome the renderer already gives a dangling pin.
    if (!item) {
      pin.set("parent", null);
      pin.set("lx", boardX);
      pin.set("ly", boardY);
      return;
    }

    const local = boardToLocal(boardX, boardY, item.x, item.y, item.rot);
    pin.set("parent", newParent);
    pin.set("lx", local.lx);
    pin.set("ly", local.ly);
  });
}

/**
 * Where a pin actually is, in board coordinates.
 *
 * A pin whose parent has vanished "renders as free-floating at its last known
 * board position, computed locally with no write" (DATA-MODEL section 8.1) —
 * so a missing parent resolves to the stored coordinates rather than to an
 * error. Invariant 5.
 */
export function pinWorldPosition(board: BoardDoc, pinId: string): { x: number; y: number } | null {
  const pinMap = board.pins.get(pinId);
  if (!pinMap) return null;
  const pin = readPin(pinId, pinMap);
  if (!pin) return null;
  if (pin.parent === null) return { x: pin.lx, y: pin.ly };

  const itemMap = board.items.get(pin.parent);
  const item = itemMap ? readItem(pin.parent, itemMap) : null;
  if (!item) return { x: pin.lx, y: pin.ly };
  return localToBoard(pin.lx, pin.ly, item.x, item.y, item.rot);
}

/**
 * Delete pins, healing every string that ran through them. One transaction,
 * so undo restores the pins and the string nodes together.
 */
export function deletePins(board: BoardDoc, pinIds: readonly string[]): void {
  if (pinIds.length === 0) return;
  mutate(board, Origin.LOCAL_USER, () => {
    const doomed = new Set(pinIds.filter((id) => board.pins.has(id)));
    if (doomed.size === 0) return;
    removePinsFromStrings(board, doomed);
    for (const id of doomed) board.pins.delete(id);
  });
}
