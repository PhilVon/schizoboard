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
import { writePoses, type Pose } from "@/crdt/ops/items";
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

/**
 * `settle` is the pose to write for an item this pin stops from hanging — the
 * same argument `deletePins` takes, and here for the mirror-image reason. An
 * item that had one pin and now has two is rigid, so the swing and the drift it
 * was drawn with cease to exist; its rendered pose written inside this
 * transaction is what keeps the paper still at the moment they stop applying,
 * and keeps it one undo entry. It comes from the caller because the rendered
 * pose lives in the scene mirror and `crdt/` may not read it.
 */
export function createPin(
  board: BoardDoc,
  input: CreatePinInput,
  settle?: ReadonlyMap<string, Pose>,
): string {
  return mutate(board, Origin.LOCAL_USER, () => {
    const { id, map } = buildPin(board, input);
    board.pins.set(id, map);
    if (settle) writePoses(board, settle);
    return id;
  });
}

/**
 * A board point, expressed in whichever frame `parent` implies — and the
 * parent that frame actually belongs to.
 *
 * Re-parenting onto an item that just vanished would strand the pin in a frame
 * that does not exist, so a missing item resolves to `null` and the board
 * coordinates stand. That is the same outcome the renderer already gives a
 * dangling pin (DATA-MODEL section 8.1), reached before the write rather than
 * papered over after it.
 *
 * The angle used is the item's **authored** rotation, which is the only one the
 * document has. An item mid-swing (DESIGN section 5.5) is therefore pinned a
 * degree or two from where the cursor was — and it has to be, because the swing
 * is local and transient and a pin placed in it would land somewhere different
 * on every peer.
 */
function inParentFrame(
  board: BoardDoc,
  parent: string | null,
  boardX: number,
  boardY: number,
): CreatePinInput {
  if (parent === null) return { parent: null, lx: boardX, ly: boardY };
  const itemMap = board.items.get(parent);
  const item = itemMap ? readItem(parent, itemMap) : null;
  if (!item) return { parent: null, lx: boardX, ly: boardY };
  const local = boardToLocal(boardX, boardY, item.x, item.y, item.rot);
  return { parent, lx: local.lx, ly: local.ly };
}

/**
 * Put an existing pin down: `parent` and the coordinates, in one transaction,
 * so no peer ever observes a pin whose two halves disagree.
 *
 * The coordinates arrive **already in the frame `parent` implies** — item-local
 * un-rotated when parented, board when free — because the caller is a tool and
 * the tool is the only thing that knows the item's *rendered* pose. An item
 * hanging on one pin is drawn at `rot + swing` about a shifted centre
 * (`sim/torsion.ts`), and neither of those is in the document; converting here
 * from board coordinates would put the pin where the paper would have been if
 * it were not hanging.
 *
 * `settle` can name **two** items here where the other pin ops name one, since
 * a re-parent changes the pin count at both ends: the item that gained the pin
 * may have stopped hanging, and so may the item that lost it. Both poses are
 * the caller's for the same reason the coordinates are.
 */
export function placePin(
  board: BoardDoc,
  pinId: string,
  parent: string | null,
  lx: number,
  ly: number,
  settle?: ReadonlyMap<string, Pose>,
): void {
  if (!Number.isFinite(lx) || !Number.isFinite(ly)) return;
  mutate(board, Origin.LOCAL_USER, () => {
    const pin = board.pins.get(pinId);
    if (!pin) return;
    pin.set("parent", parent);
    pin.set("lx", lx);
    pin.set("ly", ly);
    if (settle) writePoses(board, settle);
  });
}

/**
 * Move several pins within their current frames, in one transaction.
 *
 * The batch matters rather more than it looks. Dragging a thread moves its free
 * pins alongside its photographs (DESIGN section 3.8), and a loop of `movePin`
 * would be one transaction per pin: N undo entries for one gesture, N observer
 * flushes, and — because the rope solver wakes off the mirror — a string whose
 * two ends move on different frames, which is a visible twitch.
 *
 * Ownership is untouched, so this composes with nothing: a pin moved here is
 * the pin it already was, on the item it was already on. Re-parenting is
 * `placePin`, and it is a different gesture.
 */
export function movePins(
  board: BoardDoc,
  positions: ReadonlyMap<string, { lx: number; ly: number }>,
): void {
  mutate(board, Origin.LOCAL_USER, () => {
    for (const [pinId, at] of positions) {
      if (!Number.isFinite(at.lx) || !Number.isFinite(at.ly)) continue;
      const pin = board.pins.get(pinId);
      if (!pin) continue;
      pin.set("lx", at.lx);
      pin.set("ly", at.ly);
    }
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
    const placed = inParentFrame(board, newParent, boardX, boardY);
    pin.set("parent", placed.parent);
    pin.set("lx", placed.lx);
    pin.set("ly", placed.ly);
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
 * Delete pins, healing every string that ran through them, and settle any item
 * that has just lost the pin it was hanging from. One transaction, so undo
 * restores the pins, the string nodes and the poses together.
 *
 * ## Why a pose write belongs in a pin delete
 *
 * An item on one pin hangs plumb, and its **authored** rotation is not what is
 * on screen — `sim/torsion.ts` carries the difference in a transient the
 * document never sees. Take the pin out and that transient stops existing, so
 * without this the paper jumps to an angle nobody chose and nobody could see,
 * which is the whole of T-107.
 *
 * DESIGN section 5.1 says physics never writes to the document and lists
 * "settled rotations" among the things it must not write. This is not the
 * simulation writing: it is one write caused by a user taking a pin out, whose
 * value the simulation happened to compute — so it cannot make two peers fight,
 * which is what that rule exists to prevent. Q-11 chose it over the
 * alternative, which was to stop the rotation handle writing `rot` at all on a
 * hanging item.
 *
 * The caller supplies the poses because only it can: the rendered pose lives in
 * the scene mirror, and `crdt/` may not read that.
 */
export function deletePins(
  board: BoardDoc,
  pinIds: readonly string[],
  settle?: ReadonlyMap<string, Pose>,
): void {
  if (pinIds.length === 0) return;
  mutate(board, Origin.LOCAL_USER, () => {
    const doomed = new Set(pinIds.filter((id) => board.pins.has(id)));
    if (doomed.size === 0) return;
    removePinsFromStrings(board, doomed);
    for (const id of doomed) board.pins.delete(id);
    if (settle) writePoses(board, settle);
  });
}
