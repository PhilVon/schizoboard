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
import { boardToLocal, removePinsFromStrings } from "@/crdt/ops/cascade";
import { writePoses, type Pose } from "@/crdt/ops/items";
import { readItem, type PinKind, type YMap } from "@/crdt/schema";

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
  // Invariant 1, at the one pin path that was not already checking (T-155).
  //
  // **Coerced, where `createItems` skips.** Two of the four callers are string
  // ops building the pin a run hangs from, and a pin that refused to exist
  // while its node was still written is precisely the dangling reference the
  // janitor was built to collect — so refusing here would manufacture the
  // failure it is meant to prevent. The parent's origin is somewhere real: the
  // pin is visible, draggable and deletable, which none of those is true of
  // `NaN`.
  map.set("lx", Number.isFinite(input.lx) ? input.lx : 0);
  map.set("ly", Number.isFinite(input.ly) ? input.ly : 0);
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
 * Where a pin should be parented and what its coordinates become there.
 * `state/scene.ts` declares the same four fields for the reason stated on its
 * copy — the two are one type to every caller, and neither module imports the
 * other.
 */
export interface PinHome {
  id: string;
  parent: string | null;
  lx: number;
  ly: number;
}

/**
 * Re-home pins onto the paper they are actually stuck through — D-31.
 *
 * `parent` is not what the person who placed the pin chose; it is the topmost
 * item the pin is currently pushed through, which changes when a *different*
 * object moves. So this fires off the back of somebody's drag rather than off an
 * action of its own, and three things about it follow from that.
 *
 * **One transaction, and it must be the caller's next queued write.** It rides
 * the undo entry of the edit that caused it, so undoing that edit restores the
 * frame along with the geometry. Split them and undo tows the pin back with an
 * item it had not been stuck through yet — the hazard T-176 named when it
 * declined to build this.
 *
 * **Coordinates the caller computed from the mirror**, like every other pin
 * write here: `crdt/` cannot see a drawn pose, and the drawn pose is the whole
 * of why the conversion is invisible. `Scene.rehomes` carries that argument.
 *
 * **A named parent that is not on the board is dropped, not written as null.**
 * The pin is left exactly as it was for the janitor to reason about; inventing
 * a free pin out of a race would move it, and moving a pin is the one thing
 * this operation must never do.
 */
export function rehomePins(board: BoardDoc, homes: readonly PinHome[]): void {
  if (homes.length === 0) return;
  mutate(board, Origin.LOCAL_USER, () => {
    for (const home of homes) {
      if (!Number.isFinite(home.lx) || !Number.isFinite(home.ly)) continue;
      if (home.parent !== null && !board.items.has(home.parent)) continue;
      const pin = board.pins.get(home.id);
      if (!pin) continue;
      // The frame is the point of the write; the coordinates come along because
      // they mean something different in it. Nothing to do when it already
      // agrees — and it will, on every pin the caller asked about twice.
      if (pin.get("parent") === home.parent) continue;
      pin.set("parent", home.parent);
      pin.set("lx", home.lx);
      pin.set("ly", home.ly);
    }
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
 * Lives in `cascade.ts` now, because the slack merge needs it and a cascade may
 * not import an op. Re-exported here, which is where everything that asks the
 * question already looks.
 */
export { pinWorldPosition } from "@/crdt/ops/cascade";

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
