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
import { localToBoard, pinsOfItems, removePinsFromStrings } from "@/crdt/ops/cascade";
import { buildPin, DEFAULT_PIN_INSET } from "@/crdt/ops/pins";
import { readItem, readPin, type ItemType, type YMap } from "@/crdt/schema";
import { keyAbove } from "@/crdt/zindex";
import { highestZ } from "@/crdt/ops/z";
import { newSeed, scatterAngle } from "@/lib/seed";

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
      const w = Math.max(1, input.w);
      const h = Math.max(1, input.h);
      const itemId = freshId(board.items);
      z = keyAbove(z);

      const item = new Y.Map<unknown>();
      item.set("type", input.type);
      item.set("x", input.x);
      item.set("y", input.y);
      item.set("rot", input.rot ?? scatterAngle(seed));
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
        asset.set("w", input.asset.w);
        asset.set("h", input.asset.h);
        asset.set("mime", input.asset.mime);
        asset.set("size", input.asset.size);
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
  mutate(board, origin, () => {
    for (const [id, pose] of poses) {
      if (!Number.isFinite(pose.x) || !Number.isFinite(pose.y)) continue;
      const item = board.items.get(id);
      if (!item) continue;
      item.set("x", pose.x);
      item.set("y", pose.y);
      if (pose.rot !== undefined && Number.isFinite(pose.rot)) item.set("rot", pose.rot);
    }
  });
}

export function setItemSize(board: BoardDoc, itemId: string, w: number, h: number): void {
  if (!Number.isFinite(w) || !Number.isFinite(h)) return;
  mutate(board, Origin.LOCAL_USER, () => {
    const item = board.items.get(itemId);
    if (!item) return;
    // Invariant 6 — never zero or negative, whatever the caller thinks.
    item.set("w", Math.max(1, w));
    item.set("h", Math.max(1, h));
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
