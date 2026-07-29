/**
 * Item operations.
 *
 * An item is a physical object lying on the board. Four archetypes sharing one
 * structure; they differ only in styling and defaults. "A scrap is not a
 * special type in the code — it's a note that happens to have no text yet,
 * which is exactly what a blank piece of paper is." (DESIGN section 2.1)
 */

import * as Y from "yjs";

import { freshId, mutate, type BoardDoc } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";
import { boardToLocal, localToBoard, pinsOfItems, removePinsFromStrings } from "@/crdt/ops/cascade";
import { buildPin, DEFAULT_PIN_INSET } from "@/crdt/ops/pins";
import { MIN_ITEM_SIZE, readItem, readPin, type ItemType, type YMap } from "@/crdt/schema";
import { keyAbove } from "@/crdt/zindex";
import { highestZ } from "@/crdt/ops/z";
import { newSeed, scatterAngle } from "@/lib/seed";
import { diffText } from "@/lib/textdiff";

export interface CreateItemInput {
  type: ItemType;
  /** Board coordinates of the item's centre. */
  x: number;
  y: number;
  w: number;
  h: number;
  assetId?: string | null;
  /**
   * Metadata for `assetId`, registered in the same transaction.
   *
   * DATA-MODEL section 10 keeps `{w, h, mime, size, origName}` in the document
   * and nothing else — bytes never enter it. Supplying it here rather than in a
   * second op is what keeps a paste to one undo entry, and it is the *only*
   * moment the information exists: ingestion returns it once and the store
   * cannot be asked again, because Rust owns bytes and owns no schema.
   *
   * Without it a peer merging this item learns a hash and a size to draw at,
   * and has no way to know what it is being asked to transfer.
   */
  asset?: AssetInput;
  text?: string;
  /** Supply one only to reproduce an item exactly; otherwise it is minted. */
  seed?: number;
  /**
   * Authored rotation in radians. Defaults to the seeded scatter, because
   * "Nothing arrives straight" (DESIGN section 3.1) and a caller that has to
   * remember to jitter is a caller that will forget.
   */
  rot?: number;
  /** DESIGN section 3.1 — everything created by paste gets one pin. */
  withPin?: boolean;
}

/** DATA-MODEL section 10. `addedBy` and `addedAt` are filled in here. */
export interface AssetInput {
  w: number;
  h: number;
  mime: string;
  size: number;
  origName?: string;
}

export interface CreatedItem {
  itemId: string;
  pinId: string | null;
}

/** A number that can go in the document, or zero. */
function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Create items. **One transaction for the whole batch**, so that pasting
 * twenty photographs is one undo entry (DESIGN section 3.1) and one update on
 * the wire.
 */
export function createItems(
  board: BoardDoc,
  inputs: readonly CreateItemInput[],
): CreatedItem[] {
  if (inputs.length === 0) return [];

  return mutate(board, Origin.LOCAL_USER, () => {
    const created: CreatedItem[] = [];
    // Read the top of the stack once and walk it up within the batch, rather
    // than rescanning every item per photograph.
    let z = highestZ(board);
    const now = Date.now();

    for (const input of inputs) {
      const seed = input.seed ?? newSeed();
      const rot = input.rot ?? scatterAngle(seed);
      // Invariant 1 — every number in the document is finite — is a property of
      // these ops and not of everybody who calls them (T-155). Every *update*
      // path here already refuses a non-finite coordinate before its
      // transaction; creation was the exception, and `Math.max(1, NaN)` is NaN,
      // so a single client with no concurrency at all could put one in.
      //
      // Skipped rather than coerced, because nothing refers to an item that
      // does not exist yet — so refusing costs only the item. That is not true
      // of a pin, and `buildPin` does the opposite for exactly that reason.
      // Both callers already read the returned array rather than assuming it
      // matches the input one for one.
      if (![input.x, input.y, rot, input.w, input.h].every(Number.isFinite)) continue;

      const w = Math.max(1, input.w);
      const h = Math.max(1, input.h);
      const itemId = freshId(board.items);
      z = keyAbove(z);

      const item = new Y.Map<unknown>();
      item.set("type", input.type);
      item.set("x", input.x);
      item.set("y", input.y);
      item.set("rot", rot);
      item.set("w", w);
      item.set("h", h);
      item.set("z", z);
      item.set("seed", seed);
      item.set("assetId", input.assetId ?? null);
      item.set("crop", null);
      // Y.Text and Y.Map because two people can type into the same note, and
      // adjust different style properties, without clobbering each other.
      item.set("text", new Y.Text(input.text ?? ""));
      item.set("style", new Y.Map<unknown>());
      item.set("strokes", new Y.Map<YMap>());
      item.set("createdBy", board.doc.clientID);
      item.set("createdAt", now);
      board.items.set(itemId, item);

      // Written once and never again: two people pasting the same photograph
      // produce the same hash, and the second write is byte-identical to the
      // first, so re-registering it would be churn on the wire for no change.
      if (input.assetId && input.asset && !board.assets.has(input.assetId)) {
        const asset = new Y.Map<unknown>();
        // Zero rather than skipped: `readAsset` already returns null for a
        // non-positive dimension, so an unusable record reads as absent — and
        // absent is a state the item renders (DESIGN section 7.5). A record
        // that is merely missing would be too, but this way the hash is still
        // registered and a peer can still be asked for the bytes.
        asset.set("w", finite(input.asset.w));
        asset.set("h", finite(input.asset.h));
        asset.set("mime", input.asset.mime);
        asset.set("size", finite(input.asset.size));
        asset.set("origName", input.asset.origName ?? null);
        asset.set("addedBy", board.doc.clientID);
        asset.set("addedAt", now);
        board.assets.set(input.assetId, asset);
      }

      let pinId: string | null = null;
      if (input.withPin !== false) {
        // Top centre, in the item's local un-rotated frame. One pin means the
        // item hangs and swings (DESIGN section 5.5) — the physics follows
        // from the pin count, and the user never picks a mode.
        const pin = buildPin(board, {
          parent: itemId,
          lx: 0,
          ly: -h / 2 + Math.min(DEFAULT_PIN_INSET, h / 3),
        });
        board.pins.set(pin.id, pin.map);
        pinId = pin.id;
      }

      created.push({ itemId, pinId });
    }

    return created;
  });
}

export interface Pose {
  x: number;
  y: number;
  rot?: number;
}

/**
 * Commit a drag. `origin` is the caller's choice so that the throttled
 * crash-safety write during a drag (DESIGN section 7.3) can be merged into the
 * same undo entry as the release.
 */
export function setItemPoses(
  board: BoardDoc,
  poses: ReadonlyMap<string, Pose>,
  origin: typeof Origin.LOCAL_USER | typeof Origin.DRAG_THROTTLE = Origin.LOCAL_USER,
): void {
  if (poses.size === 0) return;
  mutate(board, origin, () => writePoses(board, poses));
}

/**
 * The pose write itself, without a transaction of its own — the step other ops
 * compose, in the same spirit as `crdt/ops/cascade.ts`. `deletePins` needs it
 * so that taking the last pin out of a hanging item and settling that item
 * where it was drawn are one entry on the undo stack.
 */
export function writePoses(board: BoardDoc, poses: ReadonlyMap<string, Pose>): void {
  for (const [id, pose] of poses) {
    if (!Number.isFinite(pose.x) || !Number.isFinite(pose.y)) continue;
    const item = board.items.get(id);
    if (!item) continue;
    item.set("x", pose.x);
    item.set("y", pose.y);
    if (pose.rot !== undefined && Number.isFinite(pose.rot)) item.set("rot", pose.rot);
  }
}

/** Where an item ends up after a resize: the new size, and the centre it implies. */
export interface Extent {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Resize items, moving their pins so the pins do not move.
 *
 * "Notes, cards and scraps resize from their edges" (DESIGN section 3.2), and
 * dragging one edge holds the opposite one still — so the centre travels by half
 * of the growth. Everything parented to the item is stored relative to that
 * centre, and a pin left at the same local offset would therefore slide across
 * the cork by half the growth, taking every string running through it along.
 *
 * A pin is not attached to a *proportion* of a note; it is pushed through the
 * paper and into the board behind it. Growing the note from its bottom edge adds
 * paper, it does not drag the top of the note out from under the pin holding it
 * up. So the compensation is exactly the centre's own movement, expressed in the
 * item's un-rotated frame and applied the other way — which leaves the pin at the
 * same board coordinates and, as it happens, over the same fibres of paper.
 *
 * The shift is measured against what is **in the document** rather than against
 * where the gesture started, so the throttled crash-safety writes during a drag
 * compose: each one moves the pins by that write's share and no more.
 *
 * One transaction per batch, pins included — half a cascade is worse than none
 * (DATA-MODEL section 8).
 */
export function resizeItems(
  board: BoardDoc,
  extents: ReadonlyMap<string, Extent>,
  origin: typeof Origin.LOCAL_USER | typeof Origin.DRAG_THROTTLE = Origin.LOCAL_USER,
): void {
  if (extents.size === 0) return;
  mutate(board, origin, () => {
    for (const [id, next] of extents) {
      if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) continue;
      if (!Number.isFinite(next.w) || !Number.isFinite(next.h)) continue;
      const map = board.items.get(id);
      const before = map ? readItem(id, map) : null;
      if (!map || !before) continue;

      const shift = boardToLocal(next.x, next.y, before.x, before.y, before.rot);
      map.set("x", next.x);
      map.set("y", next.y);
      // Invariant 6 — never zero or negative, whatever the caller thinks.
      map.set("w", Math.max(MIN_ITEM_SIZE, next.w));
      map.set("h", Math.max(MIN_ITEM_SIZE, next.h));

      // A resize that did not move the centre — both edges of an axis growing
      // equally, or nothing changing at all — leaves the pins alone, and the walk
      // is worth skipping on the second of two identical crash-safety writes.
      if (shift.lx === 0 && shift.ly === 0) continue;
      for (const [pinId, pinMap] of board.pins) {
        const pin = readPin(pinId, pinMap);
        if (!pin || pin.parent !== id) continue;
        pinMap.set("lx", pin.lx - shift.lx);
        pinMap.set("ly", pin.ly - shift.ly);
      }
    }
  });
}

export function setItemAsset(
  board: BoardDoc,
  itemId: string,
  assetId: string | null,
): void {
  mutate(board, Origin.LOCAL_USER, () => {
    board.items.get(itemId)?.set("assetId", assetId);
  });
}

export function itemText(board: BoardDoc, itemId: string): Y.Text | null {
  const text = board.items.get(itemId)?.get("text");
  return text instanceof Y.Text ? text : null;
}

/**
 * Bring an item's text to `next` — as the one splice that gets there, never as
 * a replacement.
 *
 * > Note text is a `Y.Text`, because two people can type in the same note.
 * > — DESIGN section 9.3
 *
 * Which is only true if this writes like one. `text.delete(0, len)` followed by
 * `text.insert(0, next)` produces the same string on this machine and throws
 * away every concurrent edit on the other one — the peer's characters are
 * inside the range being deleted, so a merge that should have interleaved two
 * people's typing keeps whichever transaction landed second, entire. The
 * splice touches only the characters that actually changed, so a peer typing
 * at the other end of the same note is untouched by it.
 *
 * The current value is read **inside** the transaction rather than passed in,
 * for the reason `insertPin` gives at length: the caller measured `next`
 * against a field it read a frame ago, and a peer's insert in between would
 * otherwise be diffed away as though the local person had deleted it.
 *
 * `Origin.LOCAL_USER`, which is tracked by the undo manager and carries its
 * 400 ms capture window — so "text edits are character-level and merge into
 * sensible entries by typing pause" (DESIGN section 3.6) is what the existing
 * undo grouping already does, with nothing added here.
 */
export function setItemText(board: BoardDoc, itemId: string, next: string): void {
  mutate(board, Origin.LOCAL_USER, () => {
    const text = itemText(board, itemId);
    if (!text) return;
    const edit = diffText(text.toString(), next);
    if (!edit) return;
    if (edit.remove > 0) text.delete(edit.at, edit.remove);
    if (edit.insert.length > 0) text.insert(edit.at, edit.insert);
  });
}

/**
 * Delete items and everything that dies with them, in one transaction.
 *
 * DATA-MODEL section 8:
 *   1. the item's `strokes` map goes with it — nested, so automatic;
 *   2. delete every pin whose `parent` is this item;
 *   3. remove those pins' nodes from every string that references them;
 *   4. delete any string left with fewer than two valid nodes.
 *
 * With `keepPins`, step 2 becomes a re-parent to `null` instead — `Shift+Delete`,
 * which "removes the items but leaves their pins free-floating in the cork, so
 * the string web keeps its shape with a hole where the evidence was"
 * (DESIGN section 3.8). Evidence removed, thread remains.
 */
export function deleteItems(
  board: BoardDoc,
  itemIds: readonly string[],
  options: { keepPins?: boolean } = {},
): void {
  if (itemIds.length === 0) return;

  mutate(board, Origin.LOCAL_USER, () => {
    const doomed = new Set(itemIds.filter((id) => board.items.has(id)));
    if (doomed.size === 0) return;

    const pins = pinsOfItems(board, doomed);

    if (options.keepPins) {
      for (const pinId of pins) {
        const pinMap = board.pins.get(pinId);
        const pin = pinMap ? readPin(pinId, pinMap) : null;
        if (!pinMap || !pin || pin.parent === null) continue;
        const parentMap = board.items.get(pin.parent);
        const parent = parentMap ? readItem(pin.parent, parentMap) : null;
        // Must be converted *before* the item goes, or the frame is gone.
        const world = parent
          ? localToBoard(pin.lx, pin.ly, parent.x, parent.y, parent.rot)
          : { x: pin.lx, y: pin.ly };
        pinMap.set("parent", null);
        pinMap.set("lx", world.x);
        pinMap.set("ly", world.y);
      }
    } else {
      removePinsFromStrings(board, pins);
      for (const pinId of pins) board.pins.delete(pinId);
    }

    for (const id of doomed) board.items.delete(id);
  });
}
