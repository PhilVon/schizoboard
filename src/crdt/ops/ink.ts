/**
 * Committing ink, and taking it away again.
 *
 * > Everything up to pen-up is local and ephemeral. The commit is a single
 * > `Y.Map` insertion — which makes a stroke atomic for undo, deletion and
 * > hit-testing. — DATA-MODEL section 6.2
 *
 * One stroke, one insertion, one transaction, one undo entry. That is the whole
 * design and every property this file has follows from it.
 *
 * ## Nested under the item, which is not a detail
 *
 * > Ink dies with the item it was drawn on, and undoing a delete must restore
 * > the ink atomically. Nesting gives both for free: deleting the item's map
 * > deletes the strokes with it, and one undo entry restores everything. Pins
 * > can't work this way (they're referenced by strings and can outlive the
 * > item), which is why they're top-level and need explicit cascade code.
 * > — DATA-MODEL section 3
 *
 * So there is no cascade in this file, and there is not supposed to be. The
 * strokes map is inside `board.items`, which is already a root of the undo
 * manager, so a stroke is undoable and a deleted item takes its ink with it
 * without a line of code here — see `crdt/ops/items.ts`'s `deleteItems`, which
 * has a comment saying exactly this and nothing to do about it.
 *
 * ## Ink on bare cork goes somewhere else, and that is the only fork here
 *
 * > **`boardInk` is tiled** into 2048-unit cells, keyed by the floor-divided
 * > coordinates of each stroke's bounding-box centre. — DATA-MODEL section 2
 *
 * So a stroke with no item lands in `board.boardInk` under a tile key instead of
 * in `item.strokes`, and nothing else about it differs: same fields, same
 * packing, same one insertion in one transaction. The tile is a bucket, not a
 * frame — the samples are already in board coordinates and are stored unchanged,
 * so a stroke that runs off the side of its tile is stored whole and drawn whole.
 * The renderer culls by the stroke's own bounds anyway (the same section).
 *
 * `z` is scanned within the tile for the same reason it is scanned within an
 * item: two people drawing in two different corners of the board have no
 * ordering to argue about. Across a tile boundary there is no order at all,
 * which is what a bucket means — and two strokes far enough apart to be in
 * different tiles cannot overlap unless one of them is 2048 units long.
 */

import * as Y from "yjs";

import type { BoardDoc } from "@/crdt/doc";
import { freshId, inkTileKey, mutate } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";
import type { YMap } from "@/crdt/schema";
import { keyAbove } from "@/crdt/zindex";
import type { InkSample, InkTool } from "@/lib/ink";
import { newSeed } from "@/lib/seed";
import { packStroke } from "@/lib/strokepack";

export interface CommitStrokeInput {
  /** The item the samples are local to, or null for a stroke on bare cork —
   *  which goes into a `boardInk` tile instead. See the note at the top. */
  item: string | null;
  tool: InkTool;
  color: string;
  /** Board units, which are the item's local units too — the same scale. */
  size: number;
  /** 0 to 1; the highlighter's translucency. Defaults to opaque. */
  opacity?: number;
  seed?: number;
  /** In the space `item` names — `state/tools/marker.ts` decided which at
   *  pen-down and has been converting into it ever since. */
  samples: readonly InkSample[];
}

/** Where a committed stroke landed. */
export interface CommittedStroke {
  readonly id: string;
  /**
   * The tile it went into, or null when it went onto an item.
   *
   * Returned rather than recomputed by the caller because the packer is what
   * measured the box the key comes from, and packing a second time to ask where
   * something already is would be the largest allocation in the gesture. The one
   * caller that wants it is the wet/dry handoff, which has to know which surface
   * to wait for — see `app/main.ts`.
   */
  readonly tile: string | null;
}

/**
 * Write one stroke. Returns where it landed, or null when there was nothing
 * worth keeping.
 *
 * Null covers two cases: an item that has gone, and a gesture whose samples
 * packed to no bytes. The last is a click rather than a stroke, and
 * `lib/strokepack.ts` deliberately does not throw on it — deciding a click is
 * not worth committing belongs here, to the caller that knows a pointer was
 * involved.
 *
 * `bbox` is the packer's rather than measured here, which is what makes
 * invariant 7 — "a stroke's `bbox` always contains its unpacked points" — true
 * by construction: the same function that decided where the points ended up
 * measured the box round them. The tile key is taken from that same box, so a
 * stroke is bucketed by exactly the extent it is stored with.
 */
export function commitStroke(
  board: BoardDoc,
  input: CommitStrokeInput,
): CommittedStroke | null {
  const packed = packStroke(input.samples);
  if (packed.pts.length === 0) return null;

  const [x0, y0, x1, y1] = packed.bbox;
  const tile = input.item === null ? inkTileKey((x0 + x1) / 2, (y0 + y1) / 2) : null;
  const itemId = input.item;

  return mutate(board, Origin.INK_COMMIT, () => {
    const map = itemId === null ? tileMap(board, tile!) : strokesOfItem(board, itemId);
    if (map === null) return null;

    const id = freshId(map);
    const stroke = new Y.Map<unknown>();
    stroke.set("tool", input.tool);
    stroke.set("color", input.color);
    stroke.set("size", input.size);
    stroke.set("opacity", input.opacity ?? 1);
    stroke.set("seed", input.seed ?? newSeed());
    // Above every stroke already in this item or this tile, not on the board.
    // Ink stacks within the surface it is on, and two people annotating two
    // photographs — or two corners of the cork — have no ordering to argue about.
    stroke.set("z", keyAbove(topStroke(map)));
    stroke.set("bbox", [...packed.bbox]);
    stroke.set("pts", packed.pts);
    map.set(id, stroke as YMap);
    return { id, tile };
  });
}

/**
 * An item's strokes map, or null when there is not one to write to.
 *
 * Null is an item that has gone while the pointer was down, and an item written
 * by a version of this application that predates the strokes map or by a peer
 * that broke it. Skipped, never repaired — a read that heals the document causes
 * write storms in a shared session (DATA-MODEL section 8.1), and this one would
 * fire on every pen-up.
 */
function strokesOfItem(board: BoardDoc, itemId: string): Y.Map<YMap> | null {
  const item = board.items.get(itemId);
  if (!item) return null;
  const map = item.get("strokes");
  return map instanceof Y.Map ? (map as Y.Map<YMap>) : null;
}

/**
 * A tile's strokes map, created on first use.
 *
 * Created here and never anywhere else, which is what keeps "a tile exists"
 * and "a tile has ink in it" the same statement — so the binding can mirror a
 * tile going empty as the tile disappearing, and the renderer never mounts a
 * canvas for a bucket somebody once drew in and then undid.
 *
 * Two peers drawing into the same fresh tile concurrently both create a map and
 * one of the two wins, taking the loser's stroke with it. That is a real hole
 * and it is the document's, not this function's: DATA-MODEL section 8.1's
 * janitor is where nested-map contention gets resolved, and it is Phase 7 work
 * (T-77). Locally there is one writer and no race at all.
 */
function tileMap(board: BoardDoc, key: string): Y.Map<YMap> {
  const existing = board.boardInk.get(key);
  if (existing) return existing;
  const created = new Y.Map<YMap>();
  board.boardInk.set(key, created);
  return created;
}

/**
 * Remove whole records.
 *
 * > **Erasing deletes stroke records.** Ink is never rasterised and flattened;
 * > that would destroy both undo and merge. — DATA-MODEL section 6.2
 *
 * One transaction for the batch, because a stroke eraser dragged across four
 * marks is one thing the user did. `Origin.LOCAL_USER` rather than
 * `INK_COMMIT`: the origins are both tracked and the difference is only what the
 * entry is called, but "one stroke, one entry" is a statement about drawing, and
 * a rub-out that took four strokes should undo as the one gesture it was.
 */
export function deleteStrokes(
  board: BoardDoc,
  itemId: string,
  strokeIds: readonly string[],
): void {
  if (strokeIds.length === 0) return;
  mutate(board, Origin.LOCAL_USER, () => {
    const item = board.items.get(itemId);
    if (!item) return;
    const strokes = item.get("strokes");
    if (!(strokes instanceof Y.Map)) return;
    for (const id of strokeIds) (strokes as Y.Map<YMap>).delete(id);
  });
}

/** The highest `z` among the strokes already on one surface, or null for the
 *  first one. One item or one tile — never the board — see `commitStroke`. */
function topStroke(strokes: Y.Map<YMap>): string | null {
  let highest: string | null = null;
  for (const [, stroke] of strokes) {
    const z = stroke.get("z");
    if (typeof z !== "string") continue;
    if (highest === null || z > highest) highest = z;
  }
  return highest;
}
